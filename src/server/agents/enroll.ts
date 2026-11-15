import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices, enrollmentTokens, nutHosts, type AgentKind } from "../db/schema";
import { importPublicRaw } from "../crypto/signing";
import { randomToken, sha256Hex } from "../crypto/secretbox";
import { serverSigningKey } from "../secrets";
import type { AgentInfo } from "./protocol";

export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** What a token pairs an agent with. */
export type EnrollmentTarget = { deviceId: string } | { nutHostId: string };

function targetFilter(target: EnrollmentTarget) {
  return "deviceId" in target
    ? eq(enrollmentTokens.deviceId, target.deviceId)
    : eq(enrollmentTokens.nutHostId, target.nutHostId);
}

/** Create a one-time enrollment token for a device or NUT host. Older unused tokens for it are revoked. */
export function createEnrollmentToken(target: EnrollmentTarget, now = new Date()) {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
  db.transaction((tx) => {
    tx.delete(enrollmentTokens)
      .where(and(targetFilter(target), isNull(enrollmentTokens.usedAt)))
      .run();
    tx.insert(enrollmentTokens).values({ ...target, tokenHash: sha256Hex(token), expiresAt }).run();
  });
  return { token, expiresAt };
}

export class EnrollmentError extends Error {}

export type EnrollResult = {
  agentId: string;
  kind: AgentKind;
  /** The device id for device agents. */
  deviceId: string | null;
  nutHostId: string | null;
  /** Name of the device or NUT host. */
  deviceName: string;
  serverPublicKey: string;
  replaced: boolean;
  retried: boolean;
};

/**
 * Redeem a token. A retry from the same key after the token was used succeeds,
 * so an interrupted HTTPS response does not strand the installer.
 */
export function redeemEnrollment(token: string, publicKey: string, info: AgentInfo, now = new Date()): EnrollResult {
  importPublicRaw(publicKey);
  const serverPublicKey = serverSigningKey().publicKeyRaw;
  return db.transaction((tx) => {
    const row = tx.select().from(enrollmentTokens).where(eq(enrollmentTokens.tokenHash, sha256Hex(token))).get();
    if (!row || row.expiresAt.getTime() < now.getTime()) throw new EnrollmentError("invalid or expired token");

    let owner: { kind: AgentKind; deviceId: string | null; nutHostId: string | null; name: string };
    if (row.nutHostId) {
      const host = tx.select().from(nutHosts).where(eq(nutHosts.id, row.nutHostId)).get();
      if (!host) throw new EnrollmentError("NUT host no longer exists");
      owner = { kind: "nut", deviceId: null, nutHostId: host.id, name: host.name };
    } else {
      const device = row.deviceId ? tx.select().from(devices).where(eq(devices.id, row.deviceId)).get() : undefined;
      if (!device) throw new EnrollmentError("device no longer exists");
      owner = { kind: "device", deviceId: device.id, nutHostId: null, name: device.name };
    }
    const existing = tx
      .select()
      .from(agents)
      .where(owner.nutHostId ? eq(agents.nutHostId, owner.nutHostId) : eq(agents.deviceId, owner.deviceId!))
      .get();
    const result = (agentId: string, replaced: boolean, retried: boolean): EnrollResult => ({
      agentId,
      kind: owner.kind,
      deviceId: owner.deviceId,
      nutHostId: owner.nutHostId,
      deviceName: owner.name,
      serverPublicKey,
      replaced,
      retried,
    });

    if (row.usedAt) {
      if (existing && existing.publicKey === publicKey) return result(existing.id, false, true);
      throw new EnrollmentError("token already used");
    }

    tx.update(enrollmentTokens).set({ usedAt: now }).where(eq(enrollmentTokens.id, row.id)).run();
    if (existing) tx.delete(agents).where(eq(agents.id, existing.id)).run();
    const agent = tx
      .insert(agents)
      .values({
        kind: owner.kind,
        deviceId: owner.deviceId,
        nutHostId: owner.nutHostId,
        publicKey,
        version: info.version,
        os: info.os,
        arch: info.arch,
        hostname: info.hostname,
        interfaces: info.interfaces,
        // New agents update automatically; re-pairing keeps the previous agent's choice.
        autoUpdate: existing?.autoUpdate ?? true,
        enrolledAt: now,
      })
      .returning()
      .get();
    return result(agent.id, !!existing, false);
  });
}
