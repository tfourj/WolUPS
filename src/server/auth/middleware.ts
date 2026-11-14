import type { MiddlewareHandler } from "hono";
import { clientIp } from "../client-ip";
import { auth, type Session } from "./auth";
import { touchSession } from "./sessions";

export type AuthVars = { Variables: { session: Session } };

/** Rejects API requests without a valid session and notes when and from where it was used. */
export const requireSession: MiddlewareHandler<AuthVars> = async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) return c.json({ error: "Unauthorized" }, 401);
  const ip = clientIp(c);
  touchSession(result.session, ip === "unknown" ? null : ip);
  c.set("session", result);
  await next();
};
