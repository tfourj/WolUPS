import { agents } from "../db/schema";
import { isNewerVersion } from "../../shared/version";
import { agentHub } from "./hub";
import { latestAgentRelease } from "./releases";

type AgentRow = typeof agents.$inferSelect;

/** An agent for the UI: no public key, live connection state and whether a newer release exists. */
export function serializeAgent(agent: AgentRow | null | undefined) {
  if (!agent) return null;
  const { publicKey, ...rest } = agent;
  const latest = latestAgentRelease(agent.kind).latest?.version ?? agent.latestVersion;
  return {
    ...rest,
    connected: agentHub.isConnected(agent.id),
    keyFingerprint: publicKey.slice(0, 12),
    latestVersion: latest ?? null,
    updateAvailable: isNewerVersion(latest, agent.version),
  };
}
