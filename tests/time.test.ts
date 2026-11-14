import { afterEach, describe, expect, test } from "bun:test";
import { templateVars } from "../src/server/notify/templates";
import { appSettingsSchema, updateSettings } from "../src/server/settings";
import { previewTemplate } from "../src/shared/templates";
import { DEFAULT_TIME_PREFERENCES, formatEventTime, hourCycleFor, isValidTimeZone } from "../src/shared/time";

const at = new Date("2026-01-01T19:05:00Z");

describe("time display", () => {
  afterEach(() => updateSettings({ time: DEFAULT_TIME_PREFERENCES }));

  test("formats event times in the given timezone and clock", () => {
    expect(formatEventTime(at, "UTC")).toContain("19:05:00");
    expect(formatEventTime(at, "Europe/Ljubljana", "24h")).toContain("20:05:00");
    expect(formatEventTime(at, "Europe/Ljubljana", "12h")).toContain("8:05:00 pm");
  });

  test("maps the clock to an hour cycle", () => {
    expect(hourCycleFor("auto")).toBeUndefined();
    expect(hourCycleFor("12h")).toBe("h12");
    expect(hourCycleFor("24h")).toBe("h23");
  });

  test("validates timezones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(appSettingsSchema.parse({}).time).toEqual(DEFAULT_TIME_PREFERENCES);
    expect(appSettingsSchema.safeParse({ time: { timezone: "Mars/Base" } }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ time: { timeFormat: "36h" } }).success).toBe(false);
  });

  test("notification times follow the saved time display", () => {
    updateSettings({ time: { timezone: "Europe/Ljubljana", timeFormat: "12h", timeStyle: "relative" } });
    const vars = templateVars({ type: "test", title: "T", message: "M", createdAt: at });
    expect(vars.time).toContain("8:05:00 pm");
  });

  test("template previews use the given time options", () => {
    const template = { title: "{time}", body: "" };
    const preview = previewTemplate("test", template, at, { timeZone: "UTC", timeFormat: "12h" });
    expect(preview.title).toContain("7:05:00 pm");
  });
});
