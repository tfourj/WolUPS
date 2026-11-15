# Building and Development

## Build the image from source

```bash
BASE_URL=https://wolups.example.com docker compose -f docker-compose-local.yml up -d --build
```

## Development

Requires [Bun](https://bun.sh) and, for the agent, [Go](https://go.dev).

```bash
bun install
bun run dev        # API on port 4321
bun run dev:web    # UI on port 5173, /api proxied to 4321
```

Other scripts:

```bash
bun run test         # tests
bun run typecheck    # TypeScript
bun run build        # frontend into dist/web
bun run db:generate  # create a migration after editing src/server/db/schema.ts
cd agent && go test ./...
```

## Releases

The server and the agent are tagged and released separately, see [VERSIONING.md](VERSIONING.md).

## Screenshots

The README screenshots use made-up demo data. Only Docker is needed:

```bash
sh scripts/screenshots.sh        # dark mode, or pass light
```

See [STRUCTURE.md](STRUCTURE.md) for the code layout.
