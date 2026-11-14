import { and, eq, gt, inArray } from "drizzle-orm";
import type { WSContext, WSEvents } from "hono/ws";
import { db } from "../db/client";
import { agents, commands, devices } from "../db/schema";
import { importPublicRaw } from "../crypto/signing";
import { randomToken } from "../crypto/secretbox";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import { serverSigningKey } from "../secrets";
import {
  agentMessageSchema,
  PROTOCOL_VERSION,
  signCommand,
  verifyHello,
  type AgentInfo,
  type AgentMessage,
  type CommandType,
} from "./protocol";

const log = createLogger("agents");

const HELLO_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_MS = 90_000;

type Conn = {
  ws: WSContext;
  nonce: string;
  ip: string;
  agentId: string | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
};

export type CommandRow = typeof commands.$inferSelect;
export type AckResult = { ok: boolean; error?: string; result?: Record<string, unknown>; timedOut?: boolean };
type AckHook = (command: CommandRow, ack: AckResult) => void;

class AgentHub {
  private sessions = new Map<string, Conn>();
  private waiters = new Map<string, (ack: AckResult) => void>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private ackHooks: AckHook[] = [];
  private connectHooks: ((agentId: string) => void)[] = [];

  /** Mark every agent offline on startup; live sessions reconnect on their own. */
  reset() {
    db.update(agents).set({ connected: false }).run();
  }

  onAck(hook: AckHook) {
    this.ackHooks.push(hook);
  }

  onConnect(hook: (agentId: string) => void) {
    this.connectHooks.push(hook);
  }

  isConnected(agentId: string) {
    return this.sessions.has(agentId);
  }

  connectedAgentIds(): string[] {
    return [...this.sessions.keys()];
  }

  handlers(ip: string): WSEvents {
    const conn: Conn = { ws: null as unknown as WSContext, nonce: randomToken(24), ip, agentId: null, helloTimer: null };
    return {
      onOpen: (_evt, ws) => {
        conn.ws = ws;
        ws.send(JSON.stringify({ type: "challenge", nonce: conn.nonce, protocol: PROTOCOL_VERSION }));
        conn.helloTimer = setTimeout(() => ws.close(4408, "hello timeout"), HELLO_TIMEOUT_MS);
      },
      onMessage: (evt, ws) => {
        conn.ws = ws;
        let msg: AgentMessage;
        try {
          const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer);
          msg = agentMessageSchema.parse(JSON.parse(raw));
        } catch {
          ws.close(4400, "invalid message");
          return;
        }
        if (msg.type === "hello") this.handleHello(conn, msg);
        else if (!conn.agentId) ws.close(4401, "not authenticated");
        else if (msg.type === "ack") this.handleAck(conn.agentId, msg);
        else if (msg.type === "status") this.handleStatus(conn.agentId, msg.info);
      },
      onClose: () => this.handleClose(conn),
    };
  }

  private handleHello(conn: Conn, msg: Extract<AgentMessage, { type: "hello" }>) {
    if (conn.agentId) return;
    const agent = db.select().from(agents).where(eq(agents.id, msg.agentId)).get();
    if (!agent) {
      log.warn("hello from unknown agent", { agentId: msg.agentId, ip: conn.ip });
      conn.ws.close(4404, "unknown agent, pair again");
      return;
    }
    const ok = msg.nonce === conn.nonce && verifyHello(importPublicRaw(agent.publicKey), agent.id, msg.nonce, msg.ts, msg.sig);
    if (!ok) {
      log.warn("agent signature rejected", { agentId: agent.id, ip: conn.ip });
      conn.ws.close(4401, "signature rejected");
      return;
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.agentId = agent.id;

    const previous = this.sessions.get(agent.id);
    this.sessions.set(agent.id, conn);
    if (previous) previous.ws.close(4000, "replaced by new connection");

    const device = db.select().from(devices).where(eq(devices.id, agent.deviceId)).get();
    const now = new Date();
    const versionChanged = !!agent.version && agent.version !== msg.info.version;
    this.saveInfo(agent.id, msg.info, {
      connected: true,
      ...(versionChanged ? { updateStatus: "updated", lastUpdateError: null } : {}),
    });
    db.update(devices).set({ online: true, lastSeenAt: now }).where(eq(devices.id, agent.deviceId)).run();

    const pendingDisconnect = this.disconnectTimers.get(agent.id);
    if (pendingDisconnect) {
      clearTimeout(pendingDisconnect);
      this.disconnectTimers.delete(agent.id);
    } else if (!agent.connected) {
      emitEvent({
        type: "agent_connected",
        deviceId: agent.deviceId,
        title: `${device?.name ?? "Agent"} connected`,
        message: `Agent on ${device?.name ?? msg.info.hostname} connected (v${msg.info.version})`,
        data: { device: device?.name, version: msg.info.version },
      });
    }
    if (versionChanged) {
      emitEvent({
        type: "agent_updated",
        deviceId: agent.deviceId,
        title: `${device?.name ?? "Agent"} updated`,
        message: `Agent on ${device?.name ?? msg.info.hostname} updated from v${agent.version} to v${msg.info.version}`,
        data: { device: device?.name, version: msg.info.version, previousVersion: agent.version },
      });
    }

    conn.ws.send(JSON.stringify({ type: "welcome", deviceName: device?.name ?? "" }));
    log.info("agent connected", { agentId: agent.id, device: device?.name, version: msg.info.version, ip: conn.ip });
    this.flushPending(agent.id);
    for (const hook of this.connectHooks) {
      try {
        hook(agent.id);
      } catch (error) {
        log.error("connect hook failed", { error });
      }
    }
  }

  private saveInfo(agentId: string, info: AgentInfo, extra: Partial<typeof agents.$inferInsert> = {}) {
    db.update(agents)
      .set({
        version: info.version,
        os: info.os,
        arch: info.arch,
        hostname: info.hostname,
        interfaces: info.interfaces,
        lastSeenAt: new Date(),
        ...extra,
      })
      .where(eq(agents.id, agentId))
      .run();
  }

  private handleStatus(agentId: string, info: AgentInfo) {
    this.saveInfo(agentId, info);
    const agent = db.select({ deviceId: agents.deviceId }).from(agents).where(eq(agents.id, agentId)).get();
    if (agent) db.update(devices).set({ online: true, lastSeenAt: new Date() }).where(eq(devices.id, agent.deviceId)).run();
  }

  private handleAck(agentId: string, msg: Extract<AgentMessage, { type: "ack" }>) {
    const row = db
      .select()
      .from(commands)
      .where(and(eq(commands.id, msg.id), eq(commands.agentId, agentId)))
      .get();
    if (!row) return;
    const ack: AckResult = { ok: msg.ok, error: msg.error, result: msg.result };
    const updated = db
      .update(commands)
      .set({ status: msg.ok ? "acked" : "failed", ackedAt: new Date(), error: msg.error ?? null })
      .where(eq(commands.id, row.id))
      .returning()
      .get();
    this.waiters.get(row.id)?.(ack);
    this.waiters.delete(row.id);
    for (const hook of this.ackHooks) {
      try {
        hook(updated, ack);
      } catch (error) {
        log.error("ack hook failed", { error });
      }
    }
  }

  private handleClose(conn: Conn) {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    const agentId = conn.agentId;
    if (!agentId || this.sessions.get(agentId) !== conn) return;
    this.sessions.delete(agentId);
    db.update(agents).set({ connected: false, lastSeenAt: new Date() }).where(eq(agents.id, agentId)).run();
    log.info("agent disconnected", { agentId });
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(agentId);
      if (this.sessions.has(agentId)) return;
      const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
      if (!agent) return;
      const device = db.select().from(devices).where(eq(devices.id, agent.deviceId)).get();
      emitEvent({
        type: "agent_disconnected",
        deviceId: agent.deviceId,
        title: `${device?.name ?? "Agent"} disconnected`,
        message: `Agent on ${device?.name ?? agent.hostname} lost its connection`,
        data: { device: device?.name, version: agent.version },
      });
    }, DISCONNECT_GRACE_MS);
    this.disconnectTimers.set(agentId, timer);
  }

  /** Queue a signed command. It is delivered now if the agent is connected, otherwise on reconnect until it expires. */
  send(
    agentId: string,
    type: CommandType,
    args: Record<string, unknown> = {},
    opts: { ttlMs?: number; outageId?: string; id?: string } = {},
  ): CommandRow {
    const now = Date.now();
    const row = db
      .insert(commands)
      .values({
        ...(opts.id ? { id: opts.id } : {}),
        agentId,
        type,
        payload: args,
        outageId: opts.outageId ?? null,
        expiresAt: new Date(now + (opts.ttlMs ?? 60_000)),
      })
      .returning()
      .get();
    const conn = this.sessions.get(agentId);
    if (conn) this.push(conn, row);
    return row;
  }

  /** Re-deliver an existing command (the agent dedupes by id). */
  resend(commandId: string): boolean {
    const row = db.select().from(commands).where(eq(commands.id, commandId)).get();
    if (!row || row.expiresAt.getTime() < Date.now()) return false;
    const conn = this.sessions.get(row.agentId);
    if (!conn) return false;
    this.push(conn, row);
    return true;
  }

  waitForAck(commandId: string, timeoutMs: number): Promise<AckResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(commandId);
        resolve({ ok: false, error: "agent did not respond in time", timedOut: true });
      }, timeoutMs);
      this.waiters.set(commandId, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  async sendAndWait(agentId: string, type: CommandType, args: Record<string, unknown> = {}, timeoutMs = 15_000) {
    if (!this.isConnected(agentId)) return { ok: false, error: "agent is not connected" } satisfies AckResult;
    const row = this.send(agentId, type, args, { ttlMs: timeoutMs });
    return this.waitForAck(row.id, timeoutMs);
  }

  disconnect(agentId: string, reason = "unpaired") {
    const conn = this.sessions.get(agentId);
    this.sessions.delete(agentId);
    conn?.ws.close(4403, reason);
  }

  private push(conn: Conn, row: CommandRow) {
    if (!conn.agentId) return;
    const envelope = signCommand(serverSigningKey().privateKey, {
      v: PROTOCOL_VERSION,
      id: row.id,
      agentId: conn.agentId,
      type: row.type as CommandType,
      args: row.payload,
      issuedAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
    });
    conn.ws.send(JSON.stringify(envelope));
    db.update(commands)
      .set({ status: row.status === "pending" ? "sent" : row.status, sentAt: new Date(), attempts: row.attempts + 1 })
      .where(eq(commands.id, row.id))
      .run();
  }

  private flushPending(agentId: string) {
    const conn = this.sessions.get(agentId);
    if (!conn) return;
    const pending = db
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.agentId, agentId),
          inArray(commands.status, ["pending", "sent"]),
          gt(commands.expiresAt, new Date()),
        ),
      )
      .all();
    for (const row of pending) this.push(conn, row);
  }
}

export const agentHub = new AgentHub();
