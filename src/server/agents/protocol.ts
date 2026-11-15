import { z } from "zod";
import type { KeyObject } from "node:crypto";
import { signMessage, verifyMessage } from "../crypto/signing";

/**
 * Agent wire protocol, version 1. Keep in sync with agent/internal/protocol.
 *
 * Connection: the agent dials wss://BASE_URL/api/agents/ws.
 *   server -> {type:"challenge", nonce}
 *   agent  -> {type:"hello", agentId, nonce, ts, sig, info}   sig over helloMessage()
 *   server -> {type:"welcome", deviceName}
 * Commands: server -> {type:"command", payload, sig}           sig over commandMessage(payload)
 *   agent  -> {type:"ack", id, ok, error?}
 * Status:   agent  -> {type:"status", info}                    every 30 seconds
 * NUT agents only:
 *   agent  -> {type:"progress", id, lines}                     output of a running nut_install or nut_scan
 *   agent  -> {type:"nut_status", upsd, upsmon, listening, drivers}   every 30 seconds and after changes
 */
export const PROTOCOL_VERSION = 1;

export const COMMON_COMMANDS = ["update", "unpair", "ping"] as const;
export const DEVICE_COMMANDS = ["shutdown", "wol", "resolve_mac"] as const;
export const NUT_COMMANDS = [
  "nut_detect",
  "nut_install",
  "nut_scan",
  "nut_apply",
  "nut_service",
  "nut_status",
  "nut_instcmd",
  "nut_setvar",
  "nut_logs",
  "nut_upsmon",
] as const;
export const COMMAND_TYPES = [...COMMON_COMMANDS, ...DEVICE_COMMANDS, ...NUT_COMMANDS] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];
export type NutCommandType = (typeof NUT_COMMANDS)[number];

/** Whether an agent of this kind runs the command. Device agents never get NUT commands and the reverse. */
export function commandAllowed(kind: "device" | "nut", type: CommandType): boolean {
  if ((COMMON_COMMANDS as readonly string[]).includes(type)) return true;
  const own: readonly string[] = kind === "nut" ? NUT_COMMANDS : DEVICE_COMMANDS;
  return own.includes(type);
}

export const HELLO_MAX_SKEW_MS = 5 * 60 * 1000;

export function helloMessage(agentId: string, nonce: string, ts: number): string {
  return `wolups-hello:v1\n${agentId}\n${nonce}\n${ts}`;
}

export function commandMessage(payload: string): string {
  return `wolups-command:v1\n${payload}`;
}

export type CommandPayload = {
  v: number;
  id: string;
  agentId: string;
  type: CommandType;
  args: Record<string, unknown>;
  issuedAt: number;
  expiresAt: number;
};

export function signCommand(key: KeyObject, command: CommandPayload) {
  const payload = JSON.stringify(command);
  return { type: "command" as const, payload, sig: signMessage(key, commandMessage(payload)) };
}

export function verifyHello(publicKey: KeyObject, agentId: string, nonce: string, ts: number, sig: string, now = Date.now()) {
  if (Math.abs(now - ts) > HELLO_MAX_SKEW_MS) return false;
  return verifyMessage(publicKey, helloMessage(agentId, nonce, ts), sig);
}

const interfaceSchema = z.object({
  name: z.string().max(64),
  mac: z.string().max(32),
  cidrs: z.array(z.string().max(64)).max(16),
});

export const agentInfoSchema = z.object({
  version: z.string().max(32),
  protocol: z.number().int(),
  os: z.string().max(32),
  arch: z.string().max(32),
  hostname: z.string().max(255),
  interfaces: z.array(interfaceSchema).max(32).default([]),
});

export type AgentInfo = z.infer<typeof agentInfoSchema>;

export const agentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    agentId: z.string().max(64),
    nonce: z.string().max(128),
    ts: z.number(),
    sig: z.string().max(256),
    info: agentInfoSchema,
  }),
  z.object({
    type: z.literal("ack"),
    id: z.string().max(64),
    ok: z.boolean(),
    error: z.string().max(1000).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("status"), info: agentInfoSchema }),
  z.object({
    type: z.literal("progress"),
    id: z.string().max(64),
    lines: z.array(z.string().max(500)).max(50),
  }),
  z.object({
    type: z.literal("nut_status"),
    upsd: z.string().max(32),
    upsmon: z.string().max(32),
    listening: z.boolean(),
    drivers: z.array(z.object({ ups: z.string().max(64), state: z.string().max(32) })).max(32),
    upsmonEnabled: z.boolean().optional(),
    monitors: z
      .array(
        z.object({ system: z.string().max(200), reachable: z.boolean(), error: z.string().max(100).optional() }),
      )
      .max(16)
      .optional(),
  }),
]);

export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const enrollRequestSchema = z.object({
  token: z.string().min(20).max(128),
  publicKey: z.string().min(40).max(64),
  info: agentInfoSchema,
});
