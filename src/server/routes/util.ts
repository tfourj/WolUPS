import type { Context } from "hono";
import { z } from "zod";

export async function parseBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T> | Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return c.json({ error: message }, 400);
  }
  return parsed.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Partial schema for PATCH bodies. zod's `.partial()` still applies `.default()` values,
 * which would overwrite fields the client did not send, so defaults are stripped here.
 */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field;
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as ReturnType<z.ZodObject<T>["partial"]>;
}
