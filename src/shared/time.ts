export const TIME_FORMATS = ["auto", "12h", "24h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

/** "relative" shows recent times like "5 minutes ago", "absolute" always shows the date and time. */
export const TIME_STYLES = ["relative", "absolute"] as const;
export type TimeStyle = (typeof TIME_STYLES)[number];

export type TimePreferences = {
  /** IANA timezone, null to use the default (the browser in the app, `TZ` for notifications). */
  timezone: string | null;
  timeFormat: TimeFormat;
  timeStyle: TimeStyle;
};

export const DEFAULT_TIME_PREFERENCES: TimePreferences = { timezone: null, timeFormat: "auto", timeStyle: "relative" };

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `hourCycle` option for Intl, undefined lets the locale decide. */
export function hourCycleFor(format: TimeFormat): "h12" | "h23" | undefined {
  if (format === "12h") return "h12";
  if (format === "24h") return "h23";
  return undefined;
}

/**
 * "1 Jan 2026, 19:00:00" for `{time}` in notifications. "auto" uses 24-hour time since the server does not know the
 * reader's locale. An undefined timezone uses the server's.
 */
export function formatEventTime(date: Date, timeZone: string | undefined, timeFormat: TimeFormat = "auto"): string {
  const hourCycle = timeFormat === "12h" ? "h12" : "h23";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", hourCycle, timeZone }).format(
    date,
  );
}
