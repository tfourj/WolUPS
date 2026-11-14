import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins";
import { count } from "drizzle-orm";
import { db } from "../db/client";
import { account, session, twoFactor, user, verification } from "../db/schema";
import { env } from "../env";
import { loginEventsPlugin } from "./login-events";

export function hasAccount(): boolean {
  const row = db.select({ n: count() }).from(user).get();
  return (row?.n ?? 0) > 0;
}

const devOrigins = process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"];

export const auth = betterAuth({
  appName: "WolUPS",
  baseURL: env.baseUrl,
  basePath: "/api/auth",
  secret: env.betterAuthSecret,
  database: drizzleAdapter(db, { provider: "sqlite", schema: { user, session, account, verification, twoFactor } }),
  emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: true },
  trustedOrigins: [env.baseUrl, ...devOrigins],
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    customRules: { "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 5 } },
  },
  advanced: {
    useSecureCookies: env.baseUrl.startsWith("https://"),
    ipAddress: { ipAddressHeaders: ["x-wolups-client-ip"] },
  },
  plugins: [
    // Authenticator app codes with single-use backup codes.
    twoFactorPlugin({ issuer: "WolUPS", backupCodeOptions: { amount: 10, length: 10 } }),
    // Keep last so it sees the session only once two-factor has finished.
    loginEventsPlugin(),
  ],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email" && hasAccount()) {
        throw new APIError("FORBIDDEN", { message: "Registration is closed" });
      }
    }),
  },
});

export type Session = typeof auth.$Infer.Session;
