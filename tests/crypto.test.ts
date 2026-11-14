import { describe, expect, test } from "bun:test";
import { createSecretBox, maskSecret } from "../src/server/crypto/secretbox";
import { generateSigningKey, importPublicRaw, signMessage, verifyMessage } from "../src/server/crypto/signing";
import { commandMessage, helloMessage, signCommand, verifyHello } from "../src/server/agents/protocol";

describe("secretbox", () => {
  const box = createSecretBox("test-secret-that-is-long-enough-123");

  test("round trips and uses a fresh IV each time", () => {
    const a = box.encrypt("hunter2");
    const b = box.encrypt("hunter2");
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe("hunter2");
    expect(box.decryptJson<{ x: number }>(box.encryptJson({ x: 1 }))).toEqual({ x: 1 });
  });

  test("rejects tampered ciphertext and the wrong key", () => {
    const sealed = box.encrypt("secret");
    const raw = Buffer.from(sealed.slice(3), "base64url");
    raw[15] ^= 1;
    expect(() => box.decrypt(`v1:${raw.toString("base64url")}`)).toThrow();
    expect(() => createSecretBox("another-secret-value-1234567890").decrypt(sealed)).toThrow();
  });

  test("masks secrets", () => {
    expect(maskSecret("abcdefghij")).toBe("••••••••ghij");
    expect(maskSecret("")).toBe("");
  });
});

describe("ed25519 signing", () => {
  test("verifies only the signed message with the right key", () => {
    const key = generateSigningKey();
    const other = generateSigningKey();
    const sig = signMessage(key.privateKey, "hello");
    expect(verifyMessage(importPublicRaw(key.publicKeyRaw), "hello", sig)).toBe(true);
    expect(verifyMessage(key.publicKey, "hellO", sig)).toBe(false);
    expect(verifyMessage(other.publicKey, "hello", sig)).toBe(false);
    expect(verifyMessage(key.publicKey, "hello", "garbage")).toBe(false);
  });

  test("public keys are raw 32 bytes for the Go agent", () => {
    expect(Buffer.from(generateSigningKey().publicKeyRaw, "base64url").length).toBe(32);
  });

  test("hello signatures expire and bind the nonce", () => {
    const agent = generateSigningKey();
    const now = Date.now();
    const sig = signMessage(agent.privateKey, helloMessage("a1", "n1", now));
    expect(verifyHello(agent.publicKey, "a1", "n1", now, sig, now)).toBe(true);
    expect(verifyHello(agent.publicKey, "a1", "n2", now, sig, now)).toBe(false);
    expect(verifyHello(agent.publicKey, "a1", "n1", now, sig, now + 10 * 60_000)).toBe(false);
  });

  test("command envelopes sign the exact payload string", () => {
    const server = generateSigningKey();
    const envelope = signCommand(server.privateKey, {
      v: 1,
      id: "c1",
      agentId: "a1",
      type: "shutdown",
      args: { reason: "battery" },
      issuedAt: 1,
      expiresAt: 2,
    });
    expect(verifyMessage(server.publicKey, commandMessage(envelope.payload), envelope.sig)).toBe(true);
    const tampered = envelope.payload.replace("shutdown", "update");
    expect(verifyMessage(server.publicKey, commandMessage(tampered), envelope.sig)).toBe(false);
  });
});
