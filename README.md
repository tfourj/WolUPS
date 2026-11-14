<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-white.svg">
    <img src="docs/assets/logo-black.svg" alt="WolUPS logo" width="96">
  </picture>
</p>

<h1 align="center">WolUPS</h1>

<p align="center">
  Self-hosted UPS monitoring with safe shutdowns and Wake-on-LAN.<br>
  Shuts your machines down at the battery level you choose and wakes them when power is back.
</p>

> [!NOTE]
> This app was developed using AI tools.

## Features

- Monitors any number of UPS units through NUT
- Per-device shutdown at a battery or runtime threshold
- Lightweight Linux agent with one-line install, no open ports or certificates
- Automatic agent updates
- Wake-on-LAN after power returns, sent by the server or relayed through an agent
- Notifications for power loss, shutdowns, wakes and agent updates
- Custom message templates
- Two-factor authentication and optional notifications for new sign-ins
- Dashboard with live status, battery history and event log
- Dark and light mode

## Screenshots

| Dashboard | Devices |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Devices](docs/screenshots/devices.png) |
| **UPS** | **Events** |
| ![UPS](docs/screenshots/ups.png) | ![Events](docs/screenshots/events.png) |
| **Channels** | |
| ![Channels](docs/screenshots/channels.png) | |

## Tech Stack

Bun, Hono, SQLite (Drizzle), Better Auth, React, Tailwind CSS, Go (agent)

## Install with Docker Compose

1. Download [docker-compose.yml](docker-compose.yml).
2. Create a `.env` file next to it:

   ```bash
   # Public HTTPS URL, used for login and agent install commands
   BASE_URL=https://wolups.example.com

   # Generate each with: openssl rand -base64 32
   # Optional, generated into /data/secrets.json if empty. Never change ENCRYPTION_SECRET later.
   BETTER_AUTH_SECRET=
   ENCRYPTION_SECRET=

   # Optional
   PORT=4321
   # Default timezone, can be changed in Settings → General
   TZ=Europe/Berlin
   ```

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open `BASE_URL` and create your account.
5. Add your NUT server in **UPS**, then your machines in **Devices**, and install the agent on each one.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all options and [docs/BUILD.md](docs/BUILD.md) to build from source.

## Notification providers

- Discord
- Telegram
- ntfy
- Gotify
- Slack
- Pushover
- Email (SMTP)
- Webhook (JSON)

## License

[GPL-3.0](LICENSE)
