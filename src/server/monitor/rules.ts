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

export type WakeInput = {
  now: number;
  restoredAt: number;
  upsOnline: boolean;
  upsBattery: number | null;
  device: { enabled: boolean; wakeEnabled: boolean; alwaysWake: boolean; mac: string | null; online: boolean };
  /** Last fresh observation of the device (agent hello/status or successful ping). */
  lastSeenAt: number | null;
  /** The device accepted a shutdown during this outage, so it is presumed off. */
  shutdownAcked: boolean;
  wasOnline: boolean;
  wakeAttempts: number;
  lastWakeAt: number | null;
};

export type WakeAction = "skip" | "wait" | "send" | "recovered" | "already_online" | "give_up";

export function planWake(input: WakeInput, s: WakeSettings): WakeAction {
  const { device } = input;
  if (!device.enabled || !device.wakeEnabled || !device.mac) return "skip";
  if (!input.wasOnline && !device.alwaysWake) return "skip";
  // A device that accepted a shutdown only counts as online once it is seen again after the restore.
  const online = device.online && (!input.shutdownAcked || (input.lastSeenAt ?? 0) > input.restoredAt);
  if (online) return input.wakeAttempts > 0 || input.shutdownAcked ? "recovered" : "already_online";
  const elapsed = input.now - input.restoredAt;
  if (elapsed > (s.restoreDelaySec + s.clientTimeoutSec) * 1000) return "give_up";
  if (elapsed < s.restoreDelaySec * 1000) return "wait";
  if (!input.upsOnline) return "wait";
  if (input.upsBattery === null || input.upsBattery < s.minBatteryPercent) return "wait";
  if (input.lastWakeAt !== null && input.now - input.lastWakeAt < s.reattemptDelaySec * 1000) return "wait";
  return "send";
}
