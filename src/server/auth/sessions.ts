import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { db } from "../db/client";
import { session } from "../db/schema";
import { describeUserAgent } from "../user-agent";

/** How often a session's last activity is written, so busy pages do not write on every request. */
export const ACTIVITY_INTERVAL_MS = 60_000;

type Activity = { id: string; lastActiveAt?: Date | null; lastIp?: string | null };

/** Records that the session was just used from `ip`. Returns whether a row was written. */
export function touchSession(current: Activity, ip: string | null, now = new Date()): boolean {
  const last = current.lastActiveAt ? new Date(current.lastActiveAt).getTime() : 0;
  const sameIp = !ip || ip === current.lastIp;
  if (sameIp && now.getTime() - last < ACTIVITY_INTERVAL_MS) return false;
  const values = ip ? { lastActiveAt: now, lastIp: ip } : { lastActiveAt: now };
  db.update(session).set(values).where(eq(session.id, current.id)).run();
  return true;
}

export type SessionView = {
  id: string;
  name: string;
  userAgent: string | null;
  ip: string | null;
  signedInAt: Date;
  lastActiveAt: Date;
  current: boolean;
};

/** Signed-in devices of a user: this one first, then the most recently used. */
export function listSessions(userId: string, currentId: string, now = new Date()): SessionView[] {
  return db
    .select()
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, now)))
    .all()
    .map((row) => ({
      id: row.id,
      name: describeUserAgent(row.userAgent),
      userAgent: row.userAgent || null,
      // Better Auth stores "" when no client IP header is present.
      ip: row.lastIp || row.ipAddress || null,
      signedInAt: row.createdAt,
      lastActiveAt: row.lastActiveAt ?? row.createdAt,
      current: row.id === currentId,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
}

/** Signs out the given devices, never the one making the request. Returns how many were removed. */
export function revokeSessions(userId: string, ids: string[], currentId: string): number {
  if (ids.length === 0) return 0;
  return db
    .delete(session)
    .where(and(eq(session.userId, userId), inArray(session.id, ids), ne(session.id, currentId)))
    .returning({ id: session.id })
    .all().length;
}

/** Signs out every device, including the one making the request. */
export function revokeAllSessions(userId: string): number {
  return db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id }).all().length;
}
