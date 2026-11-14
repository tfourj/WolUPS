import { Hono } from "hono";
import { websocket } from "hono/bun";
import { runMigrations } from "./db/client";
import { env } from "./env";
import { createLogger } from "./logger";
import { auth, hasAccount } from "./auth/auth";
import { withClientIp } from "./client-ip";
import { upsMonitor } from "./monitor/ups-monitor";
import { agentHub } from "./agents/hub";
import { startReleaseChecks } from "./agents/releases";
import { agentPublicRoutes } from "./routes/agent-public";
import { processShutdowns } from "./monitor/shutdown";
import { scheduleWakes } from "./monitor/wake";
import { startPresence } from "./monitor/presence";

const log = createLogger("server");

runMigrations();
agentHub.reset();

const app = new Hono();

app.get("/api/health", (c) => c.json({ status: "ok", version: env.version }));
app.get("/api/setup", (c) => c.json({ needsSetup: !hasAccount() }));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(withClientIp(c)));
app.route("/api/agents", agentPublicRoutes);

const server = Bun.serve({
  port: env.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  websocket: { ...websocket, idleTimeout: 90, sendPings: true, maxPayloadLength: 64 * 1024 },
});
log.info("listening", { port: server.port, baseUrl: env.baseUrl });

upsMonitor.onBattery(processShutdowns);
upsMonitor.onTick(scheduleWakes);
upsMonitor.start();
startPresence();
startReleaseChecks();
