import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { eq } from "drizzle-orm";
import { auth } from "../src/server/auth/auth";
import { loginEvent, signInMethod } from "../src/server/auth/login-events";
import { listSessions, touchSession } from "../src/server/auth/sessions";
import { db } from "../src/server/db/client";
import { channels, events, session, user } from "../src/server/db/schema";
import { apiRoutes } from "../src/server/routes/api";
import { loginChannelIds, setLoginChannels } from "../src/server/routes/security";
import { describeUserAgent } from "../src/server/user-agent";
import { box } from "../src/server/secrets";

const EMAIL = "owner@example.com";
const PASSWORD = "password123";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537";

const headers = (cookie?: string) =>
  new Headers({ "user-agent": UA, "x-wolups-client-ip": "203.0.113.7", ...(cookie ? { cookie } : {}) });
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Login events are recorded synchronously by the hook. */
const loginEvents = () => db.select().from(events).where(eq(events.type, "login")).all();

function signIn() {
  return auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD }, headers: headers(), asResponse: true });
}

// The app is single user and test files share one database, so start and end without an account.
beforeAll(async () => {
  db.delete(user).run();
  await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "Owner" } });
});
afterAll(() => {
  db.delete(user).run();
  db.delete(channels).run();
});
beforeEach(() => {
  db.delete(events).run();
});

describe("sign-in methods", () => {
  test("maps auth paths to a readable method", () => {
    expect(signInMethod("/sign-in/email", false)).toBe("password");
    expect(signInMethod("/sign-in/email", true)).toBe("password on a trusted device");
    expect(signInMethod("/two-factor/verify-totp", true)).toBe("password and authenticator app");
    expect(signInMethod("/two-factor/verify-backup-code", true)).toBe("password and backup code");
    expect(signInMethod("/change-password", false)).toBeNull();
    expect(signInMethod("/two-factor/enable", false)).toBeNull();
  });

  test("describes the browser and system", () => {
    expect(describeUserAgent(UA)).toBe("Chrome on macOS");
    expect(describeUserAgent("curl/8.7.1")).toBe("curl/8.7.1");
    expect(describeUserAgent(null)).toBe("Unknown device");
  });

  test("message names the account, method, device and IP", () => {
    const event = loginEvent({ email: EMAIL, method: "password", ip: "203.0.113.7", userAgent: UA });
    expect(event.message).toBe(`${EMAIL} signed in with password from Chrome on macOS (203.0.113.7)`);
    expect(loginEvent({ email: EMAIL, method: "password", ip: null, userAgent: null }).message).toBe(
      `${EMAIL} signed in with password from Unknown device`,
    );
  });
});

describe("login channels", () => {
  function addChannel(name: string, eventTypes: string[]) {
    return db
      .insert(channels)
      .values({ name, type: "ntfy", configEnc: box.encryptJson({}), events: eventTypes })
      .returning()
      .get().id;
  }

  test("subscribes only the picked channels and keeps their other events", () => {
    const a = addChannel("A", ["ups_on_battery"]);
    const b = addChannel("B", ["ups_on_battery", "login"]);
    setLoginChannels([a, "missing"]);
    expect(loginChannelIds()).toEqual([a]);
    const rows = db.select().from(channels).all();
    expect(rows.find((c) => c.id === a)?.events).toEqual(["ups_on_battery", "login"]);
    expect(rows.find((c) => c.id === b)?.events).toEqual(["ups_on_battery"]);
    setLoginChannels([]);
    expect(loginChannelIds()).toEqual([]);
  });
});

describe("devices", () => {
  const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
  const call = (path: string, cookie: string, body?: unknown) =>
    apiRoutes.request(path, {
      method: body ? "POST" : "GET",
      headers: { cookie, "x-real-ip": "198.51.100.9", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  type Device = { id: string; name: string; ip: string | null; current: boolean };

  beforeEach(() => {
    db.delete(session).run();
  });

  test("lists signed-in devices with this one first and its latest IP", async () => {
    const mine = cookiesOf(await signIn());
    await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      headers: new Headers({ "user-agent": FIREFOX, "x-wolups-client-ip": "203.0.113.8" }),
    });
    const devices = (await (await call("/security/sessions", mine)).json()) as Device[];
    expect(devices.map((d) => [d.name, d.ip, d.current])).toEqual([
      ["Chrome on macOS", "198.51.100.9", true],
      ["Firefox on Linux", "203.0.113.8", false],
    ]);
  });

  test("leaves out expired sessions", async () => {
    const mine = cookiesOf(await signIn());
    await signIn();
    const [current] = (await (await call("/security/sessions", mine)).json()) as Device[];
    const rows = db.select().from(session).all();
    const other = rows.find((r) => r.id !== current!.id)!;
    db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.id, other.id)).run();
    expect(listSessions(other.userId, current!.id).map((d) => d.id)).toEqual([current!.id]);
  });

  test("writes activity at most once a minute unless the IP changes", async () => {
    await signIn();
    const row = db.select().from(session).get()!;
    const now = new Date();
    expect(touchSession(row, "198.51.100.9", now)).toBe(true);
    const touched = db.select().from(session).get()!;
    expect(touched.lastIp).toBe("198.51.100.9");
    expect(touchSession(touched, "198.51.100.9", new Date(now.getTime() + 30_000))).toBe(false);
    expect(touchSession(touched, "198.51.100.10", new Date(now.getTime() + 30_000))).toBe(true);
    expect(touchSession(touched, "198.51.100.9", new Date(now.getTime() + 61_000))).toBe(true);
  });

  test("signs out the picked devices but never the requesting one", async () => {
    const mine = cookiesOf(await signIn());
    const other = cookiesOf(await signIn());
    const ids = db.select().from(session).all().map((r) => r.id);
    const left = (await (await call("/security/sessions/revoke", mine, { ids })).json()) as Device[];
    expect(left).toHaveLength(1);
    expect(left[0]?.current).toBe(true);
    expect((await call("/security/sessions", other)).status).toBe(401);
    expect((await call("/security/sessions", mine)).status).toBe(200);
  });

  test("signs out every device", async () => {
    const mine = cookiesOf(await signIn());
    await signIn();
    expect(await (await call("/security/sessions/revoke-all", mine, {})).json()).toEqual({ revoked: 2 });
    expect((await call("/security/sessions", mine)).status).toBe(401);
  });
});

describe("sign-in hook", () => {
  test("records password sign-ins with the device and IP", async () => {
    await signIn();
    const [event] = loginEvents();
    expect(event?.message).toBe(`${EMAIL} signed in with password from Chrome on macOS (203.0.113.7)`);
    expect(event?.data).toMatchObject({ method: "password", ip: "203.0.113.7", client: "Chrome on macOS" });
  });

  test("ignores wrong passwords", async () => {
    await auth.api
      .signInEmail({ body: { email: EMAIL, password: "wrong-password" }, headers: headers() })
      .catch(() => null);
    expect(loginEvents()).toHaveLength(0);
  });

  test("with 2FA, records the sign-in once the code is verified, not while setting it up", async () => {
    const session = cookiesOf(await signIn());
    db.delete(events).run();

    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: headers(session) });
    if (!("totpURI" in enabled)) throw new Error("expected a TOTP setup");
    const secret = new TextDecoder().decode(base32.decode(new URL(enabled.totpURI).searchParams.get("secret")!));
    const code = () => createOTP(secret).totp();
    await auth.api.verifyTOTP({ body: { code: await code() }, headers: headers(session) });
    expect(loginEvents()).toHaveLength(0);
    expect(db.select().from(user).get()?.twoFactorEnabled).toBe(true);

    const pending = await signIn();
    expect(await pending.clone().json()).toMatchObject({ twoFactorRedirect: true });
    expect(loginEvents()).toHaveLength(0);

    await auth.api.verifyTOTP({ body: { code: await code() }, headers: headers(cookiesOf(pending)) });
    expect(loginEvents().map((e) => e.data?.method)).toEqual(["password and authenticator app"]);

    const again = await signIn();
    await auth.api.verifyBackupCode({
      body: { code: enabled.backupCodes[0]! },
      headers: headers(cookiesOf(again)),
    });
    expect(loginEvents().map((e) => e.data?.method)).toContain("password and backup code");
  });
});
