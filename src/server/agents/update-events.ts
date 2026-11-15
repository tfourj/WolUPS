import { emitEvent, type EmitInput } from "../events";
import { compareNames } from "../../shared/sort";

/** Agent update events of one type that follow each other within this time become one event. */
export const GROUP_QUIET_MS = 60_000;
/** A group is sent at the latest this long after its first event, even if more keep arriving. */
export const GROUP_MAX_MS = 5 * 60_000;

export type AgentUpdateEventType = "agent_update_available" | "agent_updated" | "agent_update_failed";

/** One agent's event, as it would be emitted on its own. */
export type AgentUpdateEvent = {
  agentId: string;
  /** The device of a device agent, null for a NUT host. */
  deviceId: string | null;
  device: string;
  title: string;
  message: string;
  version: string | null;
  error?: string | null;
  data: NonNullable<EmitInput["data"]>;
};

type Group = { events: Map<string, AgentUpdateEvent>; startedAt: number; timer: ReturnType<typeof setTimeout> };

const groups = new Map<AgentUpdateEventType, Group>();

function list(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

/** The event for a group: unchanged for one agent, a summary with every device for several. */
export function groupedEvent(type: AgentUpdateEventType, events: AgentUpdateEvent[]): EmitInput {
  if (events.length === 1) {
    const [event] = events;
    return { type, deviceId: event.deviceId, title: event.title, message: event.message, data: event.data };
  }
  const sorted = [...events].sort((a, b) => compareNames(a.device, b.device));
  const names = sorted.map((event) => event.device);
  const versions = unique(sorted.map((event) => event.version));
  const errors = unique(sorted.map((event) => event.error));
  const count = sorted.length;
  const version = versions.map((v) => `v${v}`).join(", ");

  let title: string;
  let message: string;
  if (type === "agent_update_available") {
    title = `Agent update available for ${count} agents`;
    message = `Agent ${version} is available for ${list(names)}`;
  } else if (type === "agent_updated") {
    title = `${count} agents updated`;
    message = `Agents on ${list(names)} updated to ${version}`;
  } else {
    title = `Agent update failed on ${count} agents`;
    const each = sorted.map((event) => `${event.device} (${event.error ?? "unknown error"})`);
    message =
      errors.length === 1
        ? `Agents on ${list(names)} could not update: ${errors[0]}`
        : `Agents could not update: ${each.join(", ")}`;
  }
  return {
    type,
    deviceId: null,
    title,
    message,
    data: {
      device: names.join(", "),
      devices: names,
      deviceIds: sorted.map((event) => event.deviceId).filter((id): id is string => !!id),
      count,
      version: versions.join(", "),
      ...(errors.length ? { error: errors.join("; ") } : {}),
    },
  };
}

/** Time until a group is sent: the quiet window, cut short once the group reaches its maximum age. */
export function groupDelay(startedAt: number, now: number): number {
  return Math.max(0, Math.min(GROUP_QUIET_MS, startedAt + GROUP_MAX_MS - now));
}

/** Emit the waiting group of this type now. */
export function flushAgentUpdateEvents(type: AgentUpdateEventType) {
  const group = groups.get(type);
  if (!group) return;
  clearTimeout(group.timer);
  groups.delete(type);
  emitEvent(groupedEvent(type, [...group.events.values()]));
}

/**
 * Queue an agent update event. Updates usually reach every agent at once, so events of the same type are held
 * until none has arrived for GROUP_QUIET_MS and then sent as one. A later event from the same agent replaces its
 * earlier one.
 */
export function queueAgentUpdateEvent(type: AgentUpdateEventType, event: AgentUpdateEvent, now = Date.now()) {
  const existing = groups.get(type);
  if (existing) clearTimeout(existing.timer);
  const events = existing?.events ?? new Map<string, AgentUpdateEvent>();
  const startedAt = existing?.startedAt ?? now;
  events.set(event.agentId, event);
  const timer = setTimeout(() => flushAgentUpdateEvents(type), groupDelay(startedAt, now));
  groups.set(type, { events, startedAt, timer });
}
