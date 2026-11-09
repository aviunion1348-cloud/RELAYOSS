# ============================================================================
# Relay OSS — production image
#
# Multi-stage: build the SPA and compile the API in a full toolchain, then ship
# a slim runtime with only production dependencies. Runs as a non-root user with
# tini as PID 1 so SIGTERM reaches Node and shutdown is graceful.
# ============================================================================
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies resolve from lockfiles only, so these layers cache on source edits.
#
# Two installs, because apps/web is deliberately not an npm workspace member any more:
# a workspace member's `npm ci` resolves the workspace root and replaces the root
# node_modules, which is what broke the Vercel deployment. Keeping the frontend
# standalone everywhere — image, CI, platform — means one install cannot delete the
# other's dependencies.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# The root `postinstall` installs apps/web, which developers need after `npm install`.
# The script has to exist for npm to run it; here `apps/web/package.json` is not copied
# yet, so it does nothing and the explicit frontend install below stays in charge of it.
COPY scripts/install-web-deps.mjs scripts/
RUN npm ci --no-audit --no-fund

COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN npm ci --include=dev --prefix apps/web --no-audit --no-fund

COPY . .
# Guard first: a Docker build must not succeed on a codebase that fails its own
# architecture rules.
RUN node scripts/guard-no-json-store.mjs \
 && node scripts/guard-sql-portability.mjs \
 && node scripts/guard-declared-deps.mjs \
 && node scripts/gen-pg-migrations.mjs --check \
 && node scripts/check-traceability.mjs \
 && npm run typecheck \
 && npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

RUN apk add --no-cache tini curl && addgroup -S relay && adduser -S relay -G relay

# Production dependencies only: the same lockfiles, no dev toolchain in the image.
# The SPA is already built, so the frontend needs no dependencies at runtime at all.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# Same reason as the build stage: `npm ci` runs the root `postinstall`, so the file it
# references must be present. `apps/web/package.json` is not in this stage, so it exits
# without installing anything — the SPA is already built and needs no runtime deps.
COPY scripts/install-web-deps.mjs scripts/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# The PostgreSQL driver must exist in a production-only install. It once did not:
# `pg` resolved only through a dev tool, so the image built and then crashed on
# boot. Fail the build instead of the deployment.
RUN node -e "import('pg').then(() => console.log('✓ pg present')).catch(() => { console.error('✗ pg missing from the production install'); process.exit(1); })" 

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# Migrations are read at boot (SQLite set + generated PostgreSQL set).
COPY --from=build /app/db db

ENV SKIP_MIGRATE=0

USER relay
EXPOSE 4000

# Readiness, not liveness: this reports 503 when the database is unreachable.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/ready || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
