import { formatRuntime } from "../format";
import type { EventType } from "../../shared/events";
import type { TemplateVars } from "../../shared/templates";

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
