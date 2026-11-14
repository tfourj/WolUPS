import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { emitEvent, type EmitInput } from "../events";
import { describeUserAgent } from "../user-agent";

/** How a request signed the user in, or null when the path does not sign anyone in. */
export function signInMethod(path: string, twoFactorEnabled: boolean): string | null {
  switch (path) {
    case "/sign-in/email":
      // A 2FA account only gets a session here when the device is trusted.
      return twoFactorEnabled ? "password on a trusted device" : "password";
    case "/two-factor/verify-totp":
      return "password and authenticator app";
    case "/two-factor/verify-backup-code":
      return "password and backup code";
    default:
      return null;
  }
}

export type SignIn = { email: string; method: string; ip: string | null; userAgent: string | null };

export function loginEvent(signIn: SignIn): EmitInput {
  const client = describeUserAgent(signIn.userAgent);
  const from = signIn.ip ? `${client} (${signIn.ip})` : client;
  return {
    type: "login",
    title: "New sign-in to WolUPS",
    message: `${signIn.email} signed in with ${signIn.method} from ${from}`,
    data: { method: signIn.method, ip: signIn.ip, client, userAgent: signIn.userAgent },
  };
}

/** Records a "login" event, which channels subscribed to it deliver like any other event. */
export function emitLoginEvent(signIn: SignIn) {
  return emitEvent(loginEvent(signIn));
}

/**
 * Reports every completed sign-in. Must come after the two-factor plugin: its hook removes the
 * session of a password sign-in that still needs a code, so only finished sign-ins reach this one.
 */
export function loginEventsPlugin(): BetterAuthPlugin {
  return {
    id: "login-events",
    hooks: {
      after: [
        {
          matcher: (ctx) => signInMethod(ctx.path ?? "", false) !== null,
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            // Turning on 2FA verifies a code while already signed in; that is not a new sign-in.
            if (!created || ctx.context.session) return;
            const twoFactorEnabled = Boolean((created.user as { twoFactorEnabled?: boolean }).twoFactorEnabled);
            const method = signInMethod(ctx.path, twoFactorEnabled);
            if (!method) return;
            emitLoginEvent({
              email: created.user.email,
              method,
              // Better Auth stores "" when no client IP header is present.
              ip: created.session.ipAddress || null,
              userAgent: created.session.userAgent || null,
            });
          }),
        },
      ],
    },
  };
}
