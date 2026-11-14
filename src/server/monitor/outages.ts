import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { devices, outageDevices, outages, ups } from "../db/schema";
import { emitEvent } from "../events";
import { formatDuration, formatRuntime } from "../format";
import type { UpsSnapshot } from "../nut/parse";

type UpsRow = typeof ups.$inferSelect;
export type OutageRow = typeof outages.$inferSelect;

export function openOutage(upsId: string): OutageRow | undefined {
  return db
    .select()
    .from(outages)
    .where(and(eq(outages.upsId, upsId), isNull(outages.endedAt)))
    .get();
}

/** Start an outage and remember which devices were online so only those get woken later. */
export function startOutage(row: UpsRow, snap: UpsSnapshot, at = new Date()): OutageRow {
  const outage = db.transaction((tx) => {
    const created = tx
      .insert(outages)
      .values({ upsId: row.id, startedAt: at, minBattery: snap.battery, lowBattery: snap.lowBattery })
      .returning()
      .get();
    const assigned = tx.select().from(devices).where(eq(devices.upsId, row.id)).all();
    for (const device of assigned) {
      tx.insert(outageDevices).values({ outageId: created.id, deviceId: device.id, wasOnline: device.online }).run();
    }
    return created;
  });
  emitEvent({
    type: "ups_on_battery",
    upsId: row.id,
    title: `${row.name} is on battery`,
    message: `${row.name} switched to battery at ${snap.battery ?? "?"}% (runtime ${formatRuntime(snap.runtime)})`,
    data: { ups: row.name, battery: snap.battery, runtime: snap.runtime, status: snap.status },
  });
  if (snap.lowBattery) emitLowBattery(row, snap);
  return outage;
}

function emitLowBattery(row: UpsRow, snap: UpsSnapshot) {
  emitEvent({
    type: "ups_low_battery",
    upsId: row.id,
    title: `${row.name} battery is low`,
    message: `${row.name} reports low battery at ${snap.battery ?? "?"}%`,
    data: { ups: row.name, battery: snap.battery, runtime: snap.runtime, status: snap.status },
  });
}

export function updateOutage(row: UpsRow, outage: OutageRow, snap: UpsSnapshot) {
  const minBattery =
    snap.battery === null ? outage.minBattery : Math.min(outage.minBattery ?? snap.battery, snap.battery);
  const lowBattery = outage.lowBattery || snap.lowBattery;
  if (minBattery !== outage.minBattery || lowBattery !== outage.lowBattery) {
    db.update(outages).set({ minBattery, lowBattery }).where(eq(outages.id, outage.id)).run();
  }
  if (snap.lowBattery && !outage.lowBattery) emitLowBattery(row, snap);
}

export function endOutage(row: UpsRow, outage: OutageRow, snap: UpsSnapshot, at = new Date()) {
  db.update(outages).set({ endedAt: at }).where(eq(outages.id, outage.id)).run();
  const duration = formatDuration(at.getTime() - outage.startedAt.getTime());
  emitEvent({
    type: "ups_power_restored",
    upsId: row.id,
    title: `${row.name} power restored`,
    message: `${row.name} is back on line power after ${duration}, battery at ${snap.battery ?? "?"}%`,
    data: { ups: row.name, battery: snap.battery, runtime: snap.runtime, status: snap.status, duration },
  });
}
