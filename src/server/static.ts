import type { Context } from "hono";
import { stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { env } from "./env";

/** Serve the built web UI with an SPA fallback to index.html. */
export async function serveWeb(c: Context) {
  const pathname = decodeURIComponent(new URL(c.req.url).pathname);
  const candidate = normalize(join(env.webDir, pathname));
  if (candidate.startsWith(env.webDir + sep) && pathname !== "/") {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) {
      const immutable = pathname.startsWith("/assets/");
      return new Response(Bun.file(candidate), {
        headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600" },
      });
    }
  }
  const index = Bun.file(join(env.webDir, "index.html"));
  if (!(await index.exists())) return c.text("Web UI not built. Run `bun run build`.", 404);
  return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}
