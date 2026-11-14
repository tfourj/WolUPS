import { Hono } from "hono";
import { runMigrations } from "./db/client";
import { env } from "./env";
import { createLogger } from "./logger";
import { auth, hasAccount } from "./auth/auth";
import { withClientIp } from "./client-ip";

const log = createLogger("server");

runMigrations();

const app = new Hono();

app.get("/api/health", (c) => c.json({ status: "ok", version: env.version }));
app.get("/api/setup", (c) => c.json({ needsSetup: !hasAccount() }));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(withClientIp(c)));

const server = Bun.serve({ port: env.port, hostname: "0.0.0.0", fetch: app.fetch });
log.info("listening", { port: server.port, baseUrl: env.baseUrl });
