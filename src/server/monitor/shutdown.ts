import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, commands, devices, outageDevices } from "../db/schema";
import { agentHub } from "../agents/hub";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import type { UpsSnapshot } from "../nut/parse";
import { getSettings } from "../settings";
import type { OutageRow } from "./outages";
import { shouldShutdown } from "./rules";
import type { UpsRow } from "./ups-monitor";

const log = createLogger("shutdown");

const SHUTDOWN_TTL_MS = 10 * 60 * 1000;

function outageDevice(outageId: string, device: typeof devices.$inferSelect) {
  const existing = db
    .select()
    .from(outageDevices)
    .where(and(eq(outageDevices.outageId, outageId), eq(outageDevices.deviceId, device.id)))
    .get();
  if (existing) return existing;
  return db
    .insert(outageDevices)
    .values({ outageId, deviceId: device.id, wasOnline: device.online })
    .returning()
    .get();
}

/**
 * Called on every poll while a UPS is on battery. Each device gets one stable command per
 * outage; it is resent until the agent acknowledges it, and the agent ignores duplicates.
 */
export function processShutdowns(row: UpsRow, snap: UpsSnapshot, outage: OutageRow) {
  const assigned = db
    .select({ device: devices, agent: agents })
    .from(devices)
    .innerJoin(agents, eq(agents.deviceId, devices.id))
    .where(eq(devices.upsId, row.id))
    .all();
  const retryMs = Math.max(getSettings().pollIntervalSec, 5) * 1000;

  for (const { device, agent } of assigned) {
    if (!shouldShutdown(device, { battery: snap.battery, runtime: snap.runtime, onBattery: snap.onBattery })) continue;
    const od = outageDevice(outage.id, device);
    if (od.shutdownAckedAt) continue;

    const existing = od.shutdownCommandId
      ? db.select().from(commands).where(eq(commands.id, od.shutdownCommandId)).get()
      : undefined;
    const usable = existing && existing.expiresAt.getTime() > Date.now() && existing.status !== "failed";

    if (!usable) {
      const command = agentHub.send(
        agent.id,
        "shutdown",
        {
          reason: "battery",
          ups: row.name,
          battery: snap.battery,
          runtime: snap.runtime,
          threshold: device.shutdownBatteryPercent,
        },
        { ttlMs: SHUTDOWN_TTL_MS, outageId: outage.id },
      );
      const first = !od.shutdownCommandId;
      db.update(outageDevices)
        .set({ shutdownCommandId: command.id, shutdownSentAt: new Date(), shutdownError: null })
        .where(and(eq(outageDevices.outageId, outage.id), eq(outageDevices.deviceId, device.id)))
        .run();
      if (first) {
        emitEvent({
          type: "shutdown_sent",
          upsId: row.id,
          deviceId: device.id,
          title: `Shutting down ${device.name}`,
          message: `${row.name} is at ${snap.battery ?? "?"}%, sending shutdown to ${device.name} (threshold ${device.shutdownBatteryPercent}%)`,
          data: { ups: row.name, device: device.name, battery: snap.battery, runtime: snap.runtime, threshold: device.shutdownBatteryPercent },
        });
      }
      log.warn("shutdown command queued", { device: device.name, battery: snap.battery, connected: agentHub.isConnected(agent.id) });
    } else if (existing.sentAt && Date.now() - existing.sentAt.getTime() >= retryMs) {
      agentHub.resend(existing.id);
    }

    if (!agentHub.isConnected(agent.id) && !od.shutdownFailureNotified) {
      db.update(outageDevices)
        .set({ shutdownFailureNotified: true, shutdownError: "agent is not connected" })
        .where(and(eq(outageDevices.outageId, outage.id), eq(outageDevices.deviceId, device.id)))
        .run();
      emitEvent({
        type: "shutdown_failed",
        upsId: row.id,
        deviceId: device.id,
        title: `Cannot reach ${device.name}`,
        message: `${device.name} should shut down at ${snap.battery ?? "?"}% but its agent is not connected. WolUPS keeps retrying.`,
        data: { ups: row.name, device: device.name, battery: snap.battery, threshold: device.shutdownBatteryPercent },
      });
    }
  }
}

/** Manual shutdown from the UI. */
export async function shutdownNow(deviceId: string) {
  const row = db
    .select({ device: devices, agent: agents })
    .from(devices)
    .innerJoin(agents, eq(agents.deviceId, devices.id))
    .where(eq(devices.id, deviceId))
    .get();
  if (!row) return { ok: false, error: "device has no paired agent" };
  emitEvent({
    type: "shutdown_sent",
    deviceId,
    title: `Shutting down ${row.device.name}`,
    message: `Manual shutdown sent to ${row.device.name}`,
    data: { device: row.device.name, reason: "manual" },
  });
  return agentHub.sendAndWait(row.agent.id, "shutdown", { reason: "manual" }, 15_000);
}

agentHub.onAck((command, ack) => {
  if (command.type !== "shutdown") return;
  if (ack.result?.duplicate) return;
  const agent = db.select().from(agents).where(eq(agents.id, command.agentId)).get();
  const device = agent ? db.select().from(devices).where(eq(devices.id, agent.deviceId)).get() : undefined;
  if (!device) return;
  const args = command.payload as { ups?: string; battery?: number; threshold?: number; reason?: string };

  if (command.outageId) {
    db.update(outageDevices)
      .set(ack.ok ? { shutdownAckedAt: new Date(), shutdownError: null } : { shutdownError: ack.error ?? "rejected" })
      .where(and(eq(outageDevices.outageId, command.outageId), eq(outageDevices.deviceId, device.id)))
      .run();
  }
  if (ack.ok) {
    db.update(devices).set({ online: false }).where(eq(devices.id, device.id)).run();
    emitEvent({
      type: "shutdown_acknowledged",
      deviceId: device.id,
      title: `${device.name} is shutting down`,
      message:
        args.reason === "manual"
          ? `${device.name} accepted a manual shutdown`
          : `${device.name} accepted shutdown at ${args.battery ?? "?"}% UPS charge`,
      data: { device: device.name, ups: args.ups, battery: args.battery, threshold: args.threshold },
    });
  } else {
    emitEvent({
      type: "shutdown_failed",
      deviceId: device.id,
      title: `${device.name} rejected shutdown`,
      message: `${device.name} could not shut down: ${ack.error ?? "unknown error"}`,
      data: { device: device.name, ups: args.ups, battery: args.battery, error: ack.error },
    });
  }
});
