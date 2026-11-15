import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { agents, commands, devices } from "../db/schema";
import { env } from "../env";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import { isNewerVersion, parseVersion } from "../../shared/version";
import { agentHub } from "./hub";
import { PROTOCOL_VERSION } from "./protocol";
import { queueAgentUpdateEvent } from "./update-events";

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

type GitHubRelease = { tag_name?: string; draft?: boolean; prerelease?: boolean };

const AGENT_TAG = /^agent-v(\d+\.\d+\.\d+)$/;

/** Version of the newest stable agent-vX.Y.Z release. Server releases (vX.Y.Z) are skipped. */
export function newestAgentVersion(releases: GitHubRelease[]): string | null {
  let best: string | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = AGENT_TAG.exec(release.tag_name ?? "")?.[1];
    if (version && (!best || isNewerVersion(version, best))) best = version;
  }
  return best;
}

/**
 * Find the newest agent-vX.Y.Z release and read its agent-release.json. Agent releases are never the repository's
 * latest release (server releases are), so this lists releases through the GitHub API: one unauthenticated call per
 * check, well within the hourly limit at the shortest check interval.
 */
export async function fetchLatestRelease(): Promise<LatestRelease> {
  const headers = { "User-Agent": "wolups" };
  const list = await fetch(`https://api.github.com/repos/${env.agentRepo}/releases?per_page=100`, {
    headers: { ...headers, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (list.status === 403 || list.status === 429) throw new Error("GitHub API rate limit reached, try again later");
  if (!list.ok) throw new Error(`GitHub returned ${list.status} listing releases of ${env.agentRepo}`);
  const latestVersion = newestAgentVersion((await list.json()) as GitHubRelease[]);
  if (!latestVersion) return null;

  const tag = `agent-v${latestVersion}`;
  const res = await fetch(`https://github.com/${env.agentRepo}/releases/download/${tag}/agent-release.json`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`could not read agent-release.json of ${tag} (GitHub returned ${res.status})`);
  const body = (await res.json()) as { version?: string; protocol_version?: number };
  const version = body.version ?? "";
  if (!parseVersion(version) || version !== latestVersion) {
    throw new Error(`${tag} has agent-release.json version ${version || "(missing)"}`);
  }
  if (body.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(
      `release v${version} uses agent protocol ${body.protocol_version}, this server needs ${PROTOCOL_VERSION}`,
    );
  }
  const url = `https://github.com/${env.agentRepo}/releases/tag/${tag}`;
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
    queueAgentUpdateEvent("agent_update_available", {
      deviceId: agent.deviceId,
      device: name,
      title: `Agent update available for ${name}`,
      message: `Agent v${release.version} is available for ${name} (running v${agent.version})`,
      version: release.version,
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

/** Longest wait for an agent to download, verify and install an update before answering. */
const UPDATE_WAIT_MS = 2 * 60 * 1000;

export type UpdateCheck =
  | { ok: true; status: "current" | "updating"; version: string | null; latestVersion: string }
  | { ok: false; error: string };

/**
 * "Check for update" from the UI: look up the latest release now and, only if it is newer,
 * ask the agent to update and wait for its answer.
 */
export async function checkAgentUpdateNow(agentId: string): Promise<UpdateCheck> {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) return { ok: false, error: "no agent paired" };
  if (!agentHub.isConnected(agent.id)) return { ok: false, error: "agent is not connected" };
  try {
    latest = await fetchLatestRelease();
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not check for releases: ${lastError}` };
  }
  if (!latest) return { ok: false, error: "no agent release has been published yet" };

  if (!isNewerVersion(latest.version, agent.version)) {
    db.update(agents)
      .set({
        updateStatus: "current",
        latestVersion: latest.version,
        lastUpdateError: null,
        updateCheckedAt: new Date(),
      })
      .where(eq(agents.id, agent.id))
      .run();
    return { ok: true, status: "current", version: agent.version, latestVersion: latest.version };
  }

  // Join an update that is already running (automatic, or an earlier click) instead of starting another.
  const running = db
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.agentId, agent.id),
        eq(commands.type, "update"),
        inArray(commands.status, ["pending", "sent"]),
        gt(commands.expiresAt, new Date()),
      ),
    )
    .get();
  const command = running ?? requestAgentUpdate(agent.id);
  const ack = await agentHub.waitForAck(command.id, UPDATE_WAIT_MS);
  if (!ack.ok) return { ok: false, error: ack.error ?? "update failed" };
  const latestVersion = typeof ack.result?.latestVersion === "string" ? ack.result.latestVersion : latest.version;
  return { ok: true, status: ack.result?.updated ? "updating" : "current", version: agent.version, latestVersion };
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
    const name = device?.name ?? agent.hostname ?? "agent";
    queueAgentUpdateEvent("agent_update_failed", {
      deviceId: agent.deviceId,
      device: name,
      title: `Agent update failed on ${name}`,
      message: `Agent on ${name} could not update: ${ack.error ?? "unknown error"}`,
      version: agent.version,
      error: ack.error,
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
