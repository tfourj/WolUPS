import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { devices, outageDevices, outages, ups } from "../db/schema";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import { wakeDevice } from "../wol/send";
import { openOutage } from "./outages";
import { MAX_WAKE_WAIT_MS, planWake, wakeConditions } from "./rules";

const log = createLogger("wake");

let running = false;

/** Runs after each poll without blocking it. Overlapping runs are skipped. */
export function scheduleWakes() {
  if (running) return;
  running = true;
  processWakes()
    .catch((error) => log.error("wake processing failed", { error }))
    .finally(() => {
      running = false;
    });
}

/** Wakes devices that were online before a finished outage. */
export async function processWakes(now = Date.now()) {
  const s = getSettings().wake;
  // Devices may wait hours for a high battery level, plus the timeout after the first wake packet.
  const windowMs = MAX_WAKE_WAIT_MS + s.clientTimeoutSec * 1000 + 60_000;
  const recent = db
    .select()
    .from(outages)
    .where(and(isNotNull(outages.endedAt), gt(outages.endedAt, new Date(now - windowMs))))
    .all();

  for (const outage of recent) {
    const upsRow = db.select().from(ups).where(eq(ups.id, outage.upsId)).get();
    if (!upsRow) continue;
    // A newer outage on the same UPS takes over; its own device list decides who gets woken.
    const newer = db
      .select({ id: outages.id })
      .from(outages)
      .where(and(eq(outages.upsId, outage.upsId), gt(outages.startedAt, outage.startedAt)))
      .get();
    if (newer) continue;
    const upsOnline = !openOutage(upsRow.id) && upsRow.reachable;
    const pending = db
      .select({ od: outageDevices, device: devices })
      .from(outageDevices)
      .innerJoin(devices, eq(outageDevices.deviceId, devices.id))
      .where(
        and(
          eq(outageDevices.outageId, outage.id),
          isNull(outageDevices.recoveredAt),
          isNull(outageDevices.wakeGaveUpAt),
        ),
      )
      .all();

    for (const { od, device } of pending) {
      const action = planWake(
        {
          now,
          restoredAt: outage.endedAt!.getTime(),
          upsOnline,
          upsBattery: upsRow.battery,
          device,
          lastSeenAt: device.lastSeenAt?.getTime() ?? null,
          shutdownAcked: od.shutdownAckedAt !== null,
          wasOnline: od.wasOnline,
          wakeAttempts: od.wakeAttempts,
          firstWakeAt: od.firstWakeAt?.getTime() ?? null,
          lastWakeAt: od.lastWakeAt?.getTime() ?? null,
        },
        s,
      );
      const where = and(eq(outageDevices.outageId, od.outageId), eq(outageDevices.deviceId, od.deviceId));

      if (action === "already_online") {
        db.update(outageDevices).set({ recoveredAt: new Date(now) }).where(where).run();
      } else if (action === "recovered") {
        db.update(outageDevices).set({ recoveredAt: new Date(now) }).where(where).run();
        emitEvent({
          type: "device_recovered",
          deviceId: device.id,
          upsId: upsRow.id,
          title: `${device.name} is back online`,
          message: `${device.name} came back online after power was restored on ${upsRow.name}`,
          data: { device: device.name, ups: upsRow.name },
        });
      } else if (action === "give_up") {
        db.update(outageDevices).set({ wakeGaveUpAt: new Date(now) }).where(where).run();
        emitEvent({
          type: "wake_failed",
          deviceId: device.id,
          upsId: upsRow.id,
          title: `${device.name} did not come back`,
          message:
            `${device.name} is still offline ${s.clientTimeoutSec}s after the first wake packet ` +
            `(${od.wakeAttempts} attempts)`,
          data: { device: device.name, ups: upsRow.name, attempts: od.wakeAttempts },
        });
      } else if (action === "expired") {
        db.update(outageDevices).set({ wakeGaveUpAt: new Date(now) }).where(where).run();
        const { minBatteryPercent } = wakeConditions(device, s);
        emitEvent({
          type: "wake_failed",
          deviceId: device.id,
          upsId: upsRow.id,
          title: `${device.name} was not woken`,
          message:
            `${device.name} was not woken: ${upsRow.name} did not reach ${minBatteryPercent}% ` +
            `on line power within 24 hours`,
          data: { device: device.name, ups: upsRow.name, battery: upsRow.battery, threshold: minBatteryPercent },
        });
      } else if (action === "send") {
        db.update(outageDevices)
          .set({
            wakeAttempts: od.wakeAttempts + 1,
            firstWakeAt: od.firstWakeAt ?? new Date(now),
            lastWakeAt: new Date(now),
          })
          .where(where)
          .run();
        const result = await wakeDevice(device);
        if (od.wakeAttempts === 0) {
          emitEvent({
            type: result.ok ? "wake_sent" : "wake_failed",
            deviceId: device.id,
            upsId: upsRow.id,
            title: result.ok ? `Waking ${device.name}` : `Could not wake ${device.name}`,
            message: result.ok
              ? `Sent wake packet to ${device.name} via ${result.via.join(", ")}`
              : `Wake packet for ${device.name} failed: ${result.errors.join("; ")}`,
            data: { device: device.name, ups: upsRow.name, battery: upsRow.battery, via: result.via },
          });
        }
        if (!result.ok) log.warn("wake failed", { device: device.name, errors: result.errors });
      }
    }
  }
}

/** Manual wake from the UI. */
export async function wakeNow(deviceId: string) {
  const device = db.select().from(devices).where(eq(devices.id, deviceId)).get();
  if (!device) return { ok: false, via: [], errors: ["device not found"] };
  const result = await wakeDevice(device);
  emitEvent({
    type: result.ok ? "wake_sent" : "wake_failed",
    deviceId,
    title: result.ok ? `Waking ${device.name}` : `Could not wake ${device.name}`,
    message: result.ok
      ? `Sent wake packet to ${device.name} via ${result.via.join(", ")}`
      : `Wake packet for ${device.name} failed: ${result.errors.join("; ")}`,
    data: { device: device.name, via: result.via, reason: "manual" },
  });
  return result;
}
