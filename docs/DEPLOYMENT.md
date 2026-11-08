# Deployment

Two supported paths: **Node directly** (what was actually executed in this
environment) and **Docker Compose** (written, validated by build, but *not
executed here — there is no Docker binary in the build environment*). Every
claim below that was not executed is marked.

---

## 1. What runs

| Process | Port | Notes |
| --- | --- | --- |
| API + SPA | `4000` | Fastify serves `/api/*` and the built SPA from `apps/web/dist` |
| PostgreSQL | `5432` (container) / `55432` (local embedded) | authoritative store |
| Clock sweeper | in-process | every `SWEEP_INTERVAL_MS` (default 60 s) |

## 2. Node path — executed

```bash
npm ci                       # lockfile-exact install
npm run guard                # no JSON store, SQL portability, migrations in sync
npm run build                # tsc (api) + vite (web)
npm run db:migrate           # against DATABASE_URL
npm run db:seed              # optional demo dataset
npm start                    # NODE_ENV=production
```

Required environment (see `.env.example`):

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/relay` |
| `AUTH_MODE` | yes | `oidc` for a real deployment |
| `SESSION_SECRET` | yes | ≥32 random bytes; boot fails without it |
| `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URI` | when `AUTH_MODE=oidc` | boot fails if incomplete |
| `CORS_ORIGIN` | recommended | comma-separated origins; `*` is a local default |
| `PORT` / `HOST` | no | `4000` / `0.0.0.0` |
| `SWEEP_INTERVAL_MS` | no | `60000` |
| `SKIP_MIGRATE` | no | set to `1` only when a one-shot migrator ran first |

### Verified boot behaviour

| Scenario | Result |
| --- | --- |
| `NODE_ENV=production` + `AUTH_MODE=dev`, no opt-in | **refuses to boot** (`AUTH_MODE=dev is refused in production…`) |
| `NODE_ENV=production` + `AUTH_MODE=oidc`, partial OIDC vars | **refuses to boot** (`requires OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI`) |
| `NODE_ENV=production` + `AUTH_MODE=dev` + `ALLOW_DEV_AUTH_IN_PRODUCTION=1` | boots, logs `INSECURE AUTHENTICATION…`, serves the demo stack |
| No `SESSION_SECRET` | **refuses to boot** |

With the escape hatch set and PostgreSQL attached: `/api/ready` →
`{ready:true, engine:"postgres"}`, `/api/health` → `schemaVersion: 7`,
`storage: "postgres"`; `POST /api/auth/dev-login` issued a real session;
`GET /api/dashboard` returned live KPIs from PostgreSQL; an anonymous read
returned `401`; a mutation without a CSRF token returned `403`.

> The escape hatch exists so a reviewer can run the *production build* locally.
> It is not a deployment mode. It announces itself at boot and is refused
> unless the value is exactly `1`.

## 3. Docker path — written, not executed

`Dockerfile` (multi-stage):
* **build** stage: `npm ci`, `npm run guard`, `npm run build`, then the runtime
  stage copies only `dist`, `node_modules` from `npm ci --omit=dev`, and the
  migrations.
* **runtime**: non-root `relay` user, `tini` as PID 1, `NODE_ENV=production`,
  `AUTH_MODE=oidc` default, `HEALTHCHECK` on `/api/ready`, no embedded
  credentials, no SQLite default.

`docker-compose.yml`:
* `postgres:16` with a healthcheck; `app` waits on `service_healthy`
* `app` healthcheck on `/api/ready`, `stop_grace_period: 20s`
* one-shot `seed` service (`node apps/api/dist/db/cli.js seed`, `FORCE=1`)
* named volume `relay-pg`

```bash
docker compose build
docker compose run --rm seed        # one-shot demo data
docker compose up -d
curl -fsS localhost:4000/api/ready
```

**Blocker:** no Docker binary exists in this environment, so the image was never
built and compose was never started here. CI performs `docker build` and a
compose smoke; that job has not run either. Treat this section as reviewed
configuration, not as evidence.

## 4. CI

`.github/workflows/ci.yml` — install from lockfile, secret scan, guards,
typecheck, SQLite migrations from empty, unit + governance tests, PostgreSQL 16
integration, backup drill, web build, SSR smoke of all 13 screens, Docker build,
compose smoke, artefact upload, plus an `audit-trail` job that fails unless
`docs/REQUIREMENT-TRACEABILITY.md` gives every `R*` requirement an explicit
status. No auto-deploy anywhere.

## 5. Health and readiness

| Endpoint | Use |
| --- | --- |
| `GET /api/live` | liveness — process is up, no DB touch |
| `GET /api/ready` | readiness — DB reachable; `503` when not |
| `GET /api/health` | detail: schema version, storage engine, worker, memory, auth mode |
| `GET /api/metrics` | Prometheus text |

All four are anonymous and expose no user data (asserted by tests).

## 6. Rollback

* **Application** — the previous image/tag; schema migrations are additive and
  forward-only, so an older binary runs against a newer schema.
* **Release** — `PATCH /api/releases/:id {status:"rolled_back"}` is the one
  allowed non-forward transition; the ship gate and acknowledgement records are
  retained as evidence.
* **Database** — restore from the last verified backup (see
  [BACKUP-RECOVERY.md](./BACKUP-RECOVERY.md)); a drill must be run, not assumed.

## 7. What is *not* proven here

1. No container image was built or run (no Docker binary).
2. No reverse proxy / TLS termination in front of the API was exercised.
3. No multi-replica run: rate limits and the sweeper are per process, so two
   replicas double both the budget and the sweep frequency.
4. No managed-PostgreSQL provider (RDS/Cloud SQL) connection was tested; only a
   local PostgreSQL 16.
5. No live OIDC provider — the exchange path is tested against a locally
   generated keypair and JWKS.

Each of these is a deployment step, not a code change, and each is listed in the
traceability matrix so it is not mistaken for delivered functionality.
