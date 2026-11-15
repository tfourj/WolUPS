// Fills a fresh WolUPS instance with made-up demo data for the README screenshots, then keeps
// running to serve two fake NUT UPS units, four connected demo agents and a demo NUT agent.
// Runs inside the app container started by scripts/screenshots.sh, with the server on localhost:4321.
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:net";

const BASE = "http://localhost:4321";
const DATA_DIR = process.env.DATA_DIR ?? "/tmp/data";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = Date.now();

// --- Fake NUT servers ---

type FakeUps = { port: number; vars: Record<string, string> };
const FAKE_UPS: FakeUps[] = [
  {
    port: 3493,
    vars: {
      "ups.status": "OL",
      "battery.charge": "100",
      "battery.runtime": "2520",
      "ups.load": "31",
      "input.voltage": "231.4",
      "ups.model": "Eaton 5PX 1500",
    },
  },
  {
    port: 3494,
    vars: {
      "ups.status": "OL CHRG",
      "battery.charge": "86",
      "battery.runtime": "1080",
      "ups.load": "22",
      "input.voltage": "229.8",
      "ups.model": "APC Back-UPS 900",
    },
  },
];

for (const ups of FAKE_UPS) {
  createServer((sock) => {
    sock.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        if (line === "LIST VAR ups") {
          const body = Object.entries(ups.vars)
            .map(([k, v]) => `VAR ups ${k} "${v}"`)
            .join("\n");
          sock.write(`BEGIN LIST VAR ups\n${body}\nEND LIST VAR ups\n`);
        } else if (line === "LIST UPS") sock.write('BEGIN LIST UPS\nUPS ups "Demo UPS"\nEND LIST UPS\n');
        else if (line === "LOGOUT") sock.end("OK Goodbye\n");
        else sock.write("OK\n");
      }
    });
  }).listen(ups.port, "127.0.0.1");
}

// --- Account and API helpers ---

const register = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ name: "Alex Morgan", email: "alex@example.com", password: "demopass123" }),
});
if (!register.ok) throw new Error(`register failed: ${register.status} ${await register.text()}`);
const cookie = register.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

await api("PATCH", "/settings", { pollIntervalSec: 5 });
const rack = await api<{ id: string }>("POST", "/ups", {
  name: "Rack UPS",
  host: "127.0.0.1",
  port: 3493,
  upsName: "ups",
});
const office = await api<{ id: string }>("POST", "/ups", {
  name: "Office UPS",
  host: "127.0.0.1",
  port: 3494,
  upsName: "ups",
});

type DemoDevice = { name: string; body: Record<string, unknown>; agent?: { hostname: string; arch: string } };
const DEVICES: DemoDevice[] = [
  {
    name: "proxmox-1",
    body: {
      host: "192.168.1.20",
      mac: "bc:24:11:4a:9e:01",
      upsId: rack.id,
      shutdownEnabled: true,
      shutdownBatteryPercent: 30,
    },
    agent: { hostname: "pve1", arch: "amd64" },
  },
  {
    name: "proxmox-2",
    body: {
      host: "192.168.1.21",
      mac: "bc:24:11:4a:9e:02",
      upsId: rack.id,
      shutdownEnabled: true,
      shutdownBatteryPercent: 40,
    },
    agent: { hostname: "pve2", arch: "amd64" },
  },
  {
    name: "truenas",
    body: {
      host: "192.168.1.30",
      mac: "a8:a1:59:3c:10:7f",
      upsId: rack.id,
      shutdownEnabled: true,
      shutdownBatteryPercent: 25,
      shutdownRuntimeSec: 300,
    },
    agent: { hostname: "truenas", arch: "amd64" },
  },
  {
    name: "pi-relay",
    body: { host: "192.168.1.5", upsId: office.id, wakeEnabled: false },
    agent: { hostname: "raspberrypi", arch: "arm64" },
  },
  {
    name: "media-pc",
    body: { host: "192.168.1.40", mac: "d8:5e:d3:21:6b:aa", upsId: office.id, alwaysWake: true },
  },
];

// --- Demo agents: real enrollment, then a WebSocket that answers like the Go agent ---

type AgentInfo = {
  version: string;
  protocol: number;
  os: string;
  arch: string;
  hostname: string;
  interfaces: { name: string; mac: string; cidrs: string[] }[];
};

/** Pair a demo agent with an enrollment token and keep it connected. `onWelcome` runs once it is accepted. */
async function connectAgent(token: string, info: AgentInfo, onWelcome?: (ws: WebSocket) => void) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const enroll = await fetch(`${BASE}/api/agents/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, publicKey: publicKey.export({ format: "jwk" }).x, info }),
  });
  const { agentId } = (await enroll.json()) as { agentId: string };
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/agents/ws`);
  ws.onmessage = (msg) => {
    const data = JSON.parse(String(msg.data));
    if (data.type === "challenge") {
      const ts = Date.now();
      const message = `wolups-hello:v1\n${agentId}\n${data.nonce}\n${ts}`;
      const sig = sign(null, Buffer.from(message), privateKey).toString("base64url");
      ws.send(JSON.stringify({ type: "hello", agentId, nonce: data.nonce, ts, sig, info }));
    } else if (data.type === "welcome") {
      onWelcome?.(ws);
    } else if (data.type === "command") {
      ws.send(JSON.stringify({ type: "ack", id: JSON.parse(data.payload).id, ok: true }));
    }
  };
}

const deviceIds: Record<string, string> = {};
for (const d of DEVICES) {
  const device = await api<{ id: string }>("POST", "/devices", { name: d.name, ...d.body });
  deviceIds[d.name] = device.id;
  if (!d.agent) continue;
  const info = {
    version: "1.2.0",
    protocol: 1,
    os: "linux",
    arch: d.agent.arch,
    hostname: d.agent.hostname,
    interfaces: [{ name: "eth0", mac: String(d.body.mac ?? "dc:a6:32:00:00:05"), cidrs: [`${d.body.host}/24`] }],
  };
  const { token } = await api<{ token: string }>("POST", `/devices/${device.id}/enroll`);
  await connectAgent(token, info);
}

// A NUT host whose agent manages the Office UPS and reports healthy NUT services.
const nutHost = await api<{ host: { id: string }; enrollment: { token: string } }>("POST", "/nut-hosts", {
  name: "ups-pi",
});
await connectAgent(
  nutHost.enrollment.token,
  {
    version: "0.1.0",
    protocol: 1,
    os: "linux",
    arch: "arm64",
    hostname: "ups-pi",
    interfaces: [{ name: "eth0", mac: "dc:a6:32:00:00:06", cidrs: ["192.168.1.6/24"] }],
  },
  (ws) =>
    ws.send(
      JSON.stringify({
        type: "nut_status",
        upsd: "running",
        upsmon: "missing",
        listening: true,
        drivers: [{ ups: "ups", state: "running" }],
      }),
    ),
);

await api("POST", "/channels", {
  name: "Phone",
  type: "ntfy",
  config: { serverUrl: "https://ntfy.example.com", topic: "homelab-power" },
  events: ["ups_on_battery", "ups_power_restored", "ups_low_battery", "shutdown_acknowledged", "shutdown_failed"],
});
await api("POST", "/channels", {
  name: "Homelab Discord",
  type: "discord",
  config: { webhookUrl: "https://discord.example.com/api/webhooks/demo" },
  events: [
    "ups_on_battery",
    "ups_power_restored",
    "shutdown_acknowledged",
    "wake_sent",
    "device_recovered",
    "agent_updated",
  ],
});
await api("POST", "/channels", {
  name: "Email",
  type: "email",
  config: { host: "smtp.example.com", port: 587, from: "wolups@example.com", to: "alex@example.com" },
  events: ["ups_low_battery", "shutdown_failed", "wake_failed", "agent_update_failed"],
  enabled: false,
});

// Let the agents connect before replacing the live events with a made-up history.
await Bun.sleep(2000);

// --- History: events, deliveries, outages and battery samples ---

const db = new Database(`${DATA_DIR}/wolups.db`);
// What the setup wizard would have recorded for the NUT host.
db.run(
  `update nut_hosts set os = ?, package_manager = 'apt', nut_version = '2.8.2', config_dir = '/etc/nut',
   listen_address = ? where id = ?`,
  ["Raspberry Pi OS (Debian 12)", "192.168.1.6", nutHost.host.id],
);
db.run("update ups set nut_host_id = ? where id = ?", [nutHost.host.id, office.id]);
db.run("delete from events");
const channels = db.query("select id, name from channels").all() as { id: string; name: string }[];
const channelId = (name: string) => channels.find((c) => c.name === name)!.id;

type Seed = {
  at: number;
  type: string;
  severity: string;
  ups?: string;
  device?: string;
  title: string;
  message: string;
  to?: string[];
};

const outageStart = now - 9 * HOUR - 12 * MINUTE;
const outageEnd = outageStart + 23 * MINUTE;
const blipStart = now - 6 * 24 * HOUR - 3 * HOUR;
const HISTORY: Seed[] = [
  {
    at: blipStart,
    type: "ups_on_battery",
    severity: "warning",
    ups: office.id,
    title: "Office UPS is on battery",
    message: "Office UPS switched to battery at 100% (runtime 21m 0s)",
    to: ["Phone", "Homelab Discord"],
  },
  {
    at: blipStart + 2 * MINUTE + 14_000,
    type: "ups_power_restored",
    severity: "success",
    ups: office.id,
    title: "Office UPS power restored",
    message: "Office UPS is back on line power after 2m 14s, battery at 97%",
    to: ["Phone", "Homelab Discord"],
  },
  {
    at: now - 3 * 24 * HOUR,
    type: "agent_updated",
    severity: "success",
    device: "truenas",
    title: "truenas updated",
    message: "Agent on truenas updated from v1.1.0 to v1.2.0",
    to: ["Homelab Discord"],
  },
  {
    at: outageStart,
    type: "ups_on_battery",
    severity: "warning",
    ups: rack.id,
    title: "Rack UPS is on battery",
    message: "Rack UPS switched to battery at 100% (runtime 42m 0s)",
    to: ["Phone", "Homelab Discord"],
  },
  {
    at: outageStart + 14 * MINUTE,
    type: "shutdown_sent",
    severity: "warning",
    ups: rack.id,
    device: "proxmox-2",
    title: "Shutting down proxmox-2",
    message: "Rack UPS is at 40%, sending shutdown to proxmox-2 (threshold 40%)",
  },
  {
    at: outageStart + 14 * MINUTE + 2_000,
    type: "shutdown_acknowledged",
    severity: "warning",
    device: "proxmox-2",
    title: "proxmox-2 is shutting down",
    message: "proxmox-2 accepted shutdown at 40% UPS charge",
    to: ["Phone", "Homelab Discord"],
  },
  {
    at: outageEnd,
    type: "ups_power_restored",
    severity: "success",
    ups: rack.id,
    title: "Rack UPS power restored",
    message: "Rack UPS is back on line power after 23m 0s, battery at 36%",
    to: ["Phone", "Homelab Discord"],
  },
  {
    at: outageEnd + 31 * MINUTE,
    type: "wake_sent",
    severity: "info",
    ups: rack.id,
    device: "proxmox-2",
    title: "Waking proxmox-2",
    message: "Sent wake packet to proxmox-2 via agent pi-relay",
    to: ["Homelab Discord"],
  },
  {
    at: outageEnd + 33 * MINUTE,
    type: "device_recovered",
    severity: "success",
    ups: rack.id,
    device: "proxmox-2",
    title: "proxmox-2 is back online",
    message: "proxmox-2 came back online after power was restored on Rack UPS",
    to: ["Homelab Discord"],
  },
  {
    at: now - 40 * MINUTE,
    type: "agent_connected",
    severity: "info",
    device: "pi-relay",
    title: "pi-relay connected",
    message: "Agent on pi-relay connected (v1.2.0)",
  },
];

const insertEvent = db.prepare(
  `insert into events (type, severity, ups_id, device_id, title, message, data, created_at)
   values (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertDelivery = db.prepare(
  `insert into deliveries (event_id, channel_id, status, attempts, delivered_at, created_at)
   values (?, ?, 'success', 1, ?, ?)`,
);
for (const e of HISTORY) {
  const deviceId = e.device ? deviceIds[e.device] : null;
  const result = insertEvent.run(e.type, e.severity, e.ups ?? null, deviceId, e.title, e.message, "{}", e.at);
  for (const name of e.to ?? []) {
    insertDelivery.run(Number(result.lastInsertRowid), channelId(name), e.at + 1500, e.at);
  }
}

const insertOutage = db.prepare(
  "insert into outages (id, ups_id, started_at, ended_at, min_battery, low_battery) values (?, ?, ?, ?, ?, 0)",
);
insertOutage.run(crypto.randomUUID(), office.id, blipStart, blipStart + 2 * MINUTE, 97);
insertOutage.run(crypto.randomUUID(), rack.id, outageStart, outageEnd, 36);

// Battery history for the last 7 days, sampled every 5 minutes.
const insertSample = db.prepare(
  "insert into ups_samples (ups_id, ts, status, battery, runtime, load, input_voltage) values (?, ?, ?, ?, ?, ?, ?)",
);
for (let t = now - 7 * 24 * HOUR; t < now; t += 5 * MINUTE) {
  let rackBattery = 100;
  let rackStatus = "OL";
  if (t >= outageStart && t < outageEnd) {
    rackBattery = Math.round(100 - ((t - outageStart) / (outageEnd - outageStart)) * 64);
    rackStatus = "OB DISCHRG";
  } else if (t >= outageEnd && t < outageEnd + 4 * HOUR) {
    rackBattery = Math.min(100, Math.round(36 + ((t - outageEnd) / (4 * HOUR)) * 64));
    rackStatus = "OL CHRG";
  }
  const rackLoad = 29 + Math.round(4 * Math.sin(t / (3 * HOUR)));
  insertSample.run(rack.id, t, rackStatus, rackBattery, Math.round(rackBattery * 25), rackLoad, 231);
  const officeBattery = 86 + Math.round(8 * Math.sin(t / (11 * HOUR)));
  insertSample.run(office.id, t, "OL", officeBattery, officeBattery * 12, 22, 229);
}

await Bun.write(`${DATA_DIR}/seed-ready`, "ok");
console.log("demo data ready");
// Keep serving the fake UPS units and demo agents until the container is removed.
await new Promise(() => {});
