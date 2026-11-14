import { describe, expect, test } from "bun:test";
import { templateVars } from "../src/server/notify/templates";
import { renderTemplate, resolveTemplate } from "../src/shared/templates";

describe("templates", () => {
  test("replaces known variables and keeps unknown ones", () => {
    expect(renderTemplate("{ups} at {battery} ({nope})", { ups: "Rack", battery: "40%" })).toBe("Rack at 40% ({nope})");
  });

  test("builds variables from event data", () => {
    const vars = templateVars({
      type: "shutdown_sent",
      title: "T",
      message: "M",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      data: { ups: "Rack", device: "nas", battery: 25, runtime: 125, threshold: 30, status: "OB" },
    });
    expect(vars).toMatchObject({ ups: "Rack", device: "nas", battery: "25%", runtime: "2m 5s", threshold: "30%" });
    expect(vars.time).toContain("2026");
  });

  test("channel overrides win over global templates, which win over the default", () => {
    const global = { ups_on_battery: { title: "G {ups}", body: "GB" } };
    expect(resolveTemplate("ups_on_battery", global, {})).toEqual({ title: "G {ups}", body: "GB" });
    expect(resolveTemplate("ups_on_battery", global, { titleTemplate: "C" })).toEqual({ title: "C", body: "GB" });
    expect(resolveTemplate("other", global, { bodyTemplate: "  " })).toEqual({ title: "{title}", body: "{message}" });
  });
});
