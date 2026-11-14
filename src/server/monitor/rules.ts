/** Pure decision rules for shutdown and wake, kept free of I/O so they are easy to test. */

export type ShutdownPolicy = {
  enabled: boolean;
  shutdownEnabled: boolean;
  shutdownBatteryPercent: number;
  shutdownRuntimeSec: number | null;
};

export type BatteryReading = { battery: number | null; runtime: number | null; onBattery: boolean };

/** Shut down only on explicit on-battery data at or below the device's battery or runtime threshold. */
export function shouldShutdown(device: ShutdownPolicy, reading: BatteryReading): boolean {
  if (!device.enabled || !device.shutdownEnabled || !reading.onBattery) return false;
  if (reading.battery !== null && reading.battery <= device.shutdownBatteryPercent) return true;
  if (device.shutdownRuntimeSec !== null && reading.runtime !== null && reading.runtime <= device.shutdownRuntimeSec) {
    return true;
  }
  return false;
}

export type WakeSettings = {
  restoreDelaySec: number;
  minBatteryPercent: number;
  clientTimeoutSec: number;
  reattemptDelaySec: number;
};

/** Stop waiting for wake conditions (battery level, stable power) after this long. */
export const MAX_WAKE_WAIT_MS = 24 * 60 * 60 * 1000;

export type WakeDevice = {
  enabled: boolean;
  wakeEnabled: boolean;
  alwaysWake: boolean;
  mac: string | null;
  online: boolean;
  /** Per-device overrides; null uses the global settings. */
  wakeDelaySec: number | null;
  wakeMinBatteryPercent: number | null;
};

export type WakeInput = {
  now: number;
  restoredAt: number;
  upsOnline: boolean;
  upsBattery: number | null;
  device: WakeDevice;
  /** Last fresh observation of the device (agent hello/status or successful ping). */
  lastSeenAt: number | null;
  /** The device accepted a shutdown during this outage, so it is presumed off. */
  shutdownAcked: boolean;
  /** The device accepted a shutdown and is still reachable while it stops services. */
  shuttingDown: boolean;
  wasOnline: boolean;
  wakeAttempts: number;
  firstWakeAt: number | null;
  lastWakeAt: number | null;
};

/**
 * give_up: wake packets were sent but the device stayed offline for the client timeout.
 * expired: the wake conditions (delay, battery) were never met within MAX_WAKE_WAIT_MS.
 */
export type WakeAction = "skip" | "wait" | "send" | "recovered" | "already_online" | "give_up" | "expired";

/** The delay and battery level a device waits for, with per-device values over the global ones. */
export function wakeConditions(device: Pick<WakeDevice, "wakeDelaySec" | "wakeMinBatteryPercent">, s: WakeSettings) {
  return {
    delaySec: device.wakeDelaySec ?? s.restoreDelaySec,
    minBatteryPercent: device.wakeMinBatteryPercent ?? s.minBatteryPercent,
  };
}

export function planWake(input: WakeInput, s: WakeSettings): WakeAction {
  const { device } = input;
  if (!device.enabled || !device.wakeEnabled || !device.mac) return "skip";
  if (!input.wasOnline && !device.alwaysWake) return "skip";
  // Still stopping services after the shutdown (power may already be back): wait until it is really off.
  if (input.shuttingDown) return "wait";
  // A device that accepted a shutdown only counts as online once it is seen again after the restore.
  const online = device.online && (!input.shutdownAcked || (input.lastSeenAt ?? 0) > input.restoredAt);
  if (online) return input.wakeAttempts > 0 || input.shutdownAcked ? "recovered" : "already_online";

  // The give-up timer starts with the first wake packet, so waiting for a high battery level does not count.
  if (input.firstWakeAt !== null) {
    if (input.now - input.firstWakeAt > s.clientTimeoutSec * 1000) return "give_up";
  } else if (input.now - input.restoredAt > MAX_WAKE_WAIT_MS) {
    return "expired";
  }

  const { delaySec, minBatteryPercent } = wakeConditions(device, s);
  if (input.now - input.restoredAt < delaySec * 1000) return "wait";
  if (!input.upsOnline) return "wait";
  if (input.upsBattery === null || input.upsBattery < minBatteryPercent) return "wait";
  if (input.lastWakeAt !== null && input.now - input.lastWakeAt < s.reattemptDelaySec * 1000) return "wait";
  return "send";
}
