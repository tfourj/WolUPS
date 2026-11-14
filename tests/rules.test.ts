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
    device: { enabled: true, wakeEnabled: true, alwaysWake: false, mac: "aa:bb:cc:dd:ee:ff", online: false },
    lastSeenAt: null,
    shutdownAcked: true,
    wasOnline: true,
    wakeAttempts: 0,
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

  test("respects the retry delay and gives up after the timeout", () => {
    expect(planWake({ ...base, wakeAttempts: 1, lastWakeAt: 90_000 }, settings)).toBe("wait");
    expect(planWake({ ...base, wakeAttempts: 1, lastWakeAt: 50_000 }, settings)).toBe("send");
    expect(planWake({ ...base, now: 700_000 }, settings)).toBe("give_up");
  });

  test("a stale online flag does not count after an accepted shutdown", () => {
    const stale = { ...base, device: { ...base.device, online: true }, lastSeenAt: -5_000 };
    expect(planWake(stale, settings)).toBe("send");
    expect(planWake({ ...stale, lastSeenAt: 95_000 }, settings)).toBe("recovered");
    expect(planWake({ ...stale, shutdownAcked: false }, settings)).toBe("already_online");
  });
});
