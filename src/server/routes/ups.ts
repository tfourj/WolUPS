import { and, asc, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { outages, ups, upsSamples } from "../db/schema";
import { fetchUpsSnapshot, fetchUpsVars, listUps } from "../nut/client";
import { nutTarget, upsMonitor } from "../monitor/ups-monitor";
import { box } from "../secrets";
import { errorMessage, parseBody } from "./util";

export const upsRoutes = new Hono();

type UpsRow = typeof ups.$inferSelect;

export function serializeUps(row: UpsRow) {
  const { passwordEnc, ...rest } = row;
  const outage = db
    .select()
    .from(outages)
    .where(eq(outages.upsId, row.id))
    .orderBy(desc(outages.startedAt))
    .limit(1)
    .get();
  return { ...rest, hasPassword: !!passwordEnc, lastOutage: outage ?? null };
}

const upsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(3493),
  upsName: z.string().trim().min(1).max(100),
  username: z.string().trim().max(100).nullish(),
  password: z.string().max(200).nullish(),
  enabled: z.boolean().default(true),
});

upsRoutes.get("/", (c) => c.json(db.select().from(ups).orderBy(asc(ups.name)).all().map(serializeUps)));

upsRoutes.post("/", async (c) => {
  const body = await parseBody(c, upsSchema);
  if (body instanceof Response) return body;
  const row = db
    .insert(ups)
    .values({
      name: body.name,
      host: body.host,
      port: body.port,
      upsName: body.upsName,
      username: body.username || null,
      passwordEnc: body.password ? box.encrypt(body.password) : null,
      enabled: body.enabled,
    })
    .returning()
    .get();
  upsMonitor.pollNow();
  return c.json(serializeUps(row), 201);
});

upsRoutes.patch("/:id", async (c) => {
  const body = await parseBody(c, upsSchema.partial());
  if (body instanceof Response) return body;
  const existing = db.select().from(ups).where(eq(ups.id, c.req.param("id"))).get();
  if (!existing) return c.json({ error: "not found" }, 404);
  const { password, ...rest } = body;
  const row = db
    .update(ups)
    .set({
      ...rest,
      ...(rest.username !== undefined ? { username: rest.username || null } : {}),
      // Empty or missing password keeps the stored one; null clears it.
      ...(password === null ? { passwordEnc: null } : password ? { passwordEnc: box.encrypt(password) } : {}),
    })
    .where(eq(ups.id, existing.id))
    .returning()
    .get();
  upsMonitor.pollNow();
  return c.json(serializeUps(row));
});

upsRoutes.delete("/:id", (c) => {
  db.delete(ups).where(eq(ups.id, c.req.param("id"))).run();
  return c.json({ ok: true });
});

const testSchema = z.object({
  id: z.string().optional(),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(3493),
  upsName: z.string().trim().optional(),
  username: z.string().nullish(),
  password: z.string().nullish(),
});

function targetFrom(body: z.infer<typeof testSchema>) {
  let password = body.password || null;
  if (!password && body.id) {
    const row = db.select().from(ups).where(eq(ups.id, body.id)).get();
    if (row?.passwordEnc) password = box.decrypt(row.passwordEnc);
  }
  return { host: body.host, port: body.port, username: body.username || null, password };
}

/** Test a connection with the values in the form (stored password used when the field is left empty). */
upsRoutes.post("/test", async (c) => {
  const body = await parseBody(c, testSchema);
  if (body instanceof Response) return body;
  if (!body.upsName) return c.json({ error: "UPS name is required" }, 400);
  try {
    return c.json({ ok: true, snapshot: await fetchUpsSnapshot(targetFrom(body), body.upsName) });
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error) });
  }
});

upsRoutes.post("/discover", async (c) => {
  const body = await parseBody(c, testSchema);
  if (body instanceof Response) return body;
  try {
    return c.json({ ok: true, ups: await listUps(targetFrom(body)) });
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error), ups: [] });
  }
});

upsRoutes.get("/:id/vars", async (c) => {
  const row = db.select().from(ups).where(eq(ups.id, c.req.param("id"))).get();
  if (!row) return c.json({ error: "not found" }, 404);
  try {
    return c.json({ ok: true, vars: await fetchUpsVars(nutTarget(row), row.upsName) });
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error), vars: {} });
  }
});

const RANGES: Record<string, number> = { "6h": 6, "24h": 24, "7d": 168, "30d": 720 };

upsRoutes.get("/:id/samples", (c) => {
  const hours = RANGES[c.req.query("range") ?? "24h"] ?? 24;
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = db
    .select()
    .from(upsSamples)
    .where(and(eq(upsSamples.upsId, c.req.param("id")), gte(upsSamples.ts, since)))
    .orderBy(asc(upsSamples.ts))
    .all();
  // Downsample to at most ~300 points so the chart stays light.
  const step = Math.max(1, Math.ceil(rows.length / 300));
  return c.json(rows.filter((_, i) => i % step === 0 || i === rows.length - 1));
});
