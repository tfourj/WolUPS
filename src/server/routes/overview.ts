import { and, count, desc, eq, gte, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { agents, devices, events, outages, ups } from "../db/schema";
import { agentHub } from "../agents/hub";
import { serializeUps } from "./ups";

export const overviewRoutes = new Hono();

overviewRoutes.get("/", (c) => {
  const since30d = new Date(Date.now() - 30 * 86400_000);
  const upsRows = db.select().from(ups).all().map(serializeUps);
  const deviceRows = db.select().from(devices).all();
  const agentRows = db.select().from(agents).all();
  const recentEvents = db
    .select({ event: events, upsName: ups.name, deviceName: devices.name })
    .from(events)
    .leftJoin(ups, eq(events.upsId, ups.id))
    .leftJoin(devices, eq(events.deviceId, devices.id))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(10)
    .all()
    .map((r) => ({ ...r.event, upsName: r.upsName, deviceName: r.deviceName }));
  const outages30d = db.select({ n: count() }).from(outages).where(gte(outages.startedAt, since30d)).get()?.n ?? 0;
  const activeOutages = db.select({ n: count() }).from(outages).where(isNull(outages.endedAt)).get()?.n ?? 0;
  const lastOutage = db.select().from(outages).orderBy(desc(outages.startedAt)).limit(1).get() ?? null;
  const eventsToday = db
    .select({ n: count() })
    .from(events)
    .where(and(gte(events.createdAt, new Date(Date.now() - 86400_000))))
    .get()?.n ?? 0;

  return c.json({
    ups: upsRows,
    counts: {
      ups: upsRows.length,
      upsOnBattery: upsRows.filter((u) => u.status?.toUpperCase().split(/\s+/).includes("OB")).length,
      devices: deviceRows.length,
      devicesOnline: deviceRows.filter((d) => d.online).length,
      agents: agentRows.length,
      agentsConnected: agentRows.filter((a) => agentHub.isConnected(a.id)).length,
      outages30d,
      activeOutages,
      eventsToday,
    },
    lastOutage,
    recentEvents,
  });
});
