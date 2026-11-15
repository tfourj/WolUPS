import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { newestAgentVersion, newestVersion } from "../src/server/agents/releases";
import { patchSchema } from "../src/server/routes/util";
import { cidrContains, parseCidr } from "../src/server/wol/cidr";
import { magicPacket, normalizeMac, parseMac } from "../src/server/wol/magic";
import { parseArpCommand, parseArpTable } from "../src/server/wol/resolve-mac";
import { compareNames } from "../src/shared/sort";
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
