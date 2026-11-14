/** Channel types and their config fields. The UI builds forms from this; the server validates against it. */

export type FieldType = "text" | "password" | "number" | "select" | "textarea" | "url" | "email";

export type ChannelField = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number;
  options?: { value: string; label: string }[];
};

export const PRIORITY_OPTIONS = [
  { value: "auto", label: "Auto (by severity)" },
  { value: "1", label: "1 (lowest)" },
  { value: "2", label: "2" },
  { value: "3", label: "3 (default)" },
  { value: "4", label: "4" },
  { value: "5", label: "5 (highest)" },
];

export const CHANNEL_TYPES = {
  discord: {
    label: "Discord",
    fields: [
      { name: "webhookUrl", label: "Webhook URL", type: "url", required: true, secret: true,
        placeholder: "https://discord.com/api/webhooks/..." },
      { name: "username", label: "Bot name", type: "text", placeholder: "WolUPS" },
    ],
  },
  telegram: {
    label: "Telegram",
    fields: [
      { name: "botToken", label: "Bot token", type: "password", required: true, secret: true },
      { name: "chatId", label: "Chat ID", type: "text", required: true, placeholder: "123456789" },
    ],
  },
  ntfy: {
    label: "ntfy",
    fields: [
      { name: "serverUrl", label: "Server URL", type: "url", required: true, default: "https://ntfy.sh" },
      { name: "topic", label: "Topic", type: "text", required: true },
      { name: "token", label: "Access token", type: "password", secret: true, help: "Only for protected topics" },
      { name: "priority", label: "Priority", type: "select", default: "auto", options: PRIORITY_OPTIONS },
    ],
  },
  gotify: {
    label: "Gotify",
    fields: [
      { name: "serverUrl", label: "Server URL", type: "url", required: true, placeholder: "https://gotify.example.com" },
      { name: "appToken", label: "App token", type: "password", required: true, secret: true },
      { name: "priority", label: "Priority", type: "select", default: "auto", options: PRIORITY_OPTIONS },
    ],
  },
  slack: {
    label: "Slack",
    fields: [
      { name: "webhookUrl", label: "Webhook URL", type: "url", required: true, secret: true,
        placeholder: "https://hooks.slack.com/services/..." },
    ],
  },
  pushover: {
    label: "Pushover",
    fields: [
      { name: "appToken", label: "App token", type: "password", required: true, secret: true },
      { name: "userKey", label: "User key", type: "password", required: true, secret: true },
      { name: "device", label: "Device", type: "text", help: "Leave empty for all devices" },
      { name: "priority", label: "Priority", type: "select", default: "auto", options: PRIORITY_OPTIONS },
    ],
  },
  email: {
    label: "Email (SMTP)",
    fields: [
      { name: "host", label: "SMTP host", type: "text", required: true, placeholder: "smtp.example.com" },
      { name: "port", label: "Port", type: "number", required: true, default: 587 },
      {
        name: "security",
        label: "Security",
        type: "select",
        default: "starttls",
        options: [
          { value: "starttls", label: "STARTTLS" },
          { value: "tls", label: "TLS" },
          { value: "none", label: "None" },
        ],
      },
      { name: "username", label: "Username", type: "text" },
      { name: "password", label: "Password", type: "password", secret: true },
      { name: "from", label: "From", type: "email", required: true, placeholder: "wolups@example.com" },
      { name: "to", label: "To", type: "text", required: true, help: "Separate several addresses with commas" },
    ],
  },
  webhook: {
    label: "Webhook (JSON)",
    fields: [
      { name: "url", label: "URL", type: "url", required: true, secret: true },
      {
        name: "method",
        label: "Method",
        type: "select",
        default: "POST",
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
        ],
      },
      { name: "headers", label: "Headers", type: "textarea", secret: true, placeholder: "Authorization: Bearer ...",
        help: "One header per line" },
    ],
  },
} satisfies Record<string, { label: string; fields: ChannelField[] }>;

export type ChannelType = keyof typeof CHANNEL_TYPES;

export const CHANNEL_TYPE_IDS = Object.keys(CHANNEL_TYPES) as ChannelType[];

export function channelFields(type: ChannelType): ChannelField[] {
  return CHANNEL_TYPES[type].fields;
}
