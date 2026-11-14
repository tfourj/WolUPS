/** Event types shared by the server and the web UI. */
export const EVENT_TYPES = [
  "ups_on_battery",
  "ups_power_restored",
  "ups_low_battery",
  "ups_unreachable",
  "ups_reachable",
  "shutdown_sent",
  "shutdown_acknowledged",
  "shutdown_failed",
  "wake_sent",
  "wake_failed",
  "device_recovered",
  "agent_connected",
  "agent_disconnected",
  "agent_enrolled",
  "agent_update_available",
  "agent_updated",
  "agent_update_failed",
  "test",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<EventType, string> = {
  ups_on_battery: "UPS on battery",
  ups_power_restored: "Power restored",
  ups_low_battery: "UPS low battery",
  ups_unreachable: "UPS unreachable",
  ups_reachable: "UPS reachable again",
  shutdown_sent: "Shutdown sent",
  shutdown_acknowledged: "Shutdown accepted",
  shutdown_failed: "Shutdown failed",
  wake_sent: "Wake packet sent",
  wake_failed: "Wake failed",
  device_recovered: "Device back online",
  agent_connected: "Agent connected",
  agent_disconnected: "Agent disconnected",
  agent_enrolled: "Agent paired",
  agent_update_available: "Agent update available",
  agent_updated: "Agent updated",
  agent_update_failed: "Agent update failed",
  test: "Test notification",
};

export type Severity = "info" | "success" | "warning" | "error";

export const DEFAULT_EVENT_SEVERITY: Record<EventType, Severity> = {
  ups_on_battery: "warning",
  ups_power_restored: "success",
  ups_low_battery: "error",
  ups_unreachable: "error",
  ups_reachable: "success",
  shutdown_sent: "warning",
  shutdown_acknowledged: "warning",
  shutdown_failed: "error",
  wake_sent: "info",
  wake_failed: "error",
  device_recovered: "success",
  agent_connected: "info",
  agent_disconnected: "warning",
  agent_enrolled: "success",
  agent_update_available: "info",
  agent_updated: "success",
  agent_update_failed: "error",
  test: "info",
};

/** Events a new channel subscribes to by default. Noisy connection events are opt-in. */
export const DEFAULT_CHANNEL_EVENTS: EventType[] = [
  "ups_on_battery",
  "ups_power_restored",
  "ups_low_battery",
  "ups_unreachable",
  "shutdown_acknowledged",
  "shutdown_failed",
  "wake_sent",
  "wake_failed",
  "device_recovered",
  "agent_updated",
  "agent_update_failed",
];

export const TEMPLATE_VARIABLES = [
  "event",
  "title",
  "message",
  "ups",
  "device",
  "battery",
  "runtime",
  "status",
  "threshold",
  "version",
  "time",
] as const;

export const DEFAULT_TEMPLATE = { title: "{title}", body: "{message}" };
