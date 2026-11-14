function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

export function isIpv4(value: string): boolean {
  return ipv4ToInt(value) !== null;
}

/** Parse "192.168.1.10/24" into network info. */
export function parseCidr(cidr: string): { network: number; mask: number; broadcast: string } | null {
  const [ip, bitsRaw] = cidr.split("/");
  const addr = ipv4ToInt(ip ?? "");
  const bits = Number(bitsRaw);
  if (addr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (addr & mask) >>> 0;
  const bcast = (network | (~mask >>> 0)) >>> 0;
  const broadcast = [24, 16, 8, 0].map((shift) => (bcast >>> shift) & 255).join(".");
  return { network, mask, broadcast };
}

export function cidrContains(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  const addr = ipv4ToInt(ip);
  if (!parsed || addr === null) return false;
  return ((addr & parsed.mask) >>> 0) === parsed.network;
}
