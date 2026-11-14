import { describe, expect, test } from "bun:test";
import { templateVars } from "../src/server/notify/templates";
import { EVENT_TYPES, TEMPLATE_VARIABLES } from "../src/shared/events";
import { matchTemplatePreset, TEMPLATE_PRESETS } from "../src/shared/template-presets";
import { previewTemplate, renderTemplate, resolveTemplate, sampleTemplateVars } from "../src/shared/templates";

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

describe("template previews", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  test("every event type has sample variables for each template variable", () => {
    for (const type of EVENT_TYPES) {
      const vars = sampleTemplateVars(type, now);
      expect(Object.keys(vars).sort()).toEqual([...TEMPLATE_VARIABLES].sort());
      expect(vars.event).toBe(type);
      expect(vars.title).not.toBe("");
      expect(vars.message).not.toBe("");
    }
  });

  test("renders a template with the sample event", () => {
    const preview = previewTemplate("ups_on_battery", { title: "{title}", body: "{ups} at {battery} {nope}" }, now);
    expect(preview).toEqual({ title: "Rack UPS is on battery", body: "Rack UPS at 98% {nope}" });
  });
});

describe("template presets", () => {
  const variable = new RegExp(`\\{(?!(?:${TEMPLATE_VARIABLES.join("|")})\\})[a-z_]+\\}`, "i");

  test("every preset covers each event type with known variables", () => {
    for (const preset of TEMPLATE_PRESETS) {
      expect(Object.keys(preset.templates).sort()).toEqual([...EVENT_TYPES].sort());
      for (const template of Object.values(preset.templates)) {
        expect(template.title).not.toBe("");
        expect(template.body).not.toBe("");
        expect(`${template.title} ${template.body}`).not.toMatch(variable);
      }
    }
  });

  test("preset ids are unique and each preset matches only itself", () => {
    expect(new Set(TEMPLATE_PRESETS.map((p) => p.id)).size).toBe(TEMPLATE_PRESETS.length);
    for (const preset of TEMPLATE_PRESETS) expect(matchTemplatePreset(preset.templates)?.id).toBe(preset.id);
  });

  test("no saved templates match the default preset and edits match none", () => {
    expect(matchTemplatePreset({})?.id).toBe("default");
    expect(matchTemplatePreset({ login: { title: "Sign-in", body: "{message}" } })).toBeUndefined();
  });

  test("icon presets prefix the title and detailed presets list event values", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const preset = (id: string) => TEMPLATE_PRESETS.find((p) => p.id === id)!.templates.ups_on_battery;
    expect(previewTemplate("ups_on_battery", preset("icon-default"), now).title).toBe("🔋 Rack UPS is on battery");
    expect(previewTemplate("ups_on_battery", preset("detailed"), now).body).toContain("Battery: 98%\nRuntime: 42m 0s");
  });
});
