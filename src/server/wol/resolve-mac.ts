import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices } from "../db/schema";
import { agentHub } from "../agents/hub";
import { cidrContains, isIpv4 } from "./cidr";
import { normalizeMac } from "./magic";

export type MacLookup = { ok: true; mac: string; ip: string; via: string } | { ok: false; error: string };

/** Find the MAC in a /proc/net/arp style table, skipping incomplete entries. */
export function parseArpTable(table: string, ip: string): string | null {
  for (const line of table.split("\n").slice(1)) {
    const [entryIp, , flags, hw] = line.trim().split(/\s+/);
    if (entryIp !== ip || flags === "0x0" || !hw) continue;
    const mac = normalizeMac(hw);
    if (mac && mac !== "00:00:00:00:00:00") return mac;
  }
  return null;
}

/** Find the MAC in macOS `arp -n` output, used only during development. */
export function parseArpCommand(output: string): string | null {
  const match = /\sat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\s/i.exec(output);
  if (!match) return null;
  const padded = match[1]
    .split(":")
    .map((p) => p.padStart(2, "0"))
    .join(":");
  return normalizeMac(padded);
}

function poke(ip: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.once("error", () => {
      socket.close();
      resolve();
    });
    socket.send(Buffer.from([0]), 9, ip, () => {
      socket.close();
      resolve();
    });
  });
}

async function readArp(ip: string): Promise<string | null> {
  if (process.platform === "linux") {
    return parseArpTable(await readFile("/proc/net/arp", "utf8").catch(() => ""), ip);
  }
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["arp", "-n", ip], { stdout: "pipe", stderr: "ignore" });
    return parseArpCommand(await new Response(proc.stdout).text());
  }
  return null;
}

/** The server's own ARP table. Only sees the LAN when the container uses host networking. */
async function fromServer(ip: string): Promise<string | null> {
  const known = await readArp(ip);
  if (known) return known;
  await poke(ip);
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(150);
    const mac = await readArp(ip);
    if (mac) return mac;
  }
  return null;
}

/**
 * Look up the MAC for a device's host. Tries, in order: the device's own agent (it reports its
 * interfaces), the server's ARP table, then a connected agent on the same subnet.
 */
export async function resolveMac(host: string, deviceId?: string): Promise<MacLookup> {
  let ip = host.trim();
  if (!isIpv4(ip)) {
    try {
      ip = (await lookup(ip, { family: 4 })).address;
    } catch {
      return { ok: false, error: `could not resolve ${host}` };
    }
  }

  if (deviceId) {
    const own = db.select().from(agents).where(eq(agents.deviceId, deviceId)).get();
    const iface = own?.interfaces?.find((i) => i.cidrs.some((c) => c.split("/")[0] === ip));
    const mac = iface && normalizeMac(iface.mac);
    if (mac) return { ok: true, mac, ip, via: "the device's agent" };
  }

  const fromArp = await fromServer(ip);
  if (fromArp) return { ok: true, mac: fromArp, ip, via: "the server" };

  const connected = agentHub.connectedAgentIds();
  const relays = connected.length
    ? db
        .select({ agent: agents, name: devices.name })
        .from(agents)
        .innerJoin(devices, eq(agents.deviceId, devices.id))
        .where(inArray(agents.id, connected))
        .all()
        .filter((r) => r.agent.interfaces?.some((i) => i.cidrs.some((c) => cidrContains(c, ip))))
    : [];
  const errors: string[] = [];
  for (const relay of relays.slice(0, 2)) {
    const ack = await agentHub.sendAndWait(relay.agent.id, "resolve_mac", { ip }, 6_000);
    const mac = typeof ack.result?.mac === "string" ? normalizeMac(ack.result.mac) : null;
    if (ack.ok && mac) return { ok: true, mac, ip, via: `agent ${relay.name}` };
    errors.push(`${relay.name}: ${ack.error ?? "no answer"}`);
  }

  if (relays.length === 0) {
    return { ok: false, error: `no MAC found for ${ip}. Use host networking or connect an agent on the same subnet.` };
  }
  return { ok: false, error: `no MAC found for ${ip} (${errors.join("; ")})` };
}
