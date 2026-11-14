import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices } from "../db/schema";
import { env } from "../env";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import { isNewerVersion, parseVersion } from "../../shared/version";
import { agentHub } from "./hub";

const log = createLogger("releases");

const UPDATE_TTL_MS = 10 * 60 * 1000;

export type LatestRelease = { version: string; url: string; checkedAt: number } | null;

let latest: LatestRelease = null;
let lastError: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function latestAgentRelease() {
  return { latest, error: lastError };
}

export async function fetchLatestRelease(): Promise<LatestRelease> {
  const res = await fetch(`https://api.github.com/repos/${env.agentRepo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "wolups" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string };
  const version = body.tag_name?.replace(/^v/, "") ?? "";
  if (!parseVersion(version)) throw new Error(`release tag ${body.tag_name} is not a stable x.y.z version`);
  return { version, url: body.html_url ?? "", checkedAt: Date.now() };
}

/** Ask an agent to run its fixed self-update. The command carries no URL or path. */
export function requestAgentUpdate(agentId: string) {
  db.update(agents).set({ updateStatus: "updating", lastUpdateError: null }).where(eq(agents.id, agentId)).run();
  return agentHub.send(agentId, "update", {}, { ttlMs: UPDATE_TTL_MS });
}

export async function checkForAgentUpdates() {
  try {
    latest = await fetchLatestRelease();
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.warn("agent release check failed", { error: lastError });
    return;
  }
  if (!latest) return;
  const rows = db.select().from(agents).all();
  for (const agent of rows) {
    if (!isNewerVersion(latest.version, agent.version)) continue;
    const device = db.select().from(devices).where(eq(devices.id, agent.deviceId)).get();
    if (agent.latestVersion !== latest.version) {
      db.update(agents).set({ latestVersion: latest.version, updateCheckedAt: new Date() }).where(eq(agents.id, agent.id)).run();
      emitEvent({
        type: "agent_update_available",
        deviceId: agent.deviceId,
        title: `Agent update available for ${device?.name ?? agent.hostname}`,
        message: `Agent v${latest.version} is available for ${device?.name ?? agent.hostname} (running v${agent.version})`,
        data: { device: device?.name, version: latest.version, currentVersion: agent.version },
      });
    }
    if (agent.autoUpdate && agentHub.isConnected(agent.id) && agent.updateStatus !== "updating") {
      log.info("starting automatic agent update", { agentId: agent.id, to: latest.version });
      requestAgentUpdate(agent.id);
    }
  }
}

agentHub.onAck((command, ack) => {
  if (command.type !== "update") return;
  const agent = db.select().from(agents).where(eq(agents.id, command.agentId)).get();
  if (!agent) return;
  if (!ack.ok) {
    db.update(agents)
      .set({ updateStatus: "failed", lastUpdateError: ack.error ?? "update failed", updateCheckedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .run();
    const device = db.select().from(devices).where(eq(devices.id, agent.deviceId)).get();
    emitEvent({
      type: "agent_update_failed",
      deviceId: agent.deviceId,
      title: `Agent update failed on ${device?.name ?? agent.hostname}`,
      message: `Agent on ${device?.name ?? agent.hostname} could not update: ${ack.error ?? "unknown error"}`,
      data: { device: device?.name, version: agent.version, error: ack.error },
    });
    return;
  }
  const updated = ack.result?.updated === true;
  db.update(agents)
    .set({
      updateStatus: updated ? "restarting" : "current",
      latestVersion: typeof ack.result?.latestVersion === "string" ? ack.result.latestVersion : agent.latestVersion,
      updateCheckedAt: new Date(),
    })
    .where(eq(agents.id, agent.id))
    .run();
});

export function startReleaseChecks() {
  const schedule = (delay: number) => {
    timer = setTimeout(async () => {
      await checkForAgentUpdates();
      schedule(getSettings().agentUpdateCheckHours * 3600_000);
    }, delay);
  };
  if (!timer) schedule(30_000);
}
