# ============================================================================
# Relay OSS — production image
#
# Multi-stage: build the SPA and compile the API in a full toolchain, then ship
# a slim runtime with only production dependencies. Runs as a non-root user with
# tini as PID 1 so SIGTERM reaches Node and shutdown is graceful.
# ============================================================================
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies resolve from the lockfile only, so this layer caches on source edits.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

COPY . .
# Guard first: a Docker build must not succeed on a codebase that fails its own
# architecture rules.
RUN node scripts/guard-no-json-store.mjs \
 && node scripts/guard-sql-portability.mjs \
 && node scripts/gen-pg-migrations.mjs --check \
 && npm run typecheck \
 && npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

RUN apk add --no-cache tini curl && addgroup -S relay && adduser -S relay -G relay

# Production dependencies only: the same lockfile, no dev toolchain in the image.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# Migrations are read at boot (SQLite set + generated PostgreSQL set).
COPY --from=build /app/db db

ENV SKIP_MIGRATE=0 \
    AUTH_MODE=oidc

USER relay
EXPOSE 4000

# Readiness, not liveness: this reports 503 when the database is unreachable.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/ready || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
