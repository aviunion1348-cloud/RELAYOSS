# Deployment

Three supported paths: **Vercel** (one long-lived Fastify service, the requested
target), **Node directly**, and **Docker Compose**.

> **On the Vercel path specifically.** Everything below — the function entry point,
> the routing, the connection budget, the cron endpoint, the auth mode — is
> implemented and tested in this repository. What has *not* happened is a
> deployment: no Vercel account was used, no project was created, no URL exists.
> The requester imports the repository into their own Vercel account and generates
> the URL. Section 8 states exactly what that requires.

## 1. Vercel — one service, one origin

The repository deploys as **one Vercel project containing one service**. That
service is the Fastify process itself: it answers `/api/*` and it serves the built
SPA, from the same origin, in the same invocation model.

```
vercel.json
├── services
│   └── app   framework: fastify   apps/api/src/entrypoints/index.ts
│             buildCommand: npm run build:service   (API + SPA, one command)
└── rewrites
    └── /(.*) → app
```

### 1.0 Why not two services

An earlier revision split this into an `api` service routed under `/api/(.*)` and a
`web` service routed under `/(.*)`. It was the conventional shape and it was the
source of every deployment failure this repository had:

| Failure | Cause |
| --- | --- |
| Every panel reported "a non-JSON response" | `/api` was answered by the frontend service with `index.html` and status 200 — a rewrite ordered or targeted wrongly |
| The API was absent from the deployment entirely | The project's Framework Preset was not `Services`, so Vercel ignored the `services` block **silently** and built only the root app |
| A framework prefix that could not be asserted | The preset is a dashboard setting; no committed file can prove it |

A boundary between two deployments is a thing that can be misconfigured, and all
three failures were that boundary. The application never needed it: every number on
every screen is computed by this process from PostgreSQL, and the process can serve
the built assets itself. Removing the split removes the class of failure rather than
documenting it, and `npm run verify:routing` now boots the real server and asserts
the behaviour instead of simulating a routing table.

### 1.1 What the single service does

| Concern | How it is handled | Why not the obvious way |
| --- | --- | --- |
| API | `apps/api/src/entrypoints/index.ts`, declared explicitly in `vercel.json` and compiled to `apps/api/dist/entrypoints/index.js` | The entrypoint is named rather than discovered, so the file production runs is the file CI boots. `entrypoints/vercel.ts` remains as the in-process handler the tests drive; it is **not** the deployed entry. |
| SPA | The same process serves `apps/web/dist` through `@fastify/static` when a build is on disk; in a deployment bundle it serves the same files from `src/generated/web-assets.ts`, compiled in by `scripts/embed-web-assets.mjs`. A not-found handler answers browser routes with the document | One origin means the browser has no cross-origin hop. The tracer follows module imports only, so a directory read with `fs` is invisible to it — and `includeFiles`, the documented-looking remedy, is rejected by the services schema. Embedding is the form that survives both (§1.1.2). |
| Deep links | The not-found handler answers a browser route with `index.html` | Reloading `/projects/pr_northwind` must not 404. |
| Missing assets | The not-found handler returns **404** for any path that names a file | The naive fallback answers `/assets/index-abc123.js` with the document and status 200, so a stale reference renders a blank page with a MIME-type error instead of failing cleanly. A rewrite rule used to prevent this; the rule now lives in the handler, and `verify:routing` asserts it against the running process. |
| Listening | **Not in the entrypoint.** It exports a handler; the platform launcher binds and proxies. `apps/api/src/index.ts` is the process that listens, for `npm start` and Docker | The launcher stubs `http.Server.prototype.listen` while importing the module and never calls its callback, so an entrypoint that awaits `listen()` deadlocks the import. See §1.1.1 — this is the mistake that caused the outage. |
| `app.ready()` | Called once per process, explicitly, before the first request is dispatched | Fastify installs its hook pipeline here. `listen()` does that for you, but the socket is owned by the entry's own server, so `ready()` is called directly rather than inherited. |
| Background sweeper | A lazy sweep on real requests + `/api/cron/sweep` | `setInterval` does not survive between invocations, and instances are concurrent — a timer would either never fire or double-fire. |
| Service-to-service | **None.** There is one service | With a single service there is no private URL to bind, and a hardcoded `localhost` in server code resolves to the caller itself in production. The guard fails on any loopback URL in server code. |
| Database | `DATABASE_URL` (PostgreSQL, **pooled** endpoint) — **required** | SQLite cannot be written from parallel serverless instances. A local file in `/tmp` accepted writes and lost them on the next cold start; the runtime now refuses to boot without `DATABASE_URL` rather than falling back. |
| Connections | `DATABASE_POOL_MAX`, defaulting to 3 on Vercel | Each instance owns a pool. `pg`'s default of 10 × concurrent instances exhausts a managed database. |
| Migrations | `npm run db:migrate:prod`, run by the operator | Migrating on every request is a race and a latency tax. One command, deliberately separate. |
| Auth | **None.** The API authenticates nobody | This is a deliberate, single-tenant deployment: `/` opens the dashboard with no sign-in. Access control belongs to the hosting layer — see `docs/AUTH-REMOVAL.md`. |

#### 1.1.1 The `500 FUNCTION_INVOCATION_FAILED` outage

A preview deployment answered **every** path, `/` included, with Vercel's platform page:

```
This page is unavailable
A function needed by this page temporarily failed.
500 FUNCTION_INVOCATION_FAILED
```

It was not a routing bug, a database bug or a migrations bug. It was the entrypoint
failing the launcher's contract, and it happened twice in opposite directions.

**The contract.** `framework: "fastify"` is only a filename hint; the invocation is
`@vercel/node`'s `compileUserCode`, which:

1. replaces `http.Server.prototype.listen` with a stub that records the server and
   **returns without binding and without invoking the callback**;
2. `await import(entrypoint)` with that stub installed;
3. peels up to five nested `.default` values;
4. uses a **function** export per request; failing that, a server the module got
   captured by the stub; failing that, it throws `Can't detect way to handle request`.

**Both failures came from that list:**

| Entrypoint shape | What the launcher did | What the user saw |
| --- | --- | --- |
| Built the app, exported a `(req, res)` handler, never listened — **and the guard failed the build if it *did* call `listen()`** | found a function… but the module graph was imported for a service shim that expected a server, and nothing bound a port | `500 FUNCTION_INVOCATION_FAILED` |
| `await new Promise(r => server.listen(port, () => r()))` | step 1 swallowed the callback, so the promise never settled, `import()` never resolved, the invocation timed out | the same `500`, with no app log line |

The second one is the important lesson: **binding a port is the wrong fix for this
launcher.** The launcher binds, and only after the module finishes importing. Awaiting
`listen()` inside the entrypoint deadlocks by construction.

**What the entrypoint is now.** `apps/api/src/entrypoints/index.ts` exports a handler
function and binds nothing. Everything else it needs is imported dynamically, inside the
handler, in a `try`/`catch`, so a failure while loading the application becomes a JSON
`500 { error: { code: "boot_failed", detail } }` naming the cause instead of an
unexplained platform page. `apps/api/src/index.ts` remains the process that listens —
the `npm start`, Docker and Compose path, where nothing stubs `listen`.

**Why it survived review twice.** The absence of an error body was the diagnostic that
was available all along: every failure path in this application reports through a
response (`503 misconfigured`, `500 handler_failed`, `500 deployment_misconfigured`),
always JSON. A *platform* page means the invocation died outside the handler, so no
application code ran. And the checks agreed with the code rather than the platform —
first a guard that forbade `listen()`, then tests that booted the app the way we would
rather than the way the platform does. There is now a test that imports the built
entrypoint **with `listen` stubbed**, which is the only local test that can see this
class of failure (`apps/api/test/platform-launcher.test.mjs`).

**A second defect fixed with it.** The handler was built with `serveStatic: false` from
a two-service era. In a single service the catch-all rewrite sends every browser path
here, so `/` and deep links were being answered `404` JSON by the only public
entrypoint. `serveStatic` is now on, and the launcher test asserts `/` returns the
document.

#### 1.1.2 Why `/` answered a JSON 404 while the API worked

The SPA was served by the API process with `@fastify/static`. That is a directory read at
runtime, and the platform's bundler traces **module imports only** — it does not see
`fs.readdir`, so `apps/web/dist` was not in the deployed function. The deployment then
started cleanly, served every `/api` route, and answered every browser path with
`{"error":{"code":"not_found"}}`. To a user that looks like "the login doesn't work"; the
API was the only part that did.

The obvious fix — declaring the directory with `includeFiles` on the service — is not
available: the services schema rejects it (`services.app should NOT have additional
property includeFiles`), and it was published that way once before being noticed. A
config key the platform refuses is not a fix, it is a failed deploy.

So the SPA is **compiled into the API** instead, which is the one thing a bundler is
guaranteed to follow. `scripts/embed-web-assets.mjs` walks `apps/web/dist` after the Vite
build and writes `apps/api/src/generated/web-assets.ts` — every file inlined, text as text
and binary as base64 (~1 MB for the current build). `build:service` runs it *before*
`tsc`, so the module is part of `apps/api/dist` and travels with the function. The server
serves `web-dist.ts`'s directory when one exists (development, Docker, `npm start`) and
the embedded copy when it does not (a deployment bundle). Nothing in `vercel.json`
declares it; there is no key to get wrong.

Three things are enforced rather than remembered:

- **The embed runs, and runs first.** `npm run guard` fails if `build:service` stops
  calling `scripts/embed-web-assets.mjs`, or compiles the API before embedding it — the
  latter silently ships the *previous* module. It also fails if `includeFiles` reappears
  on the service, because the schema will reject the deployment before it reaches a
  browser.
- **The path is found, not computed.** `config.webDist` is derived from
  `import.meta.url` — three levels up from the module file, which in a flattened bundle
  is outside the artefact. `lib/web-dist.ts` searches candidate directories instead, and
  `resolveWebDist` returning `null` is the normal case in a bundle, not an error.
- **An unbuilt SPA is visible.** With neither a directory nor an embedded build the
  server answers a JSON 404 naming the path, rather than a 200 with nothing in it.

`apps/api/test/deployment-layout.test.mjs` builds that layout in a temporary directory —
compiled API **only**, no `apps/web/dist`, no repository — and runs the server there. It
asserts `/`, a deep link, a real asset from the embedded map, and
`/api/dashboard|clients|projects|live|health`. Before the embedding it failed with
exactly the production symptom: `GET / must return the dashboard, got 404`. It also
covers the opposite mistake: replace the embedded module with an empty one and `/` must
answer a JSON 404 while `/api/live` keeps working — the misleading shape this
deployment had.

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
| Build Command | **Leave empty.** A value here overrides the service's `buildCommand` even when the preset is Services |
| Install Command | **Leave empty.** Same reason |
| Output Directory | **Leave empty** — the Fastify service has no static output directory; it serves `apps/web/dist` itself |
| Node.js Version | **22.x** (`engines.node` is `>=22.18.0 <23`; verified on v22.22.3) |

If an existing project was imported before the preset was switched, the framework
preset and any Build/Install Command overrides must be corrected before redeploying.
Clearing those two overrides matters as much as the preset: a stale
`npm run build` in the dashboard is what produced the log above even though
`vercel.json` had already been corrected.

`vercel.json` cannot carry these values. `framework`, `buildCommand`,
`installCommand` and `outputDirectory` are **invalid at the top level** whenever
`services` is present, so writing them there to compensate would produce a
configuration error instead of a fix.

### 1.2.1 What the one service builds

| Artefact | Produced by | Served as |
| --- | --- | --- |
| `apps/api/dist/` | `npm run build -w @relay/api` | The function itself, plus `api/index.js`'s delegated handler |
| `apps/web/dist/` | `npm run install:web && npm run build --prefix apps/web` | The SPA document and its hashed assets, through `@fastify/static` |

Both come from the single `build:service` command, and the guard asserts that the
script names both workspaces. A build that compiles only the API deploys a working
API in front of a 404 for every page — the sort of half-deployment that looks
healthy in the build log.

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

So the service declares both commands. These keys are invalid at the top level in
services mode and belong in the service object:

| Service | `installCommand` | `buildCommand` |
| --- | --- | --- |
| `app` | `npm ci --include=dev --no-audit --no-fund` | `npm run build:service` |

`build:service` is the contract the whole shape rests on: it compiles the API **and**
builds the SPA, because the API serves `apps/web/dist` itself. The deployment guard
resolves the script from `package.json` and fails if it stops naming both workspaces.

`vite` stays a devDependency. Moving it into `dependencies` would hide mistake 1
rather than correct it: the build would work for the wrong reason, and the next
build-time tool to be added would fail the same way.

**Reproducing this locally.** `npm run build:service` runs the service's own
`buildCommand` from a clean tree with `NODE_ENV=production`, exactly as the platform
does. `npm run verify:routing` then boots the compiled server against that build and
asserts what it serves. CI runs both in the `single-service-build` job, which installs
at production mode and asserts that the handler, the container entry, the SPA document
and its assets all exist afterwards.

CI runs the same harness as a separate `service-builds` job. The main `verify` job
installs at the root and builds both workspaces — a genuinely different thing, and
exactly how a missing build tool reached production while CI stayed green.

**Does `include=dev` ship the development toolchain to production?** No. The
deployed bundle is not the install tree: Vercel traces the service's actual imports
and ships only those. Traced from `apps/api/dist/entrypoints/index.js`: **80 packages,
655 files, and zero files from `vite`, `typescript`, `playwright`, `embedded-postgres`,
`@vitejs/*`, `tailwindcss` or `concurrently`.** The bundle is Fastify, `pg`, `argon2`,
`zod` and their transitive dependencies.

The dev toolchain occupies build-machine disk for the duration of the build and nothing
else. That is the normal arrangement for compiling TypeScript at build time, and it is
cheaper than the alternative: a runtime install that cannot rebuild the bundle.

**Node version.** `engines.node` is a bounded range, `>=22.18.0 <23`, not `>=22.18.0`.
The lower bound is not a preference: the deployed entrypoint is TypeScript importing
`.ts` specifiers, which Node executes only with default type stripping (22.18.0 and
later). A floor below that pins a range that cannot run the file it selects.
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

The frontend now installs into its own `node_modules`, so nothing can delete the API's.
This still matters in a single-service deployment: `build:service` runs
`npm run install:web`, and that install must not walk up and replace the repo-root tree
the API was just compiled against. The deployment guard asserts that `apps/web` is not
a workspace member and keeps its own lockfile.

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
*Preview* if you want preview deployments).

**No variable is required to boot.** The deployment has no sign-in, so there is no
session secret and no credential to provision. Missing `SESSION_SECRET` or
`RELAY_ADMIN_PASSWORD_HASH` — which are now inert if present — cannot stop the API
from starting.

**`DATABASE_URL` is nevertheless required for a deployment to be useful.** Without it
the API boots, determines it is serving a deployment, and refuses to use a local file:
every browser path answers the setup page and every `/api` path answers
`503 misconfigured`. That is not a bug to route around — see §1.3.1.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **required on any deployment** | PostgreSQL connection string. Use the provider's **pooled** endpoint (Neon `-pooler`, Supabase `:6543`, PgBouncer). Append `?sslmode=require` if the provider requires TLS. Without it a deployed instance serves the setup page rather than a non-durable database — see §1.3.1. |
| `CRON_SECRET` | recommended | Authenticates `/api/cron/sweep`. Without it the endpoint returns 503 rather than running unauthenticated. This is not user authentication and is unaffected by the removal. |
| `OPERATOR_USER_ID` | optional | Which `users` row every request is attributed to. Defaults to `usr_owner`; if that row is absent the API uses the first administrator, then any user at all. |
| `OPERATOR_NAME` | optional | Display name of the single operator account created on a first run. Defaults to `Owner`. |
| `OPERATOR_EMAIL` | optional | Email of that account. Defaults to `owner@localhost`. |
| `DATABASE_POOL_MAX` | optional | Defaults to 3 on Vercel. Raise only if you are behind a connection pooler. |
| `NODE_ENV` | set by Vercel | `production`. |
| `CORS_ORIGIN` | optional | Only needed if the frontend is served from a different origin. Same-origin by default. |
| `SESSION_SECRET`, `RELAY_ADMIN_PASSWORD_HASH`, `RELAY_LOGIN_USERNAME`, `AUTH_MODE`, `ALLOW_DEV_AUTH_IN_PRODUCTION` | **ignored** | Read by the removed authentication system. They are accepted and have no effect; leaving them set is harmless, and they should be deleted when convenient so they do not imply a login that does not exist. |

**Never** put `CRON_SECRET` or `DATABASE_URL` in a `VITE_`-prefixed variable. Vite
inlines `VITE_*` into the client bundle, which would publish the secret to every
visitor. The frontend needs no secrets: it talks to `/api` on its own origin.

> **Access control is now the hosting layer's job.** The API authenticates nobody,
> so anyone who can reach the URL can read and write every record. If this
> deployment is reachable from the internet, put it behind your organisation's
> access control — Vercel deployment protection, an SSO proxy, or a private
> network. See `docs/AUTH-REMOVAL.md` for the full list of what changed.

### 1.3.1 Running with no database at all (evaluation mode)

You can deploy with **no PostgreSQL instance and no environment variables at
all**. On boot the API creates SQLite in the instance temp directory (the
deployment bundle is read-only, so the source tree cannot be used), runs the
migrations, and seeds the demo studio because `users` is empty.

Verified cold, with no `DATABASE_URL`, no `DB_PATH` and no credential:

```
GET /api/ready         200 {"ready":true,"engine":"sqlite"}
GET /api/auth/session  200 {"authMode":"none","user":{"name":"Maya Iyer",...}}
GET /api/projects      200 6 seeded projects
GET /api/dashboard     200 {"kpis":{"openTasks":73,"inFlight":31,"blocked":8,...}}
POST /api/clients      201 created, no credential sent
```

**The cost, stated plainly:** SQLite in `/tmp` is per-instance. Every cold start
begins with a fresh database, so anything a user creates is lost when the function
recycles, and two concurrent instances do not see each other's writes. It is enough
to evaluate the product; it is not enough to use it. Set `DATABASE_URL` for
durable storage — that is the only difference between the two modes, and it is
why the API reports `"engine":"sqlite"` on `/api/ready` and names the consequence
on any boot failure.

**This is a local-development mode only.** It is not available on a deployed
instance, and that is enforced rather than documented: `createDb()` treats a serving
runtime (Vercel, Lambda, Cloud Run, or `NODE_ENV=production`) as one that must have
`DATABASE_URL`, and throws a message naming the remedy if it does not. On a deployment
without `DATABASE_URL` every browser path answers the setup page (§1.1) and every
`/api` path answers `503 misconfigured`.

The reason is what SQLite in a serverless instance actually is:

- **Data does not survive a cold start.** `/tmp` is per-instance. Write a task, let the
  instance recycle, and it is gone.
- **Two concurrent instances do not share state.** A second instance has its own empty
  file. Concurrent edits to "the same" row are not conflicts, they are two different
  databases.
- **A first run is indistinguishable from data loss**, because both look like a
  dashboard with nothing in it.

That combination is why the deployment requires PostgreSQL. §1.4 has the exact
commands.

`/api/health` always reports the engine (`sqlite` or `postgres`), so which mode a
deployment is in is never a guess.

### 1.3.2 What a fresh deployment contains

One row: the operator account, named from `OPERATOR_NAME` / `OPERATOR_EMAIL`. No
clients, projects, tasks, deals, invoices, boards or teams.

This is a change of behaviour, so it is worth stating why. Boot used to run the demo
seed whenever `users` was empty, which filled a new deployment with a fictional studio —
twelve people, six projects, 89 tasks, twelve deals. Two problems, both fatal to trust:

- **Invented data and real data were indistinguishable.** Both arrived through the same
  read endpoints, in the same shape. A dashboard showing "6 projects" said nothing about
  whether anybody had six projects.
- **It was impossible to start clean.** Deleting the demo rows and restarting re-created
  them, because the trigger was "is `users` empty".

The bind that makes *some* row necessary is attribution: `created_by`, `updated_by` and
`actor_id` are foreign keys to `users`, so with no people the first write fails. One
operator is the minimum that makes the product usable, and it is a fact only the
operator can supply — hence the environment variables rather than a default person.

The demo dataset still exists for screenshots and walkthroughs, behind an explicit
command that nothing else calls:

```bash
npm run db:seed        # fictional studio, local evaluation only
```

It refuses in production unless `FORCE=1` is set, which is the CLI's way of asking
whether you meant it.

### 1.4 Provision the database — the exact steps

There is no login to provision. The only setup step is the database, and skipping
it is a supported (if non-durable) configuration.

```bash
# 1. Migrate the schema. Idempotent, safe to re-run.
DATABASE_URL='postgres://…' npm run db:migrate:prod
# Expected: "✓ migrations applied: 17" (or "already at version N" on a re-run)

# 2. Seed the demo studio. Required only on a fresh database: the API attributes
#    requests to a row in `users`, and cannot invent one.
DATABASE_URL='postgres://…' npm run db:seed
# Expected: a summary of the rows created.

# 3. Confirm.
curl -s https://<your-deployment>/api/ready   | jq
curl -s https://<your-deployment>/api/projects | jq '.data | length'
```

`npm run db:seed` is the step that matters on a new database. Without a `users`
row the API answers `503 misconfigured` and says exactly that — it will not refuse
with a 401, because there is no authentication to fail:

```json
{
  "error": {
    "code": "misconfigured",
    "stage": "identity",
    "message": "No users exist in the database, so requests cannot be attributed. Run `npm run db:seed`, or set OPERATOR_USER_ID to an existing user id. (Looked for "usr_maya".)"
  }
}
```

> **The old `set-password` and `assign-login` scripts are obsolete.** They still
> exist and still run, but nothing reads `local_credentials`, so the credential
> they write has no effect on access. Do not treat running them as part of a
> deployment.

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

### 1.5.0 When the deployed dashboard says the API is unreachable

There is no sign-in screen, so a failure now appears inside the dashboard as an
inline message from `ApiFailure`. Three of them are distinguishable, and the
distinction is the point — the original bug here reported "is the API running on
:4000?" for a 503, which is false on every deployed host.

| Message | Means | Fix |
| --- | --- | --- |
| "This deployment is not configured yet." | The API is running and told you exactly what is wrong. | Read the variable names it lists. |
| "Could not reach the API." | The request never completed: wrong host, a build without the service, a network fault. | Check the deployment and the routing config. |
| A status and code, e.g. `429 rate_limited`. | The API answered and refused this particular request. | See the status. |

Check the deployment directly:

```bash
curl -s https://<your-deployment>/api/health | jq '.data | {status, storage, authMode}'
curl -s https://<your-deployment>/api/ready  | jq
```

`/api/ready` reports the storage engine. If it says `"engine":"sqlite"` on a
production deployment, `DATABASE_URL` is not set and **data will not persist
across cold starts** — that is the most common real problem, and it is not an
authentication problem.

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
* the declared entrypoint exists, **default-exports a handler**, and does **not** call
  `.listen()` — both halves of the launcher contract in §1.1.1;
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
| **Platform page: `500 FUNCTION_INVOCATION_FAILED` on every path, `/` included** | The entrypoint failed the launcher contract: no default export, or it awaited `.listen()` and deadlocked the import. No application code ran, so no JSON envelope appeared. See §1.1.1 | `npm run guard` fails the build on both shapes, and `node --test apps/api/test/platform-launcher.test.mjs` imports the built entrypoint exactly as the launcher does |
| **`500` with a non-JSON body on every `/api` route** | The function has no handler at all. A version-gated built-in (`node:sqlite`) or a native binding (`argon2`) was imported statically, so the module graph threw while loading — before any error handling existed | Both are now imported on demand. If it recurs, check for a newly added static import of a native/version-gated module in the request graph |
| Sign-in shows *"Could not reach the API"* rather than the variables above | The request never reached the function — the deployment has no `api` service, or the `/api` rewrite is missing | Check the rewrite order (§1.2) and that both services are detected in the build log |
| The identity list never loads in development mode | Fixed: the screen called `GET /api/users`, the authenticated directory, which no anonymous visitor can read | `GET /api/auth/dev-users` is the anonymous, minimal counterpart. Update rather than special-casing the 401 |
| `deployment_build_incomplete` from `/api` | `apps/api/dist/entrypoints/vercel.js` is absent because the build did not compile the API | Check the build log for the API half of `build:service`; redeploy |
| `/` returns JSON `not_found` instead of a page | The catch-all rewrite is missing or points at `api`, so a browser route reached the API function | Confirm `/(.*) → web` is last in `rewrites` |
| Every `/api/*` call returns HTML | The `/api` rewrite is missing, or the catch-all is listed before it | Order the rewrites specific-first; the guard checks this |
| 500 with `Cannot read properties of undefined (reading 'length')` | `app.ready()` was skipped — a stale build | Rebuild; this is fixed in `apps/api/src/vercel.ts` |
| Every login returns 401 | Credential never provisioned, or a hash for a different password | Re-run step 1.4 from 3 |
| Boot fails: "RELAY_ADMIN_PASSWORD_HASH is not a complete Argon2id hash" | The value was truncated on paste, or quoted so `$` was expanded by the shell | Single-quote the value; re-paste |
| `/api/ready` returns 503 | `DATABASE_URL` wrong, or TLS required but not requested | Add `?sslmode=require`; check the pooled host |
| Random timeouts under load | Pool exhaustion — too many instances × pool size | Use the pooled endpoint; lower `DATABASE_POOL_MAX` |
| `/api/cron/sweep` returns 503 | `CRON_SECRET` unset | Set it; redeploy |
| `ENOENT: lstat '…/node_modules/fastify/package.json'` at **Deploying outputs**, after a successful build | The web install replaced the shared workspace-root `node_modules` | `apps/web` must not be an npm workspace member and must keep its own `package-lock.json`; see §1.2.6 |
| `vite: command not found` (or `tsc: command not found`) during the build | Vercel installed with production-mode npm, which omits `devDependencies` | The service's `installCommand` must be `npm ci --include=dev --no-audit --no-fund`; confirm with `npm run build:service` |
| The API build fails on a deploy but the web build is fine | That service is running the root `build` script, which compiles both workspaces | `api` must use `npm run build -w @relay/api`; `web` must use `npm run build`. Each service builds only its own workspace |
| Password login returns 500 `no such table: local_credentials` | The database predates migration 0014; login is the first thing to touch that table | Run `npm run db:migrate:prod`, then `npm run db:pg:assign-login` |
| `argon2` works locally but fails on the platform | npm 12 skipped the install script because the version is not approved | Update the pinned `allowScripts` entry to the installed version; the guard fails when the pin and the lockfile disagree |
| `npm warn Unknown env config "cache-dir"` | Vercel's build image exports `npm_config_cache_dir`; npm 11+ rejects the key | Cosmetic. `.npmrc` pins the supported `cache` key; see §1.2.4 |
| Deep links 404 but the root works | The `web` service is not falling back to the document | `web` must declare a fallback to `/index.html` that excludes file-like paths, e.g. `{"source": "/((?!assets/)[^.]*)", "destination": "/index.html"}`; confirm the request reached `web` and not `api` |
| The app loads but shows a MIME type error, or a page goes blank after a deploy | A stale or missing hashed asset was answered with the SPA document (200) instead of 404 | The fallback is too broad — `/(.*)` catches `/assets/*`. Use the extension-guarded pattern above |
| The build log shows a single root `npm run build` | Framework Preset is not `Services`, or a project-level Build Command overrides the service command | See §1.2: set the preset to Services and clear Build/Install Command |
| `/api/*` returns the HTML page | The `/api` rewrite is missing | Check `vercel.json` rewrites are present and ordered |

### 1.7 What is not proven about the Vercel path

1. No deployment was performed. There is no URL, no project, no team id. The
   configuration is implemented and locally exercised; the platform itself is the
   requester's step.
2. The built service entrypoint is spawned as its own process and driven with `fetch`
   over a real socket (`apps/api/test/service-entry.test.mjs`) — which covers binding
   `PORT`, the SPA at `/` and deep links, `/api/live`, and the 503 report for an
   unbuildable configuration, but not Vercel's own launcher, cold-start timing, or
   edge network behaviour.
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
| `DATABASE_URL` | strongly recommended | `postgres://user:pass@host:5432/relay`. Without it the app runs on SQLite in `/tmp`, which works but does not persist. |
| `CRON_SECRET` | recommended | Authenticates `/api/cron/sweep`; without it the endpoint returns 503 rather than running open. |
| `CORS_ORIGIN` | recommended | comma-separated origins; `*` is a local default |
| `PORT` / `HOST` | no | `4000` / `0.0.0.0` |
| `SWEEP_INTERVAL_MS` | no | `60000` |
| `SKIP_MIGRATE` | no | set to `1` only when a one-shot migrator ran first |
| `OPERATOR_USER_ID` | no | which `users` row requests are attributed to; defaults to `usr_maya` |

There is no authentication configuration. `AUTH_MODE`, `SESSION_SECRET`,
`RELAY_ADMIN_PASSWORD_HASH` and the `OIDC_*` variables are **ignored** — they may
still be present in an environment, and they change nothing.

#### Verified boot behaviour

| Scenario | Result |
| --- | --- |
| Any environment, including none at all | **boots and serves.** This is the property the previous release failed: a missing `SESSION_SECRET` refused boot, and every request got a non-JSON 500. |
| `NODE_ENV=production` + a stale `AUTH_MODE=dev` | boots; the variable has no effect and no gate is re-armed |
| `NODE_ENV=production` + a malformed password hash | boots; nothing reads the hash, so it cannot be a startup failure |
| Empty database (migrated, not seeded) | `/api/ready` → 200; business reads → `503 misconfigured` naming `npm run db:seed` as the fix |

With PostgreSQL attached: `/api/ready` → `{ready:true, engine:"postgres"}`,
`/api/health` → `{status:"ok", storage:"postgres", authMode:"none"}`,
`GET /api/projects` → 200 **with no cookie and no token**, and a mutation with no
CSRF token succeeds — because there is neither a session nor a CSRF token.

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
