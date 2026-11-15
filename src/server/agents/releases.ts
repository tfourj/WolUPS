import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { agents, commands, type AgentKind } from "../db/schema";
import { env } from "../env";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import { isNewerVersion, parseVersion } from "../../shared/version";
import { agentHub } from "./hub";
import { agentOwner, ownerEventDevice, ownerName } from "./owner";
import { PROTOCOL_VERSION } from "./protocol";
import { queueAgentUpdateEvent } from "./update-events";

const log = createLogger("releases");

const UPDATE_TTL_MS = 10 * 60 * 1000;
/** After a failed automatic update, wait this long before trying the same release again. */
const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;

export type LatestRelease = { version: string; url: string; checkedAt: number } | null;

/** Release tags and manifests of each agent program. */
export const RELEASE_COMPONENTS: Record<AgentKind, { prefix: string; manifest: string; label: string }> = {
  device: { prefix: "agent-v", manifest: "agent-release.json", label: "Agent" },
  nut: { prefix: "nut-agent-v", manifest: "nut-agent-release.json", label: "NUT agent" },
};

const KINDS = Object.keys(RELEASE_COMPONENTS) as AgentKind[];

let latest: Record<AgentKind, LatestRelease> = { device: null, nut: null };
let lastErrors: Record<AgentKind, string | null> = { device: null, nut: null };
/** When releases were last looked up, whether or not anything was found. */
let lastCheckedAt: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function latestAgentRelease(kind: AgentKind = "device") {
  return { latest: latest[kind], error: lastErrors[kind], checkedAt: lastCheckedAt };
}

type GitHubRelease = { tag_name?: string; draft?: boolean; prerelease?: boolean };

/** Version of the newest stable <prefix>X.Y.Z release. Other components' releases are skipped. */
export function newestVersion(releases: GitHubRelease[], prefix: string): string | null {
  let best: string | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const tag = release.tag_name ?? "";
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    if (/^\d+\.\d+\.\d+$/.test(version) && (!best || isNewerVersion(version, best))) best = version;
  }
  return best;
}

/** Version of the newest stable agent-vX.Y.Z release. */
export function newestAgentVersion(releases: GitHubRelease[]): string | null {
  return newestVersion(releases, RELEASE_COMPONENTS.device.prefix);
}

const HEADERS = { "User-Agent": "wolups" };

async function readManifest(kind: AgentKind, latestVersion: string): Promise<NonNullable<LatestRelease>> {
  const { prefix, manifest } = RELEASE_COMPONENTS[kind];
  const tag = `${prefix}${latestVersion}`;
  const res = await fetch(`https://github.com/${env.agentRepo}/releases/download/${tag}/${manifest}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`could not read ${manifest} of ${tag} (GitHub returned ${res.status})`);
  const body = (await res.json()) as { version?: string; protocol_version?: number };
  const version = body.version ?? "";
  if (!parseVersion(version) || version !== latestVersion) {
    throw new Error(`${tag} has ${manifest} version ${version || "(missing)"}`);
  }
  if (body.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(
      `release v${version} uses agent protocol ${body.protocol_version}, this server needs ${PROTOCOL_VERSION}`,
    );
  }
  return { version, url: `https://github.com/${env.agentRepo}/releases/tag/${tag}`, checkedAt: Date.now() };
}

/**
 * Find the newest release of each agent program and read its manifest. Agent releases are never the repository's
 * latest release (server releases are), so this lists releases through the GitHub API: one unauthenticated call per
 * check for all agent programs, well within the hourly limit at the shortest check interval. A broken release of
 * one program does not stop the others.
 */
export async function fetchLatestReleases() {
  const list = await fetch(`https://api.github.com/repos/${env.agentRepo}/releases?per_page=100`, {
    headers: { ...HEADERS, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (list.status === 403 || list.status === 429) throw new Error("GitHub API rate limit reached, try again later");
  if (!list.ok) throw new Error(`GitHub returned ${list.status} listing releases of ${env.agentRepo}`);
  const releases = (await list.json()) as GitHubRelease[];
  const found = { ...latest };
  const errors: Record<AgentKind, string | null> = { device: null, nut: null };
  for (const kind of KINDS) {
    const version = newestVersion(releases, RELEASE_COMPONENTS[kind].prefix);
    try {
      found[kind] = version ? await readManifest(kind, version) : null;
    } catch (error) {
      errors[kind] = error instanceof Error ? error.message : String(error);
    }
  }
  return { releases: found, errors };
}

/** Run a release lookup and remember its outcome. Returns false when GitHub could not be asked at all. */
async function refreshReleases(): Promise<boolean> {
  lastCheckedAt = Date.now();
  try {
    const result = await fetchLatestReleases();
    latest = result.releases;
    lastErrors = result.errors;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastErrors = { device: message, nut: message };
    log.warn("agent release check failed", { error: message });
    return false;
  }
  for (const kind of KINDS) {
    if (lastErrors[kind]) log.warn("agent release check failed", { kind, error: lastErrors[kind] });
  }
  return true;
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
  const owner = agentOwner(agent);
  const name = ownerName(owner, agent);
  const { label } = RELEASE_COMPONENTS[agent.kind];
  if (agent.latestVersion !== release.version) {
    db.update(agents)
      .set({ latestVersion: release.version, updateCheckedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .run();
    queueAgentUpdateEvent("agent_update_available", {
      agentId: agent.id,
      deviceId: ownerEventDevice(owner),
      device: name,
      title: `${label} update available for ${name}`,
      message: `${label} v${release.version} is available for ${name} (running v${agent.version})`,
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
  if (!(await refreshReleases())) return;
  for (const agent of db.select().from(agents).all()) {
    const release = latest[agent.kind];
    if (release) handleAgentRelease(agent, release);
  }
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
  await refreshReleases();
  const error = lastErrors[agent.kind];
  if (error) return { ok: false, error: `could not check for releases: ${error}` };
  const release = latest[agent.kind];
  if (!release) return { ok: false, error: "no release of this agent has been published yet" };

  if (!isNewerVersion(release.version, agent.version)) {
    db.update(agents)
      .set({
        updateStatus: "current",
        latestVersion: release.version,
        lastUpdateError: null,
        updateCheckedAt: new Date(),
      })
      .where(eq(agents.id, agent.id))
      .run();
    return { ok: true, status: "current", version: agent.version, latestVersion: release.version };
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
  const latestVersion = typeof ack.result?.latestVersion === "string" ? ack.result.latestVersion : release.version;
  return { ok: true, status: ack.result?.updated ? "updating" : "current", version: agent.version, latestVersion };
}

// An agent that was offline during the last check updates as soon as it reconnects.
agentHub.onConnect((agentId) => {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  const release = agent ? latest[agent.kind] : null;
  if (agent && release) handleAgentRelease(agent, release);
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
    const owner = agentOwner(agent);
    const name = ownerName(owner, agent);
    const { label } = RELEASE_COMPONENTS[agent.kind];
    queueAgentUpdateEvent("agent_update_failed", {
      agentId: agent.id,
      deviceId: ownerEventDevice(owner),
      device: name,
      title: `${label} update failed on ${name}`,
      message: `${label} on ${name} could not update: ${ack.error ?? "unknown error"}`,
      version: agent.version,
      error: ack.error,
      data: { device: owner?.name, version: agent.version, error: ack.error },
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
