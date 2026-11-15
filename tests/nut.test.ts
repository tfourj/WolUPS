import { describe, expect, test } from "bun:test";
import {
  parseCmdList,
  parseEnumList,
  parseRangeList,
  parseRwList,
  parseType,
  parseUpsList,
  parseVarList,
  powerState,
  toSnapshot,
  unquote,
} from "../src/server/nut/parse";

describe("nut parsing", () => {
  test("unquotes escaped values", () => {
    expect(unquote('"Back-UPS \\"ES\\" 700"')).toBe('Back-UPS "ES" 700');
    expect(unquote("plain")).toBe("plain");
  });

  test("parses variable and UPS lists", () => {
    const vars = parseVarList(['VAR ups battery.charge "87"', 'VAR ups ups.status "OL CHRG"', "garbage"]);
    expect(vars).toEqual({ "battery.charge": "87", "ups.status": "OL CHRG" });
    expect(parseUpsList(['UPS rack "Rack UPS"'])).toEqual([{ name: "rack", description: "Rack UPS" }]);
  });

  test("builds snapshots and power state", () => {
    const snap = toSnapshot({ "ups.status": "OB LB", "battery.charge": "19.6", "battery.runtime": "300" });
    expect(snap).toMatchObject({ onBattery: true, lowBattery: true, battery: 20, runtime: 300 });
    expect(powerState(snap)).toBe("battery");
    expect(powerState(toSnapshot({ "ups.status": "OL" }))).toBe("online");
    expect(powerState(toSnapshot({ "ups.status": "BYPASS" }))).toBe("unknown");
  });

  test("ignores out of range or invalid battery values", () => {
    expect(toSnapshot({ "battery.charge": "140" }).battery).toBeNull();
    expect(toSnapshot({ "battery.charge": "n/a" }).battery).toBeNull();
  });
});

describe("UPS controls", () => {
  test("parses instant commands and writable variables", () => {
    expect(parseCmdList(["CMD rack beeper.mute", "CMD rack test.battery.start.quick"])).toEqual([
      "beeper.mute",
      "test.battery.start.quick",
    ]);
    expect(parseRwList(['RW rack battery.charge.low "20"', 'RW rack ups.id "Rack \\"A\\""'])).toEqual({
      "battery.charge.low": "20",
      "ups.id": 'Rack "A"',
    });
  });

  test("parses variable types, enums and ranges", () => {
    expect(parseType("TYPE rack ups.id RW STRING:30")).toEqual({ kind: "string", maxLength: 30 });
    expect(parseType("TYPE rack input.sensitivity RW ENUM")).toEqual({ kind: "enum" });
    expect(parseType("TYPE rack battery.charge.low RW RANGE")).toEqual({ kind: "range" });
    expect(parseType("TYPE rack ups.delay.shutdown RW NUMBER")).toEqual({ kind: "number" });
    expect(parseEnumList(['ENUM rack input.sensitivity "low"', 'ENUM rack input.sensitivity "high"'])).toEqual([
      "low",
      "high",
    ]);
    expect(parseRangeList(['RANGE rack battery.charge.low "10" "90"'])).toEqual([{ min: 10, max: 90 }]);
  });
});
