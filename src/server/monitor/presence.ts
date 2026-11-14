import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, devices } from "../db/schema";
import { agentHub } from "../agents/hub";
import { createLogger } from "../logger";
import { ping } from "../net/ping";
import { getSettings } from "../settings";

const log = createLogger("presence");

/** How long a device may stay reachable after accepting a shutdown before the state is dropped. */
export const SHUTDOWN_STATE_TIMEOUT_MS = 30 * 60 * 1000;

/** A device stays "shutting down" until it is really unreachable, or the timeout passes. */
export function shutdownState(since: Date | null, online: boolean, now = Date.now()): Date | null {
  if (!since || !online) return null;
  return now - since.getTime() > SHUTDOWN_STATE_TIMEOUT_MS ? null : since;
}

/** Device is online when its agent is connected, otherwise when its host answers ping. */
export async function refreshPresence() {
  const rows = db
    .select({ device: devices, agentId: agents.id })
    .from(devices)
    .leftJoin(agents, eq(agents.deviceId, devices.id))
    .all();
  await Promise.all(
    rows.map(async ({ device, agentId }) => {
      let online = agentId ? agentHub.isConnected(agentId) : false;
      if (!online && device.host) online = await ping(device.host);
      if (online !== device.online) {
        log.info(online ? "device online" : "device offline", { device: device.name });
      }
      // Only ever clear the state here; a shutdown accepted during the ping must not be overwritten.
      const clearShutdown = !!device.shuttingDownSince && !shutdownState(device.shuttingDownSince, online);
      if (clearShutdown) {
        const message = online ? "device did not shut down in time" : "device finished shutting down";
        log.info(message, { device: device.name });
      }
      db.update(devices)
        .set({
          online,
          ...(online ? { lastSeenAt: new Date() } : {}),
          ...(clearShutdown ? { shuttingDownSince: null } : {}),
        })
        .where(eq(devices.id, device.id))
        .run();
    }),
  );
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function startPresence() {
  const loop = async () => {
    try {
      await refreshPresence();
    } catch (error) {
      log.error("presence check failed", { error });
    }
    timer = setTimeout(loop, getSettings().devicePingIntervalSec * 1000);
  };
  if (!timer) void loop();
}
