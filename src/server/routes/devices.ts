import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { agents, devices, ups } from "../db/schema";
import { agentHub } from "../agents/hub";
import { createEnrollmentToken } from "../agents/enroll";
import { checkAgentUpdateNow, latestAgentRelease } from "../agents/releases";
import { env } from "../env";
import { emitEvent } from "../events";
import { shutdownNow } from "../monitor/shutdown";
import { wakeNow } from "../monitor/wake";
import { normalizeMac } from "../wol/magic";
import { resolveMac } from "../wol/resolve-mac";
import { compareNames } from "../../shared/sort";
import { isNewerVersion } from "../../shared/version";
import { parseBody, patchSchema } from "./util";

export const deviceRoutes = new Hono();

type DeviceRow = typeof devices.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function serializeAgent(agent: AgentRow | null) {
  if (!agent) return null;
  const { publicKey, ...rest } = agent;
  const latest = latestAgentRelease().latest?.version ?? agent.latestVersion;
  return {
    ...rest,
    connected: agentHub.isConnected(agent.id),
    keyFingerprint: publicKey.slice(0, 12),
    latestVersion: latest ?? null,
    updateAvailable: isNewerVersion(latest, agent.version),
  };
}

function serialize(device: DeviceRow, agent: AgentRow | null, upsName: string | null) {
  return { ...device, upsName, agent: serializeAgent(agent) };
}

function loadDevice(id: string) {
  const row = db
    .select({ device: devices, agent: agents, upsName: ups.name })
    .from(devices)
    .leftJoin(agents, eq(agents.deviceId, devices.id))
    .leftJoin(ups, eq(devices.upsId, ups.id))
    .where(eq(devices.id, id))
    .get();
  return row ? serialize(row.device, row.agent, row.upsName) : null;
}

function firstUpsId(): string | null {
  const names = db.select({ id: ups.id, name: ups.name }).from(ups).all();
  return names.sort((a, b) => compareNames(a.name, b.name))[0]?.id ?? null;
}

const macSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === "") return null;
    const mac = normalizeMac(v);
    if (!mac) ctx.addIssue({ code: "custom", message: "invalid MAC address" });
    return mac;
  });

const deviceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z
    .string()
    .trim()
    .max(255)
    .regex(/^[A-Za-z0-9.:_-]*$/, "invalid host")
    .transform((v) => v || null)
    .nullish(),
  mac: macSchema.nullish(),
  upsId: z.string().nullish(),
  enabled: z.boolean().default(true),
  shutdownEnabled: z.boolean().default(false),
  shutdownBatteryPercent: z.number().int().min(1).max(100).default(20),
  shutdownRuntimeSec: z.number().int().min(0).max(86400).nullish(),
  wakeEnabled: z.boolean().default(true),
  alwaysWake: z.boolean().default(false),
});

deviceRoutes.get("/", (c) => {
  const rows = db
    .select({ device: devices, agent: agents, upsName: ups.name })
    .from(devices)
    .leftJoin(agents, eq(agents.deviceId, devices.id))
    .leftJoin(ups, eq(devices.upsId, ups.id))
    .all()
    .sort((a, b) => compareNames(a.device.name, b.device.name));
  return c.json(rows.map((r) => serialize(r.device, r.agent, r.upsName)));
});

deviceRoutes.post("/resolve-mac", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      host: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9.:_-]+$/, "invalid host"),
      deviceId: z.string().optional(),
    }),
  );
  if (body instanceof Response) return body;
  return c.json(await resolveMac(body.host, body.deviceId));
});

deviceRoutes.post("/", async (c) => {
  const body = await parseBody(c, deviceSchema);
  if (body instanceof Response) return body;
  // Without an explicit choice, a new device is powered by the first UPS (by name).
  const upsId = body.upsId === undefined ? firstUpsId() : body.upsId || null;
  const row = db
    .insert(devices)
    .values({ ...body, host: body.host ?? null, mac: body.mac ?? null, upsId })
    .returning()
    .get();
  return c.json(loadDevice(row.id), 201);
});

deviceRoutes.patch("/:id", async (c) => {
  const body = await parseBody(c, patchSchema(deviceSchema));
  if (body instanceof Response) return body;
  const id = c.req.param("id");
  const existing = db.select().from(devices).where(eq(devices.id, id)).get();
  if (!existing) return c.json({ error: "not found" }, 404);
  const update: Partial<DeviceRow> = { ...body, updatedAt: new Date() } as Partial<DeviceRow>;
  if (body.upsId !== undefined) update.upsId = body.upsId || null;
  db.update(devices).set(update).where(eq(devices.id, id)).run();
  return c.json(loadDevice(id));
});

deviceRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const agent = db.select().from(agents).where(eq(agents.deviceId, id)).get();
  if (agent && agentHub.isConnected(agent.id)) {
    await agentHub.sendAndWait(agent.id, "unpair", {}, 5_000);
    agentHub.disconnect(agent.id);
  }
  db.delete(devices).where(eq(devices.id, id)).run();
  return c.json({ ok: true });
});

const SCRIPT_BASE = `https://raw.githubusercontent.com/${env.agentRepo}/main/agent`;

function installCommand(token: string) {
  const flags = [`--server ${env.baseUrl}`, `--token ${token}`];
  if (env.baseUrl.startsWith("http://")) flags.push("--allow-http");
  return `curl -fsSL ${SCRIPT_BASE}/install.sh | sh -s -- ${flags.join(" ")}`;
}

deviceRoutes.post("/:id/enroll", (c) => {
  const device = db.select().from(devices).where(eq(devices.id, c.req.param("id"))).get();
  if (!device) return c.json({ error: "not found" }, 404);
  const { token, expiresAt } = createEnrollmentToken(device.id);
  return c.json({
    token,
    expiresAt,
    serverUrl: env.baseUrl,
    insecure: env.baseUrl.startsWith("http://"),
    command: installCommand(token),
    uninstallCommand: `curl -fsSL ${SCRIPT_BASE}/uninstall.sh | sh`,
  });
});

deviceRoutes.post("/:id/shutdown", async (c) => c.json(await shutdownNow(c.req.param("id"))));

deviceRoutes.post("/:id/wake", async (c) => c.json(await wakeNow(c.req.param("id"))));

function agentFor(deviceId: string) {
  return db.select().from(agents).where(eq(agents.deviceId, deviceId)).get();
}

deviceRoutes.post("/:id/agent/ping", async (c) => {
  const agent = agentFor(c.req.param("id"));
  if (!agent) return c.json({ ok: false, error: "no agent paired" }, 404);
  const started = Date.now();
  const ack = await agentHub.sendAndWait(agent.id, "ping", {}, 10_000);
  return c.json({ ...ack, latencyMs: Date.now() - started });
});

deviceRoutes.post("/:id/agent/update", async (c) => {
  const agent = agentFor(c.req.param("id"));
  if (!agent) return c.json({ ok: false, error: "no agent paired" }, 404);
  return c.json(await checkAgentUpdateNow(agent.id));
});

deviceRoutes.patch("/:id/agent", async (c) => {
  const body = await parseBody(c, z.object({ autoUpdate: z.boolean() }));
  if (body instanceof Response) return body;
  const agent = agentFor(c.req.param("id"));
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  db.update(agents).set({ autoUpdate: body.autoUpdate }).where(eq(agents.id, agent.id)).run();
  return c.json(loadDevice(agent.deviceId));
});

deviceRoutes.post("/:id/agent/unpair", async (c) => {
  const body = await parseBody(c, z.object({ force: z.boolean().default(false) }));
  if (body instanceof Response) return body;
  const agent = agentFor(c.req.param("id"));
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  if (!body.force) {
    const ack = await agentHub.sendAndWait(agent.id, "unpair", {}, 10_000);
    if (!ack.ok) return c.json({ ok: false, error: ack.error ?? "agent did not confirm", canForce: true }, 409);
  }
  agentHub.disconnect(agent.id);
  db.delete(agents).where(eq(agents.id, agent.id)).run();
  const device = db.select().from(devices).where(eq(devices.id, agent.deviceId)).get();
  emitEvent({
    type: "agent_disconnected",
    deviceId: agent.deviceId,
    title: `${device?.name ?? "Agent"} unpaired`,
    message: `Agent on ${device?.name ?? agent.hostname} was unpaired${body.force ? " (forced)" : ""}`,
    data: { device: device?.name, version: agent.version },
  });
  return c.json({ ok: true });
});
