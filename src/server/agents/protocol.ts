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
 */
export const PROTOCOL_VERSION = 1;

export const COMMAND_TYPES = ["shutdown", "wol", "update", "unpair", "ping"] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

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
]);

export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const enrollRequestSchema = z.object({
  token: z.string().min(20).max(128),
  publicKey: z.string().min(40).max(64),
  info: agentInfoSchema,
});
