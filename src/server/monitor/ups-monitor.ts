import { eq, lt } from "drizzle-orm";
import { db } from "../db/client";
import { events, ups, upsSamples } from "../db/schema";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import { fetchUpsSnapshot, type NutTarget } from "../nut/client";
import { powerState, type UpsSnapshot } from "../nut/parse";
import { box } from "../secrets";
import { getSettings } from "../settings";
import { endOutage, openOutage, startOutage, updateOutage, type OutageRow } from "./outages";

const log = createLogger("monitor");

export type UpsRow = typeof ups.$inferSelect;

/** Consecutive failed polls before a UPS is reported unreachable. */
const UNREACHABLE_AFTER = 3;

export type BatteryHook = (row: UpsRow, snap: UpsSnapshot, outage: OutageRow) => Promise<void> | void;
export type TickHook = () => Promise<void> | void;

export function nutTarget(row: UpsRow): NutTarget {
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.passwordEnc ? box.decrypt(row.passwordEnc) : null,
  };
}

class UpsMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = new Map<string, number>();
  private unreachable = new Set<string>();
  private lastSample = new Map<string, number>();
  private lastPrune = 0;
  private batteryHooks: BatteryHook[] = [];
  private tickHooks: TickHook[] = [];

  onBattery(hook: BatteryHook) {
    this.batteryHooks.push(hook);
  }

  onTick(hook: TickHook) {
    this.tickHooks.push(hook);
  }

  start() {
    for (const row of db.select().from(ups).all()) {
      if (!row.reachable && row.lastError) this.unreachable.add(row.id);
    }
    log.info("ups monitor started");
    void this.loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop() {
    const started = Date.now();
    try {
      await this.tick();
    } catch (error) {
      log.error("monitor tick failed", { error });
    }
    const interval = getSettings().pollIntervalSec * 1000;
    this.timer = setTimeout(() => void this.loop(), Math.max(1000, interval - (Date.now() - started)));
  }

  /** Poll now, outside the regular schedule (used after the UPS list changes). */
  pollNow() {
    if (this.timer) clearTimeout(this.timer);
    void this.loop();
  }

  async tick() {
    const rows = db.select().from(ups).where(eq(ups.enabled, true)).all();
    await Promise.all(rows.map((row) => this.pollOne(row)));
    for (const hook of this.tickHooks) {
      try {
        await hook();
      } catch (error) {
        log.error("tick hook failed", { error });
      }
    }
    this.prune();
  }

  private async pollOne(row: UpsRow) {
    let snap: UpsSnapshot;
    try {
      snap = await fetchUpsSnapshot(nutTarget(row), row.upsName);
    } catch (error) {
      this.handleFailure(row, error instanceof Error ? error.message : String(error));
      return;
    }
    this.handleSuccess(row, snap);

    const state = powerState(snap);
    let outage = openOutage(row.id);
    if (state === "battery") {
      if (!outage) outage = startOutage(row, snap);
      else updateOutage(row, outage, snap);
      for (const hook of this.batteryHooks) {
        try {
          await hook(row, snap, outage);
        } catch (error) {
          log.error("battery hook failed", { error, ups: row.name });
        }
      }
    } else if (state === "online" && outage) {
      endOutage(row, outage, snap);
    }
  }

  private handleFailure(row: UpsRow, message: string) {
    const count = (this.failures.get(row.id) ?? 0) + 1;
    this.failures.set(row.id, count);
    log.warn("ups poll failed", { ups: row.name, error: message, failures: count });
    const markUnreachable = count >= UNREACHABLE_AFTER && !this.unreachable.has(row.id);
    db.update(ups)
      .set({ lastError: message, lastPolledAt: new Date(), ...(count >= UNREACHABLE_AFTER ? { reachable: false } : {}) })
      .where(eq(ups.id, row.id))
      .run();
    if (markUnreachable) {
      this.unreachable.add(row.id);
      emitEvent({
        type: "ups_unreachable",
        upsId: row.id,
        title: `${row.name} is unreachable`,
        message: `Cannot read ${row.name} from NUT: ${message}`,
        data: { ups: row.name, error: message },
      });
    }
  }

  private handleSuccess(row: UpsRow, snap: UpsSnapshot) {
    const recovered = this.unreachable.delete(row.id);
    this.failures.set(row.id, 0);
    const now = new Date();
    db.update(ups)
      .set({
        reachable: true,
        lastError: null,
        lastPolledAt: now,
        status: snap.status,
        battery: snap.battery,
        runtime: snap.runtime,
        load: snap.load,
        inputVoltage: snap.inputVoltage,
        model: snap.model,
      })
      .where(eq(ups.id, row.id))
      .run();
    if (recovered) {
      emitEvent({
        type: "ups_reachable",
        upsId: row.id,
        title: `${row.name} is reachable again`,
        message: `${row.name} is responding again (${snap.status}, ${snap.battery ?? "?"}%)`,
        data: { ups: row.name, battery: snap.battery, status: snap.status },
      });
    }
    const sampleEvery = getSettings().sampleIntervalSec * 1000;
    const last = this.lastSample.get(row.id) ?? 0;
    if (now.getTime() - last >= sampleEvery || row.status !== snap.status) {
      this.lastSample.set(row.id, now.getTime());
      db.insert(upsSamples)
        .values({
          upsId: row.id,
          ts: now,
          status: snap.status,
          battery: snap.battery,
          runtime: snap.runtime,
          load: snap.load,
          inputVoltage: snap.inputVoltage,
        })
        .run();
    }
  }

  private prune() {
    const now = Date.now();
    if (now - this.lastPrune < 60 * 60 * 1000) return;
    this.lastPrune = now;
    const s = getSettings();
    db.delete(upsSamples).where(lt(upsSamples.ts, new Date(now - s.sampleRetentionDays * 86400_000))).run();
    db.delete(events).where(lt(events.createdAt, new Date(now - s.eventRetentionDays * 86400_000))).run();
  }
}

export const upsMonitor = new UpsMonitor();
