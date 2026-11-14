import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

export function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "wolups", "wolups-secretbox-v1", 32));
}

export function createSecretBox(secret: string) {
  const key = deriveKey(secret);

  function encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${Buffer.concat([iv, body, tag]).toString("base64url")}`;
  }

  function decrypt(payload: string): string {
    const [version, data] = payload.split(":", 2);
    if (version !== VERSION || !data) throw new Error("unsupported ciphertext format");
    const raw = Buffer.from(data, "base64url");
    if (raw.length < 28) throw new Error("ciphertext too short");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const body = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  return {
    encrypt,
    decrypt,
    encryptJson: (value: unknown) => encrypt(JSON.stringify(value)),
    decryptJson: <T>(payload: string) => JSON.parse(decrypt(payload)) as T,
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Mask a secret for display, keeping only the last few characters. */
export function maskSecret(value: string | null | undefined, visible = 4): string {
  if (!value) return "";
  if (value.length <= visible) return "•".repeat(value.length);
  return `${"•".repeat(8)}${value.slice(-visible)}`;
}
