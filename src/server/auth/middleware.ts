import type { MiddlewareHandler } from "hono";
import { auth, type Session } from "./auth";

export type AuthVars = { Variables: { session: Session } };

/** Rejects API requests without a valid session. */
export const requireSession: MiddlewareHandler<AuthVars> = async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) return c.json({ error: "Unauthorized" }, 401);
  c.set("session", result);
  await next();
};
