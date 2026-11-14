import { DEFAULT_TEMPLATE } from "./events";

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
