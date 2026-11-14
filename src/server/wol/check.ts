import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { devices } from "../db/schema";
import { agentHub } from "../agents/hub";
import { resolveIpv4 } from "../net/resolve";
import { getSettings } from "../settings";
import { cidrContains } from "./cidr";
import { relayCandidates, sendFromServer, serverNetworks } from "./send";

/** A magic packet for this MAC wakes nothing, so it can be sent to test the path safely. */
const TEST_MAC = "00:00:00:00:00:00";

export type WakeCheck = {
  ok: boolean;
  mode: "auto" | "server" | "agent";
  mac: string | null;
  ip: string | null;
  server: { used: boolean; networks: string[]; sameNetwork: boolean; sendError: string | null };
  relays: { name: string; sameSubnet: boolean; sendError: string | null; tested: boolean }[];
  problems: string[];
};

/**
 * Check whether a wake packet can reach a device: whether the server sits on its network,
 * which connected agents can relay, and whether each sender can actually send a test packet.
 */
export async function checkWake(deviceId: string): Promise<WakeCheck | null> {
  const device = db.select().from(devices).where(eq(devices.id, deviceId)).get();
  if (!device) return null;
  const { wolMode, wolBroadcast } = getSettings();
  const ip = await resolveIpv4(device.host);
  const problems: string[] = [];
  if (!device.mac) problems.push("The device has no MAC address.");
  if (!device.host) problems.push("The device has no host or IP, so WolUPS cannot tell which network it is on.");
  else if (!ip) problems.push(`${device.host} could not be resolved to an IPv4 address.`);

  const networks = serverNetworks();
  const server = {
    used: wolMode !== "agent",
    networks,
    sameNetwork: !!ip && networks.some((n) => cidrContains(n, ip)),
    sendError: null as string | null,
  };
  if (server.used) {
    server.sendError = await sendFromServer(TEST_MAC, wolBroadcast, ip);
  }

  const relays: WakeCheck["relays"] = [];
  if (wolMode !== "server") {
    const candidates = relayCandidates(device, ip);
    // Test the relay that would be used first: the best same-subnet agent.
    for (const [index, relay] of candidates.entries()) {
      const entry = { name: relay.name, sameSubnet: relay.sameSubnet, sendError: null as string | null, tested: false };
      if (index === 0) {
        const args = { mac: TEST_MAC, broadcast: relay.broadcast };
        const ack = await agentHub.sendAndWait(relay.agentId, "wol", args, 10_000);
        entry.tested = true;
        if (!ack.ok) entry.sendError = ack.error ?? "failed";
      }
      relays.push(entry);
    }
  }

  const serverWorks = server.used && server.sameNetwork && !server.sendError;
  const relayWorks = relays.some((r) => r.tested && !r.sendError && (r.sameSubnet || !ip));
  if (server.used && ip && !server.sameNetwork) {
    problems.push(
      `The server is not on ${ip}'s network (it sees ${networks.join(", ") || "no networks"}). ` +
        "Use network_mode: host, or rely on a relay agent.",
    );
  }
  if (server.sendError) problems.push(`The server could not send a broadcast: ${server.sendError}`);
  if (wolMode !== "server" && relays.length === 0) problems.push("No other agent is connected to relay wake packets.");
  else if (wolMode !== "server" && ip && !relays.some((r) => r.sameSubnet)) {
    problems.push(`No connected agent is on ${ip}'s subnet.`);
  }
  const failedRelay = relays.find((r) => r.sendError);
  if (failedRelay) problems.push(`Agent ${failedRelay.name} could not send: ${failedRelay.sendError}`);

  return {
    ok: !!device.mac && (serverWorks || relayWorks),
    mode: wolMode,
    mac: device.mac,
    ip,
    server,
    relays,
    problems,
  };
}
