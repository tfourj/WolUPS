import type { Severity } from "../../../shared/events";

export type NotificationMessage = {
  title: string;
  body: string;
  severity: Severity;
  event: string;
  time: Date;
  data: Record<string, unknown>;
};

export type ChannelConfig = Record<string, string | number | undefined>;

export type Provider = (config: ChannelConfig, message: NotificationMessage) => Promise<void>;

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "User-Agent": "WolUPS", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  await ensureOk(res);
}

export async function ensureOk(res: Response) {
  if (res.ok) return;
  const text = (await res.text().catch(() => "")).slice(0, 300);
  throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
}

export function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

/** Map a priority setting to 1-5. "auto" derives it from the event severity. */
export function priority(config: ChannelConfig, severity: Severity): number {
  const raw = str(config, "priority");
  if (raw && raw !== "auto") {
    const n = Number(raw);
    if (n >= 1 && n <= 5) return n;
  }
  return { error: 5, warning: 4, success: 3, info: 3 }[severity];
}
