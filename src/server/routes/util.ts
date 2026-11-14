import type { Context } from "hono";
import type { z } from "zod";

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
