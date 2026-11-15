import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { agents, nutHosts, ups } from "../db/schema";
import { createEnrollmentToken } from "../agents/enroll";
import { agentHub } from "../agents/hub";
import { checkAgentUpdateNow } from "../agents/releases";
import { serializeAgent } from "../agents/serialize";
import { env } from "../env";
import { emitEvent } from "../events";
import { nutTarget } from "../monitor/ups-monitor";
import { fetchUpsControls } from "../nut/client";
import { adoptableUps, applyNutConfig, previewNutConfig, removeNutUps } from "../nut-hosts/apply";
import {
  applySchema,
  CONF_VALUE,
  nutAgent,
  nutCommandState,
  nutHost,
  runNutCommand,
  scanSchema,
  startNutCommand,
  type DetectResult,
} from "../nut-hosts/commands";
import "../nut-hosts/health";
import { compareNames } from "../../shared/sort";
import { errorMessage, parseBody } from "./util";

export const nutHostRoutes = new Hono();

type HostRow = typeof nutHosts.$inferSelect;

const SCRIPT_BASE = `https://raw.githubusercontent.com/${env.agentRepo}/main/agent`;

function serializeHost(host: HostRow) {
  const agent = nutAgent(host.id);
  const upsRows = db
    .select({ id: ups.id, name: ups.name, upsName: ups.upsName })
    .from(ups)
    .where(eq(ups.nutHostId, host.id))
    .all();
  return { ...host, agent: serializeAgent(agent), interfaces: agent?.interfaces ?? [], ups: upsRows };
}

function enrollment(hostId: string) {
  const { token, expiresAt } = createEnrollmentToken({ nutHostId: hostId });
  const flags = [`--server ${env.baseUrl}`, `--token ${token}`];
  if (env.baseUrl.startsWith("http://")) flags.push("--allow-http");
  return {
    token,
    expiresAt,
    serverUrl: env.baseUrl,
    insecure: env.baseUrl.startsWith("http://"),
    command: `curl -fsSL ${SCRIPT_BASE}/install-nut.sh | sh -s -- ${flags.join(" ")}`,
    uninstallCommand: `curl -fsSL ${SCRIPT_BASE}/uninstall-nut.sh | sh`,
  };
}

/** Find the host or answer 404. */
function withHost(c: { req: { param: (name: string) => string } }) {
  return nutHost(c.req.param("id")) ?? null;
}

const nameSchema = z.object({ name: z.string().trim().min(1).max(100) });

nutHostRoutes.get("/", (c) => {
  const rows = db
    .select()
    .from(nutHosts)
    .all()
    .sort((a, b) => compareNames(a.name, b.name));
  return c.json(rows.map(serializeHost));
});

nutHostRoutes.post("/", async (c) => {
  const body = await parseBody(c, nameSchema);
  if (body instanceof Response) return body;
  const host = db.insert(nutHosts).values({ name: body.name }).returning().get();
  return c.json({ host: serializeHost(host), enrollment: enrollment(host.id) }, 201);
});

nutHostRoutes.get("/:id", (c) => {
  const host = withHost(c);
  return host ? c.json(serializeHost(host)) : c.json({ error: "not found" }, 404);
});

nutHostRoutes.patch("/:id", async (c) => {
  const body = await parseBody(c, nameSchema);
  if (body instanceof Response) return body;
  const host = db.update(nutHosts).set({ name: body.name }).where(eq(nutHosts.id, c.req.param("id"))).returning().get();
  return host ? c.json(serializeHost(host)) : c.json({ error: "not found" }, 404);
});

nutHostRoutes.post("/:id/enroll", (c) => {
  const host = withHost(c);
  return host ? c.json(enrollment(host.id)) : c.json({ error: "not found" }, 404);
});

/** Unpair the agent and remove the host. Its UPS entries stay as plain NUT servers. */
nutHostRoutes.delete("/:id", async (c) => {
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const agent = nutAgent(host.id);
  if (agent) {
    if (agentHub.isConnected(agent.id)) await agentHub.sendAndWait(agent.id, "unpair", {}, 10_000);
    agentHub.disconnect(agent.id);
    emitEvent({
      type: "agent_disconnected",
      title: `${host.name} unpaired`,
      message: `NUT agent on ${host.name} was unpaired`,
      data: { device: host.name, version: agent.version },
    });
  }
  db.delete(nutHosts).where(eq(nutHosts.id, host.id)).run();
  return c.json({ ok: true });
});

nutHostRoutes.post("/:id/agent/ping", async (c) => {
  const agent = nutAgent(c.req.param("id"));
  if (!agent) return c.json({ ok: false, error: "no NUT agent paired" }, 404);
  const started = Date.now();
  const ack = await agentHub.sendAndWait(agent.id, "ping", {}, 10_000);
  return c.json({ ...ack, latencyMs: Date.now() - started });
});

nutHostRoutes.post("/:id/agent/update", async (c) => {
  const agent = nutAgent(c.req.param("id"));
  if (!agent) return c.json({ ok: false, error: "no NUT agent paired" }, 404);
  return c.json(await checkAgentUpdateNow(agent.id));
});

nutHostRoutes.patch("/:id/agent", async (c) => {
  const body = await parseBody(c, z.object({ autoUpdate: z.boolean() }));
  if (body instanceof Response) return body;
  const host = withHost(c);
  const agent = host ? nutAgent(host.id) : undefined;
  if (!host || !agent) return c.json({ error: "no NUT agent paired" }, 404);
  db.update(agents).set({ autoUpdate: body.autoUpdate }).where(eq(agents.id, agent.id)).run();
  return c.json(serializeHost(host));
});

nutHostRoutes.post("/:id/detect", async (c) => {
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const ack = await runNutCommand(host.id, "nut_detect");
  if (!ack.ok) return c.json({ error: ack.error ?? "detect failed" }, 502);
  const result = ack.result as DetectResult;
  db.update(nutHosts)
    .set({
      os: result.os || null,
      packageManager: result.packageManager || null,
      nutVersion: result.nutVersion || null,
      configDir: result.configDir || null,
    })
    .where(eq(nutHosts.id, host.id))
    .run();
  // UPS entries added by hand for this host's NUT server, which setup will take over.
  const names = [...result.existing, ...result.managed].map((section) => section.name);
  const adopt = adoptableUps(host.id, names).map(({ id, name, upsName, host: address }) => ({
    id,
    name,
    upsName,
    host: address,
  }));
  return c.json({ ...result, adopt });
});

nutHostRoutes.post("/:id/install", (c) => {
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const started = startNutCommand(host.id, "nut_install");
  return started.ok ? c.json({ commandId: started.commandId }) : c.json({ error: started.error }, 409);
});

nutHostRoutes.post("/:id/scan", async (c) => {
  const body = await parseBody(c, scanSchema);
  if (body instanceof Response) return body;
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const started = startNutCommand(host.id, "nut_scan", body);
  return started.ok ? c.json({ commandId: started.commandId }) : c.json({ error: started.error }, 409);
});

nutHostRoutes.get("/:id/commands/:commandId", (c) => {
  const state = nutCommandState(c.req.param("id"), c.req.param("commandId"));
  return state ? c.json(state) : c.json({ error: "not found" }, 404);
});

nutHostRoutes.post("/:id/apply", async (c) => {
  const body = await parseBody(c, applySchema);
  if (body instanceof Response) return body;
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const outcome = await applyNutConfig(host.id, body);
  return outcome.ok ? c.json(outcome) : c.json(outcome, 502);
});

nutHostRoutes.post("/:id/preview", async (c) => {
  const body = await parseBody(c, applySchema);
  if (body instanceof Response) return body;
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const outcome = await previewNutConfig(host.id, body);
  return outcome.ok ? c.json(outcome) : c.json(outcome, 502);
});

nutHostRoutes.post("/:id/service", async (c) => {
  const body = await parseBody(c, z.object({ action: z.enum(["start", "stop", "restart"]) }));
  if (body instanceof Response) return body;
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const ack = await runNutCommand(host.id, "nut_service", body);
  return ack.ok ? c.json(ack.result ?? {}) : c.json({ error: ack.error }, 502);
});

/** Turn upsmon on or off. Off also ends "shut down this host", so NUT restarts do not start it again. */
nutHostRoutes.post("/:id/upsmon", async (c) => {
  const body = await parseBody(c, z.object({ enabled: z.boolean() }));
  if (body instanceof Response) return body;
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const ack = await runNutCommand(host.id, "nut_upsmon", body);
  if (!ack.ok) return c.json({ error: ack.error ?? "the NUT agent could not change upsmon" }, 502);
  if (!body.enabled) db.update(nutHosts).set({ localShutdown: false }).where(eq(nutHosts.id, host.id)).run();
  return c.json(serializeHost(nutHost(host.id)!));
});

nutHostRoutes.post("/:id/status", async (c) => {
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const ack = await runNutCommand(host.id, "nut_status");
  return ack.ok ? c.json(ack.result ?? {}) : c.json({ error: ack.error }, 502);
});

nutHostRoutes.post("/:id/logs", async (c) => {
  const body = await parseBody(c, z.object({ lines: z.number().int().min(10).max(500).default(200) }));
  if (body instanceof Response) return body;
  const host = withHost(c);
  if (!host) return c.json({ error: "not found" }, 404);
  const ack = await runNutCommand(host.id, "nut_logs", body);
  return ack.ok ? c.json(ack.result ?? { log: [] }) : c.json({ error: ack.error }, 502);
});

/** A UPS entry that belongs to this host. */
function managedUps(hostId: string, upsId: string) {
  return db
    .select()
    .from(ups)
    .where(and(eq(ups.id, upsId), eq(ups.nutHostId, hostId)))
    .get();
}

nutHostRoutes.delete("/:id/ups/:upsId", async (c) => {
  const outcome = await removeNutUps(c.req.param("id"), c.req.param("upsId"));
  if (outcome.ok) return c.json(outcome);
  return c.json(outcome, outcome.error === "not found" ? 404 : 502);
});

nutHostRoutes.get("/:id/ups/:upsId/controls", async (c) => {
  const row = managedUps(c.req.param("id"), c.req.param("upsId"));
  if (!row) return c.json({ error: "not found" }, 404);
  try {
    return c.json(await fetchUpsControls(nutTarget(row), row.upsName));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 502);
  }
});

nutHostRoutes.post("/:id/ups/:upsId/instcmd", async (c) => {
  const body = await parseBody(c, z.object({ command: z.string().regex(/^[a-z0-9._]{1,64}$/) }));
  if (body instanceof Response) return body;
  const row = managedUps(c.req.param("id"), c.req.param("upsId"));
  if (!row) return c.json({ error: "not found" }, 404);
  const ack = await runNutCommand(row.nutHostId!, "nut_instcmd", { ups: row.upsName, command: body.command });
  return ack.ok ? c.json({ ok: true }) : c.json({ error: ack.error }, 502);
});

nutHostRoutes.post("/:id/ups/:upsId/setvar", async (c) => {
  const body = await parseBody(
    c,
    z.object({ name: z.string().regex(/^[a-z0-9._]{1,64}$/), value: z.string().regex(CONF_VALUE) }),
  );
  if (body instanceof Response) return body;
  const row = managedUps(c.req.param("id"), c.req.param("upsId"));
  if (!row) return c.json({ error: "not found" }, 404);
  const ack = await runNutCommand(row.nutHostId!, "nut_setvar", { ups: row.upsName, ...body });
  return ack.ok ? c.json({ ok: true }) : c.json({ error: ack.error }, 502);
});
