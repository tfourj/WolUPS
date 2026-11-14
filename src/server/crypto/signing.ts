import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** Ed25519 helpers. Public keys travel as raw 32-byte base64url so the Go agent can use them directly. */

export type SigningKeyPair = { privateKey: KeyObject; publicKey: KeyObject; publicKeyRaw: string };

export function generateSigningKey(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, publicKeyRaw: exportPublicRaw(publicKey) };
}

export function exportPublicRaw(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw new Error("not an Ed25519 public key");
  return jwk.x;
}

export function importPublicRaw(raw: string): KeyObject {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" });
}

export function exportPrivatePem(key: KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

export function importPrivatePem(pem: string): SigningKeyPair {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyRaw: exportPublicRaw(publicKey) };
}

export function signMessage(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
}

export function verifyMessage(publicKey: KeyObject, message: string, signature: string): boolean {
  try {
    const sig = Buffer.from(signature, "base64url");
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(message, "utf8"), publicKey, sig);
  } catch {
    return false;
  }
}
