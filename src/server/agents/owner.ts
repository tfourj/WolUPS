import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices, nutHosts } from "../db/schema";

type AgentRow = typeof agents.$inferSelect;

/** What an agent is paired with: a device (wolups-agent) or a NUT host (wolups-nut-agent). */
export type AgentOwner = { kind: "device"; id: string; name: string } | { kind: "nut"; id: string; name: string };

export function agentOwner(agent: Pick<AgentRow, "kind" | "deviceId" | "nutHostId" | "hostname">): AgentOwner | null {
  if (agent.kind === "nut" && agent.nutHostId) {
    const host = db.select().from(nutHosts).where(eq(nutHosts.id, agent.nutHostId)).get();
    return host ? { kind: "nut", id: host.id, name: host.name } : null;
  }
  if (agent.deviceId) {
    const device = db.select().from(devices).where(eq(devices.id, agent.deviceId)).get();
    return device ? { kind: "device", id: device.id, name: device.name } : null;
  }
  return null;
}

/** "Agent" or "NUT agent", as used in event messages. */
export function agentLabel(kind: AgentRow["kind"]): string {
  return kind === "nut" ? "NUT agent" : "Agent";
}

/** Display name for messages, falling back to the agent's hostname. */
export function ownerName(owner: AgentOwner | null, agent: Pick<AgentRow, "hostname">): string {
  return owner?.name ?? agent.hostname ?? "agent";
}

/** Event fields for an agent event: device events point at the device, NUT host events carry only the name. */
export function ownerEventDevice(owner: AgentOwner | null): string | null {
  return owner?.kind === "device" ? owner.id : null;
}

/** Record that the owner was just seen online or went offline. */
export function markOwnerSeen(owner: AgentOwner | null, online: boolean, at = new Date()) {
  if (!owner) return;
  if (owner.kind === "device") {
    // Devices only go offline through presence checks, an agent disconnect alone does not mean the machine is off.
    if (online) db.update(devices).set({ online: true, lastSeenAt: at }).where(eq(devices.id, owner.id)).run();
    return;
  }
  db.update(nutHosts)
    .set(online ? { online: true, lastSeenAt: at } : { online: false })
    .where(eq(nutHosts.id, owner.id))
    .run();
}
