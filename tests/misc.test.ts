import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { patchSchema } from "../src/server/routes/util";
import { cidrContains, parseCidr } from "../src/server/wol/cidr";
import { magicPacket, normalizeMac, parseMac } from "../src/server/wol/magic";
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
});
