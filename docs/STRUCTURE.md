# Project structure

```
WolUPS/
├── Dockerfile, docker-compose.yml   Single-container image and example compose file
├── drizzle/                         SQL migrations, applied on startup
├── drizzle.config.ts                drizzle-kit config (bun run db:generate)
├── vite.config.ts, components.json  Web UI build and shadcn/ui config
├── src/
│   ├── shared/                      Code used by both server and UI
│   │   ├── events.ts                Event types, labels, severities, template variables
│   │   ├── channels.ts              Notification channel types and their config fields
│   │   └── version.ts               Version comparison
│   ├── server/
│   │   ├── index.ts                 Entry point: Hono app, WebSocket, background jobs
│   │   ├── env.ts, logger.ts        Env vars, generated secrets, JSON logging
│   │   ├── settings.ts              App settings stored in the database
│   │   ├── secrets.ts               Encryption box and server signing key
│   │   ├── events.ts                Event log and listeners
│   │   ├── cli.ts                   Recovery commands (reset-password)
│   │   ├── db/                      Drizzle schema and SQLite client
│   │   ├── auth/                    Better Auth setup and session middleware
│   │   ├── crypto/                  AES-GCM secret storage, Ed25519 signing
│   │   ├── nut/                     NUT protocol client and parser
│   │   ├── monitor/                 UPS polling, outages, shutdown and wake rules, presence
│   │   ├── agents/                  Agent protocol, enrollment, WebSocket hub, release checks
│   │   ├── wol/                     Magic packets, subnet matching, agent relay
│   │   ├── notify/                  Channel config, providers, templates, delivery retries
│   │   └── routes/                  REST API for the UI and public agent endpoints
│   └── web/                         React UI
│       ├── components/              Layout, shared components, shadcn/ui primitives
│       ├── lib/                     API client, auth client, types, formatting, theme
│       └── pages/                   Dashboard, UPS, Devices, Events, Channels, Settings, auth pages
├── agent/                           Go agent, install.sh and uninstall.sh
├── tests/                           bun test suites
├── docs/                            Agent guide and this file
└── .github/workflows/               CI, Docker image, agent release
```
