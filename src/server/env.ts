import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "./logger";

const log = createLogger("env");

type StoredSecrets = { betterAuthSecret?: string; encryptionSecret?: string };

function loadStoredSecrets(file: string): StoredSecrets {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredSecrets;
  } catch (error) {
    log.error("could not read stored secrets", { file, error });
    return {};
  }
}

function resolveSecret(
  name: "BETTER_AUTH_SECRET" | "ENCRYPTION_SECRET",
  key: keyof StoredSecrets,
  stored: StoredSecrets,
): { value: string; generated: boolean } {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) log.warn(`${name} is shorter than 32 characters`);
    return { value: fromEnv, generated: false };
  }
  const existing = stored[key];
  if (existing) return { value: existing, generated: false };
  log.warn(`${name} not set, generating one and saving it in the data directory`);
  return { value: randomBytes(32).toString("base64url"), generated: true };
}

function normalizeBaseUrl(value: string | undefined, port: number): string {
  const raw = value?.trim() || `http://localhost:${port}`;
  return raw.replace(/\/+$/, "");
}

function loadEnv() {
  const port = Number(process.env.PORT ?? 4321);
  const dataDir = resolve(process.env.DATA_DIR ?? (existsSync("/data") ? "/data" : "./data"));
  mkdirSync(dataDir, { recursive: true });

  const secretsFile = join(dataDir, "secrets.json");
  const stored = loadStoredSecrets(secretsFile);
  const auth = resolveSecret("BETTER_AUTH_SECRET", "betterAuthSecret", stored);
  const enc = resolveSecret("ENCRYPTION_SECRET", "encryptionSecret", stored);

  if (auth.generated || enc.generated) {
    const next: StoredSecrets = { ...stored };
    if (auth.generated) next.betterAuthSecret = auth.value;
    if (enc.generated) next.encryptionSecret = enc.value;
    writeFileSync(secretsFile, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(secretsFile, 0o600);
  }

  if (!process.env.BASE_URL) log.warn("BASE_URL not set, agents and auth will use localhost");

  return {
    port,
    dataDir,
    dbPath: join(dataDir, "wolups.db"),
    baseUrl: normalizeBaseUrl(process.env.BASE_URL, port),
    betterAuthSecret: auth.value,
    encryptionSecret: enc.value,
    webDir: resolve(process.env.WEB_DIR ?? "./dist/web"),
    migrationsDir: resolve(process.env.MIGRATIONS_DIR ?? "./drizzle"),
    agentRepo: process.env.AGENT_REPO ?? "tfourj/WolUPS",
  };
}

export const env = loadEnv();
export type Env = typeof env;
