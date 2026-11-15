import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "../db/client";
import { channels, deliveries, deliveryAttempts, events } from "../db/schema";
import { onEvent, type EventRow } from "../events";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import { DEFAULT_EVENT_SEVERITY, type EventType, type Severity } from "../../shared/events";
import { decryptConfig, isChannelType, type ChannelRow } from "./channels";
import { providers } from "./providers";
import type { NotificationMessage } from "./providers/types";
import { renderMessage, resolveTemplate } from "../../shared/templates";
import { templateVars } from "./templates";

const log = createLogger("notify");

export const MAX_ATTEMPTS = 6;
const WORKER_INTERVAL_MS = 5_000;

/** Exponential backoff: 30s, 1m, 2m, 4m, 8m, capped at 30 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

/** Devices an event is about: its own, or every device of a grouped agent update. */
function eventDeviceIds(event: Pick<EventRow, "deviceId"> & { data?: EventRow["data"] }): string[] {
  if (event.deviceId) return [event.deviceId];
  const grouped = event.data?.deviceIds;
  return Array.isArray(grouped) ? grouped.filter((id): id is string => typeof id === "string") : [];
}

export function channelMatches(
  channel: ChannelRow,
  event: Pick<EventRow, "type" | "upsId" | "deviceId"> & { data?: EventRow["data"] },
): boolean {
  if (!channel.enabled) return false;
  if (event.type !== "test" && !channel.events.includes(event.type)) return false;
  if (channel.upsIds?.length && event.upsId && !channel.upsIds.includes(event.upsId)) return false;
  const allowed = channel.deviceIds ?? [];
  const deviceIds = eventDeviceIds(event);
  if (allowed.length && deviceIds.length && !deviceIds.some((id) => allowed.includes(id))) return false;
  return true;
}

export function buildMessage(channel: ChannelRow, event: EventRow): NotificationMessage {
  const template = resolveTemplate(event.type, getSettings().templates, channel);
  return {
    ...renderMessage(template, templateVars(event)),
    severity: (event.severity as Severity) ?? DEFAULT_EVENT_SEVERITY[event.type as EventType] ?? "info",
    event: event.type,
    time: event.createdAt,
    data: event.data ?? {},
  };
}

export async function sendToChannel(channel: ChannelRow, message: NotificationMessage) {
  if (!isChannelType(channel.type)) throw new Error(`unknown channel type ${channel.type}`);
  await providers[channel.type](decryptConfig(channel), message);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let working = false;

async function processDue() {
  if (working) return;
  working = true;
  try {
    const due = db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.status, "pending"), lte(deliveries.nextAttemptAt, new Date())))
      .limit(50)
      .all();
    for (const delivery of due) await attempt(delivery);
  } catch (error) {
    log.error("delivery worker failed", { error });
  } finally {
    working = false;
  }
}

async function attempt(delivery: typeof deliveries.$inferSelect) {
  const channel = db.select().from(channels).where(eq(channels.id, delivery.channelId)).get();
  const event = db.select().from(events).where(eq(events.id, delivery.eventId)).get();
  if (!channel || !event) {
    db.update(deliveries).set({ status: "failed", lastError: "channel or event removed" }).where(eq(deliveries.id, delivery.id)).run();
    return;
  }
  const attemptNo = delivery.attempts + 1;
  const started = Date.now();
  let error: string | null = null;
  try {
    await sendToChannel(channel, buildMessage(channel, event));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Date.now() - started;
  db.insert(deliveryAttempts).values({ deliveryId: delivery.id, attempt: attemptNo, ok: !error, error, durationMs }).run();

  if (!error) {
    db.update(deliveries)
      .set({ status: "success", attempts: attemptNo, deliveredAt: new Date(), lastError: null, nextAttemptAt: null })
      .where(eq(deliveries.id, delivery.id))
      .run();
    log.debug("notification delivered", { channel: channel.name, event: event.type });
    return;
  }
  const giveUp = attemptNo >= MAX_ATTEMPTS;
  db.update(deliveries)
    .set({
      status: giveUp ? "failed" : "pending",
      attempts: attemptNo,
      lastError: error,
      nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs(attemptNo)),
    })
    .where(eq(deliveries.id, delivery.id))
    .run();
  log.warn("notification failed", { channel: channel.name, event: event.type, attempt: attemptNo, giveUp, error });
}

function enqueue(event: EventRow) {
  if (event.type === "test") return;
  const targets = db.select().from(channels).where(eq(channels.enabled, true)).all().filter((c) => channelMatches(c, event));
  if (targets.length === 0) return;
  const now = new Date();
  db.insert(deliveries)
    .values(targets.map((c) => ({ eventId: event.id, channelId: c.id, nextAttemptAt: now })))
    .run();
  void processDue();
}

/** Retry a failed delivery now (from the Events page). */
export function retryDeliveries(ids: number[]) {
  if (ids.length === 0) return;
  db.update(deliveries)
    .set({ status: "pending", nextAttemptAt: new Date(), attempts: 0 })
    .where(inArray(deliveries.id, ids))
    .run();
  void processDue();
}

export function startDispatcher() {
  onEvent(enqueue);
  const loop = async () => {
    await processDue();
    timer = setTimeout(loop, WORKER_INTERVAL_MS);
  };
  if (!timer) void loop();
}
