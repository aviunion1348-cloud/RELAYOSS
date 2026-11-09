# RelayOS — architecture walkthrough

Companion to `RELAYOS_SYSTEM_ARCHITECTURE.excalidraw` (14 frames).
Everything here refers to commit **`ad79aa1b201b68ba42445a0f830614085c2e3cb6`**.

There are two boards, for two readers:

| Board | For | Shape |
| --- | --- | --- |
| `RELAYOS_GUIDED_TOUR` | someone who has never opened the repository | 10 frames: an overview grid (00) then nine sections, plain English on top and the real file / line / SQL underneath |
| `RELAYOS_SYSTEM_ARCHITECTURE` | an engineer navigating the code | 14 frames, dense, every component, path and line number |

The guided tour is the front door; this document is the script you talk over while pointing at the dense one.

Read it in the order the board is drawn: 00 overview → 01 deployment → 02 frontend → 03 backend → 04 database → 05 request lifecycle → 06 workflow → 07 background → 08 security → 09 failure → 10 testing → 11 stack → 12 source map → 13 gaps.

---

## A. The five-minute architecture explanation

Say it roughly like this.

> RelayOS is a delivery-studio operating system: clients, projects, tasks, QA, releases, contracts and the SLA clocks
> that govern the work. The whole thing is **one Node process**. There is no separate API service and no separate
> web service — a single Fastify 5 application serves the JSON API *and* the compiled React single-page app from the
> same origin, because the SPA is compiled into the API's own build output.
>
> The frontend is React 19 with Vite. The router is react-router 7, and all server state goes through TanStack Query.
> There is one API client, `apps/web/src/lib/api.ts`, and its base URL is the literal string `/api`. That is the whole
> integration story: same origin, relative path, no CORS configuration to get wrong.
>
> The backend is Fastify with about a hundred routes in one router module, business rules in `services/` and `domain/`,
> and plain SQL against PostgreSQL 16 through a single async `Db` interface. There is no ORM. Migrations are numbered
> SQL files applied at boot with a checksummed ledger, so seventeen migrations run idempotently on every cold start.
>
> The database is the interesting part, because the business logic lives in it as much as in the code. A task belongs
> to a project and to a board column, and the column is looked up by `(board_id, key)` because the schema has a unique
> constraint on exactly that pair. Turnover gates, acceptance steps, SLA timers and the client lifecycle are all rows,
> not hard-coded flows — the code enforces transitions over those rows.
>
> A request goes: browser → Vercel's single rewrite → Fastify router → an `onRequest` hook that resolves the operator
> identity → the handler → zod validation → a service or a SQL query → the `ok()` envelope → `onResponse` hooks that
> write an access-log line, a metric, and a `change_log` row for the live-update feed.
>
> Deployment is Vercel in services mode with one service. The build installs with dev dependencies because the build
> needs `vite` and `tsc`, builds the SPA, embeds it into the API as a generated TypeScript module, then compiles the
> API. At runtime the process reads `DATABASE_URL` — it refuses to start without one rather than silently using a file
> in `/tmp` — opens a pg pool, applies migrations, ensures there is an operator row, and listens on `PORT`.
>
> The honest caveat: this deployment has **no authentication**. That is a deliberate product decision, and the
> application says so out loud: `/api/auth/session` returns `authMode: "none"`, and `/api/auth/login` answers `410 Gone`.
> The only gate in front of it is Vercel Deployment Protection.

If they only remember one sentence: **one process, one origin, one database, and the rules are rows.**

---

## B. The fifteen-minute deep walkthrough

Point at each frame as you speak. Times are cumulative.

### 0:00–1:30 — Frame 00, overview

**Point at:** the big vertical spine: Operator → Browser → the single Vercel service container → PostgreSQL.

**Say:** “Everything between the browser and the database is one deployable unit. The container box holds two things:
the API and the SPA bytes. The SPA is not hosted separately — it is compiled into the API build as a module and served
by the API.”

**Be precise about the chips:** `embedded SPA module` is the production path
(`apps/api/src/lib/embedded-web.ts`); `@fastify/static` is the development/container path where a real
`apps/web/dist` directory exists (`app.ts`, lines 558–570). They are dashed because they are conditional.

**Then name what is missing, before they ask:** no queue, no cache, no object storage, no authentication.

### 1:30–3:30 — Frame 01, deployment

**Point at:** the four build steps inside the purple container, then the runtime column on the right.

**Say:** “Vercel runs `npm ci --include=dev` — dev dependencies are not optional, because the build uses Vite and tsc.
Then `build:service` runs four steps: install the web project, build the SPA, embed it as TypeScript, compile the API.”

**Why the embed step exists** — this is the strongest detail you can offer:
the platform's bundler follows *imports*, not directories. A `fs.readdir` of `apps/web/dist` at runtime would find
nothing in the deployment bundle, and the services schema rejects `includeFiles`. So `scripts/embed-web-assets.mjs`
turns the built SPA into `apps/api/src/generated/web-assets.ts`, which `tsc` compiles into `dist`. One artefact, no
configuration.

**Build time vs runtime:** nothing on a request compiles anything. At runtime the process opens a pool, applies
migrations, ensures the operator row, listens.

**The honest caveat:** every deployment URL redirects to Vercel login — Deployment Protection — so I could verify the
build and the deploy checks, not the running function from outside the account.

### 3:30–5:00 — Frame 02, frontend

**Point at:** the chain `main.tsx → App.tsx → Shell.tsx → pages`, then the data layer card.

**Say:** “`main.tsx` creates one `QueryClient` — 15-second stale time, one retry and only for 5xx — wraps the app in
`BrowserRouter`. `App.tsx` owns the error boundary, the suspense boundary and all thirteen routes. `Shell.tsx` is the
navigation and the command palette.”

**The single most important line of frontend code:** `const BASE = '/api'` in `apps/web/src/lib/api.ts`. Everything
else follows from it: no environment variable, no CORS, no mixed content, no base URL to misconfigure per environment.

**Failure design:** `ApiError` means the API answered and said no; `NetworkError` means it never answered. The UI
renders different text for each, and the smoke suite asserts both.

**Concrete flow:** `/projects` → `Projects.tsx` → `useQuery({ queryKey: ['projects'], queryFn: api.projects })` →
`fetch('/api/projects')` → `{data:[…]}` → cached under `['projects']` → `useQueryState` picks the branch → table.

### 5:00–7:30 — Frame 03, backend

**Point at:** the four columns: entrypoint → `app.ts` → `routes/index.ts` → services/domain → db.

**Say:** “Fastify is configured once in `buildApp`: `trustProxy`, a request-id generator, a 2 MB body limit, helmet,
CORS, and then hooks. Two `onResponse` hooks do the observability work: one writes the structured access line and the
RED metrics; the other appends a `change_log` row for any successful POST/PUT/PATCH/DELETE.”

**Why that hook exists** — good story: the live feed needs to know “did anything change since X?”. `audit_log` was the
obvious source, but only five handlers wrote to it, so the feed would have been blind. The fix was one hook at the
single place every write already passes through, rather than editing forty-nine handlers.

**Then the layering, honestly:** handlers call SQL directly for reads; services own multi-step writes and invariants;
`repositories/query.ts` is a *mapper* module (`TASK_SELECT`, `mapProject`, `mapClient`), not a repository layer.
No ORM, no DI container. Say that before they find it.

**Validation:** zod in the route module (e.g. the `createSchema` in `POST /api/tasks`), plus small validators in
`lib/http.ts` (`requireString`, `optionalNumber`). Everything funnels into one `setErrorHandler` that renders the same
envelope for 400/404/409/500.

### 7:30–9:30 — Frame 04, database

**Point at:** the two columns, then the FK notation inside each card.

**Say:** “Eighty-one tables, seventeen migrations. The core is ordinary: clients → projects → tasks, with users as the
actor. What makes it a delivery system is the governance tables: `turnover_gates` and `turnover_checks`,
`acceptance_records`, `sla_clocks` and `sla_timers`, `releases`, `project_phases`.”

**Call out three deliberate details:**

1. `tasks.column_id` is a real FK, and `columns` is `UNIQUE (board_id, key)` — which is why `createTask` resolves the
   column by lookup instead of guessing an id shape.
2. `sla_timers.entity_type` + `entity_id` is polymorphic and has **no** foreign key. That is a design decision, not an
   oversight: a timer can point at a deal, project, phase, task, release or QA report.
3. `qa_reports.release_id` is text without an FK, so a QA report outlives a deleted release.

**On `*_new` tables:** if they see `sessions_new` or `sla_timers_new` in migrations 0010/0014, it is a SQLite-compatible
table rebuild (create, copy, drop, rename), not leftover cruft.

### 9:30–11:00 — Frame 05, request lifecycle

Walk the twelve chips of sequence A, then B.

**Say for the read path:** “Notice there is no authentication step and no session lookup — the identity hook resolves
one operator row, cached per instance. Then it is one SQL statement with four correlated subqueries for the counts, and
`mapProject` converts snake_case to camelCase. The response is `{data:[…]}`.”

**Say for the write path:** “The interesting part is ordering: validate with zod, resolve the board, resolve the column
by `(board_id, key)`, generate the task key from the highest existing suffix — not from the row count, because the
count version collided with an existing key — insert the task, its checklist and its gates, then return the full joined
task with 201.”

**Then the failure table:** 400 for validation or a short title, 400 for a board with no such column, 404 for an
unknown board, 409 for a key collision, 500 for anything uncaught — all in the same envelope.

### 11:00–12:30 — Frame 06, workflow

**Say:** “There are two different kinds of workflow in here, and only one of them is enforced.”

- **Pipeline stages** (12) are data: `pipeline_stages`, and a deal's `stage_id` is a NOT NULL FK. Moving a deal is a
  PATCH. There is no server-side rule about which stage may follow which. Say it plainly.
- **Client lifecycle** (18 stages) *is* enforced: `services/lifecycle.ts` holds a `TRANSITIONS` table, refuses anything
  absent from it, and requires evidence rows for guarded moves.
- **Acceptance ladder**: `dev_complete → qa_approved → lead_approved → client_accepted`, one row per step, unique per
  task and step, index checked before writing.
- **Turnover gates**: eight machine rules (`AUTO_RULES`), gates and checks as rows.
- **Ship gate**: `evaluateShipGate()` refuses to ship while a required check is open.
- **SLA clocks**: policies with target/warn/stretch hours; timers with `running/met/missed/paused/waived`.

**The line to end on:** “A screen showing a green tick is not an approval. The approvals that matter are rows.”

### 12:30–13:15 — Frame 07, background work

**Say:** “There is no queue and no worker. The only time-based invariant is that a running clock whose due date passed
must become missed. That is one UPDATE, so it runs wherever a process is awake: the Vercel cron at 03:00, an interval
every 60 seconds in the container, and — on the serverless path — an inline sweep throttled to once a minute so a daily
cron is not the only chance.”

**Idempotency:** the sweep only touches `outcome='running' AND due_at <= now`, so a second run finds nothing.

### 13:15–14:00 — Frame 08, security

**Say it without flinching:** “There is no authentication. No session, no cookie, no CSRF token, no RBAC in force.
Every write is attributed to one operator row, `usr_owner`, with role admin. The schema for RBAC exists —
`project_members`, `partner_iam_users`, `client_portal_users` — and `scope.ts` can enforce it, but with an admin
operator the scope resolves to unrestricted.”

**Then the active controls:** helmet, CORS, rate limits (1200/30/240 per minute), 2 MB body limit, parameterised SQL,
constraints as invariants, timing-safe cron comparison, and two append-only history tables.

**The consequence, stated plainly:** anyone who can reach the URL can read and write. Deployment Protection is the only
gate, and it is a platform setting, not application code.

### 14:00–14:40 — Frame 09, failure

Walk the six break-points. Spend your time on two:

1. **Boot failure.** No `DATABASE_URL` → the process refuses to start and records why. Every response is 503: JSON
   under `/api`, a setup page for a browser, naming the missing variable. Not a blank 500.
2. **The module-format outage.** `@fastify/static` was imported at module scope; in 10.1.4 a transitive dependency
   became ESM-only; on a runtime without `require(esm)` that threw `ERR_REQUIRE_ESM` *while the function was loading*,
   so no route existed to report anything. Fix: pin 10.1.3 and move the import inside the branch that needs it. Test:
   four cases in a child process with `--no-experimental-require-module`.

That story is the best evidence you have that you debug systems rather than guess at them.

### 14:40–15:00 — Frames 10–13, one line each

- **10**: “`npm run verify` is the local gate — guard, typecheck, 283 tests, 19 PostgreSQL tests, build, routing, smoke,
  boot, restart persistence, backup drill. CI adds Chromium e2e and Docker.”
- **11**: “The stack is deliberately small. The one exact pin is `@fastify/static 10.1.3`, for the reason above.”
- **12**: “This frame is the map from every box to a file — this is how you navigate the repo.”
- **13**: “And this is what is missing, with the evidence.”

---

## C. Twenty-five questions an employer could ask

Answers below are about *this* code, not textbook answers.

**1. Why one service instead of separate frontend and backend?**
The product is a single-origin internal tool, and the split bought nothing: both halves deploy from one repository, one
commit, one build. Serving the SPA from the API also removes the entire CORS class of bugs — `BASE = '/api'` is
relative, so there is no base URL to configure per environment. Cost: the SPA ships inside the API artefact, so a
frontend-only change still redeploys the API. `docs/DEPLOYMENT.md` §1.0 records the trade.

**2. Why Fastify and not Express?**
Fastify's hook pipeline is what the request path actually uses: two `onRequest` hooks (identity, start time), two
`onResponse` hooks (access log + metrics, `change_log` append), one `setErrorHandler`, one `setNotFoundHandler`. Express
would need middleware ordering by hand, and the structured logger is built in.

**3. How does a request travel through the system?**
Frame 05. Browser → rewrite → Fastify router → `onRequest` (identity) → handler → zod → service/SQL → `ok()` envelope →
`onResponse` (log, metric, change log). Errors unwind to one handler.

**4. How are routes organised?**
One module, `apps/api/src/routes/index.ts`, 3 370 lines, ~100 handlers, grouped by domain with blank-line sections and
comments. `routes/operator.ts` holds the identity endpoints. There is no per-entity router file; that is a known debt.

**5. Where does validation happen?**
At the route, before any business logic: zod `safeParse` on write bodies (e.g. `createSchema` for `POST /api/tasks`),
plus `requireString`/`optionalNumber` in `lib/http.ts` for query and scalar input. Failures throw `badRequest` with the
issue list.

**6. How is the response shaped?**
`ok(data)` → `{data}`; `page(items, meta)` → `{data, meta:{total, limit, offset}}`; errors → `{error:{code, message, …}}`.
One handler produces the error shape for the whole API, so clients parse one thing.

**7. How does the frontend keep state?**
TanStack Query, not Redux. Fifteen-second stale time, one retry for 5xx only, no refetch on window focus. Mutations
invalidate the specific keys they touch (`['projects']`, `['dashboard']`), and `useLiveUpdates` polls `/api/changes` and
invalidates what changed. `useQueryState` normalises every screen into loading / error / empty / data.

**8. How is data persisted?**
PostgreSQL through `pg` with a pool of 10. Writes go through `db.run` (or `tx()` for multi-statement work). Migrations
are applied at boot from a checksummed ledger. There is no ORM, so the SQL is where you can read it.

**9. How are relationships enforced?**
By the database, not by the application: `tasks.project_id → projects ON DELETE CASCADE`,
`projects.client_id → clients ON DELETE RESTRICT`, `acceptance_records UNIQUE (task_id, step)`,
`columns UNIQUE (board_id, key)`, CHECK constraints on every status enum. Two references are deliberately *not* FKs:
`sla_timers.entity_id` (polymorphic) and `qa_reports.release_id` (reports outlive releases).

**10. How are concurrent writes handled?**
Transactions via `tx(fn)` where a write spans statements; unique constraints as the real arbiter, with constraint
violations mapped to 409. Task keys are generated from the highest existing suffix and protected by `UNIQUE`. There is
no optimistic-concurrency version column — an honest gap for a multi-user future.

**11. What happens if two users create a task at once?**
Both attempt an insert; the second either gets a distinct key (the generator re-reads) or a 409 on the unique
constraint. Nothing silently overwrites, because nothing is an upsert unless it is meant to be.

**12. How does Vercel deploy this?**
Frame 01: one service, `installCommand` with dev dependencies, `buildCommand` = `build:service`, entrypoint
`apps/api/src/entrypoints/index.ts`, rewrite `/(.*)` to the service. Build produces `dist`; runtime opens the pool,
migrates, listens.

**13. What happens if PostgreSQL becomes unavailable?**
The pool rejects; the request fails at the query; `setErrorHandler` renders 500 in the standard envelope. `/api/live`
still answers 200 (process is up) while `/api/ready` reports the database state — which is the difference the two
endpoints exist to express. If the database is missing at boot, the process refuses to start and says which variable.

**14. Why does the app refuse to boot without `DATABASE_URL`?**
Because the previous rule — “fall back to SQLite in a writable directory” — meant `/tmp` on a serverless platform. The
API booted, accepted writes, read them back, and lost them when the instance was recycled. A database that behaves
exactly like one until it does not. Refusing to start is a failure a person can fix in a minute.

**15. How do health checks work?**
`/api/live` — process up plus uptime. `/api/ready` — database reachable, engine name. `/api/health` — configuration
report including `authMode: 'none'` and `storage: 'postgres'`. `/api/metrics` — Prometheus text; business gauges are
computed on scrape so they cannot drift from the rows.

**16. How are migrations managed?**
Seventeen numbered SQL files in `db/migrations/pg`, applied in order, each recorded in `schema_migrations` with a
checksum and duration. `migrate()` runs on boot unless `SKIP_MIGRATE=1`. The SQL is bundled as text at build time
(`db/migrations-bundle.ts`), because a deployment bundle carries imports, not directories.

**17. How do tests verify business rules?**
Through the API and the database, not with mocks: `domain.test.mjs`, `shipgate.test.mjs`, `lifecycle.test.mjs`,
`clock-scope.test.mjs`, `clocks-pause.test.mjs`, `crud.test.mjs`, `editing.test.mjs`. The PostgreSQL suite
(`scripts/test-pg.mjs`) runs the same governance tests against a real cluster, because SQLite and PostgreSQL disagree
about enough to matter.

**18. Difference between a green build and a working deployment?**
A build proves the code compiles and artefacts exist. It says nothing about whether the platform's Node runtime matches
the one under test, whether environment variables exist, or whether the entrypoint binds a port. That is why CI has a
`single-service-build` job (production install + the service's own build command) and why the repo has
`service-entry.test.mjs` and `platform-launcher.test.mjs` that spawn the built entry over a socket.

**19. What are the security limitations?**
No authentication, no CSRF (nothing to protect — `credentials: 'omit'`), RBAC present but unenforced because the
operator is admin, rate limits per IP rather than per user, and an audit trail that answers *what* changed but not
*who*. Deployment Protection is the only gate in front of a public URL.

**20. What would happen at 10,000 users?**
The first wall is not the API, it is the write path: `routes/index.ts` is synchronous SQL per request, the pool is 10
connections per instance, and the `change_log` append is one insert per mutation — all survivable, but the dashboard
endpoint computes aggregates on every call. Second wall: rate limiting is per IP and in memory, which stops meaning
anything behind a proxy. Third: everything is one process, so a slow query blocks nothing but itself — yet there is no
read replica or cache tier to absorb dashboard traffic.

**21. What are the current bottlenecks?**
`GET /api/dashboard` and `GET /api/pipeline` (aggregate queries per request), the 3 370-line router module (review
cost, not runtime cost), and migrations on cold start (a long migration delays every instance's first request).

**22. What would you redesign first?**
Split `routes/index.ts` by domain, because review and testing cost is where the risk is. Then add a per-user identity
(the schema is ready) and make `audit_log` complete rather than partial. Only then consider caching or read replicas —
there is no evidence yet that the database is the limit.

**23. How does the SPA get into the deployment at all?**
`scripts/embed-web-assets.mjs` walks `apps/web/dist`, inlines text as text and binaries as base64, and writes
`apps/api/src/generated/web-assets.ts`. `tsc` compiles it into `dist`. `embedded-web.ts` serves from that map when no
directory exists. Sixteen files in the current build.

**24. Why is `@fastify/static` pinned exactly?**
Because 10.1.4 pulled `content-disposition@3`, which is ESM-only, into a CommonJS `require` graph. On a runtime without
`require(esm)` that threw while the module loaded, so every route answered `boot_failed`. The pin plus a lazy import
means the API can boot even if that dependency regresses again.

**25. What is not true about this system that a diagram might imply?**
That the workflows are all enforced. Pipeline stage order is data, not a guard. That communications and e-signature are
integrated — both are status reporting over stored rows. That there is a queue — there is not. That the deployment is
verified end-to-end — the runtime is behind Deployment Protection and could not be observed from outside the account.

---

## D. The fifteen files that matter, explained like a developer

For each: what it does, why it exists, what calls it, what it calls, what breaks without it, and how data moves.

**1. `apps/api/src/app.ts` (636 lines)** — builds the Fastify instance: plugins, hooks, error handling, static serving,
boot migration and operator bootstrap. Called by both entrypoints. Calls `getDb`, `migrate`, `ensureOperator`,
`registerRoutes`, `registerOperatorRoutes`. Without it there is no application. Data: none of its own — it wires the
request path. **Why it matters:** this is where a request lifecycle is defined, and where the module-format outage was
introduced (top-level import) and fixed (lazy import).

**2. `apps/api/src/routes/index.ts` (3 370 lines)** — every HTTP handler. Called by `app.ts`. Calls services, `lib/http`
validators, `db.all/get/run`, and the scope helpers. Without it the API has no endpoints. Data: reads request bodies and
params, returns envelopes. **Example:** `POST /api/tasks` parses with zod, calls `createTask`, returns `taskDetail`.

**3. `apps/api/src/services/tasks.ts` (454)** — task invariants: `nextKey`, `createTask`, `updateTask`,
`ensureTaskChecks`, `recordAcceptance`, `taskDetail`, and the `ACCEPTANCE_LADDER`. Called by task routes. Calls SQL and
the turnover domain. Without it, task creation produces rows with no key, no checklist and no gates.

**4. `apps/api/src/services/clocks.ts` (309)** — SLA timers: `startTimer`, `pauseTimerFor`, `resumeTimerFor`,
`resolveTimer`, `sweepTimers`, `clockHealth`, `clockHistory`. Called by clock routes, the cron endpoint, the interval
sweeper and the inline sweep. Without it nothing ever becomes “missed”.

**5. `apps/api/src/services/lifecycle.ts` (457)** — the 18-stage client lifecycle: `STAGE_KEYS`, `TRANSITIONS`,
`transition`, `addEvidence`, `lifecycleView`. Called by lifecycle routes. Without it the lifecycle becomes a free-form
status field.

**6. `apps/api/src/domain/turnover.ts`** — pure functions over gate rows: `evaluateGates`, `AUTO_RULES`, `CheckState`.
Called by task and phase routes. It holds no database handle, so it is trivially testable — that separation is
deliberate.

**7. `apps/api/src/db/index.ts`** — chooses and caches the `Db`: PostgreSQL when `DATABASE_URL` exists, SQLite only when
explicitly requested, and a clear throw otherwise. Also lazily imports `node:sqlite` so a version-dependent built-in is
never in the module graph of a PostgreSQL deployment.

**8. `apps/api/src/db/postgres.ts` (120)** — `PostgresDb`: pool construction, `all/get/run/exec`, and `tx()` which
holds one client for the duration and rolls back on throw. Without it there is no database.

**9. `apps/api/src/db/sql.ts` (151)** — dialect translation: `?` → `$n`, `upsertInto`, `placeholderCount`. Every
statement in the codebase is written once and runs on both engines; the portability guard in CI checks that claim.

**10. `apps/api/src/db/migrate.ts`** — `ensureLedger`, `migrate`, `schemaVersion`. Applies numbered SQL files in order,
records idempotency state with a checksum. Without it a new deployment has an empty database.

**11. `apps/api/src/entrypoints/index.ts`** — the deployed entry: loads the app, binds `PORT`, owns the socket. Its
header explains why *this* file is the entry rather than the handler: an earlier revision exported a handler while the
platform waited for a socket.

**12. `apps/api/src/lib/http.ts`** — `HttpError`, the `ok`/`page` envelopes, and the small validators. Every route
speaks through it, which is why one error handler can serve the whole API.

**13. `apps/web/src/App.tsx` (144)** — routes, error boundary, suspense. Thirteen routes plus explicit redirects for
retired URLs (`/login`, `/signin`, `/sign-in`) and a catch-all to the dashboard.

**14. `apps/web/src/lib/api.ts` (475)** — `BASE = '/api'`, `request()` with a deadline and two error classes, and the
`api.*` object of ~60 typed methods. This is the entire frontend/backend contract in one file.

**15. `scripts/embed-web-assets.mjs`** — turns `apps/web/dist` into a TypeScript module. The single most
deployment-specific file in the repository: it exists because bundlers follow imports and services cannot declare
`includeFiles`.

---

## E. Glossary

- **Runtime** — the environment code executes in after deployment (here: a Node process on Vercel). Compare **build
  time**, when `tsc`/Vite run.
- **Entrypoint** — the file the platform starts. Here `apps/api/src/entrypoints/index.ts`, which listens on `PORT`.
- **Handler** — a function bound to a method and path, e.g. the function passed to `app.post('/api/tasks', …)`.
- **Hook / middleware** — code that runs before or after a handler. Fastify calls them `onRequest` and `onResponse`.
- **API / REST** — HTTP endpoints over JSON resources; here `/api/projects`, `/api/tasks/:id`.
- **Request lifecycle** — the ordered path a request takes: router → hooks → handler → response hooks.
- **Schema** — the shape of the database: tables, columns, types, constraints.
- **Migration** — a numbered SQL file that changes the schema; applied once, recorded in `schema_migrations`.
- **Ledger** — the table that records which migrations ran, with a checksum to detect edits.
- **Primary key / foreign key** — the column that identifies a row / a column that must match a row in another table.
- **Cardinality** — how many rows relate to how many: one client → many projects.
- **Connection pool** — a fixed set of reusable database connections (`max: 10`) instead of one per request.
- **Transaction** — several statements that succeed or fail together (`tx()`).
- **Constraint** — a database rule (`NOT NULL`, `UNIQUE`, `CHECK`, `FOREIGN KEY`) that cannot be bypassed by a buggy
  handler.
- **Cron** — a scheduled trigger. Here Vercel calls `/api/cron/sweep` daily at 03:00.
- **Idempotent** — running it twice has the same effect as once; the sweep only touches already-due, still-running rows.
- **Serverless function** — code the platform starts per invocation rather than keeping a process alive. This project
  is deployed as a long-lived process (services mode), but retains a function-shaped handler in `api/index.js`.
- **Envelope** — the standard response wrapper: `{data}` or `{error:{code,message,…}}`.
- **Prepared/parameterised query** — SQL with placeholders, so input can never be treated as SQL.
- **RBAC** — role-based access control. The schema supports it; the current deployment does not enforce it.
- **Deployment Protection** — a Vercel setting that puts an SSO login in front of every deployment URL.

---

## F. What to study before the interview

Ranked by how likely it is to come up.

1. **The request path in `app.ts`.** Be able to name the five hooks and what each does without opening the file.
2. **The module-format outage.** Cause, reproduction command (`--no-experimental-require-module`), the two-part fix and
   the four regression tests. This is your strongest story; rehearse it.
3. **`createTask` end to end.** Why the column is looked up by `(board_id, key)`; why the key comes from the highest
   suffix; what the turnover checks and acceptance rows are for.
4. **The deployment build steps.** Four steps, why dev dependencies are required, why the SPA is embedded as a module
   rather than copied.
5. **The ER core.** clients → projects → tasks → turnover/acceptance, plus `sla_clocks`/`sla_timers`. Know which two
   references are intentionally not foreign keys, and why.
6. **Migrations and boot sequence.** Ledger, checksum, `SKIP_MIGRATE`, and why a bad migration blocks cold start.
7. **TanStack Query behaviour in this app.** staleTime, retry policy, invalidation keys, live polling.
8. **Pool sizing and its serverless consequence.** Why `max: 10` is wrong for many instances and what the pooled
   connection string solves.
9. **Rate limiting.** Where the counters live, what happens when instances share a database.
10. **The honest gaps.** Practise saying “no authentication, by design, here is the consequence” without hedging — it
    is the answer that proves you know the system rather than admire it.

If you have an hour left, read in this order: `app.ts` → `routes/index.ts` (the task group only) → `services/tasks.ts`
→ `db/migrate.ts` → `lib/api.ts` → `vercel.json`. That is the whole system in six files.
