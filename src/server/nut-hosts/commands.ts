import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { agents, commands, nutHosts } from "../db/schema";
import { agentHub, type AckResult } from "../agents/hub";
import type { NutCommandType } from "../agents/protocol";

/** How long each NUT command may take before the server stops waiting. */
export const NUT_TIMEOUTS: Record<NutCommandType, number> = {
  nut_detect: 30_000,
  nut_install: 10 * 60_000,
  nut_scan: 3 * 60_000,
  nut_apply: 2 * 60_000,
  nut_service: 60_000,
  nut_status: 30_000,
  nut_instcmd: 60_000,
  nut_setvar: 60_000,
  nut_logs: 30_000,
  nut_upsmon: 60_000,
};

/** Values written into ups.conf. Passwords have their own rule. */
export const CONF_VALUE = /^[A-Za-z0-9._:/@-]{1,128}$/;
export const SECRET_VALUE = /^[\x20-\x7e]{8,64}$/;
const SECRET_FORBIDDEN = /["\\]/;
export const UPS_NAME = /^[a-z0-9_-]{1,32}$/;

export const SNMP_V3_KEYS = ["secLevel", "secName", "authProtocol", "authPassword", "privProtocol", "privPassword"];
const PASSWORD_KEYS = new Set(["authPassword", "privPassword", "community"]);
/** ups.conf keys a managed UPS may carry besides driver, port and desc. */
export const EXTRA_KEYS = [
  "vendorid",
  "productid",
  "serial",
  "bus",
  "community",
  "snmp_version",
  "pollinterval",
  ...SNMP_V3_KEYS,
];

const confValue = z.string().regex(CONF_VALUE);
const secret = z
  .string()
  .regex(SECRET_VALUE)
  .refine((value) => !SECRET_FORBIDDEN.test(value), "must not contain quotes or backslashes");

export const snmpSchema = z
  .object({
    start: z.ipv4(),
    end: z.ipv4(),
    version: z.enum(["v1", "v2c", "v3"]),
    community: confValue.optional(),
    secLevel: z.enum(["noAuthNoPriv", "authNoPriv", "authPriv"]).optional(),
    secName: confValue.optional(),
    authProtocol: z.enum(["MD5", "SHA", "SHA256", "SHA384", "SHA512"]).optional(),
    authPassword: secret.optional(),
    privProtocol: z.enum(["DES", "AES", "AES192", "AES256"]).optional(),
    privPassword: secret.optional(),
  })
  .superRefine((snmp, ctx) => {
    if (snmp.version !== "v3") return;
    if (!snmp.secLevel || !snmp.secName) {
      ctx.addIssue({ code: "custom", message: "v3 needs a security level and user" });
    }
    if (snmp.secLevel !== "noAuthNoPriv" && (!snmp.authProtocol || !snmp.authPassword)) {
      ctx.addIssue({ code: "custom", message: "v3 with authentication needs a protocol and password" });
    }
    if (snmp.secLevel === "authPriv" && (!snmp.privProtocol || !snmp.privPassword)) {
      ctx.addIssue({ code: "custom", message: "v3 with privacy needs a protocol and password" });
    }
  });

export const scanSchema = z.object({ usb: z.boolean().default(true), snmp: snmpSchema.optional() });

/** SNMPv3 passwords follow the password rule, a community may be either. Everything else is a plain value. */
function validExtra(key: string, value: string): boolean {
  if (key === "authPassword" || key === "privPassword") return secret.safeParse(value).success;
  if (key === "community") return CONF_VALUE.test(value) || secret.safeParse(value).success;
  return CONF_VALUE.test(value);
}

const extraSchema = z.record(z.string(), z.string()).superRefine((extra, ctx) => {
  for (const [key, value] of Object.entries(extra)) {
    if (!EXTRA_KEYS.includes(key)) ctx.addIssue({ code: "custom", message: `${key} is not an allowed ups.conf key` });
    else if (!validExtra(key, value)) ctx.addIssue({ code: "custom", message: `invalid value for ${key}` });
  }
});

export const applySchema = z.object({
  ups: z
    .array(
      z.object({
        name: z.string().regex(UPS_NAME),
        displayName: z.string().trim().min(1).max(100),
        driver: confValue,
        port: confValue,
        desc: z.string().max(100).regex(/^[^"\\\n]*$/).optional(),
        extra: extraSchema.default({}),
      }),
    )
    .max(16),
  /** Sections already in ups.conf that WolUPS should monitor without rewriting them. */
  imported: z
    .array(z.object({ name: z.string().regex(UPS_NAME), displayName: z.string().trim().min(1).max(100) }))
    .max(16),
  listen: z.ipv4(),
  localShutdown: z.boolean().default(false),
  /** Move the imported sections into the WolUPS block instead of only monitoring them. */
  migrate: z.boolean().default(false),
  /** Change the description, port or serial of managed UPS without rewriting their sections. */
  edit: z
    .array(
      z.object({
        name: z.string().regex(UPS_NAME),
        displayName: z.string().trim().min(1).max(100),
        set: z
          .object({
            desc: z.string().max(100).regex(/^[^"\\\n]*$/),
            port: confValue,
            serial: z.union([confValue, z.literal("")]),
          })
          .partial(),
      }),
    )
    .max(16)
    .default([]),
});

export type ApplyInput = z.infer<typeof applySchema>;

export type ScanDevice = {
  driver: string;
  port: string;
  vendor?: string;
  product?: string;
  serial?: string;
  vendorid?: string;
  productid?: string;
  bus?: string;
  desc?: string;
  extra?: Record<string, string>;
};

export type DetectResult = {
  os: string;
  packageManager: string;
  nutVersion: string;
  configDir: string;
  services: { upsd: string; upsmon: string };
  /** UPS sections outside the WolUPS block, which can be imported. */
  existing: ConfSection[];
  /** UPS sections WolUPS manages. */
  managed: ConfSection[];
  /** The rest of an existing NUT setup, for the migration prompt. */
  config: { mode: string; listen: string[]; users: string[]; monitors: string[] };
};

export type ConfSection = { name: string; driver: string; port: string; desc?: string; extra?: Record<string, string> };

/** The agent of a NUT host, if one is paired. */
export function nutAgent(hostId: string) {
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.nutHostId, hostId), eq(agents.kind, "nut")))
    .get();
}

export function nutHost(hostId: string) {
  return db.select().from(nutHosts).where(eq(nutHosts.id, hostId)).get();
}

/** Replace password values in a stored command, so SNMP passwords do not stay in the database. */
export function redactPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactPayload);
  if (!payload || typeof payload !== "object") return payload;
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, PASSWORD_KEYS.has(key) ? "***" : redactPayload(value)]),
  );
}

function redactCommand(commandId: string) {
  const row = db.select({ payload: commands.payload }).from(commands).where(eq(commands.id, commandId)).get();
  if (!row) return;
  const redacted = redactPayload(row.payload) as Record<string, unknown>;
  db.update(commands).set({ payload: redacted }).where(eq(commands.id, commandId)).run();
}

const REDACTED_TYPES = new Set<string>(["nut_scan", "nut_apply"]);

agentHub.onAck((command) => {
  if (REDACTED_TYPES.has(command.type)) redactCommand(command.id);
});

/** Queue a NUT command for a host's agent. */
export function startNutCommand(hostId: string, type: NutCommandType, args: Record<string, unknown> = {}) {
  const agent = nutAgent(hostId);
  if (!agent) return { ok: false as const, error: "no NUT agent paired" };
  if (!agentHub.isConnected(agent.id)) return { ok: false as const, error: "NUT agent is not connected" };
  const ttlMs = NUT_TIMEOUTS[type];
  const row = agentHub.send(agent.id, type, args, { ttlMs });
  // An agent that never answers would leave the arguments behind until they expire.
  if (REDACTED_TYPES.has(type)) setTimeout(() => redactCommand(row.id), ttlMs).unref?.();
  return { ok: true as const, commandId: row.id, agentId: agent.id };
}

/** Run a NUT command and wait for its answer. */
export async function runNutCommand(
  hostId: string,
  type: NutCommandType,
  args: Record<string, unknown> = {},
): Promise<AckResult> {
  const started = startNutCommand(hostId, type, args);
  if (!started.ok) return { ok: false, error: started.error };
  return agentHub.waitForAck(started.commandId, NUT_TIMEOUTS[type]);
}

export type CommandState = {
  status: "running" | "done" | "failed";
  lines: string[];
  result?: Record<string, unknown>;
  error?: string | null;
};

/** State of a NUT command started for this host, for the wizard's polling. */
export function nutCommandState(hostId: string, commandId: string): CommandState | null {
  const agent = nutAgent(hostId);
  if (!agent) return null;
  const row = db
    .select()
    .from(commands)
    .where(and(eq(commands.id, commandId), eq(commands.agentId, agent.id)))
    .get();
  if (!row) return null;
  const lines = agentHub.commandOutput(row.id);
  if (row.status === "acked") return { status: "done", lines, result: commandResults.get(row.id) ?? {} };
  if (row.status === "failed") return { status: "failed", lines, error: row.error };
  if (row.expiresAt.getTime() < Date.now()) return { status: "failed", lines, error: "agent did not respond in time" };
  return { status: "running", lines };
}

/** Results of finished commands, kept as long as their output. Results are not stored in the database. */
const commandResults = new Map<string, Record<string, unknown>>();

agentHub.onAck((command, ack) => {
  if (!command.type.startsWith("nut_") || !ack.result) return;
  commandResults.set(command.id, ack.result);
  setTimeout(() => commandResults.delete(command.id), 10 * 60_000).unref?.();
});
