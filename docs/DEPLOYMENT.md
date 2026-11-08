# Deployment

Three supported paths: **Vercel** (serverless, the requested target), **Node
directly**, and **Docker Compose**.

> **On the Vercel path specifically.** Everything below — the function entry point,
> the routing, the connection budget, the cron endpoint, the auth mode — is
> implemented and tested in this repository. What has *not* happened is a
> deployment: no Vercel account was used, no project was created, no URL exists.
> The requester imports the repository into their own Vercel account and generates
> the URL. Section 8 states exactly what that requires.

## 1. Vercel — serverless

### 1.1 Architecture on Vercel

| Concern | How it is handled | Why not the obvious way |
| --- | --- | --- |
| API | `api/index.js` → `apps/api/src/vercel.ts`, compiled to `apps/api/dist/vercel.js` | Vercel executes `api/*.js` directly; it does not compile TypeScript. The delegation is a dynamic import because the compiled file does not exist until the build command has run. |
| Listening | Never. The handler mounts `app.server` and returns | `app.listen()` binds a port nothing routes to. It works locally and fails silently on the platform. |
| `app.ready()` | Called once per instance, explicitly | Fastify installs its hook pipeline here. `listen()` does that for you; without `listen()` the first request crashes inside the hook runner. |
| Background sweeper | Removed. Replaced by a lazy sweep on real requests + `/api/cron/sweep` | `setInterval` does not survive between invocations, and instances are concurrent — a timer would either never fire or double-fire. |
| Frontend | Vercel serves `apps/web/dist` as static assets | CDN-cached, no function invocation, no cold start for the shell. |
| Routing | `/api/(.*)` rewritten to the function; everything else falls through to static files | The SPA fallback must not swallow `/api`. A rewrite rule is ordered, unlike a catch-all that inspects the path at runtime. |
| Database | `DATABASE_URL` (PostgreSQL, **pooled** endpoint) | SQLite cannot be written from parallel serverless instances. |
| Connections | `DATABASE_POOL_MAX`, defaulting to 3 on Vercel | Each instance owns a pool. `pg`'s default of 10 × concurrent instances exhausts a managed database. |
| Migrations | `npm run db:migrate:prod`, run by the operator | Migrating on every request is a race and a latency tax. One command, deliberately separate. |
| Auth | `AUTH_MODE=password` with the shared credential | Needs no external IdP, and the demo identities are refused. |

### 1.2 The project settings

Import the GitHub repository into Vercel and use these values. Nothing in the
source needs to change.

| Setting | Value |
| --- | --- |
| Framework preset | **Other** (the repository supplies its own build) |
| Root directory | Repository root — **leave blank** |
| Install command | `npm ci --no-audit --no-fund` |
| Build command | `npm run build:vercel` |
| Output directory | `apps/web/dist` |
| Node.js version | **22.x** (`engines.node` is `>=22`; verified on v22.22.3) |
| Include files outside root | Not required |

`vercel.json` already declares the build command, output directory, install
command, the `/api` rewrite, the security headers, the function memory/duration
and the cron schedule — so the dashboard values above are a restatement, not
extra work. If the dashboard and `vercel.json` disagree, `vercel.json` wins.

### 1.3 Environment variables

Set these in **Project → Settings → Environment Variables** for *Production* (and
*Preview* if you want preview deployments). Values are not included here;
`RELAY_ADMIN_PASSWORD_HASH` is generated in step 1.4.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | PostgreSQL connection string. Use the provider's **pooled** endpoint (Neon `-pooler`, Supabase `:6543`, PgBouncer). Append `?sslmode=require` if the provider requires TLS. |
| `SESSION_SECRET` | **yes** | Signs CSRF tokens and session cookies. 32+ random bytes, base64url. Rotating it invalidates every session. |
| `RELAY_LOGIN_USERNAME` | **yes** | The shared username. Needed only by the provisioning command, not by the running app, but keep it so the value is documented. |
| `RELAY_ADMIN_PASSWORD_HASH` | **yes** for provisioning | The Argon2id hash. Validated at boot: a malformed value fails startup with a clear message rather than a permanent 401. |
| `AUTH_MODE` | recommended | `password`. Without it, `auto` resolves to `password` once a credential is provisioned — so this is belt and braces. |
| `CRON_SECRET` | recommended | Authenticates `/api/cron/sweep`. Without it the endpoint returns 503 instead of running unauthenticated. |
| `DATABASE_POOL_MAX` | optional | Defaults to 3 on Vercel. Raise only if you are behind a connection pooler. |
| `NODE_ENV` | set by Vercel | `production`. |
| `CORS_ORIGIN` | optional | Only needed if the frontend is served from a different origin. Same-origin by default. |

**Never** put `RELAY_ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `CRON_SECRET` or
`DATABASE_URL` in a `VITE_`-prefixed variable. Vite inlines `VITE_*` into the
client bundle, which would publish the secret to every visitor. The frontend needs
no secrets: it talks to `/api` on its own origin.

### 1.4 Provision the database and the login — the exact steps

Run these **after** the first deployment, from a machine with the repository
checked out and the same `DATABASE_URL` exported. They are not part of the build;
each is a deliberate, one-off act.

**Step 1 — create the schema.**

```bash
npm ci
DATABASE_URL='postgres://…' npm run db:migrate:prod
# Expected: "✓ migrations applied: 15" (or "already at version 15" on a re-run)
```

Migrations are forward-only and additive; running them twice is safe.

**Step 2 — generate the hash.** Nothing is written to disk.

```bash
RELAY_LOGIN_PASSWORD='your-chosen-password' node scripts/set-password.mjs --print-env

# If the password is shorter than 12 characters the script refuses and generates
# nothing:
#   "Password is 11 characters; 12 is recommended for an internet-facing login."
# That is a warning about margin, not a validation failure you should work around
# silently. Re-run with --allow-short if you accept it; the script then prints the
# mitigations that remain (Argon2id m=65536,t=3,p=4, login lockout, distributed
# rate limiting) and still verifies the hash before printing it.
# prints RELAY_LOGIN_USERNAME and RELAY_ADMIN_PASSWORD_HASH, then verifies the
# hash by checking the password against it before printing.
```

The script enforces 12+ characters. If you must use a shorter one it will refuse
unless you add `--allow-short`, and it then prints a warning explaining the
reduced margin and the mitigations that remain (Argon2id cost, dual throttling).
It never writes a `.env` file — a secret in a checkout is a secret one `git add`
away from being public.

**Step 3 — write the credential, then confirm it.**

```bash
RELAY_LOGIN_USERNAME='your-shared-username' RELAY_ADMIN_PASSWORD_HASH='$argon2id$…' DATABASE_URL='postgres://…'   npm run db:pg:assign-login

# Expected:
#   ✓ created user usr_owner (admin)                     [first run only]
#   ✓ provisioned credential for "<username>" → user usr_owner
#   ✓ verified: username "<username>", version 1, enabled
```

The command reads the row back after writing and fails if it cannot. Add it to the
Vercel environment variables as well, so the boot-time validation applies and a
future rotation is a one-line change.

**Step 4 — verify the deployment.**

```bash
curl -sS -o /dev/null -w '%{http_code}
' https://<your-deployment>/api/live     # 200
curl -sS -o /dev/null -w '%{http_code}
' https://<your-deployment>/api/projects # 401
curl -sS -o /dev/null -w '%{http_code}
' https://<your-deployment>/api/ready    # 200
```

`401` on `/api/projects` is the correct answer and the one worth checking: it
proves an unauthenticated visitor cannot read data. Then open the deployment root
in a browser, sign in with the shared username and password, and confirm the
dashboard renders. Reload a deep link such as `/projects/pr_northwind` — the SPA
must restore the session and render, not redirect to `/login` or 404.

**Step 5 — rotate the password (when needed).**

```bash
RELAY_LOGIN_PASSWORD='the-new-password' node scripts/set-password.mjs --print-env
RELAY_LOGIN_USERNAME='…' RELAY_ADMIN_PASSWORD_HASH='…' DATABASE_URL='…' npm run db:pg:assign-login
```

Re-running `assign-login` bumps `version`, which invalidates every live session at
its next request. You do not need to enumerate or delete session rows. Update the
Vercel variable afterwards so future boots validate the current hash.

### 1.5 Cron — and its honest limit

`vercel.json` schedules `/api/cron/sweep` daily at 03:00 UTC. That cadence is
chosen because **Vercel Hobby permits one cron run per day**; anything more
frequent fails to deploy on Hobby. On Pro, change `schedule` to `* * * * *` (or any
per-minute expression) for minute-level accuracy.

Daily is not enough on its own for SLA correctness, so it is not the only
mechanism. Deadline processing also runs inline on real requests, throttled by
`SWEEP_THROTTLE_MS` (60 s default). Consequences, stated plainly:

* With traffic, overdue clocks are recorded within about a minute — the sweep rides
  on requests that were happening anyway.
* On a completely idle deployment, a breach is recorded at the next request or at
  the next daily cron, whichever comes first.
* The operation is idempotent. A retried or overlapping invocation transitions
  nothing twice, because the sweep only touches timers whose deadline has passed
  and whose outcome is still `running`.

### 1.6 Debugging a deployment

| Symptom | Cause | Fix |
| --- | --- | --- |
| `deployment_misconfigured` from `/api` | The build command was not `npm run build:vercel`, so `apps/api/dist/vercel.js` is absent | Fix the build command; redeploy |
| 500 with `Cannot read properties of undefined (reading 'length')` | `app.ready()` was skipped — a stale build | Rebuild; this is fixed in `apps/api/src/vercel.ts` |
| Every login returns 401 | Credential never provisioned, or a hash for a different password | Re-run step 1.4 from 3 |
| Boot fails: "RELAY_ADMIN_PASSWORD_HASH is not a complete Argon2id hash" | The value was truncated on paste, or quoted so `$` was expanded by the shell | Single-quote the value; re-paste |
| `/api/ready` returns 503 | `DATABASE_URL` wrong, or TLS required but not requested | Add `?sslmode=require`; check the pooled host |
| Random timeouts under load | Pool exhaustion — too many instances × pool size | Use the pooled endpoint; lower `DATABASE_POOL_MAX` |
| `/api/cron/sweep` returns 503 | `CRON_SECRET` unset | Set it; redeploy |
| Deep links 404 but the root works | Output directory is wrong | `apps/web/dist` |
| `/api/*` returns the HTML page | The `/api` rewrite is missing | Check `vercel.json` rewrites are present and ordered |

### 1.7 What is not proven about the Vercel path

1. No deployment was performed. There is no URL, no project, no team id. The
   configuration is implemented and locally exercised; the platform itself is the
   requester's step.
2. The serverless handler was verified by mounting it on a real
   `http.createServer` and driving it with `fetch` against PostgreSQL 16 — which
   covers routing, readiness, auth and cron, but not Vercel's own invocation
   wrapper, cold-start timing, or edge network behaviour.
3. No managed PostgreSQL provider was contacted. The pool sizing and SSL guidance
   are applicable to one; they were not tested against one.
4. Vercel-specific limits (30 s function duration, 4.5 MB request body on Hobby)
   are documented above and reflected in the code, but not measured on the platform.

---

## 2. Node directly

Two additional paths remain fully supported: **Node directly** and **Docker Compose**. Both have been
executed — the Node path in this sandbox, the Docker path on the GitHub runner
(CI run 42469354957: image built, stack started, `/api/ready` returned 200 from a
fresh PostgreSQL 16 volume). This sandbox still has no Docker binary, so Docker
commands below are quoted from the pipeline that ran, not from here.

---

### 2.1 What runs

| Process | Port | Notes |
| --- | --- | --- |
| API + SPA | `4000` | Fastify serves `/api/*` and the built SPA from `apps/web/dist` |
| PostgreSQL | `5432` (container) / `55432` (local embedded) | authoritative store |
| Clock sweeper | in-process | every `SWEEP_INTERVAL_MS` (default 60 s) |

### 2.2 The Node path — executed

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

#### Verified boot behaviour

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

### 2.3 Docker path — executed on CI

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

**Status:** the image build and the compose fresh-start both pass in CI
(run 42469354957). The first attempts failed, and that failure was real: `pg`
was imported but never declared, resolving only through a dev-only dependency,
so `npm ci --omit=dev` produced an image with no PostgreSQL driver. It is now
declared, asserted inside the Dockerfile, and guarded by
`scripts/guard-declared-deps.mjs` so the mistake fails at build time.

What the compose run proves: migrations apply on a fresh volume, the health
gate holds the app until PostgreSQL is ready, and `/api/ready` answers 200.
What it does not prove: sustained load, multi-replica behaviour, TLS
termination, or a managed database provider.

## 3. CI

`.github/workflows/ci.yml` — install from lockfile, secret scan, guards,
typecheck, SQLite migrations from empty, unit + governance tests, PostgreSQL 16
integration, backup drill, web build, SSR smoke of all 13 screens, Docker build,
compose smoke, artefact upload, plus an `audit-trail` job that fails unless
`docs/REQUIREMENT-TRACEABILITY.md` gives every `R*` requirement an explicit
status. No auto-deploy anywhere.

## 4. Health and readiness

| Endpoint | Use |
| --- | --- |
| `GET /api/live` | liveness — process is up, no DB touch |
| `GET /api/ready` | readiness — DB reachable; `503` when not |
| `GET /api/health` | detail: schema version, storage engine, worker, memory, auth mode |
| `GET /api/metrics` | Prometheus text |

All four are anonymous and expose no user data (asserted by tests).

## 5. Rollback

* **Application** — the previous image/tag; schema migrations are additive and
  forward-only, so an older binary runs against a newer schema.
* **Release** — `PATCH /api/releases/:id {status:"rolled_back"}` is the one
  allowed non-forward transition; the ship gate and acknowledgement records are
  retained as evidence.
* **Database** — restore from the last verified backup (see
  [BACKUP-RECOVERY.md](./BACKUP-RECOVERY.md)); a drill must be run, not assumed.

## 6. What is *not* proven about the container paths

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
