# ============================================================================
# Relay OSS — production image
# Multi-stage: build the SPA + type-check the API, then ship a slim runtime.
# ============================================================================
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile only, so the layer caches on source changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DB_PATH=/data/relay.sqlite

RUN apk add --no-cache tini curl && addgroup -S relay && adduser -S relay -G relay

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/src apps/api/src
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/db db
COPY --from=build /app/scripts scripts

RUN mkdir -p /data && chown -R relay:relay /data /app
USER relay
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
