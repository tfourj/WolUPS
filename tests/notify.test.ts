import { describe, expect, test } from "bun:test";
import { backoffMs, channelMatches } from "../src/server/notify/dispatcher";
import { mergeConfig, publicConfig, type ChannelRow } from "../src/server/notify/channels";

function channel(partial: Partial<ChannelRow>): ChannelRow {
  return {
    id: "c",
    name: "c",
    type: "ntfy",
    configEnc: "",
    enabled: true,
    events: ["ups_on_battery"],
    upsIds: null,
    deviceIds: null,
    titleTemplate: null,
    bodyTemplate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

describe("channel filters", () => {
  const event = { type: "ups_on_battery", upsId: "u1", deviceId: null };

  test("match on event type and enabled state", () => {
    expect(channelMatches(channel({}), event)).toBe(true);
    expect(channelMatches(channel({ enabled: false }), event)).toBe(false);
    expect(channelMatches(channel({ events: ["shutdown_failed"] }), event)).toBe(false);
  });

  test("UPS and device filters only apply when the event has that id", () => {
    expect(channelMatches(channel({ upsIds: ["u2"] }), event)).toBe(false);
    expect(channelMatches(channel({ upsIds: ["u1"] }), event)).toBe(true);
    expect(channelMatches(channel({ deviceIds: ["d1"] }), event)).toBe(true);
    const deviceEvent = { type: "ups_on_battery", upsId: null, deviceId: "d2" };
    expect(channelMatches(channel({ deviceIds: ["d1"] }), deviceEvent)).toBe(false);
  });

  test("a grouped agent update matches a device filter on any of its devices", () => {
    const grouped = { type: "agent_updated", upsId: null, deviceId: null, data: { deviceIds: ["d1", "d2"] } };
    const events = ["agent_updated"];
    expect(channelMatches(channel({ events, deviceIds: ["d2"] }), grouped)).toBe(true);
    expect(channelMatches(channel({ events, deviceIds: ["d3"] }), grouped)).toBe(false);
  });
});

describe("retry backoff", () => {
  test("doubles and caps at 30 minutes", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});

describe("channel config", () => {
  test("keeps stored secrets when the field is left empty", () => {
    const stored = { serverUrl: "https://ntfy.sh", topic: "t", token: "secret", priority: "auto" };
    const { config, errors } = mergeConfig("ntfy", { serverUrl: "https://ntfy.sh", topic: "t2", token: "" }, stored);
    expect(errors).toEqual([]);
    expect(config).toMatchObject({ topic: "t2", token: "secret" });
  });

  test("validates required fields and urls", () => {
    expect(mergeConfig("gotify", { serverUrl: "gotify.lan" }).errors).toEqual([
      "Server URL must start with http:// or https://",
      "App token is required",
    ]);
  });

  test("never exposes secret values", () => {
    const view = publicConfig("telegram", { botToken: "123:abc", chatId: "42" });
    expect(view.values).toEqual({ chatId: "42" });
    expect(view.secretsSet).toEqual({ botToken: true });
  });
});
