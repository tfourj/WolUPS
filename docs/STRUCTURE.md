# Project structure

```
WolUPS/
├── Dockerfile                       Single-container image
├── docker-compose.yml               Compose file for the published image (-local builds from source)
├── drizzle/                         SQL migrations, applied on startup
├── drizzle.config.ts                drizzle-kit config (bun run db:generate)
├── vite.config.ts, components.json  Web UI build and shadcn/ui config
├── src/
│   ├── shared/                      Code used by both server and UI
│   │   ├── events.ts                Event types, labels, severities, template variables
│   │   ├── channels.ts              Notification channel types and their config fields
│   │   ├── templates.ts             Template rendering and resolution
│   │   ├── template-presets.ts      Ready-made template sets
│   │   ├── time.ts                  Time display preferences and notification time format
│   │   └── version.ts               Version comparison
│   ├── server/
│   │   ├── index.ts                 Entry point: Hono app, WebSocket, background jobs
│   │   ├── env.ts, logger.ts        Env vars, generated secrets, JSON logging
│   │   ├── build-info.ts            Running version and commit
│   │   ├── settings.ts              App settings stored in the database
│   │   ├── secrets.ts               Encryption box and server signing key
│   │   ├── events.ts                Event log and listeners
│   │   ├── cli.ts                   Recovery commands (reset-password, disable-2fa)
│   │   ├── db/                      Drizzle schema and SQLite client
│   │   ├── auth/                    Better Auth and two-factor setup, login event hook, sessions
│   │   ├── crypto/                  AES-GCM secret storage, Ed25519 signing
│   │   ├── nut/                     NUT protocol client and parser
│   │   ├── monitor/                 UPS polling, outages, shutdown and wake rules, presence
│   │   ├── agents/                  Agent protocol, enrollment, WebSocket hub, release checks
│   │   ├── nut-hosts/               NUT agent commands, apply and verify, health events
│   │   ├── wol/                     Magic packets, subnet matching, agent relay
│   │   ├── notify/                  Channel config, providers, templates, delivery retries
│   │   └── routes/                  REST API for the UI and public agent endpoints
│   └── web/                         React UI
│       ├── components/              Layout, shared components, shadcn/ui primitives
│       ├── lib/                     API client, auth client, types, formatting, theme
│       └── pages/                   Dashboard, UPS and NUT hosts, Devices, Events, Channels, Settings, auth
├── agent/                           Go agents with their install and uninstall scripts
│   ├── internal/core/               Pairing, connection, signed commands, updates, service file
│   ├── internal/nut/                NUT config, scanning, services and health checks
│   ├── cmd/wolups-agent/            Device agent: shutdown, wake, MAC lookup
│   └── cmd/wolups-nut-agent/        NUT agent: sets up and manages NUT on a host
├── tests/                           bun test suites
├── scripts/                         README screenshot generator with demo data
├── docs/                            Configuration, build guide, versioning, screenshots and logo
└── .github/workflows/               build (checks, Docker image, server release), agent and NUT agent releases
```
