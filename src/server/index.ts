import { Hono } from "hono";
import { env } from "./env";
import { createLogger } from "./logger";

const log = createLogger("server");
const app = new Hono();

app.get("/api/health", (c) => c.json({ status: "ok", version: env.version }));

const server = Bun.serve({ port: env.port, hostname: "0.0.0.0", fetch: app.fetch });
log.info("listening", { port: server.port, baseUrl: env.baseUrl });
