/** Parsing for NUT network protocol responses (RFC 9271). */

export type UpsVars = Record<string, string>;

export type UpsSnapshot = {
  status: string;
  flags: string[];
  onBattery: boolean;
  onLine: boolean;
  lowBattery: boolean;
  battery: number | null;
  runtime: number | null;
  load: number | null;
  inputVoltage: number | null;
  model: string | null;
};

/** Unquote a NUT value: "foo \"bar\"" -> foo "bar" */
export function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  let out = "";
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length) {
      out += trimmed[++i];
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

/** Parse `VAR <ups> <name> "<value>"` lines into a map. */
export function parseVarList(lines: string[]): UpsVars {
  const vars: UpsVars = {};
  for (const line of lines) {
    const match = /^VAR\s+\S+\s+(\S+)\s+(.*)$/.exec(line);
    if (match) vars[match[1]] = unquote(match[2]);
  }
  return vars;
}

/** Parse `UPS <name> "<description>"` lines. */
export function parseUpsList(lines: string[]): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const line of lines) {
    const match = /^UPS\s+(\S+)\s+(.*)$/.exec(line);
    if (match) out.push({ name: match[1], description: unquote(match[2]) });
  }
  return out;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Turn raw variables into a snapshot. Battery is clamped to 0-100 and rounded; invalid values become null. */
export function toSnapshot(vars: UpsVars): UpsSnapshot {
  const status = (vars["ups.status"] ?? "").trim();
  const flags = status.toUpperCase().split(/\s+/).filter(Boolean);
  const batteryRaw = toNumber(vars["battery.charge"]);
  const battery = batteryRaw !== null && batteryRaw >= 0 && batteryRaw <= 100 ? Math.round(batteryRaw) : null;
  const runtime = toNumber(vars["battery.runtime"]);
  const load = toNumber(vars["ups.load"]);
  const model = vars["ups.model"] ?? vars["device.model"] ?? null;
  return {
    status,
    flags,
    onBattery: flags.includes("OB"),
    onLine: flags.includes("OL"),
    lowBattery: flags.includes("LB"),
    battery,
    runtime: runtime === null ? null : Math.round(runtime),
    load: load === null ? null : Math.round(load),
    inputVoltage: toNumber(vars["input.voltage"]),
    model: model?.trim() || null,
  };
}

/** Power state the monitor acts on. `unknown` means the data is not safe to act on. */
export function powerState(snapshot: UpsSnapshot): "online" | "battery" | "unknown" {
  if (snapshot.onBattery) return "battery";
  if (snapshot.onLine) return "online";
  return "unknown";
}

/** Parse `CMD <ups> <name>` lines into command names. */
export function parseCmdList(lines: string[]): string[] {
  return lines.map((line) => /^CMD\s+\S+\s+(\S+)/.exec(line)?.[1]).filter((name): name is string => !!name);
}

/** Split the quoted values after a `<KIND> <ups> <var>` prefix, for ENUM and RANGE lists. */
function quotedValues(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => unquote(`"${match[1]}"`));
}

/** `ENUM <ups> <var> "<value>"` lines into values. */
export function parseEnumList(lines: string[]): string[] {
  return lines.map((line) => quotedValues(line)[0]).filter((value): value is string => value !== undefined);
}

/** `RANGE <ups> <var> "<min>" "<max>"` lines into numeric ranges. */
export function parseRangeList(lines: string[]): { min: number; max: number }[] {
  return lines
    .map((line) => quotedValues(line).map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
    .map(([min, max]) => ({ min, max }));
}

export type WritableType =
  | { kind: "string"; maxLength: number | null }
  | { kind: "number" }
  | { kind: "enum" }
  | { kind: "range" };

/** `TYPE <ups> <var> RW STRING:30` (or ENUM, RANGE, NUMBER) into the kind of value a variable takes. */
export function parseType(line: string): WritableType {
  const flags = line.split(/\s+/).slice(3);
  if (flags.includes("ENUM")) return { kind: "enum" };
  if (flags.includes("RANGE")) return { kind: "range" };
  if (flags.includes("NUMBER")) return { kind: "number" };
  const string = flags.find((flag) => flag.startsWith("STRING"));
  const length = string ? Number(string.split(":")[1]) : NaN;
  return { kind: "string", maxLength: Number.isFinite(length) ? length : null };
}

/** Parse `RW <ups> <name> "<value>"` lines into a map. */
export function parseRwList(lines: string[]): UpsVars {
  const vars: UpsVars = {};
  for (const line of lines) {
    const match = /^RW\s+\S+\s+(\S+)\s+(.*)$/.exec(line);
    if (match) vars[match[1]] = unquote(match[2]);
  }
  return vars;
}
