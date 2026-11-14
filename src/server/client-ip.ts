import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

/**
 * Client IP for rate limiting and logs. WolUPS is meant to sit behind a reverse proxy
 * (Coolify, Cloudflare), so forwarded headers are trusted when present.
 */
export function clientIp(c: Context): string {
  const headers = c.req.raw.headers;
  const forwarded =
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Copy of the request with a single trusted client IP header for Better Auth. */
export function withClientIp(c: Context): Request {
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-wolups-client-ip", clientIp(c));
  return new Request(c.req.raw, { headers });
}
