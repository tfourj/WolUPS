import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices } from "../db/schema";
import { agentHub } from "../agents/hub";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import { resolveIpv4 } from "../net/resolve";
import { cidrContains, parseCidr } from "./cidr";
import { sendMagicPacket } from "./magic";

const log = createLogger("wol");

type DeviceRow = typeof devices.$inferSelect;

export type WakeResult = { ok: boolean; via: string[]; errors: string[] };

export type Relay = { agentId: string; name: string; broadcast: string; sameSubnet: boolean };

/** Connected agents that can send a wake packet for this device, same-subnet agents first. */
export function relayCandidates(target: DeviceRow, ip: string | null): Relay[] {
  const connected = agentHub.connectedAgentIds();
  if (connected.length === 0) return [];
  const rows = db
    .select({ agent: agents, name: devices.name })
    .from(agents)
    .innerJoin(devices, eq(agents.deviceId, devices.id))
    .where(inArray(agents.id, connected))
    .all()
    .filter((r) => r.agent.deviceId !== target.id);

  const sameSubnet: Relay[] = [];
  const others: Relay[] = [];
  for (const { agent, name } of rows) {
    const cidr = ip ? agent.interfaces?.flatMap((i) => i.cidrs).find((c) => cidrContains(c, ip)) : undefined;
    if (cidr) {
      sameSubnet.push({ agentId: agent.id, name, broadcast: parseCidr(cidr)?.broadcast ?? "", sameSubnet: true });
    }
    else others.push({ agentId: agent.id, name, broadcast: "", sameSubnet: false });
  }
  return [...sameSubnet, ...others];
}

/**
 * Send a wake packet. In "auto" mode the server broadcasts itself (works on host networking)
 * and one relay agent sends it too; duplicate packets are harmless.
 */
export async function wakeDevice(device: DeviceRow): Promise<WakeResult> {
  if (!device.mac) return { ok: false, via: [], errors: ["device has no MAC address"] };
  const { wolMode, wolBroadcast } = getSettings();
  const result: WakeResult = { ok: false, via: [], errors: [] };

  if (wolMode !== "agent") {
    try {
      await sendMagicPacket(device.mac, wolBroadcast);
      result.via.push("server");
    } catch (error) {
      result.errors.push(`server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (wolMode !== "server") {
    const ip = await resolveIpv4(device.host);
    for (const relay of relayCandidates(device, ip).slice(0, 2)) {
      const args = { mac: device.mac, broadcast: relay.broadcast };
      const ack = await agentHub.sendAndWait(relay.agentId, "wol", args, 10_000);
      if (ack.ok) {
        result.via.push(`agent ${relay.name}`);
        break;
      }
      result.errors.push(`agent ${relay.name}: ${ack.error ?? "failed"}`);
    }
    if (wolMode === "agent" && result.via.length === 0 && result.errors.length === 0) {
      result.errors.push("no connected agent available to relay the wake packet");
    }
  }

  result.ok = result.via.length > 0;
  log.info("wake packet", { device: device.name, via: result.via, errors: result.errors });
  return result;
}
