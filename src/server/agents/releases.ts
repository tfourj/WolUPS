import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices } from "../db/schema";
import { env } from "../env";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import { isNewerVersion, parseVersion } from "../../shared/version";
import { agentHub } from "./hub";
import { PROTOCOL_VERSION } from "./protocol";

const log = createLogger("releases");

const UPDATE_TTL_MS = 10 * 60 * 1000;
/** After a failed automatic update, wait this long before trying the same release again. */
const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;

export type LatestRelease = { version: string; url: string; checkedAt: number } | null;

let latest: LatestRelease = null;
let lastError: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function latestAgentRelease() {
  return { latest, error: lastError };
}

/**
 * Read the latest release's agent-release.json. This is a release asset download, not a GitHub
 * API call, so it does not count against the API rate limit shared by everything on this IP.
 */
export async function fetchLatestRelease(): Promise<LatestRelease> {
  const res = await fetch(`https://github.com/${env.agentRepo}/releases/latest/download/agent-release.json`, {
    headers: { "User-Agent": "wolups" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const body = (await res.json()) as { version?: string; protocol_version?: number };
  const version = body.version ?? "";
  if (!parseVersion(version)) {
    throw new Error(`release version ${version || "(missing)"} is not a stable x.y.z version`);
  }
  if (body.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(
      `release v${version} uses agent protocol ${body.protocol_version}, this server needs ${PROTOCOL_VERSION}`,
    );
  }
  const url = `https://github.com/${env.agentRepo}/releases/tag/v${version}`;
  return { version, url, checkedAt: Date.now() };
}

/** Ask an agent to run its fixed self-update. The command carries no URL or path. */
export function requestAgentUpdate(agentId: string) {
  db.update(agents)
    .set({ updateStatus: "updating", lastUpdateError: null, updateCheckedAt: new Date() })
    .where(eq(agents.id, agentId))
    .run();
  return agentHub.send(agentId, "update", {}, { ttlMs: UPDATE_TTL_MS });
}

type AgentRow = typeof agents.$inferSelect;

/**
 * Whether an automatic update should wait. An update that never got an answer (agent went offline)
 * stops blocking once it expires, and a failed one is retried after a few hours, not on every check.
 */
function autoUpdateBlocked(agent: AgentRow, now = Date.now()) {
  const age = agent.updateCheckedAt ? now - agent.updateCheckedAt.getTime() : Infinity;
  if (agent.updateStatus === "updating" || agent.updateStatus === "restarting") return age < UPDATE_TTL_MS;
  if (agent.updateStatus === "failed") return age < FAILED_RETRY_MS;
  return false;
}

/** Record a newer release for this agent and start an update when automatic updates are on. */
function handleAgentRelease(agent: AgentRow, release: NonNullable<LatestRelease>) {
  if (!isNewerVersion(release.version, agent.version)) return;
  const device = db.select().from(devices).where(eq(devices.id, agent.deviceId)).get();
  const name = device?.name ?? agent.hostname ?? "agent";
  if (agent.latestVersion !== release.version) {
    db.update(agents)
      .set({ latestVersion: release.version, updateCheckedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .run();
    emitEvent({
      type: "agent_update_available",
      deviceId: agent.deviceId,
      title: `Agent update available for ${name}`,
      message: `Agent v${release.version} is available for ${name} (running v${agent.version})`,
      data: { device: name, version: release.version, currentVersion: agent.version },
    });
  }
  if (agent.autoUpdate && agentHub.isConnected(agent.id) && !autoUpdateBlocked(agent)) {
    log.info("starting automatic agent update", { agentId: agent.id, to: release.version });
    requestAgentUpdate(agent.id);
  }
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
  for (const agent of db.select().from(agents).all()) handleAgentRelease(agent, latest);
}

// An agent that was offline during the last check updates as soon as it reconnects.
agentHub.onConnect((agentId) => {
  if (!latest) return;
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (agent) handleAgentRelease(agent, latest);
});

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
      schedule(getSettings().agentUpdateCheckMinutes * 60_000);
    }, delay);
  };
  if (!timer) schedule(30_000);
}
