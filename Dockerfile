# syntax=docker/dockerfile:1

# --- Build the web UI ---
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- Production dependencies only ---
FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Runtime ---
FROM oven/bun:1.4.4-alpine
# Set by CI. Builds that are not a stable release show the short commit instead of the version.
ARG WOLUPS_VERSION=""
ARG WOLUPS_COMMIT=""
ARG WOLUPS_RELEASE="false"
ENV NODE_ENV=production \
    PORT=4321 \
    DATA_DIR=/data \
    WEB_DIR=/app/dist/web \
    MIGRATIONS_DIR=/app/drizzle \
    WOLUPS_VERSION=${WOLUPS_VERSION} \
    WOLUPS_COMMIT=${WOLUPS_COMMIT} \
    WOLUPS_RELEASE=${WOLUPS_RELEASE}
# iputils for device ping checks, tzdata so TZ works
RUN apk add --no-cache iputils tzdata
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/web ./dist/web
COPY package.json ./
COPY drizzle ./drizzle
COPY src/server ./src/server
COPY src/shared ./src/shared
VOLUME /data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["bun", "src/server/index.ts"]
