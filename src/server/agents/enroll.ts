import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices, enrollmentTokens } from "../db/schema";
import { importPublicRaw } from "../crypto/signing";
import { randomToken, sha256Hex } from "../crypto/secretbox";
import { serverSigningKey } from "../secrets";
import type { AgentInfo } from "./protocol";

export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** Create a one-time enrollment token for a device. Older unused tokens for the device are revoked. */
export function createEnrollmentToken(deviceId: string, now = new Date()) {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
  db.transaction((tx) => {
    tx.delete(enrollmentTokens)
      .where(and(eq(enrollmentTokens.deviceId, deviceId), isNull(enrollmentTokens.usedAt)))
      .run();
    tx.insert(enrollmentTokens).values({ deviceId, tokenHash: sha256Hex(token), expiresAt }).run();
  });
  return { token, expiresAt };
}

export class EnrollmentError extends Error {}

export type EnrollResult = {
  agentId: string;
  deviceId: string;
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
    const device = tx.select().from(devices).where(eq(devices.id, row.deviceId)).get();
    if (!device) throw new EnrollmentError("device no longer exists");
    const existing = tx.select().from(agents).where(eq(agents.deviceId, device.id)).get();

    if (row.usedAt) {
      if (existing && existing.publicKey === publicKey) {
        return { agentId: existing.id, deviceId: device.id, deviceName: device.name, serverPublicKey, replaced: false, retried: true };
      }
      throw new EnrollmentError("token already used");
    }

    tx.update(enrollmentTokens).set({ usedAt: now }).where(eq(enrollmentTokens.id, row.id)).run();
    if (existing) tx.delete(agents).where(eq(agents.id, existing.id)).run();
    const agent = tx
      .insert(agents)
      .values({
        deviceId: device.id,
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
    return { agentId: agent.id, deviceId: device.id, deviceName: device.name, serverPublicKey, replaced: !!existing, retried: false };
  });
}
