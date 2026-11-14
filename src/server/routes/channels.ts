import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { channels } from "../db/schema";
import { box } from "../secrets";
import { decryptConfig, isChannelType, mergeConfig, publicConfig, type ChannelRow } from "../notify/channels";
import { buildMessage } from "../notify/dispatcher";
import { providers } from "../notify/providers";
import { EVENT_TYPES } from "../../shared/events";
import { CHANNEL_TYPE_IDS, type ChannelType } from "../../shared/channels";
import { errorMessage, parseBody } from "./util";

export const channelRoutes = new Hono();

function serialize(row: ChannelRow) {
  const { configEnc, ...rest } = row;
  const config = isChannelType(row.type) ? publicConfig(row.type, decryptConfig(row)) : { values: {}, secretsSet: {} };
  return { ...rest, config: config.values, secretsSet: config.secretsSet };
}

const baseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(CHANNEL_TYPE_IDS as [ChannelType, ...ChannelType[]]),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  events: z.array(z.enum(EVENT_TYPES)).default([]),
  upsIds: z.array(z.string()).nullish(),
  deviceIds: z.array(z.string()).nullish(),
  titleTemplate: z.string().max(500).nullish(),
  bodyTemplate: z.string().max(4000).nullish(),
});

channelRoutes.get("/", (c) => c.json(db.select().from(channels).orderBy(asc(channels.name)).all().map(serialize)));

channelRoutes.post("/", async (c) => {
  const body = await parseBody(c, baseSchema);
  if (body instanceof Response) return body;
  const { config, errors } = mergeConfig(body.type, body.config);
  if (errors.length) return c.json({ error: errors.join("; ") }, 400);
  const row = db
    .insert(channels)
    .values({
      name: body.name,
      type: body.type,
      configEnc: box.encryptJson(config),
      enabled: body.enabled,
      events: body.events,
      upsIds: body.upsIds?.length ? body.upsIds : null,
      deviceIds: body.deviceIds?.length ? body.deviceIds : null,
      titleTemplate: body.titleTemplate || null,
      bodyTemplate: body.bodyTemplate || null,
    })
    .returning()
    .get();
  return c.json(serialize(row), 201);
});

channelRoutes.patch("/:id", async (c) => {
  const body = await parseBody(c, baseSchema.partial());
  if (body instanceof Response) return body;
  const existing = db.select().from(channels).where(eq(channels.id, c.req.param("id"))).get();
  if (!existing || !isChannelType(existing.type)) return c.json({ error: "not found" }, 404);
  const type = body.type ?? existing.type;
  const set: Partial<ChannelRow> = { updatedAt: new Date() };
  if (body.config || body.type) {
    const previous = type === existing.type ? decryptConfig(existing) : {};
    const { config, errors } = mergeConfig(type, body.config ?? {}, previous);
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    set.configEnc = box.encryptJson(config);
    set.type = type;
  }
  if (body.name !== undefined) set.name = body.name;
  if (body.enabled !== undefined) set.enabled = body.enabled;
  if (body.events !== undefined) set.events = body.events;
  if (body.upsIds !== undefined) set.upsIds = body.upsIds?.length ? body.upsIds : null;
  if (body.deviceIds !== undefined) set.deviceIds = body.deviceIds?.length ? body.deviceIds : null;
  if (body.titleTemplate !== undefined) set.titleTemplate = body.titleTemplate || null;
  if (body.bodyTemplate !== undefined) set.bodyTemplate = body.bodyTemplate || null;
  const row = db.update(channels).set(set).where(eq(channels.id, existing.id)).returning().get();
  return c.json(serialize(row));
});

channelRoutes.delete("/:id", (c) => {
  db.delete(channels).where(eq(channels.id, c.req.param("id"))).run();
  return c.json({ ok: true });
});

/** Send a test using the form values; empty secret fields fall back to the saved channel. */
channelRoutes.post("/test", async (c) => {
  const body = await parseBody(
    c,
    baseSchema.pick({ type: true, config: true, titleTemplate: true, bodyTemplate: true }).extend({
      id: z.string().optional(),
      name: z.string().optional(),
    }),
  );
  if (body instanceof Response) return body;
  const saved = body.id ? db.select().from(channels).where(eq(channels.id, body.id)).get() : undefined;
  const previous = saved && saved.type === body.type ? decryptConfig(saved) : {};
  const { config, errors } = mergeConfig(body.type, body.config, previous);
  if (errors.length) return c.json({ ok: false, error: errors.join("; ") });
  const channel = {
    ...(saved ?? {}),
    type: body.type,
    titleTemplate: body.titleTemplate ?? null,
    bodyTemplate: body.bodyTemplate ?? null,
  } as ChannelRow;
  const message = buildMessage(channel, {
    id: 0,
    type: "test",
    severity: "info",
    upsId: null,
    deviceId: null,
    title: "WolUPS test notification",
    message: `This is a test from WolUPS for channel "${body.name || saved?.name || body.type}".`,
    data: { ups: "Example UPS", device: "Example device", battery: 57, runtime: 840, status: "OB", threshold: 20 },
    createdAt: new Date(),
  });
  try {
    await providers[body.type](config, message);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error) });
  }
});

