import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../auth/middleware";
import { loginEvent } from "../auth/login-events";
import { listSessions, revokeAllSessions, revokeSessions } from "../auth/sessions";
import { clientIp } from "../client-ip";
import { db } from "../db/client";
import { channels, user } from "../db/schema";
import { buildMessage, sendToChannel } from "../notify/dispatcher";
import { DEFAULT_EVENT_SEVERITY } from "../../shared/events";
import { errorMessage, parseBody } from "./util";

export const securityRoutes = new Hono<AuthVars>();

/** Channels that deliver "login" events. */
export function loginChannelIds(): string[] {
  return db
    .select()
    .from(channels)
    .orderBy(asc(channels.name))
    .all()
    .filter((c) => c.events.includes("login"))
    .map((c) => c.id);
}

/** Subscribe exactly the given channels to "login" events and unsubscribe the rest. */
export function setLoginChannels(ids: string[]) {
  const wanted = new Set(ids);
  for (const channel of db.select().from(channels).all()) {
    const has = channel.events.includes("login");
    if (has === wanted.has(channel.id)) continue;
    const events = has ? channel.events.filter((e) => e !== "login") : [...channel.events, "login"];
    db.update(channels).set({ events, updatedAt: new Date() }).where(eq(channels.id, channel.id)).run();
  }
}

function view(userId: string) {
  const row = db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId)).get();
  return { twoFactorEnabled: row?.twoFactorEnabled ?? false, loginChannelIds: loginChannelIds() };
}

const channelIdsSchema = z.object({ channelIds: z.array(z.string()).max(100) });

securityRoutes.get("/", (c) => c.json(view(c.get("session").user.id)));

securityRoutes.patch("/login-channels", async (c) => {
  const body = await parseBody(c, channelIdsSchema);
  if (body instanceof Response) return body;
  setLoginChannels(body.channelIds);
  return c.json(view(c.get("session").user.id));
});

/** Send a sample sign-in, built from this request, to the given enabled channels. */
securityRoutes.post("/login-channels/test", async (c) => {
  const body = await parseBody(c, channelIdsSchema);
  if (body instanceof Response) return body;
  const targets = db
    .select()
    .from(channels)
    .orderBy(asc(channels.name))
    .all()
    .filter((ch) => ch.enabled && body.channelIds.includes(ch.id));
  if (targets.length === 0) return c.json({ error: "Pick at least one enabled channel" }, 400);

  const input = loginEvent({
    email: c.get("session").user.email,
    method: "password",
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });
  const event = {
    id: 0,
    type: "login",
    severity: DEFAULT_EVENT_SEVERITY.login,
    upsId: null,
    deviceId: null,
    title: `[Test] ${input.title}`,
    message: input.message,
    data: input.data ?? {},
    createdAt: new Date(),
  };
  const results = await Promise.all(
    targets.map(async (channel) => {
      try {
        await sendToChannel(channel, buildMessage(channel, event));
        return { id: channel.id, name: channel.name, ok: true, error: null };
      } catch (error) {
        return { id: channel.id, name: channel.name, ok: false, error: errorMessage(error) };
      }
    }),
  );
  return c.json({ results });
});

const sessionIdsSchema = z.object({ ids: z.array(z.string()).min(1).max(100) });

/** Devices signed in to the account. */
securityRoutes.get("/sessions", (c) => {
  const { user: owner, session: current } = c.get("session");
  return c.json(listSessions(owner.id, current.id));
});

/** Sign out the picked devices. The requesting device is skipped. */
securityRoutes.post("/sessions/revoke", async (c) => {
  const body = await parseBody(c, sessionIdsSchema);
  if (body instanceof Response) return body;
  const { user: owner, session: current } = c.get("session");
  revokeSessions(owner.id, body.ids, current.id);
  return c.json(listSessions(owner.id, current.id));
});

/** Sign out every device, including this one. */
securityRoutes.post("/sessions/revoke-all", (c) => {
  const revoked = revokeAllSessions(c.get("session").user.id);
  return c.json({ revoked });
});
