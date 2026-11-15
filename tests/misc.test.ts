import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { newestAgentVersion, newestVersion } from "../src/server/agents/releases";
import { patchSchema } from "../src/server/routes/util";
import { cidrContains, parseCidr } from "../src/server/wol/cidr";
import { magicPacket, normalizeMac, parseMac } from "../src/server/wol/magic";
import { parseArpCommand, parseArpTable } from "../src/server/wol/resolve-mac";
import { compareNames } from "../src/shared/sort";
import { lineDiff, withContext } from "../src/web/lib/diff";
import { matchScanned, scanLabel } from "../src/web/lib/nut-match";
import { isNewerVersion } from "../src/shared/version";

describe("patchSchema", () => {
  test("does not fill defaults for fields that were not sent", () => {
    const schema = z.object({ port: z.number().default(3493), enabled: z.boolean().default(true), name: z.string() });
    expect(patchSchema(schema).parse({ enabled: false })).toEqual({ enabled: false });
  });
});

describe("wake on lan helpers", () => {
  test("normalizes MAC addresses", () => {
    expect(normalizeMac("AA-BB-CC-DD-EE-FF")).toBe("aa:bb:cc:dd:ee:ff");
    expect(parseMac("nope")).toBeNull();
  });

  test("builds a 102 byte magic packet", () => {
    const packet = magicPacket(parseMac("01:02:03:04:05:06")!);
    expect(packet.length).toBe(102);
    expect([...packet.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    expect([...packet.subarray(96)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("matches subnets and computes broadcast addresses", () => {
    expect(cidrContains("192.168.1.10/24", "192.168.1.200")).toBe(true);
    expect(cidrContains("192.168.1.10/24", "192.168.2.1")).toBe(false);
    expect(parseCidr("10.0.5.3/22")?.broadcast).toBe("10.0.7.255");
  });
});

describe("versions", () => {
  test("compares stable versions", () => {
    expect(isNewerVersion("1.2.0", "1.10.0")).toBe(false);
    expect(isNewerVersion("v1.10.0", "1.2.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "dev")).toBe(true);
    expect(isNewerVersion("garbage", "1.0.0")).toBe(false);
  });

  test("picks the newest stable agent release", () => {
    const releases = [
      { tag_name: "v9.0.0" },
      { tag_name: "agent-v0.1.3" },
      { tag_name: "agent-v0.1.10" },
      { tag_name: "agent-v0.2.0", prerelease: true },
      { tag_name: "agent-v0.3.0", draft: true },
      { tag_name: "agent-v0.4.0-rc.1" },
    ];
    expect(newestAgentVersion(releases)).toBe("0.1.10");
    expect(newestAgentVersion([{ tag_name: "v1.0.0" }])).toBeNull();
    const mixed = [{ tag_name: "agent-v0.2.0" }, { tag_name: "nut-agent-v0.1.0" }, { tag_name: "nut-agent-v0.1.2" }];
    expect(newestAgentVersion(mixed)).toBe("0.2.0");
    expect(newestVersion(mixed, "nut-agent-v")).toBe("0.1.2");
  });
});

describe("name sorting", () => {
  test("is natural and case-insensitive", () => {
    const names = ["pve-10", "Zeta", "pve-2", "alpha", "PVE-1"];
    expect(names.sort(compareNames)).toEqual(["alpha", "PVE-1", "pve-2", "pve-10", "Zeta"]);
  });
});

describe("arp parsing", () => {
  test("reads complete entries from /proc/net/arp", () => {
    const table = [
      "IP address       HW type     Flags       HW address            Mask     Device",
      "192.168.1.20     0x1         0x2         BC:24:11:4A:9E:01     *        eth0",
      "192.168.1.21     0x1         0x0         00:00:00:00:00:00     *        eth0",
    ].join("\n");
    expect(parseArpTable(table, "192.168.1.20")).toBe("bc:24:11:4a:9e:01");
    expect(parseArpTable(table, "192.168.1.21")).toBeNull();
    expect(parseArpTable(table, "192.168.1.22")).toBeNull();
  });

  test("reads macOS arp output with short octets", () => {
    expect(parseArpCommand("? (192.168.1.1) at 0:11:32:a:b:c on en0 ifscope [ethernet]")).toBe("00:11:32:0a:0b:0c");
    expect(parseArpCommand("192.168.1.9 (192.168.1.9) -- no entry")).toBeNull();
  });
});

describe("config diff", () => {
  test("marks added and removed lines and folds long unchanged runs", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\n";
    const after = "a\nb\nc\nd\ne\nf\nG\nh\n";
    const diff = lineDiff(before, after);
    expect(diff.filter((l) => l.kind !== "same")).toEqual([
      { kind: "remove", text: "g" },
      { kind: "add", text: "G" },
      { kind: "add", text: "h" },
    ]);
    expect(withContext(diff, 1)).toEqual([
      null,
      { kind: "same", text: "f" },
      { kind: "remove", text: "g" },
      { kind: "add", text: "G" },
      { kind: "add", text: "h" },
    ]);
    expect(lineDiff("", "x\n")).toEqual([{ kind: "add", text: "x" }]);
  });
});

describe("matching scanned UPS to ups.conf", () => {
  const usb = (serial?: string) => ({
    driver: "usbhid-ups",
    port: "auto",
    vendor: "1",
    product: "2200R",
    vendorid: "0764",
    productid: "0601",
    serial,
  });
  const section = (name: string, extra: Record<string, string>) => ({
    name,
    driver: "usbhid-ups",
    port: "auto",
    extra,
  });

  test("identical models are told apart by serial", () => {
    const devices = [usb("AAA"), usb("BBB"), usb("CCC")];
    const matches = matchScanned(devices, [section("ups2", { serial: "bbb" }), section("ups1", { serial: "AAA" })]);
    expect([...matches.entries()]).toEqual([
      [0, "ups1"],
      [1, "ups2"],
    ]);
    expect(scanLabel(devices[2], devices)).toBe("1 2200R (CCC)");
    expect(scanLabel(devices[0], [devices[0]])).toBe("1 2200R");
  });

  test("without serials, ids only match when there is no doubt", () => {
    const one = section("ups1", { vendorid: "0764", productid: "0601" });
    expect(matchScanned([usb()], [one]).get(0)).toBe("ups1");
    expect(matchScanned([usb(), usb()], [one]).size).toBe(0);
    const snmp = { driver: "snmp-ups", port: "10.0.0.5" };
    expect(matchScanned([snmp], [{ name: "apc", driver: "snmp-ups", port: "10.0.0.5" }]).get(0)).toBe("apc");
  });
});
