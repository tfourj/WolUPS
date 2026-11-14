import { Hono } from "hono";
import { requireSession, type AuthVars } from "../auth/middleware";
import { channelRoutes } from "./channels";
import { deviceRoutes } from "./devices";
import { eventRoutes } from "./events";
import { overviewRoutes } from "./overview";
import { settingsRoutes } from "./settings";
import { upsRoutes } from "./ups";

/** Authenticated API used by the web UI. */
export const apiRoutes = new Hono<AuthVars>();

apiRoutes.use("*", requireSession);
apiRoutes.route("/overview", overviewRoutes);
apiRoutes.route("/ups", upsRoutes);
apiRoutes.route("/devices", deviceRoutes);
apiRoutes.route("/events", eventRoutes);
apiRoutes.route("/channels", channelRoutes);
apiRoutes.route("/settings", settingsRoutes);
