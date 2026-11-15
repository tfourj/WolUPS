import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import { agents, devices, nutHosts, ups } from "../src/server/db/schema";
import { agentHub } from "../src/server/agents/hub";
import { commandAllowed } from "../src/server/agents/protocol";
import { applyNutConfig, removeNutUps, verifyFromServer } from "../src/server/nut-hosts/apply";
import { applySchema, redactPayload, snmpSchema } from "../src/server/nut-hosts/commands";
import { healthChanges, nutProblems } from "../src/server/nut-hosts/health";
import { box } from "../src/server/secrets";

const host = { name: "pi", localShutdown: false, upsNames: new Map([["rack", "Rack UPS"]]) };
const healthy = {
  upsd: "running",
  upsmon: "missing",
  listening: true,
  drivers: [{ ups: "rack", state: "running" }],
};

describe("NUT health", () => {
  test("finds stopped drivers, a stopped upsd and a closed listen address", () => {
    expect(nutProblems(healthy, host)).toEqual([]);
    const driver = nutProblems({ ...healthy, drivers: [{ ups: "rack", state: "failed" }] }, host);
    expect(driver).toMatchObject([{ key: "driver:rack", ups: "Rack UPS", error: "driver for rack is failed" }]);
    expect(nutProblems({ ...healthy, upsd: "stopped" }, host).map((p) => p.key)).toEqual(["upsd"]);
    expect(nutProblems({ ...healthy, listening: false }, host).map((p) => p.key)).toEqual(["listen"]);
  });

  test("only checks upsmon when it shuts the host down, and ignores what is not installed", () => {
    expect(nutProblems({ ...healthy, upsmon: "stopped" }, host)).toEqual([]);
    const shutdown = { ...host, localShutdown: true };
    expect(nutProblems({ ...healthy, upsmon: "stopped" }, shutdown).map((p) => p.key)).toEqual(["upsmon"]);
    expect(nutProblems({ ...healthy, upsd: "missing", listening: false }, host)).toEqual([]);
  });

  test("notifies a problem after two reports and its recovery after two clean ones", () => {
    expect(healthChanges([], [], ["upsd"])).toEqual({ failed: [], recovered: [], notified: [] });
    expect(healthChanges([], ["upsd"], ["upsd"])).toEqual({ failed: ["upsd"], recovered: [], notified: ["upsd"] });
    expect(healthChanges(["upsd"], ["upsd"], [])).toEqual({ failed: [], recovered: [], notified: ["upsd"] });
    expect(healthChanges(["upsd"], [], [])).toEqual({ failed: [], recovered: ["upsd"], notified: [] });
  });
});

describe("NUT command input", () => {
  test("SNMPv3 needs credentials for its security level", () => {
    const base = { start: "192.168.1.10", end: "192.168.1.20", version: "v3" as const };
    expect(snmpSchema.safeParse({ ...base, secLevel: "noAuthNoPriv", secName: "nut" }).success).toBe(true);
    expect(snmpSchema.safeParse({ ...base, secLevel: "authPriv", secName: "nut" }).success).toBe(false);
    const full = {
      ...base,
      secLevel: "authPriv",
      secName: "nut",
      authProtocol: "SHA256",
      authPassword: "auth pass 123",
      privProtocol: "AES",
      privPassword: "priv-pass-456",
    };
    expect(snmpSchema.safeParse(full).success).toBe(true);
    expect(snmpSchema.safeParse({ ...full, authPassword: 'bad"quote1' }).success).toBe(false);
  });

  test("ups.conf values are restricted", () => {
    const section = { name: "rack", displayName: "Rack", driver: "usbhid-ups", port: "auto" };
    const input = (extra: Record<string, string>) => ({
      ups: [{ ...section, extra }],
      imported: [],
      listen: "10.0.0.2",
    });
    expect(applySchema.safeParse(input({ vendorid: "0764" })).success).toBe(true);
    expect(applySchema.safeParse(input({ vendorid: "07 64" })).success).toBe(false);
    expect(applySchema.safeParse(input({ maxretry: "3" })).success).toBe(false);
    expect(applySchema.safeParse({ ...input({}), ups: [{ ...section, name: "Rack UPS" }] }).success).toBe(false);
  });

  test("passwords are removed from stored commands", () => {
    const payload = {
      snmp: { version: "v3", authPassword: "a", privPassword: "b" },
      ups: [{ extra: { community: "c" } }],
    };
    expect(redactPayload(payload)).toEqual({
      snmp: { version: "v3", authPassword: "***", privPassword: "***" },
      ups: [{ extra: { community: "***" } }],
    });
  });
});

describe("agent kinds", () => {
  test("device and NUT agents only get their own commands", () => {
    expect(commandAllowed("device", "shutdown")).toBe(true);
    expect(commandAllowed("device", "nut_scan")).toBe(false);
    expect(commandAllowed("nut", "nut_scan")).toBe(true);
    expect(commandAllowed("nut", "wol")).toBe(false);
    expect(commandAllowed("nut", "update")).toBe(true);
  });

  test("the hub refuses a NUT command for a device agent", () => {
    const device = db.insert(devices).values({ name: "kind-check" }).returning().get();
    const agent = db.insert(agents).values({ deviceId: device.id, publicKey: "pk" }).returning().get();
    expect(() => agentHub.send(agent.id, "nut_detect")).toThrow();
  });
});

describe("applying a NUT config", () => {
  const input = {
    ups: [{ name: "rack", displayName: "Rack UPS", driver: "usbhid-ups", port: "auto", extra: {} }],
    imported: [{ name: "old", displayName: "Old UPS" }],
    listen: "192.168.1.5",
    localShutdown: false,
  };
  const applied = async () => ({
    ok: true,
    result: { files: ["/etc/nut/ups.conf"], monitorUser: "wolups", monitorPassword: "pw" },
  });

  test("creates UPS entries only after the server can read them", async () => {
    const hostId = db.insert(nutHosts).values({ name: "pi-apply" }).returning().get().id;
    const failing = await applyNutConfig(hostId, input, {
      run: applied,
      verify: async () => {
        throw new Error("connection refused");
      },
      timeoutMs: 0,
    });
    expect(failing.ok).toBe(false);
    expect(failing.ok ? "" : failing.error).toContain("192.168.1.5 on port 3493");
    expect(db.select().from(ups).where(eq(ups.nutHostId, hostId)).all()).toHaveLength(0);

    const ok = await applyNutConfig(hostId, input, { run: applied, verify: async () => ({}) });
    expect(ok.ok).toBe(true);
    const rows = db.select().from(ups).where(eq(ups.nutHostId, hostId)).all();
    expect(rows.map((r) => [r.name, r.upsName, r.host, r.port, r.username]).sort()).toEqual([
      ["Old UPS", "old", "192.168.1.5", 3493, "wolups"],
      ["Rack UPS", "rack", "192.168.1.5", 3493, "wolups"],
    ]);
    expect(box.decrypt(rows[0].passwordEnc!)).toBe("pw");
    expect(db.select().from(nutHosts).where(eq(nutHosts.id, hostId)).get()?.listenAddress).toBe("192.168.1.5");

    // Adding another UPS later keeps the existing entries.
    const spare = { ...input.ups[0], name: "spare", displayName: "Spare" };
    await applyNutConfig(hostId, { ...input, ups: [spare], imported: [] }, { run: applied, verify: async () => ({}) });
    const names = () =>
      db
        .select()
        .from(ups)
        .where(eq(ups.nutHostId, hostId))
        .all()
        .map((r) => r.upsName)
        .sort();
    expect(names()).toEqual(["old", "rack", "spare"]);

    // Removing one asks the agent to drop its section and deletes only that entry.
    const sent: Record<string, unknown>[] = [];
    const rackId = rows.find((r) => r.upsName === "rack")!.id;
    const removed = await removeNutUps(hostId, rackId, {
      run: async (_host, _type, args) => {
        sent.push(args ?? {});
        return { ok: true };
      },
    });
    expect(removed).toEqual({ ok: true });
    expect(sent).toEqual([{ ups: [], remove: ["rack"], listen: "192.168.1.5", localShutdown: false }]);
    expect(names()).toEqual(["old", "spare"]);
  });

  test("reports the agent's error", async () => {
    const outcome = await applyNutConfig("missing", input, { run: async () => ({ ok: false, error: "boom" }) });
    expect(outcome).toEqual({ ok: false, error: "boom" });
  });

  test("retries while drivers start", async () => {
    let calls = 0;
    const error = await verifyFromServer(
      { host: "h", port: 3493 },
      ["rack"],
      async () => {
        calls++;
        if (calls < 3) throw new Error("driver not connected");
      },
      1_000,
      1,
    );
    expect(error).toBeNull();
    expect(calls).toBe(3);
  });
});
