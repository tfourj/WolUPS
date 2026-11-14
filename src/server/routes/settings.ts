import { Hono } from "hono";
import { latestAgentRelease, checkForAgentUpdates } from "../agents/releases";
import { env } from "../env";
import { appSettingsSchema, getSettings, updateSettings } from "../settings";
import { parseBody } from "./util";

export const settingsRoutes = new Hono();

function system() {
  const release = latestAgentRelease();
  return {
    version: env.version,
    baseUrl: env.baseUrl,
    agentRepo: env.agentRepo,
    timezone: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    latestAgent: release.latest,
    latestAgentError: release.error,
  };
}

settingsRoutes.get("/", (c) => c.json({ settings: getSettings(), system: system() }));

settingsRoutes.patch("/", async (c) => {
  const body = await parseBody(c, appSettingsSchema.partial());
  if (body instanceof Response) return body;
  return c.json({ settings: updateSettings(body), system: system() });
});

settingsRoutes.post("/check-agent-release", async (c) => {
  await checkForAgentUpdates();
  return c.json(system());
});
