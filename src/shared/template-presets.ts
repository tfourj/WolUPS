import { DEFAULT_TEMPLATE, EVENT_TYPES, type EventType } from "./events";
import type { Template } from "./templates";

export type TemplatePreset = { id: string; label: string; templates: Record<EventType, Template> };

const ICONS: Record<EventType, string> = {
  ups_on_battery: "🔋",
  ups_power_restored: "⚡",
  ups_low_battery: "🪫",
  ups_unreachable: "❌",
  ups_reachable: "✅",
  shutdown_sent: "🛑",
  shutdown_acknowledged: "💤",
  shutdown_failed: "⚠️",
  wake_sent: "⏰",
  wake_failed: "⚠️",
  device_recovered: "🟢",
  agent_connected: "🔗",
  agent_disconnected: "🔌",
  agent_enrolled: "🤝",
  agent_update_available: "⬆️",
  agent_updated: "✨",
  agent_update_failed: "⚠️",
  login: "🔐",
  test: "🔔",
};

type Detail = "ups" | "device" | "battery" | "runtime" | "status" | "threshold" | "version" | "time";

const DETAIL_LABELS: Record<Detail, { text: string; icon: string }> = {
  ups: { text: "UPS:", icon: "🔌" },
  device: { text: "Device:", icon: "🖥️" },
  battery: { text: "Battery:", icon: "🔋" },
  runtime: { text: "Runtime:", icon: "⏱️" },
  status: { text: "Status:", icon: "📊" },
  threshold: { text: "Threshold:", icon: "🎯" },
  version: { text: "Version:", icon: "🏷️" },
  time: { text: "Time:", icon: "🕒" },
};

const UPS_DETAILS: Detail[] = ["battery", "runtime", "status", "time"];
const SHUTDOWN_DETAILS: Detail[] = ["ups", "battery", "threshold", "time"];
const WAKE_DETAILS: Detail[] = ["ups", "battery", "time"];
const AGENT_DETAILS: Detail[] = ["version", "time"];

/** Variables each event carries beyond what its message already says. */
const DETAILS: Record<EventType, Detail[]> = {
  ups_on_battery: UPS_DETAILS,
  ups_power_restored: UPS_DETAILS,
  ups_low_battery: UPS_DETAILS,
  ups_unreachable: ["time"],
  ups_reachable: ["battery", "status", "time"],
  shutdown_sent: SHUTDOWN_DETAILS,
  shutdown_acknowledged: SHUTDOWN_DETAILS,
  shutdown_failed: SHUTDOWN_DETAILS,
  wake_sent: WAKE_DETAILS,
  wake_failed: WAKE_DETAILS,
  device_recovered: ["ups", "time"],
  agent_connected: AGENT_DETAILS,
  agent_disconnected: AGENT_DETAILS,
  agent_enrolled: AGENT_DETAILS,
  agent_update_available: AGENT_DETAILS,
  agent_updated: AGENT_DETAILS,
  agent_update_failed: AGENT_DETAILS,
  login: ["time"],
  test: ["ups", "device", "battery", "runtime", "status", "threshold", "time"],
};

function forEachEvent(build: (type: EventType) => Template): Record<EventType, Template> {
  return Object.fromEntries(EVENT_TYPES.map((type) => [type, build(type)])) as Record<EventType, Template>;
}

function detailLines(type: EventType, icons: boolean): string {
  return DETAILS[type].map((d) => `${DETAIL_LABELS[d][icons ? "icon" : "text"]} {${d}}`).join("\n");
}

const iconTitle = (type: EventType) => `${ICONS[type]} {title}`;

/** Ready-made template sets. The first one is the built-in default. */
export const TEMPLATE_PRESETS: TemplatePreset[] = [
  { id: "default", label: "Default", templates: forEachEvent(() => DEFAULT_TEMPLATE) },
  { id: "minimal", label: "Minimalistic", templates: forEachEvent(() => ({ title: "{title}", body: "{time}" })) },
  {
    id: "detailed",
    label: "Detailed",
    templates: forEachEvent((type) => ({ title: "{title}", body: `{message}\n\n${detailLines(type, false)}` })),
  },
  {
    id: "icon-default",
    label: "Icon Default",
    templates: forEachEvent((type) => ({ title: iconTitle(type), body: "{message}" })),
  },
  {
    id: "icon-minimal",
    label: "Icon Minimalistic",
    templates: forEachEvent((type) => ({ title: iconTitle(type), body: "🕒 {time}" })),
  },
  {
    id: "icon-detailed",
    label: "Icon Detailed",
    templates: forEachEvent((type) => ({ title: iconTitle(type), body: `{message}\n\n${detailLines(type, true)}` })),
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
