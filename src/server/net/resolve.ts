import { lookup } from "node:dns/promises";
import { isIpv4 } from "../wol/cidr";

/** Resolve a host to an IPv4 address; IPv4 literals are returned as they are. */
export async function resolveIpv4(host: string | null | undefined): Promise<string | null> {
  const value = host?.trim();
  if (!value) return null;
  if (isIpv4(value)) return value;
  try {
    return (await lookup(value, { family: 4 })).address;
  } catch {
    return null;
  }
}
