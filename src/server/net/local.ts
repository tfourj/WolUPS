import { networkInterfaces } from "node:os";
import type { AgentInterface } from "../db/schema";

/** The address the server uses for a NUT server on its own machine. */
export const LOOPBACK = "127.0.0.1";

/** "mac ip" for each IPv4 address of this machine's network interfaces. */
export function serverAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.internal || addr.family !== "IPv4" || addr.mac === "00:00:00:00:00:00") continue;
      out.add(`${addr.mac.toLowerCase()} ${addr.address}`);
    }
  }
  return out;
}

/**
 * Whether an agent runs on the same machine as the server: one of its interfaces has the same MAC and IPv4 address as
 * one of the server's. Under Docker this only holds with host networking.
 */
export function sameMachine(interfaces: AgentInterface[] | null | undefined, own = serverAddresses()): boolean {
  return (interfaces ?? []).some((iface) =>
    iface.cidrs.some((cidr) => own.has(`${iface.mac.toLowerCase()} ${cidr.split("/")[0]}`)),
  );
}
