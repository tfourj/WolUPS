import nodemailer from "nodemailer";
import type { ChannelType } from "../../../shared/channels";
import { ensureOk, postJson, priority, str, type Provider } from "./types";

const SEVERITY_COLORS = { info: 0x3b82f6, success: 0x22c55e, warning: 0xf59e0b, error: 0xef4444 };

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const discord: Provider = async (config, msg) => {
  await postJson(str(config, "webhookUrl"), {
    username: str(config, "username") || "WolUPS",
    embeds: [
      {
        title: msg.title.slice(0, 256),
        description: msg.body.slice(0, 4000),
        color: SEVERITY_COLORS[msg.severity],
        timestamp: msg.time.toISOString(),
      },
    ],
  });
};

const telegram: Provider = async (config, msg) => {
  await postJson(`https://api.telegram.org/bot${str(config, "botToken")}/sendMessage`, {
    chat_id: str(config, "chatId"),
    text: `<b>${escapeHtml(msg.title)}</b>\n${escapeHtml(msg.body)}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
};

const ntfy: Provider = async (config, msg) => {
  const token = str(config, "token");
  const tags = { error: ["rotating_light"], warning: ["warning"], success: ["white_check_mark"], info: ["electric_plug"] };
  await postJson(
    str(config, "serverUrl").replace(/\/+$/, "") || "https://ntfy.sh",
    { topic: str(config, "topic"), title: msg.title, message: msg.body, priority: priority(config, msg.severity), tags: tags[msg.severity] },
    token ? { Authorization: `Bearer ${token}` } : {},
  );
};

const gotify: Provider = async (config, msg) => {
  const gotifyPriority = { 1: 1, 2: 3, 3: 5, 4: 7, 5: 9 }[priority(config, msg.severity)] ?? 5;
  await postJson(
    `${str(config, "serverUrl").replace(/\/+$/, "")}/message`,
    { title: msg.title, message: msg.body, priority: gotifyPriority },
    { "X-Gotify-Key": str(config, "appToken") },
  );
};

const slack: Provider = async (config, msg) => {
  await postJson(str(config, "webhookUrl"), { text: `*${msg.title}*\n${msg.body}` });
};

const pushover: Provider = async (config, msg) => {
  const p = priority(config, msg.severity);
  const form = new URLSearchParams({
    token: str(config, "appToken"),
    user: str(config, "userKey"),
    title: msg.title.slice(0, 250),
    message: msg.body.slice(0, 1024),
    priority: String(Math.min(1, p - 3)),
    timestamp: String(Math.floor(msg.time.getTime() / 1000)),
  });
  if (str(config, "device")) form.set("device", str(config, "device"));
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  await ensureOk(res);
};

const email: Provider = async (config, msg) => {
  const security = str(config, "security") || "starttls";
  const transport = nodemailer.createTransport({
    host: str(config, "host"),
    port: Number(config.port) || 587,
    secure: security === "tls",
    requireTLS: security === "starttls",
    auth: str(config, "username") ? { user: str(config, "username"), pass: str(config, "password") } : undefined,
    connectionTimeout: 15_000,
  });
  await transport.sendMail({
    from: str(config, "from"),
    to: str(config, "to"),
    subject: msg.title,
    text: msg.body,
  });
};

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

const webhook: Provider = async (config, msg) => {
  await postJson(
    str(config, "url"),
    { event: msg.event, title: msg.title, message: msg.body, severity: msg.severity, time: msg.time.toISOString(), data: msg.data },
    parseHeaders(str(config, "headers")),
    str(config, "method") === "PUT" ? "PUT" : "POST",
  );
};

export const providers: Record<ChannelType, Provider> = { discord, telegram, ntfy, gotify, slack, pushover, email, webhook };
