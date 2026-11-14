import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { settings } from "./db/schema";
import { env } from "./env";
import { createSecretBox } from "./crypto/secretbox";
import { exportPrivatePem, generateSigningKey, importPrivatePem, type SigningKeyPair } from "./crypto/signing";

export const box = createSecretBox(env.encryptionSecret);

const SIGNING_KEY = "server_signing_key";
let cached: SigningKeyPair | null = null;

/** Server Ed25519 key used to sign every command sent to agents. Stored encrypted in the settings table. */
export function serverSigningKey(): SigningKeyPair {
  if (cached) return cached;
  const row = db.select().from(settings).where(eq(settings.key, SIGNING_KEY)).get();
  if (row) {
    cached = importPrivatePem(box.decrypt(JSON.parse(row.value) as string));
    return cached;
  }
  const pair = generateSigningKey();
  const value = JSON.stringify(box.encrypt(exportPrivatePem(pair.privateKey)));
  db.insert(settings).values({ key: SIGNING_KEY, value }).onConflictDoNothing().run();
  cached = pair;
  return cached;
}
