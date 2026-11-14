import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;
const ts = () => integer({ mode: "timestamp_ms" });
const bool = () => integer({ mode: "boolean" });
const uuid = () => text().primaryKey().$defaultFn(() => crypto.randomUUID());

// Better Auth core tables (model names: user, session, account, verification)

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: bool().notNull().default(false),
  image: text(),
  twoFactorEnabled: bool().notNull().default(false),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const session = sqliteTable("session", {
  id: text().primaryKey(),
  expiresAt: ts().notNull(),
  token: text().notNull().unique(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
  ipAddress: text(),
  userAgent: text(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: ts(),
  refreshTokenExpiresAt: ts(),
  scope: text(),
  password: text(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const verification = sqliteTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: ts().notNull(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

// Better Auth two-factor plugin. The secret and backup codes are encrypted with BETTER_AUTH_SECRET.
export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: bool().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: ts(),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

// App tables

export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const ups = sqliteTable("ups", {
  id: uuid(),
  name: text().notNull(),
  host: text().notNull(),
  port: integer().notNull().default(3493),
  upsName: text().notNull(),
  username: text(),
  passwordEnc: text(),
  enabled: bool().notNull().default(true),
  reachable: bool().notNull().default(false),
  status: text(),
  battery: integer(),
  runtime: integer(),
  load: integer(),
  inputVoltage: real(),
  model: text(),
  lastPolledAt: ts(),
  lastError: text(),
  createdAt: ts().notNull().default(now),
});

export const upsSamples = sqliteTable(
  "ups_samples",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    upsId: text()
      .notNull()
      .references(() => ups.id, { onDelete: "cascade" }),
    ts: ts().notNull(),
    status: text(),
    battery: integer(),
    runtime: integer(),
    load: integer(),
    inputVoltage: real(),
  },
  (t) => [index("ups_samples_ups_ts_idx").on(t.upsId, t.ts)],
);

export const outages = sqliteTable(
  "outages",
  {
    id: uuid(),
    upsId: text()
      .notNull()
      .references(() => ups.id, { onDelete: "cascade" }),
    startedAt: ts().notNull(),
    endedAt: ts(),
    minBattery: integer(),
    lowBattery: bool().notNull().default(false),
  },
  (t) => [index("outages_ups_idx").on(t.upsId, t.endedAt)],
);

export const devices = sqliteTable("devices", {
  id: uuid(),
  name: text().notNull(),
  host: text(),
  mac: text(),
  upsId: text().references(() => ups.id, { onDelete: "set null" }),
  enabled: bool().notNull().default(true),
  shutdownEnabled: bool().notNull().default(false),
  shutdownBatteryPercent: integer().notNull().default(20),
  shutdownRuntimeSec: integer(),
  wakeEnabled: bool().notNull().default(true),
  alwaysWake: bool().notNull().default(false),
  // Per-device wake conditions; null uses the global wake settings.
  wakeDelaySec: integer(),
  wakeMinBatteryPercent: integer(),
  online: bool().notNull().default(false),
  // Set when the device accepts a shutdown; cleared once it is really off (or after a timeout).
  shuttingDownSince: ts(),
  lastSeenAt: ts(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const outageDevices = sqliteTable(
  "outage_devices",
  {
    outageId: text()
      .notNull()
      .references(() => outages.id, { onDelete: "cascade" }),
    deviceId: text()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    wasOnline: bool().notNull().default(false),
    shutdownCommandId: text(),
    shutdownSentAt: ts(),
    shutdownAckedAt: ts(),
    shutdownError: text(),
    shutdownFailureNotified: bool().notNull().default(false),
    wakeAttempts: integer().notNull().default(0),
    firstWakeAt: ts(),
    lastWakeAt: ts(),
    recoveredAt: ts(),
    wakeGaveUpAt: ts(),
  },
  (t) => [primaryKey({ columns: [t.outageId, t.deviceId] })],
);

export const agents = sqliteTable("agents", {
  id: uuid(),
  deviceId: text()
    .notNull()
    .unique()
    .references(() => devices.id, { onDelete: "cascade" }),
  publicKey: text().notNull(),
  version: text(),
  os: text(),
  arch: text(),
  hostname: text(),
  interfaces: text({ mode: "json" }).$type<AgentInterface[]>(),
  connected: bool().notNull().default(false),
  lastSeenAt: ts(),
  enrolledAt: ts().notNull().default(now),
  // Enrollment turns this on for new agents. The column default stays false to avoid rebuilding the table.
  autoUpdate: bool().notNull().default(false),
  updateStatus: text(),
  latestVersion: text(),
  lastUpdateError: text(),
  updateCheckedAt: ts(),
});

export type AgentInterface = { name: string; mac: string; cidrs: string[] };

export const enrollmentTokens = sqliteTable("enrollment_tokens", {
  id: uuid(),
  deviceId: text()
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  tokenHash: text().notNull().unique(),
  expiresAt: ts().notNull(),
  usedAt: ts(),
  createdAt: ts().notNull().default(now),
});

export const commands = sqliteTable(
  "commands",
  {
    id: uuid(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    type: text().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    outageId: text(),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    createdAt: ts().notNull().default(now),
    sentAt: ts(),
    ackedAt: ts(),
    expiresAt: ts().notNull(),
    error: text(),
  },
  (t) => [index("commands_agent_status_idx").on(t.agentId, t.status)],
);

export const events = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    severity: text().notNull().default("info"),
    upsId: text(),
    deviceId: text(),
    title: text().notNull(),
    message: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: ts().notNull().default(now),
  },
  (t) => [index("events_created_idx").on(t.createdAt), index("events_type_idx").on(t.type)],
);

export const channels = sqliteTable("channels", {
  id: uuid(),
  name: text().notNull(),
  type: text().notNull(),
  configEnc: text().notNull(),
  enabled: bool().notNull().default(true),
  events: text({ mode: "json" }).$type<string[]>().notNull(),
  upsIds: text({ mode: "json" }).$type<string[] | null>(),
  deviceIds: text({ mode: "json" }).$type<string[] | null>(),
  titleTemplate: text(),
  bodyTemplate: text(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    eventId: integer()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channelId: text()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts(),
    lastError: text(),
    deliveredAt: ts(),
    createdAt: ts().notNull().default(now),
  },
  (t) => [index("deliveries_status_idx").on(t.status, t.nextAttemptAt), index("deliveries_event_idx").on(t.eventId)],
);

export const deliveryAttempts = sqliteTable("delivery_attempts", {
  id: integer().primaryKey({ autoIncrement: true }),
  deliveryId: integer()
    .notNull()
    .references(() => deliveries.id, { onDelete: "cascade" }),
  attempt: integer().notNull(),
  ok: bool().notNull(),
  error: text(),
  durationMs: integer(),
  createdAt: ts().notNull().default(now),
});
