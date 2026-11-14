import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/client";
import { settings } from "./db/schema";

export const appSettingsSchema = z.object({
  pollIntervalSec: z.number().int().min(2).max(300).default(10),
  sampleIntervalSec: z.number().int().min(10).max(3600).default(60),
  devicePingIntervalSec: z.number().int().min(5).max(3600).default(30),
  wake: z
    .object({
      restoreDelaySec: z.number().int().min(0).max(3600).default(30),
      minBatteryPercent: z.number().int().min(0).max(100).default(25),
      clientTimeoutSec: z.number().int().min(30).max(86400).default(600),
      reattemptDelaySec: z.number().int().min(5).max(3600).default(30),
    })
    .default({ restoreDelaySec: 30, minBatteryPercent: 25, clientTimeoutSec: 600, reattemptDelaySec: 30 }),
  wolMode: z.enum(["auto", "server", "agent"]).default("auto"),
  wolBroadcast: z.string().default("255.255.255.255"),
  agentUpdateCheckMinutes: z.number().int().min(5).max(1440).default(15),
  eventRetentionDays: z.number().int().min(1).max(3650).default(90),
  sampleRetentionDays: z.number().int().min(1).max(365).default(30),
  templates: z.record(z.string(), z.object({ title: z.string(), body: z.string() })).default({}),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const KEY = "app";
let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const raw = row ? JSON.parse(row.value) : {};
  const parsed = appSettingsSchema.safeParse(raw);
  cache = parsed.success ? parsed.data : appSettingsSchema.parse({});
  return cache;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = appSettingsSchema.parse({ ...getSettings(), ...patch });
  const value = JSON.stringify(next);
  db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  cache = next;
  return next;
}
