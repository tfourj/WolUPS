import type { EventType, Severity } from "@shared/events";
import type { ChannelType } from "@shared/channels";
import type { TimePreferences } from "@shared/time";

export type Outage = {
  id: string;
  upsId: string;
  startedAt: string;
  endedAt: string | null;
  minBattery: number | null;
  lowBattery: boolean;
};

export type Ups = {
  id: string;
  name: string;
  host: string;
  port: number;
  upsName: string;
  username: string | null;
  hasPassword: boolean;
  enabled: boolean;
  reachable: boolean;
  status: string | null;
  battery: number | null;
  runtime: number | null;
  load: number | null;
  inputVoltage: number | null;
  model: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
  lastOutage: Outage | null;
};

export type UpsSnapshot = {
  status: string;
  flags: string[];
  onBattery: boolean;
  onLine: boolean;
  lowBattery: boolean;
  battery: number | null;
  runtime: number | null;
  load: number | null;
  inputVoltage: number | null;
  model: string | null;
};

export type Sample = { ts: string; battery: number | null; runtime: number | null; load: number | null; status: string | null };

export type Agent = {
  id: string;
  deviceId: string;
  version: string | null;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  interfaces: { name: string; mac: string; cidrs: string[] }[] | null;
  connected: boolean;
  lastSeenAt: string | null;
  enrolledAt: string;
  autoUpdate: boolean;
  updateStatus: string | null;
  latestVersion: string | null;
  lastUpdateError: string | null;
  updateAvailable: boolean;
  keyFingerprint: string;
};

export type Device = {
  id: string;
  name: string;
  host: string | null;
  mac: string | null;
  upsId: string | null;
  upsName: string | null;
  enabled: boolean;
  shutdownEnabled: boolean;
  shutdownBatteryPercent: number;
  shutdownRuntimeSec: number | null;
  wakeEnabled: boolean;
  alwaysWake: boolean;
  wakeDelaySec: number | null;
  wakeMinBatteryPercent: number | null;
  online: boolean;
  shuttingDownSince: string | null;
  lastSeenAt: string | null;
  agent: Agent | null;
};

export type Delivery = {
  id: number;
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  status: "pending" | "success" | "failed";
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
};

export type EventItem = {
  id: number;
  type: EventType;
  severity: Severity;
  upsId: string | null;
  deviceId: string | null;
  upsName: string | null;
  deviceName: string | null;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
  deliveries?: Delivery[];
};

export type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  events: EventType[];
  upsIds: string[] | null;
  deviceIds: string[] | null;
  titleTemplate: string | null;
  bodyTemplate: string | null;
  config: Record<string, string | number>;
  secretsSet: Record<string, boolean>;
};

export type Overview = {
  ups: Ups[];
  counts: {
    ups: number;
    upsOnBattery: number;
    devices: number;
    devicesOnline: number;
    agents: number;
    agentsConnected: number;
    outages30d: number;
    activeOutages: number;
    eventsToday: number;
  };
  lastOutage: Outage | null;
  recentEvents: EventItem[];
};

export type AppSettings = {
  pollIntervalSec: number;
  sampleIntervalSec: number;
  devicePingIntervalSec: number;
  wake: { restoreDelaySec: number; minBatteryPercent: number; clientTimeoutSec: number; reattemptDelaySec: number };
  wolMode: "auto" | "server" | "agent";
  wolBroadcast: string;
  agentUpdateCheckMinutes: number;
  eventRetentionDays: number;
  sampleRetentionDays: number;
  time: TimePreferences;
  templates: Record<string, { title: string; body: string }>;
};

export type SystemInfo = {
  version: string;
  /** Short commit for builds that are not a stable release. */
  commit: string | null;
  baseUrl: string;
  agentRepo: string;
  timezone: string;
  latestAgent: { version: string; url: string; checkedAt: number } | null;
  latestAgentError: string | null;
};

export type SecurityStatus = { twoFactorEnabled: boolean; loginChannelIds: string[] };

export type SignedInDevice = {
  id: string;
  name: string;
  userAgent: string | null;
  ip: string | null;
  signedInAt: string;
  lastActiveAt: string;
  current: boolean;
};

export type LoginTestResult = { results: { id: string; name: string; ok: boolean; error: string | null }[] };
