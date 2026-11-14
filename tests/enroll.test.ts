import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/server/db/client";
import { agents, devices } from "../src/server/db/schema";
import { createEnrollmentToken, EnrollmentError, redeemEnrollment } from "../src/server/agents/enroll";
import { generateSigningKey } from "../src/server/crypto/signing";

const info = { version: "1.0.0", protocol: 1, os: "linux", arch: "amd64", hostname: "pve", interfaces: [] };
let deviceId: string;

beforeEach(() => {
  deviceId = db.insert(devices).values({ name: `dev-${crypto.randomUUID()}` }).returning().get().id;
});

describe("agent enrollment", () => {
  test("a token pairs one agent and can be retried with the same key only", () => {
    const { token } = createEnrollmentToken(deviceId);
    const key = generateSigningKey().publicKeyRaw;
    const first = redeemEnrollment(token, key, info);
    expect(first.deviceId).toBe(deviceId);
    expect(first.retried).toBe(false);

    const retry = redeemEnrollment(token, key, info);
    expect(retry.agentId).toBe(first.agentId);
    expect(retry.retried).toBe(true);

    expect(() => redeemEnrollment(token, generateSigningKey().publicKeyRaw, info)).toThrow(EnrollmentError);
  });

  test("expired and unknown tokens are rejected", () => {
    const { token } = createEnrollmentToken(deviceId, new Date(Date.now() - 60 * 60_000));
    expect(() => redeemEnrollment(token, generateSigningKey().publicKeyRaw, info)).toThrow("invalid or expired");
    expect(() => redeemEnrollment("x".repeat(43), generateSigningKey().publicKeyRaw, info)).toThrow(EnrollmentError);
  });

  test("a new token revokes the previous one and re-pairing replaces the agent", () => {
    const old = createEnrollmentToken(deviceId);
    const fresh = createEnrollmentToken(deviceId);
    expect(() => redeemEnrollment(old.token, generateSigningKey().publicKeyRaw, info)).toThrow(EnrollmentError);

    const firstAgent = redeemEnrollment(fresh.token, generateSigningKey().publicKeyRaw, info);
    const again = createEnrollmentToken(deviceId);
    const secondAgent = redeemEnrollment(again.token, generateSigningKey().publicKeyRaw, info);
    expect(secondAgent.replaced).toBe(true);
    expect(secondAgent.agentId).not.toBe(firstAgent.agentId);
    const rows = db.select().from(agents).all().filter((a) => a.deviceId === deviceId);
    expect(rows.length).toBe(1);
  });

  test("rejects malformed public keys", () => {
    const { token } = createEnrollmentToken(deviceId);
    expect(() => redeemEnrollment(token, "not-a-key", info)).toThrow();
  });
});
