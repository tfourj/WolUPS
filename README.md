# WolUPS

**WolUPS** watches your UPS units through [NUT (Network UPS Tools)](https://networkupstools.org/), shuts down machines at the battery level you choose, and wakes them again with Wake-on-LAN once power is back. It is a self-hosted web app with a small agent for each Linux machine.

## What it does

When a UPS switches to battery, WolUPS:

1. Reads the UPS from your NUT server and starts tracking the outage
2. Remembers which devices were online before the outage
3. Sends a signed shutdown to each device's agent when the UPS reaches that device's battery (or runtime) threshold
4. Retries until the agent confirms, without ever shutting a machine down twice
5. Waits for line power and a safe battery level after the outage
6. Wakes the devices that were online, from the server or through an agent on the same LAN
7. Notifies you at every step

## Features

- Multiple NUT servers and UPS units, each device assigned to one UPS
- Per-device battery and optional runtime shutdown thresholds
- Linux agent (amd64, arm64) that connects out to WolUPS over HTTPS, with no open port and no certificates to manage
- One-line agent install with a one-time token, and verified automatic agent updates
- Wake-on-LAN from the server or relayed through any online agent
- Notifications through Discord, Telegram, ntfy, Gotify, Slack, Pushover, email (SMTP), or a JSON webhook, with per-channel event, UPS, and device filters, custom templates, and retries
- Dashboard with live UPS status, battery history, and an event log with delivery status for each channel
- Single user, secrets encrypted at rest, and runs in one Docker container

## Quick start

### Docker Compose

```yaml
services:
  wolups:
    image: ghcr.io/tfourj/wolups:latest
    container_name: wolups
    restart: unless-stopped
    ports:
      - "4321:4321"
    volumes:
      - ./data:/data
    environment:
      - BASE_URL=https://wolups.example.com
      - TZ=Europe/London
```

```bash
docker compose up -d
```

### Docker run

```bash
docker run -d --name wolups --restart unless-stopped \
  -p 4321:4321 \
  -v ./data:/data \
  -e BASE_URL=https://wolups.example.com \
  -e TZ=Europe/London \
  ghcr.io/tfourj/wolups:latest
```

Open WolUPS and create your account. The first account is the only one, and registration closes after it exists.

Then:

1. Add your NUT server under **UPS**. Use **Find** to list the UPS names it serves, and **Test connection** before saving.
2. Add your machines under **Devices**, assign each to its UPS, and set a shutdown threshold.
3. Choose **Install agent** on a device and run the command on that machine as root.
4. Add a notification channel under **Channels** and send a test.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4321` | Port for the web UI, API, and agent connections |
| `BASE_URL` | `http://localhost:4321` | Public URL of WolUPS. Used for sign-in cookies and in agent install commands |
| `BETTER_AUTH_SECRET` | generated | Session signing secret, at least 32 characters |
| `ENCRYPTION_SECRET` | generated | Key for encrypting NUT passwords, channel credentials, and the server signing key |
| `TZ` | `UTC` | Time zone for notification timestamps |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

If either secret is not set, WolUPS generates it on first start, saves it in `/data/secrets.json`, and logs a warning. Back up `/data` as a whole: without `ENCRYPTION_SECRET`, stored credentials cannot be decrypted and every agent has to be paired again.

## Agents

The agent is a single static binary that runs as a systemd service. It connects to `BASE_URL`, so the device only needs outbound HTTPS. The agent accepts only these fixed actions: shut down, send a wake packet, update itself, unpair, and ping. It never runs commands, paths, or URLs sent by the server.

Install it from the device's **Install agent** dialog. The command looks like this:

```bash
curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/install.sh | sh -s -- --server https://wolups.example.com --token <token>
```

Run it as root. On Proxmox you are root already. Elsewhere, use `| sudo sh -s -- ...` instead. The installer never calls `sudo` itself, and tells you how to rerun it if you are not root.

See [docs/agent.md](docs/agent.md) for pairing, updates, security, and recovery.

## Wake-on-LAN

Wake packets are broadcasts, so they only reach your LAN from a container that uses `network_mode: host`. With the default port mapping, WolUPS asks an online agent to send the packet instead, preferring one on the target's subnet. In **Settings → Wake** you can choose to send from the server, from a relay agent, or both (the default).

## Reverse proxy, Coolify and Cloudflare

- Set `BASE_URL` to the public HTTPS address. WolUPS reads the client IP from `CF-Connecting-IP`, `X-Real-IP`, or `X-Forwarded-For`, so keep port 4321 reachable only through the proxy.
- In Coolify, expose port `4321`, add a persistent volume at `/data`, and set `BASE_URL` to the domain Coolify serves. The image includes a health check on `/api/health`.
- Agents connect with a WebSocket at `/api/agents/ws`, which Cloudflare supports.
- Cloudflare must not challenge the agent: Bot Fight Mode or a managed challenge breaks `/api/agents/enroll` and `/api/agents/ws`. Disable Bot Fight Mode, or add a WAF custom rule that skips security checks for paths starting with `/api/agents/`.

## Notifications

Each channel has its own event list and can be limited to specific UPS units or devices. Message templates can be set globally under **Settings → Templates** or per channel, using these variables:

`{event}` `{title}` `{message}` `{ups}` `{device}` `{battery}` `{runtime}` `{status}` `{threshold}` `{version}` `{time}`

Failed deliveries are retried with exponential backoff, up to 6 attempts. Every attempt is logged, and failed deliveries can be retried from the **Events** page.

## Recovery

Reset the password from inside the container:

```bash
docker exec -it wolups bun src/server/cli.ts reset-password 'new-password'
```

## Development

```bash
bun install
bun run dev        # API on :4321
bun run dev:web    # UI on :5173, proxied to the API
bun run test
cd agent && go test ./...
```

Project layout is described in [docs/STRUCTURE.md](docs/STRUCTURE.md).

## Releases

Pushing a `vX.Y.Z` tag publishes the Docker image and a GitHub release with both agent binaries, `install.sh`, `uninstall.sh`, `agent-release.json`, and a SHA-256 file for each.
