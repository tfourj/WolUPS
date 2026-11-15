import { describe, expect, test } from "bun:test";
import { templateVars } from "../src/server/notify/templates";
import { EVENT_TYPES, TEMPLATE_VARIABLES, type EventType } from "../src/shared/events";
import { matchTemplatePreset, TEMPLATE_PRESETS } from "../src/shared/template-presets";
import {
  previewTemplate,
  renderMessage,
  renderTemplate,
  resolveTemplate,
  sampleTemplateVars,
} from "../src/shared/templates";

describe("templates", () => {
  test("replaces known variables and keeps unknown ones", () => {
    expect(renderTemplate("{ups} at {battery} ({nope})", { ups: "Rack", battery: "40%" })).toBe("Rack at 40% ({nope})");
  });

  test("leaves out lines whose values are all empty", () => {
    const vars = { message: "M", battery: "", runtime: "", ups: "Rack" };
    expect(renderTemplate("{message}\n\nBattery {battery}\nRuntime {runtime}", vars)).toBe("M");
    expect(renderTemplate("{ups} at {battery}\nno values\n{nope}", vars)).toBe("Rack at \nno values\n{nope}");
  });

  test("an empty title or body falls back to the event's own", () => {
    const vars = { title: "T", message: "M", battery: "" };
    expect(renderMessage({ title: "", body: "Battery {battery}" }, vars)).toEqual({ title: "T", body: "M" });
    expect(renderMessage({ title: "x", body: "y" }, vars)).toEqual({ title: "x", body: "y" });
  });

  test("joins the senders of a wake packet and passes on errors and durations", () => {
    const event = { type: "wake_sent", title: "T", message: "M", createdAt: new Date("2026-01-01T00:00:00Z") };
    const vars = templateVars({ ...event, data: { via: ["server", "agent"], error: "boom", duration: "5m 0s" } });
    expect(vars).toMatchObject({ via: "server, agent", error: "boom", duration: "5m 0s" });
    expect(templateVars(event)).toMatchObject({ via: "", error: "", duration: "" });
  });

  test("counts agents only for grouped agent updates", () => {
    const event = { type: "agent_updated", title: "T", message: "M", createdAt: new Date("2026-01-01T00:00:00Z") };
    expect(templateVars({ ...event, data: { device: "nas, pve", count: 2 } })).toMatchObject({
      device: "nas, pve",
      count: "2",
    });
    expect(templateVars({ ...event, data: { device: "nas" } }).count).toBe("");
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

  const now = new Date("2026-01-01T12:00:00Z");
  const preview = (id: string, type: EventType) =>
    previewTemplate(type, TEMPLATE_PRESETS.find((p) => p.id === id)!.templates[type], now);

  test("icon presets write the message themselves with icons", () => {
    expect(preview("icon-default", "ups_on_battery")).toEqual({
      title: "🔋 Rack UPS is on battery",
      body: "Rack UPS switched to battery power\n🔋 Battery 98%\n⏱️ Runtime 42m 0s",
    });
    expect(preview("icon-minimal", "ups_power_restored").body).toBe("⏳ 12m 30s\n🔋 64%");
    expect(preview("minimal", "wake_failed").body).toBe("no agent on the subnet");
  });

  test("presets leave out values an event does not carry", () => {
    const unreachable = preview("icon-detailed", "ups_unreachable").body;
    expect(unreachable).toMatch(/^Cannot read Rack UPS from NUT\n❗ connection refused\n🕒 /);
    expect(preview("minimal", "login").body).toBe(sampleTemplateVars("login", now).message);
  });

  test("every preset renders a title and body for each example event", () => {
    for (const preset of TEMPLATE_PRESETS) {
      for (const type of EVENT_TYPES) {
        const { title, body } = preview(preset.id, type);
        expect(title).not.toBe("");
        expect(body).not.toMatch(/^$|\n$|\{/);
      }
    }
  });
});
