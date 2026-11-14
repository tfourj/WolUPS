import { DEFAULT_TEMPLATE, type EventType } from "./events";

export type TemplateVars = Record<string, string>;

export type Template = { title: string; body: string };

/** Replace {name} placeholders. Unknown placeholders are left untouched. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{([a-z_]+)\}/gi, (match, name: string) => (name in vars ? vars[name] : match));
}

/** Channel override first, then the global template for the event type, then the default. */
export function resolveTemplate(
  eventType: string,
  global: Record<string, Template>,
  channel: { titleTemplate?: string | null; bodyTemplate?: string | null },
): Template {
  const base = global[eventType] ?? DEFAULT_TEMPLATE;
  return {
    title: channel.titleTemplate?.trim() ? channel.titleTemplate : base.title,
    body: channel.bodyTemplate?.trim() ? channel.bodyTemplate : base.body,
  };
}

type Sample = { title: string; message: string; vars?: Partial<TemplateVars> };

const SAMPLE_VARS: TemplateVars = {
  ups: "Rack UPS",
  device: "nas",
  battery: "42%",
  runtime: "14m 0s",
  status: "OB",
  threshold: "30%",
  version: "1.4.0",
};

/** Agent events carry no UPS data. */
const AGENT_VARS: Partial<TemplateVars> = { ups: "", battery: "", runtime: "", status: "", threshold: "" };

/** Example events used to preview templates in the UI. */
const SAMPLES: Record<EventType, Sample> = {
  ups_on_battery: {
    title: "Rack UPS is on battery",
    message: "Rack UPS switched to battery at 98% (runtime 42m 0s)",
    vars: { battery: "98%", runtime: "42m 0s", device: "" },
  },
  ups_power_restored: {
    title: "Rack UPS power restored",
    message: "Rack UPS is back on line power after 12m 30s, battery at 64%",
    vars: { battery: "64%", status: "OL CHRG", device: "" },
  },
  ups_low_battery: {
    title: "Rack UPS battery is low",
    message: "Rack UPS reports low battery at 18%",
    vars: { battery: "18%", runtime: "3m 20s", status: "OB LB", device: "" },
  },
  ups_unreachable: {
    title: "Rack UPS is unreachable",
    message: "Cannot read Rack UPS from NUT: connection refused",
    vars: { battery: "", runtime: "", status: "", device: "" },
  },
  ups_reachable: {
    title: "Rack UPS is reachable again",
    message: "Rack UPS is responding again (OL, 100%)",
    vars: { battery: "100%", runtime: "", status: "OL", device: "" },
  },
  shutdown_sent: {
    title: "Shutting down nas",
    message: "Rack UPS is at 28%, sending shutdown to nas (threshold 30%)",
    vars: { battery: "28%" },
  },
  shutdown_acknowledged: {
    title: "nas is shutting down",
    message: "nas accepted shutdown at 28% UPS charge",
    vars: { battery: "28%" },
  },
  shutdown_failed: {
    title: "Cannot reach nas",
    message: "nas should shut down at 28% but its agent is not connected. WolUPS keeps retrying.",
    vars: { battery: "28%" },
  },
  wake_sent: {
    title: "Waking nas",
    message: "Sent wake packet to nas via server",
    vars: { battery: "64%", status: "OL" },
  },
  wake_failed: {
    title: "Could not wake nas",
    message: "Wake packet for nas failed: no agent on the subnet",
    vars: { battery: "64%", status: "OL" },
  },
  device_recovered: {
    title: "nas is back online",
    message: "nas came back online after power was restored on Rack UPS",
    vars: { battery: "", status: "OL" },
  },
  agent_connected: {
    title: "nas connected",
    message: "Agent on nas connected (v1.4.0)",
    vars: AGENT_VARS,
  },
  agent_disconnected: {
    title: "nas disconnected",
    message: "Agent on nas lost its connection",
    vars: AGENT_VARS,
  },
  agent_enrolled: {
    title: "nas paired",
    message: "Agent on nas paired with nas (v1.4.0)",
    vars: AGENT_VARS,
  },
  agent_update_available: {
    title: "Agent update available for nas",
    message: "Agent v1.5.0 is available for nas (running v1.4.0)",
    vars: { ...AGENT_VARS, version: "1.5.0" },
  },
  agent_updated: {
    title: "nas updated",
    message: "Agent on nas updated from v1.4.0 to v1.5.0",
    vars: { ...AGENT_VARS, version: "1.5.0" },
  },
  agent_update_failed: {
    title: "Agent update failed on nas",
    message: "Agent on nas could not update: checksum mismatch",
    vars: AGENT_VARS,
  },
  test: {
    title: "WolUPS test notification",
    message: 'This is a test from WolUPS for channel "Phone".',
  },
};

/** Variables for an example event of the given type, as the server would build them. */
export function sampleTemplateVars(eventType: EventType, now = new Date()): TemplateVars {
  const sample = SAMPLES[eventType];
  const time = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" }).format(now);
  return {
    ...SAMPLE_VARS,
    ...sample.vars,
    event: eventType,
    title: sample.title,
    message: sample.message,
    time,
  } as TemplateVars;
}

/** Render a template against an example event of the given type. */
export function previewTemplate(eventType: EventType, template: Template, now = new Date()): Template {
  const vars = sampleTemplateVars(eventType, now);
  return { title: renderTemplate(template.title, vars), body: renderTemplate(template.body, vars) };
}
