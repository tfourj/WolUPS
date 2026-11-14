import { DEFAULT_TEMPLATE, EVENT_TYPES, type EventType } from "./events";
import type { Template } from "./templates";

export type TemplatePreset = { id: string; label: string; templates: Record<EventType, Template> };

type Detail =
  | "ups"
  | "device"
  | "battery"
  | "runtime"
  | "status"
  | "threshold"
  | "version"
  | "duration"
  | "error"
  | "via"
  | "time";

/** One line per value. Lines whose value is empty for an event are left out when rendering. */
const DETAILS: Record<Detail, { icon: string; text: string }> = {
  ups: { icon: "🔌", text: "{ups}" },
  device: { icon: "🖥️", text: "{device}" },
  battery: { icon: "🔋", text: "Battery {battery}" },
  runtime: { icon: "⏱️", text: "Runtime {runtime}" },
  status: { icon: "📊", text: "Status {status}" },
  threshold: { icon: "🎯", text: "Threshold {threshold}" },
  version: { icon: "🏷️", text: "Version {version}" },
  duration: { icon: "⏳", text: "Outage {duration}" },
  error: { icon: "❗", text: "{error}" },
  via: { icon: "📡", text: "Via {via}" },
  time: { icon: "🕒", text: "{time}" },
};

type EventSpec = {
  icon: string;
  /** The message in the template's own words. */
  summary: string;
  /** Values that matter most for the event. */
  key: Detail[];
  /** Further values shown by the detailed presets. */
  more: Detail[];
};

const EVENTS: Record<EventType, EventSpec> = {
  ups_on_battery: {
    icon: "🔋",
    summary: "{ups} switched to battery power",
    key: ["battery", "runtime"],
    more: ["status", "time"],
  },
  ups_power_restored: {
    icon: "⚡",
    summary: "{ups} is back on line power",
    key: ["duration", "battery"],
    more: ["status", "time"],
  },
  ups_low_battery: {
    icon: "🪫",
    summary: "{ups} reports low battery",
    key: ["battery", "runtime"],
    more: ["status", "time"],
  },
  ups_unreachable: { icon: "❌", summary: "Cannot read {ups} from NUT", key: ["error"], more: ["time"] },
  ups_reachable: { icon: "✅", summary: "{ups} is responding again", key: ["battery", "status"], more: ["time"] },
  shutdown_sent: {
    icon: "🛑",
    summary: "Sending shutdown to {device}",
    key: ["ups", "battery", "threshold"],
    more: ["runtime", "time"],
  },
  shutdown_acknowledged: {
    icon: "💤",
    summary: "{device} accepted shutdown",
    key: ["ups", "battery"],
    more: ["threshold", "time"],
  },
  shutdown_failed: {
    icon: "⚠️",
    summary: "{device} did not shut down",
    key: ["error", "battery"],
    more: ["ups", "threshold", "time"],
  },
  wake_sent: { icon: "⏰", summary: "Sent wake packet to {device}", key: ["via"], more: ["ups", "battery", "time"] },
  wake_failed: { icon: "⚠️", summary: "{device} was not woken", key: ["error"], more: ["ups", "battery", "time"] },
  device_recovered: { icon: "🟢", summary: "{device} came back online", key: ["ups"], more: ["time"] },
  agent_connected: { icon: "🔗", summary: "Agent connected", key: ["device", "version"], more: ["time"] },
  agent_disconnected: {
    icon: "🔌",
    summary: "Agent is no longer connected",
    key: ["device"],
    more: ["version", "time"],
  },
  agent_enrolled: { icon: "🤝", summary: "Agent paired", key: ["device", "version"], more: ["time"] },
  agent_update_available: {
    icon: "⬆️",
    summary: "Agent update available",
    key: ["device", "version"],
    more: ["time"],
  },
  agent_updated: { icon: "✨", summary: "Agent updated", key: ["device", "version"], more: ["time"] },
  agent_update_failed: { icon: "⚠️", summary: "Agent update failed", key: ["device", "error"], more: ["time"] },
  login: { icon: "🔐", summary: "{message}", key: [], more: ["time"] },
  test: {
    icon: "🔔",
    summary: "{message}",
    key: [],
    more: ["ups", "device", "battery", "runtime", "status", "threshold", "time"],
  },
};

type LineStyle = "text" | "icon" | "icon-text";

function detailLine(detail: Detail, style: LineStyle): string {
  const { icon, text } = DETAILS[detail];
  if (style === "text") return text;
  return style === "icon" ? `${icon} {${detail}}` : `${icon} ${text}`;
}

function body(lead: string, details: Detail[], style: LineStyle, gap = "\n"): string {
  const lines = details.map((detail) => detailLine(detail, style)).join("\n");
  if (!lead) return lines || "{message}";
  return lines ? `${lead}${gap}${lines}` : lead;
}

function forEachEvent(build: (spec: EventSpec) => Template): Record<EventType, Template> {
  return Object.fromEntries(EVENT_TYPES.map((type) => [type, build(EVENTS[type])])) as Record<EventType, Template>;
}

const iconTitle = (spec: EventSpec) => `${spec.icon} {title}`;

/** Ready-made template sets. The first one is the built-in default. */
export const TEMPLATE_PRESETS: TemplatePreset[] = [
  { id: "default", label: "Default", templates: forEachEvent(() => DEFAULT_TEMPLATE) },
  {
    id: "minimal",
    label: "Minimalistic",
    templates: forEachEvent((spec) => ({ title: "{title}", body: body("", spec.key, "text") })),
  },
  {
    id: "detailed",
    label: "Detailed",
    templates: forEachEvent((spec) => ({
      title: "{title}",
      // The message already states the error.
      body: body("{message}", [...spec.key, ...spec.more].filter((d) => d !== "error"), "text", "\n\n"),
    })),
  },
  {
    id: "icon-default",
    label: "Icon Default",
    templates: forEachEvent((spec) => ({ title: iconTitle(spec), body: body(spec.summary, spec.key, "icon-text") })),
  },
  {
    id: "icon-minimal",
    label: "Icon Minimalistic",
    templates: forEachEvent((spec) => ({ title: iconTitle(spec), body: body("", spec.key, "icon") })),
  },
  {
    id: "icon-detailed",
    label: "Icon Detailed",
    templates: forEachEvent((spec) => ({
      title: iconTitle(spec),
      body: body(spec.summary, [...spec.key, ...spec.more], "icon-text"),
    })),
  },
];

/** The preset whose templates equal the given ones for every event type, if any. */
export function matchTemplatePreset(templates: Record<string, Template>): TemplatePreset | undefined {
  return TEMPLATE_PRESETS.find((preset) =>
    EVENT_TYPES.every((type) => {
      const current = templates[type] ?? DEFAULT_TEMPLATE;
      return current.title === preset.templates[type].title && current.body === preset.templates[type].body;
    }),
  );
}
