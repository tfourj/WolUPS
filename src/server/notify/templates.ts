import { formatRuntime } from "../format";
import { DEFAULT_TEMPLATE, type EventType } from "../../shared/events";

export type TemplateVars = Record<string, string>;

/** Replace {name} placeholders. Unknown placeholders are left untouched. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{([a-z_]+)\}/gi, (match, name: string) => (name in vars ? vars[name] : match));
}

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: process.env.TZ || undefined,
  }).format(date);
}

export type TemplateEvent = {
  type: EventType | string;
  title: string;
  message: string;
  createdAt: Date;
  data?: Record<string, unknown> | null;
};

export function templateVars(event: TemplateEvent): TemplateVars {
  const d = event.data ?? {};
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return {
    event: event.type,
    title: event.title,
    message: event.message,
    ups: str(d.ups),
    device: str(d.device),
    battery: d.battery === null || d.battery === undefined ? "" : `${d.battery}%`,
    runtime: typeof d.runtime === "number" ? formatRuntime(d.runtime) : "",
    status: str(d.status),
    threshold: d.threshold === null || d.threshold === undefined ? "" : `${d.threshold}%`,
    version: str(d.version),
    time: formatTime(event.createdAt),
  };
}

export type Template = { title: string; body: string };

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
