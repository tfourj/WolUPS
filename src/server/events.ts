import { db } from "./db/client";
import { events } from "./db/schema";
import { createLogger } from "./logger";
import { DEFAULT_EVENT_SEVERITY, type EventType, type Severity } from "../shared/events";

const log = createLogger("events");

export type EventData = {
  ups?: string;
  device?: string;
  battery?: number | null;
  runtime?: number | null;
  status?: string | null;
  threshold?: number | null;
  version?: string | null;
  [key: string]: unknown;
};

export type EmitInput = {
  type: EventType;
  title: string;
  message: string;
  upsId?: string | null;
  deviceId?: string | null;
  severity?: Severity;
  data?: EventData;
};

export type EventRow = typeof events.$inferSelect;

type Listener = (event: EventRow) => void | Promise<void>;
const listeners: Listener[] = [];

export function onEvent(listener: Listener) {
  listeners.push(listener);
}

/** Record an event and hand it to listeners (the notification dispatcher). */
export function emitEvent(input: EmitInput): EventRow {
  const row = db
    .insert(events)
    .values({
      type: input.type,
      severity: input.severity ?? DEFAULT_EVENT_SEVERITY[input.type],
      upsId: input.upsId ?? null,
      deviceId: input.deviceId ?? null,
      title: input.title,
      message: input.message,
      data: input.data ?? {},
    })
    .returning()
    .get();
  log.info(input.message, { event: input.type, upsId: input.upsId, deviceId: input.deviceId });
  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(row))
      .catch((error) => log.error("event listener failed", { error }));
  }
  return row;
}
