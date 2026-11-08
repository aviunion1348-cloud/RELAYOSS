# Deployment

Three supported paths: **Vercel** (serverless, the requested target), **Node
directly**, and **Docker Compose**.

> **On the Vercel path specifically.** Everything below — the function entry point,
> the routing, the connection budget, the cron endpoint, the auth mode — is
> implemented and tested in this repository. What has *not* happened is a
> deployment: no Vercel account was used, no project was created, no URL exists.
> The requester imports the repository into their own Vercel account and generates
> the URL. Section 8 states exactly what that requires.

## 1. Vercel — two services

The repository deploys as **one Vercel project containing two services**. Vercel
builds each independently and routes to them from a single top-level rewrite table,
so the deployment has one domain and one set of environment variables.

```
vercel.json
├── services
│   ├── api   framework: fastify   apps/api/src/entrypoints/index.ts → /api/*
│   └── web   framework: vite      apps/web/  + /(.*) → /index.html  → everything else
└── rewrites
    ├── /api/(.*) → api      (specific first)
    └── /(.*)     → web      (catch-all last)
```

Both services are public, and each one receives exactly the traffic it is built for:

* **`api`** is reachable only under `/api/*`. It has no rewrite of its own; the
  top-level `/api/(.*)` rule is the only way in.
* **`web`** is the catch-all. Because routing into a service is final, the service
  owns its own deep-link behaviour — `web` declares a service-level fallback so that
  reloading `/projects/pr_northwind` returns the document rather than a 404.
* **The fallback is not `/(.*)`.** That pattern also matches `/assets/index-abc123.js`,
  so a missing or stale hashed asset would be answered with the HTML document and
  status 200: the browser reports a MIME type error instead of a 404, and a stale
  reference renders a blank page rather than failing cleanly. The fallback excludes
  file-like paths:

  ```json
  { "source": "/((?!assets/)[^.]*)", "destination": "/index.html" }
  ```

  Deep links (`/projects/pr_northwind`) contain no dot and resolve to the document;
  anything with an extension 404s. `npm run verify:routing` proves this against the
  built output — `vercel dev` cannot, because it proxies the Vite dev server, which
  serves `index.html` for every unmatched path itself.
* Order matters. Vercel routes to the first match, so a catch-all listed first would
  swallow `/api` entirely. The guard asserts the order.

There is **no container service**, and no `Dockerfile.vercel`. An earlier revision
ran an `app` container serving the SPA while `web` built the same bundle: two
artifacts for one frontend, and `vercel dev` could not even start the container
(`DEV_SERVICE_START_FAILED`), so the primary deployment path was untestable locally.
The root `Dockerfile` and `docker-compose.yml` are untouched and remain the local
and CI path — see §1.6.

### 1.1 Architecture on Vercel

| Concern | How it is handled | Why not the obvious way |
| --- | --- | --- |
| API | The `api` service, entrypoint `apps/api/src/entrypoints/index.ts` → `entrypoints/vercel.ts`, compiled to `apps/api/dist/entrypoints/vercel.js` | Vercel's Fastify preset discovers entrypoints by filename, and `src/index.ts` is on that list — but that file calls `app.listen()` and starts a `setInterval`. The handler lives in `entrypoints/` precisely so the preset cannot resolve to the long-lived entry. `api/index.js` is retained as the wrapper and delegates to the same artefact. |
| SPA | The `web` service — `vite build` to `apps/web/dist`, declared with `framework: "vite"` | The same bundle the frontend is developed as, built once. The service-level `/(.*) → /index.html` fallback handles deep links; Vite's asset hashing means a real asset either resolves or is genuinely absent. |
| Listening | Never. The handler mounts `app.server` and returns | `app.listen()` binds a port nothing routes to. It works locally and fails silently on the platform. |
| `app.ready()` | Called once per instance, explicitly | Fastify installs its hook pipeline here. `listen()` does that for you; without `listen()` the first request crashes inside the hook runner. |
| Background sweeper | Removed. Replaced by a lazy sweep on real requests + `/api/cron/sweep` | `setInterval` does not survive between invocations, and instances are concurrent — a timer would either never fire or double-fire. |
| Routing | Two top-level rewrites to service *names*, specific before catch-all | Vercel routes to the first match and routing into a service is final — there is no fallback to another service. A catch-all listed first would swallow `/api` entirely. |
| Service-to-service | **No bindings.** Nothing calls anything privately | The `api` service talks to PostgreSQL and to the identity provider (OIDC); the browser reaches it over the public `/api` rewrite. There is no third internal service to call, so a binding would inject an unused variable. |
| Database | `DATABASE_URL` (PostgreSQL, **pooled** endpoint) | SQLite cannot be written from parallel serverless instances. |
| Connections | `DATABASE_POOL_MAX`, defaulting to 3 on Vercel | Each instance owns a pool. `pg`'s default of 10 × concurrent instances exhausts a managed database. |
| Migrations | `npm run db:migrate:prod`, run by the operator | Migrating on every request is a race and a latency tax. One command, deliberately separate. |
| Auth | `AUTH_MODE=password` with the shared credential | Needs no external IdP, and the demo identities are refused. |

### 1.2 The project settings

Import the GitHub repository into Vercel and use these values.

> **The Framework Preset must be set to `Services`. This is not optional and cannot be
> committed.** Vercel only builds a `services` block when the *project* framework preset
> is Services. If the preset is anything else, Vercel ignores the block **silently** and
> falls back to ordinary single-app framework detection — which runs the root
> `npm run build` and ignores every per-service `installCommand`.

That fallback is exactly the failure this repository was reporting:

```
20:30:30.487 Running "npm run build"
20:30:30.611 > relay-oss@1.0.0 build
20:30:34.584 > @relay/web@1.0.0 build
20:30:34.591 sh: line 1: vite: command not found
```

Three signals in that log identify it, and none of them is a repository defect:

| Signal in the log | What it means |
| --- | --- |
| `Running "npm run build"` — the **root** script, once | Services mode runs each service's `buildCommand`. A single root build means the block was never read. |
| `added 95 packages` | Vercel's production install excludes devDependencies. `vite` is a devDependency, so the frontend cannot build. Measured: a production root install adds 144 packages and leaves no `vite`. |
| No `api [Fastify]` / `web [Vite]` lines | Services were never detected. `vercel dev -L` prints them immediately. |

**The dashboard is the fix, and only the dashboard can apply it.**

| Setting | Value |
| --- | --- |
| **Framework Preset** | **`Services`** — required, see above |
| Root Directory | Repository root — **leave blank** |
| Build Command | **Leave empty.** A value here overrides the per-service `buildCommand`s even when the preset is Services |
| Install Command | **Leave empty.** Same reason |
| Output Directory | **Leave empty** — the `web` service declares `dist` itself |
| Node.js Version | **22.x** (`engines.node` is `>=22.5.0 <23`; verified on v22.22.3) |

If an existing project was imported before the preset was switched, the framework
preset and any Build/Install Command overrides must be corrected before redeploying.
Clearing those two overrides matters as much as the preset: a stale
`npm run build` in the dashboard is what produced the log above even though
`vercel.json` had already been corrected.

`vercel.json` cannot carry these values. `framework`, `buildCommand`,
`installCommand` and `outputDirectory` are **invalid at the top level** whenever
`services` is present, so writing them there to compensate would produce a
configuration error instead of a fix.

### 1.2.1 Which service exists to do what

| Service | Builds | Serves | Public path |
| --- | --- | --- | --- |
| `api` | The Fastify application from `apps/api/src/entrypoints/index.ts` | The API | `/api/*` |
| `web` | `vite build` → `apps/web/dist` | The SPA document and its assets | `/` and every other path |

Both are public because both need public traffic: the browser fetches the document
and then calls `/api` same-origin. Only `web` needs a fallback, and only `web` has
one.

The root `Dockerfile` is **not** used by any service. It remains the long-lived
single-process deployment — API and SPA in one process on :4000, with a
`setInterval` sweeper — and `docker compose up` still uses it. It is not a Vercel
service, and nothing routes to it.

**Workspace dependencies.** Each service builds from its own `root`, but the
repository is an npm workspace. npm resolves `apps/web` by walking up to the
repo-root `package-lock.json`, so `npm ci` run from `apps/web` installs the correct
tree. Verified: with the root lockfile removed, `npm ci` from `apps/web` fails
outright — so the resolution genuinely comes from the workspace root, and each
service needs no lockfile of its own.

### 1.2.2 Build and install commands — and the failure they fix

A production deploy failed with:

```
npm run build
> npm run build -w @relay/api && npm run build -w @relay/web
Web build: FAIL
sh: line 1: vite: command not found
```

Two independent mistakes, each fatal on its own:

1. **Vercel installs with production-mode npm, which omits `devDependencies`.**
   `vite` and `typescript` are devDependencies — correctly, they are build tools, not
   runtime code — so they were simply absent when the build ran. Measured: `npm ci`
   from `apps/web` adds **52** packages and leaves no `vite`; `npm ci --include=dev`
   adds **134** and hoists `vite` to the root bin, where `npm run build` resolves it.
2. **The root `build` script builds both workspaces in sequence.** Using it as one
   service's build command compiles the sibling too, and fails as soon as that
   sibling's dependencies are missing.

So each service declares both commands. These keys are invalid at the top level in
services mode and belong in the service object:

| Service | `installCommand` | `buildCommand` | `outputDirectory` |
| --- | --- | --- | --- |
| `api` | `npm ci --include=dev --no-audit --no-fund` | `npm run build -w @relay/api` | — |
| `web` | `npm ci --include=dev --no-audit --no-fund` | `npm run build` | `dist` |

`vite` stays a devDependency. Moving it into `dependencies` would hide mistake 1
rather than correct it: the build would work for the wrong reason, and the next
build-time tool to be added would fail the same way.

**Reproducing this locally.** `npm run build:service` runs
`scripts/verify-service-builds.mjs` for each service in turn: cwd at the service
`root`, `NODE_ENV=production`, the service's own `installCommand` and `buildCommand`,
then asserts the tool (`vite` / `tsc`) exists *before* the build and the expected
output exists after. One service per invocation, so a pass proves that service builds
alone. It correctly reproduces the original failure when the install command is
reverted to a production-only one.

CI runs the same harness as a separate `service-builds` job. The main `verify` job
installs at the root and builds both workspaces — a genuinely different thing, and
exactly how a missing build tool reached production while CI stayed green.

**Does `include=dev` ship the development toolchain to production?** No. The
serverless bundle is not the install tree: Vercel traces the function's actual imports
and ships only those. Traced from `apps/api/dist/entrypoints/vercel.js`: **80 packages,
655 files, and zero files from `vite`, `typescript`, `playwright`, `embedded-postgres`,
`@vitejs/*`, `tailwindcss` or `concurrently`.** The bundle is Fastify, `pg`, `argon2`,
`zod` and their transitive dependencies.

The dev toolchain occupies build-machine disk for the duration of the build and nothing
else. That is the normal arrangement for compiling TypeScript at build time, and it is
cheaper than the alternative: a runtime install that cannot rebuild the bundle.

**Node version.** `engines.node` is a bounded range, `>=22.5.0 <23`, not `>=22.5.0`.
An open-ended lower bound is satisfied by every future major, so Vercel would auto-upgrade
the build image and change the runtime without anyone deciding to — the deploy log warned
about precisely this. GitHub Actions uses `node-version: 22`, so CI and the platform stay
on the same line.

### 1.2.3 Install scripts: the Argon2 approval

The build log also reported `argon2@0.41.1 (install: node-gyp-build)` not approved.
npm 12 stopped running dependency lifecycle scripts by default; they run only when
`package.json` approves them in `allowScripts`. The approval is version-pinned, so a
version bump cannot silently inherit it:

```json
"allowScripts": { "argon2@0.41.1": true }
```

`argon2` ships **prebuilt** binaries for `linux-x64` (glibc and musl), so
`node-gyp-build` selects and links one — it does not compile, and no toolchain is
needed. Verified on a clean install: Argon2id hash, correct password verifies, wrong
password does not.

Only `argon2` is approved. `esbuild` and the `@embedded-postgres/*` binaries also
carry install scripts; neither is needed for this deployment, and approving them
would widen the allowlist for no benefit. The guard fails if the list grows, if an
entry is unpinned, or if the pin stops matching the locked version — because a stale
pin fails at *runtime*, not at build time.

### 1.2.4 The `cache-dir` warning

`npm warn Unknown env config "cache-dir"` does not come from this repository: there
is no `.npmrc` that sets it, no such key in any manifest, and no environment variable
locally. Vercel's build image exports `npm_config_cache_dir`, and npm 11+ rejects that
as an unknown key. The value was never honoured either way — `cache-dir` is not an npm
setting (`cache` is).

Because it arrives from the build environment, a repository cannot unset it; what it
can do is pin the supported key, which `.npmrc` does:

```
cache=~/.npm
```

The warning is cosmetic and does not fail a build. It is documented rather than
suppressed, and the `.npmrc` deliberately does **not** use `ignore-scripts` — that
would silently disable every dependency lifecycle script, which is precisely what
`allowScripts` exists to decide per package.

### 1.2.5 The `.npmrc` fallback, and why it is not redundant

`.npmrc` also carries `include=dev`:

```
cache=~/.npm
include=dev
```

The service `installCommand`s already pass `--include=dev`, and the guard enforces
that. This setting exists because the failing deployment ran the **root**
`npm run build` — not a service build — so the production install that starved it did
not come from a service `installCommand` at all. With `include=dev` at the project
level, a plain `npm ci` installs the build toolchain regardless of which command,
which directory, or which config path drives it.

That is deliberately belt-and-braces rather than the primary fix: the per-service
commands state the requirement where a reader looks for it, and the `.npmrc` line
means an unanticipated install path cannot reintroduce `vite: command not found`.
Both are asserted by the guard.

### 1.2.6 Why `apps/web` is not an npm workspace member

The `api` service builds at the repository root; the `web` service builds in
`apps/web`. Vercel runs every service's install and build, then `Deploying outputs`.
That last step failed with:

```
ENOENT: no such file or directory, lstat '/vercel/path0/node_modules/fastify/package.json'
```

Both builds were green. The problem was ordering plus a shared tree:

`npm ci` **deletes `node_modules` at the project root before installing.** For an npm
workspace member, "the project root" is the workspace root. So when the `web` service
ran its install from `apps/web`, npm walked up and replaced the repo-root
`node_modules` — deleting `fastify` from under the API function that had just been
compiled against it.

Narrowing the command does not help. Verified: `npm ci --workspace @relay/web` run from
`apps/web` also wipes the root tree. The conflict is structural, not a flag.

So `apps/web` is a **standalone project**, not a workspace member:

| | |
| --- | --- |
| root `package.json` | `"workspaces": ["apps/api"]` — the web app is not a member |
| `apps/web/package.json` | no `workspaces` key, own `allowScripts` for `esbuild` |
| `apps/web/package-lock.json` | **committed**; without it npm resolves the repo-root lockfile, treats the directory as part of the workspace, and wipes the shared tree again |

Each service now installs into its own `node_modules`, so nothing can delete the
other's. Verified by replaying Vercel's exact sequence — api install, api build, web
install, web build — and then checking `node_modules/fastify/package.json` still exists.
`scripts/verify-service-builds.mjs` asserts this on every CI run.

Consequences worth knowing:

* `npm run build` still builds both, using `npm run build --prefix apps/web` for the
  web half. `npm run install:web` installs the frontend's own dependencies.
* The Docker image does two installs for the same reason. Its runtime stage needs no
  frontend dependencies at all — the SPA is already built.
* `smoke:web` bundles inside `apps/web` so its imports resolve from the web project.

Locally you may install however you like; the constraint is on the deployment path. Just
do not add `apps/web` back to `workspaces` — the guard fails if you do.

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

### 1.3.1 Running with no database at all (evaluation mode)

You can deploy and sign in with **no PostgreSQL instance**. Set two variables and
nothing else:

| Variable | Value |
| --- | --- |
| `SESSION_SECRET` | 32+ random bytes |
| `RELAY_ADMIN_PASSWORD_HASH` | from `npm run set-password` |

Optionally `RELAY_LOGIN_USERNAME` (default `lear roadmap 289`) and
`RELAY_LOGIN_USER_ID` (default `usr_owner`).

On boot the API then: creates SQLite in the instance temp directory (the
deployment bundle is read-only, so the source tree cannot be used), runs the
migrations, seeds the demo studio because `users` is empty, and writes the
credential from the two environment values before the auth mode is resolved — so
`AUTH_MODE=auto` chooses `password` rather than `dev`, and the production refusal
never fires.

Verified cold, with no `DATABASE_URL` and no `DB_PATH`:

```
GET /api/ready         200 {"ready":true,"engine":"sqlite"}
POST /api/auth/login   200 admin session
GET /api/projects      200 seeded projects
GET /api/dashboard     200 {"openTasks":73,"inFlight":31,"blocked":8,...}
```

**What this mode is not.** SQLite lives in `/tmp`, which is per-instance and
discarded. Specifically:

- **Data does not survive a cold start.** Write a task, let the instance recycle,
  and it is gone — the seed runs again and you are back to the demo data.
- **Two concurrent instances do not share state.** A second instance has its own
  empty file and its own seed. Concurrent edits to "the same" row are not
  conflicts, they are two different databases.
- **Session cookies survive only while the instance does**, and the CSRF secret
  is derived per instance.

That makes this a way to *evaluate* the product and to see it working, not a way
to run a studio. Set `DATABASE_URL` to make it durable — §1.4 has the exact
commands. `SEED_DEMO_DATA=0` turns the automatic seed off if you want an empty
instance instead.

`/api/health` always reports the engine (`sqlite` or `postgres`), so which mode a
deployment is in is never a guess.

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

### 1.5.0 When the deployed sign-in screen says the API is unreachable

The first thing a newly deployed instance shows is the sign-in screen, and it used
to report every failure the same way — *"Could not load identities. Is the API
running on :4000?"* — which is false on every deployed host and points at the
wrong problem. It now distinguishes three cases, and the distinction is the
diagnosis:

| What the screen says | What it means | Where to look |
| --- | --- | --- |
| *"This deployment is not configured yet"* + a list of variable names | The API is **running and healthy**. It refused to boot because its environment is incomplete, and it has told you exactly what is missing | `error.missing` on any `/api` response, then §1.4 |
| *"Could not reach the API"* | The request never completed. Routing or deployment, not configuration | The `/api` rewrite, and that both services appear in the build log |
| *"The API rejected the request (status · code)"* | The API answered and refused. Read the status | The status itself; 401 at sign-in means no credential is provisioned |

The middle row is the only one that is a connectivity question, which is why the
other two no longer claim to be.

**Read the JSON, not the screen.** Every `/api` route answers a provisioning
failure identically, so `curl` is faster than the browser:

```bash
curl -s https://<deployment>/api/ready | jq .error
```

```json
{
  "code": "misconfigured",
  "stage": "configuration",
  "summary": "SESSION_SECRET is required (used to sign CSRF tokens and cookie sessions)",
  "missing": ["SESSION_SECRET", "DATABASE_URL"],
  "invalid": [],
  "remedy": [
    "Set SESSION_SECRET to 32+ random bytes: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    "Set DATABASE_URL to your provider's pooled PostgreSQL connection string (…)",
    "Run the schema migration: DATABASE_URL=… npm run db:migrate:prod",
    "Provision the shared login: npm run set-password, then npm run db:pg:assign-login",
    "Redeploy and confirm GET /api/ready returns 200"
  ]
}
```

Three properties are deliberate and tested (`apps/api/test/vercel.test.mjs`):

- **Names, never values.** This endpoint is unauthenticated. It says
  `SESSION_SECRET` is missing; it never echoes a secret, a hash or a connection
  string.
- **503, not 500.** The instance genuinely is unavailable. `500` suggests a bug;
  `503` says "not ready", which is what this is.
- **Not cached.** `Cache-Control: no-store`. A cached failure would keep the
  deployment looking broken after it was fixed.

`stage` separates the two ways a boot fails: `configuration` (the guard refused
before opening a connection) and `database` (the connection or migration failed
after). They have entirely different fixes, and conflating them is how the
original `500` wasted an afternoon.

### 1.5.1 Running this locally

`vercel dev` starts both services and injects the routing table, which is the only
way to exercise the rewrites, the SPA fallback and the `/api` split before
deploying. Local mode needs no login and no link:

```bash
npx vercel@latest dev --local
```

`--local` reads `vercel.json` and the environment from your shell instead of from a
linked project, so it does not touch any Vercel account. Give the API an
**absolute** `DB_PATH`: the `dev:api` script runs with `apps/api` as its working
directory, so a relative path resolves inside `apps/api` and quietly creates an
empty database — which then answers `Invalid credentials` rather than telling you
the database is wrong.

`npm run dev` remains the normal local loop: Vite on :5173 proxying `/api` to
Fastify on :4000. That path does not exercise the rewrites or the service split.

`vercel build` is *not* an offline check — it contacts `api.vercel.com`, so it
cannot be run in a sandbox without egress to Vercel. The static guard plus
`vercel dev --local` are the substitute, and between them they cover the routing,
the fallback and the entrypoint.

### 1.5.2 Verifying the services configuration without deploying

`npm run guard` checks the whole configuration statically and fails closed:

* every service has a `root` that exists, and no unknown service keys;
* no `buildCommand`/`outputDirectory`/`framework`/`functions` stranded at the top
  level, where services mode does not honour them;
* every rewrite targets a service that exists, and the catch-all is last;
* both services receive public traffic — a service that is neither routed nor
  deliberately internal is a service nobody can reach;
* `web` declares its own `/(.*) → /index.html` fallback, so a deep-link refresh
  cannot 404;
* **no container service**, and no `Dockerfile.vercel` / `deploy/web-server.mjs`
  left behind as dead configuration — the duplicate SPA build that motivated its
  removal;
* `api`'s declared entrypoint exists and does **not** call `app.listen()` or start a
  timer — the failure that would land the Fastify preset on the long-lived entry;
* `web`'s output directory is `dist`, matching the service build;
* **every service declares an `installCommand` containing `--include=dev`** — the
  production-mode install that omitted `vite` and broke the deploy;
* **`api` builds only `@relay/api` and `web` does not build the API** — the root
  `npm run build` builds both workspaces and is not a valid service build command;
* `package.json` has an `allowScripts` map, every approving entry is version-pinned,
  `argon2` is approved at exactly the locked version, and nothing the deployment does
  not need (`esbuild`, `@embedded-postgres/*`) is approved;
* every binding (there are none today) names a real service, is not self-referential,
  and does not have its variable set in `.env.example`;
* no server-side source file contains a hardcoded loopback URL.

Each of those was sabotaged deliberately and confirmed to fail — a guard that has
never failed is a guard you do not know works.

### 1.6 Debugging a deployment

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503` with `{"error":{"code":"misconfigured"}}` from every `/api/*` route | The function booted but refused to start: `SESSION_SECRET` or `DATABASE_URL` is unset, or `RELAY_ADMIN_PASSWORD_HASH` is malformed. **This is the intended response** and it names the missing variables in `error.missing` | Read `error.summary` and `error.missing`, then follow `error.remedy`. Complete §1.4, redeploy, confirm `/api/ready` returns 200. Nothing is wrong with the browser or the build |
| **`500` with a non-JSON body on every `/api` route** | The function has no handler at all. A version-gated built-in (`node:sqlite`) or a native binding (`argon2`) was imported statically, so the module graph threw while loading — before any error handling existed | Both are now imported on demand. If it recurs, check for a newly added static import of a native/version-gated module in the request graph |
| Sign-in shows *"Could not reach the API"* rather than the variables above | The request never reached the function — the deployment has no `api` service, or the `/api` rewrite is missing | Check the rewrite order (§1.2) and that both services are detected in the build log |
| The identity list never loads in development mode | Fixed: the screen called `GET /api/users`, the authenticated directory, which no anonymous visitor can read | `GET /api/auth/dev-users` is the anonymous, minimal counterpart. Update rather than special-casing the 401 |
| `deployment_build_incomplete` from `/api` | `apps/api/dist/entrypoints/vercel.js` is absent because the api service's build did not compile the API | Check the `api` service build; redeploy |
| `/` returns JSON `not_found` instead of a page | The catch-all rewrite is missing or points at `api`, so a browser route reached the API function | Confirm `/(.*) → web` is last in `rewrites` |
| Every `/api/*` call returns HTML | The `/api` rewrite is missing, or the catch-all is listed before it | Order the rewrites specific-first; the guard checks this |
| 500 with `Cannot read properties of undefined (reading 'length')` | `app.ready()` was skipped — a stale build | Rebuild; this is fixed in `apps/api/src/vercel.ts` |
| Every login returns 401 | Credential never provisioned, or a hash for a different password | Re-run step 1.4 from 3 |
| Boot fails: "RELAY_ADMIN_PASSWORD_HASH is not a complete Argon2id hash" | The value was truncated on paste, or quoted so `$` was expanded by the shell | Single-quote the value; re-paste |
| `/api/ready` returns 503 | `DATABASE_URL` wrong, or TLS required but not requested | Add `?sslmode=require`; check the pooled host |
| Random timeouts under load | Pool exhaustion — too many instances × pool size | Use the pooled endpoint; lower `DATABASE_POOL_MAX` |
| `/api/cron/sweep` returns 503 | `CRON_SECRET` unset | Set it; redeploy |
| `ENOENT: lstat '…/node_modules/fastify/package.json'` at **Deploying outputs**, after both builds succeeded | The web service's install replaced the shared workspace-root `node_modules` | `apps/web` must not be an npm workspace member and must keep its own `package-lock.json`; see §1.2.6 |
| `vite: command not found` (or `tsc: command not found`) during the build | Vercel installed with production-mode npm, which omits `devDependencies` | The service's `installCommand` must be `npm ci --include=dev --no-audit --no-fund`; confirm with `npm run build:service` |
| The API build fails on a deploy but the web build is fine | That service is running the root `build` script, which compiles both workspaces | `api` must use `npm run build -w @relay/api`; `web` must use `npm run build`. Each service builds only its own workspace |
| Password login returns 500 `no such table: local_credentials` | The database predates migration 0014; login is the first thing to touch that table | Run `npm run db:migrate:prod`, then `npm run db:pg:assign-login` |
| `argon2` works locally but fails on the platform | npm 12 skipped the install script because the version is not approved | Update the pinned `allowScripts` entry to the installed version; the guard fails when the pin and the lockfile disagree |
| `npm warn Unknown env config "cache-dir"` | Vercel's build image exports `npm_config_cache_dir`; npm 11+ rejects the key | Cosmetic. `.npmrc` pins the supported `cache` key; see §1.2.4 |
| Deep links 404 but the root works | The `web` service is not falling back to the document | `web` must declare a fallback to `/index.html` that excludes file-like paths, e.g. `{"source": "/((?!assets/)[^.]*)", "destination": "/index.html"}`; confirm the request reached `web` and not `api` |
| The app loads but shows a MIME type error, or a page goes blank after a deploy | A stale or missing hashed asset was answered with the SPA document (200) instead of 404 | The fallback is too broad — `/(.*)` catches `/assets/*`. Use the extension-guarded pattern above |
| The deployment builds the root app instead of the two services | Framework Preset is not `Services`, or a project-level Build Command overrides the service commands | See §1.2: set the preset to Services and clear Build/Install Command |
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
