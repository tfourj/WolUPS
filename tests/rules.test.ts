import { describe, expect, test } from "bun:test";
import { planWake, shouldShutdown, type WakeInput } from "../src/server/monitor/rules";

const device = { enabled: true, shutdownEnabled: true, shutdownBatteryPercent: 30, shutdownRuntimeSec: null };

describe("shouldShutdown", () => {
  test("triggers at or below the battery threshold only on battery", () => {
    expect(shouldShutdown(device, { battery: 30, runtime: 900, onBattery: true })).toBe(true);
    expect(shouldShutdown(device, { battery: 31, runtime: 900, onBattery: true })).toBe(false);
    expect(shouldShutdown(device, { battery: 10, runtime: 900, onBattery: false })).toBe(false);
  });

  test("never acts on missing battery data", () => {
    expect(shouldShutdown(device, { battery: null, runtime: null, onBattery: true })).toBe(false);
  });

  test("honours the optional runtime threshold", () => {
    const d = { ...device, shutdownRuntimeSec: 300 };
    expect(shouldShutdown(d, { battery: 80, runtime: 299, onBattery: true })).toBe(true);
    expect(shouldShutdown(d, { battery: 80, runtime: 301, onBattery: true })).toBe(false);
  });

  test("respects disabled devices", () => {
    expect(shouldShutdown({ ...device, shutdownEnabled: false }, { battery: 5, runtime: 1, onBattery: true })).toBe(false);
    expect(shouldShutdown({ ...device, enabled: false }, { battery: 5, runtime: 1, onBattery: true })).toBe(false);
  });
});

describe("planWake", () => {
  const settings = { restoreDelaySec: 30, minBatteryPercent: 25, clientTimeoutSec: 600, reattemptDelaySec: 30 };
  const base: WakeInput = {
    now: 100_000,
    restoredAt: 0,
    upsOnline: true,
    upsBattery: 50,
    device: {
      enabled: true,
      wakeEnabled: true,
      alwaysWake: false,
      mac: "aa:bb:cc:dd:ee:ff",
      online: false,
      wakeDelaySec: null,
      wakeMinBatteryPercent: null,
    },
    lastSeenAt: null,
    shutdownAcked: true,
    wasOnline: true,
    wakeAttempts: 0,
    firstWakeAt: null,
    lastWakeAt: null,
  };

  test("sends after the restore delay", () => {
    expect(planWake(base, settings)).toBe("send");
    expect(planWake({ ...base, now: 10_000 }, settings)).toBe("wait");
  });

  test("waits for battery and line power", () => {
    expect(planWake({ ...base, upsBattery: 20 }, settings)).toBe("wait");
    expect(planWake({ ...base, upsOnline: false }, settings)).toBe("wait");
  });

  test("only wakes devices that were online unless always wake is set", () => {
    expect(planWake({ ...base, wasOnline: false }, settings)).toBe("skip");
    expect(planWake({ ...base, wasOnline: false, device: { ...base.device, alwaysWake: true } }, settings)).toBe("send");
    expect(planWake({ ...base, device: { ...base.device, mac: null } }, settings)).toBe("skip");
  });

  test("respects the retry delay and gives up after the timeout from the first wake packet", () => {
    const sent = { ...base, wakeAttempts: 1, firstWakeAt: 50_000 };
    expect(planWake({ ...sent, lastWakeAt: 90_000 }, settings)).toBe("wait");
    expect(planWake({ ...sent, lastWakeAt: 50_000 }, settings)).toBe("send");
    expect(planWake({ ...sent, now: 700_000, lastWakeAt: 680_000 }, settings)).toBe("give_up");
    // Without a wake packet yet, the same delay is not a give-up.
    expect(planWake({ ...base, now: 700_000 }, settings)).toBe("send");
  });

  test("uses per-device delay and battery level over the global settings", () => {
    const picky = { ...base, device: { ...base.device, wakeDelaySec: 120, wakeMinBatteryPercent: 80 } };
    expect(planWake({ ...picky, now: 60_000 }, settings)).toBe("wait");
    expect(planWake({ ...picky, now: 130_000, upsBattery: 50 }, settings)).toBe("wait");
    expect(planWake({ ...picky, now: 130_000, upsBattery: 80 }, settings)).toBe("send");
  });

  test("stops waiting after 24 hours when conditions are never met", () => {
    const picky = { ...base, device: { ...base.device, wakeMinBatteryPercent: 90 }, upsBattery: 60 };
    expect(planWake({ ...picky, now: 23 * 3_600_000 }, settings)).toBe("wait");
    expect(planWake({ ...picky, now: 25 * 3_600_000 }, settings)).toBe("expired");
  });

  test("a stale online flag does not count after an accepted shutdown", () => {
    const stale = { ...base, device: { ...base.device, online: true }, lastSeenAt: -5_000 };
    expect(planWake(stale, settings)).toBe("send");
    expect(planWake({ ...stale, lastSeenAt: 95_000 }, settings)).toBe("recovered");
    expect(planWake({ ...stale, shutdownAcked: false }, settings)).toBe("already_online");
  });
});
