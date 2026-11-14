import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { redeemEnrollment, EnrollmentError } from "../agents/enroll";
import { agentHub } from "../agents/hub";
import { enrollRequestSchema } from "../agents/protocol";
import { clientIp } from "../client-ip";
import { emitEvent } from "../events";
import { createLogger } from "../logger";

const log = createLogger("enroll");

/** Unauthenticated agent endpoints. Enrollment needs a one-time token; the socket needs a signed hello. */
export const agentPublicRoutes = new Hono();

const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

agentPublicRoutes.post("/enroll", async (c) => {
  const ip = clientIp(c);
  if (rateLimited(ip)) return c.json({ error: "too many attempts" }, 429);
  const parsed = enrollRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid request" }, 400);
  try {
    const result = redeemEnrollment(parsed.data.token, parsed.data.publicKey, parsed.data.info);
    log.info("agent enrolled", { device: result.deviceName, agentId: result.agentId, ip, retried: result.retried });
    if (!result.retried) emitEvent({
      type: "agent_enrolled",
      deviceId: result.deviceId,
      title: `${result.deviceName} paired`,
      message: `Agent on ${parsed.data.info.hostname} paired with ${result.deviceName} (v${parsed.data.info.version})`,
      data: { device: result.deviceName, version: parsed.data.info.version },
    });
    return c.json({
      agentId: result.agentId,
      deviceName: result.deviceName,
      serverPublicKey: result.serverPublicKey,
    });
  } catch (error) {
    if (error instanceof EnrollmentError) {
      log.warn("enrollment rejected", { ip, reason: error.message });
      return c.json({ error: error.message }, 403);
    }
    log.error("enrollment failed", { error });
    return c.json({ error: "enrollment failed" }, 500);
  }
});

agentPublicRoutes.get(
  "/ws",
  upgradeWebSocket((c) => agentHub.handlers(clientIp(c))),
);
