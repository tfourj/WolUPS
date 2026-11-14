import { CHANNEL_TYPES, channelFields, type ChannelType } from "../../shared/channels";
import { box } from "../secrets";
import type { channels } from "../db/schema";
import type { ChannelConfig } from "./providers/types";

export type ChannelRow = typeof channels.$inferSelect;

export function isChannelType(value: string): value is ChannelType {
  return value in CHANNEL_TYPES;
}

export function decryptConfig(row: ChannelRow): ChannelConfig {
  return box.decryptJson<ChannelConfig>(row.configEnc);
}

/**
 * Merge an incoming config with the stored one. Secret fields that are omitted or empty keep their
 * stored value, so the UI never needs to see them. Validates required fields.
 */
export function mergeConfig(type: ChannelType, incoming: Record<string, unknown>, existing: ChannelConfig = {}) {
  const out: ChannelConfig = {};
  const errors: string[] = [];
  for (const field of channelFields(type)) {
    let value = incoming[field.name];
    if (field.secret && (value === undefined || value === "")) value = existing[field.name];
    if (value === undefined || value === null || value === "") value = field.default;
    if (field.type === "number" && value !== undefined && value !== "") {
      const n = Number(value);
      if (!Number.isFinite(n)) errors.push(`${field.label} must be a number`);
      else value = n;
    }
    if (typeof value === "string") value = value.trim();
    if (field.required && (value === undefined || value === "")) errors.push(`${field.label} is required`);
    if (field.type === "url" && typeof value === "string" && value && !/^https?:\/\//i.test(value)) {
      errors.push(`${field.label} must start with http:// or https://`);
    }
    if (field.options && value !== undefined && !field.options.some((o) => o.value === String(value))) {
      errors.push(`${field.label} has an invalid value`);
    }
    if (value !== undefined) out[field.name] = value as string | number;
  }
  return { config: out, errors };
}

/** Config for the UI: secrets replaced with a flag saying whether they are set. */
export function publicConfig(type: ChannelType, config: ChannelConfig) {
  const values: Record<string, string | number> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const field of channelFields(type)) {
    const value = config[field.name];
    if (field.secret) secretsSet[field.name] = value !== undefined && value !== "";
    else if (value !== undefined) values[field.name] = value;
  }
  return { values, secretsSet };
}
