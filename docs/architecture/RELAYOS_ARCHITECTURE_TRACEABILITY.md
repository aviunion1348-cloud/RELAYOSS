# RelayOS — architecture traceability

**Inspected commit:** `ad79aa1b201b68ba42445a0f830614085c2e3cb6`
(`Merge pull request #19 …`, `main`, 9 Nov 2026)
**Board:** `docs/architecture/RELAYOS_SYSTEM_ARCHITECTURE.excalidraw`
**Rule applied:** where a document and the code disagree, the code wins. No source file was changed to make the diagram true.

Read `Implementation status` as:

| Tag | Meaning |
| --- | --- |
| `implemented` | Present in code and exercised by tests or a real run |
| `implemented (data only)` | Rows and endpoints exist; no external effect happens |
| `conditional` | Present but only on one path (dev/container, or when a directory exists) |
| `absent` | Deliberately not built |
| `unverified` | Exists, but its behaviour could not be observed (platform-side) |

---

## 1. Frame 00 — architecture overview

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| Single Vercel service `app` | `vercel.json` | `services.app` | implemented | one service, `root: "."`, `framework: "fastify"`, rewrite `/(.*)` → service `app` |
| API process | `apps/api/src/app.ts` | `buildApp()` (line 54) | implemented | returns `{ app, db }`; `Fastify({…})` at line 123 |
| SPA served as bytes by the API | `apps/api/src/lib/embedded-web.ts` | `embeddedIndex`, `embeddedFile`, `hasEmbeddedSpa` | implemented | generated module `apps/api/src/generated/web-assets.ts` (16 assets after `build:service`) |
| `@fastify/static` path | `apps/api/src/app.ts` lines 558–570 | dynamic `import('@fastify/static')` | conditional | only when `serveStatic && webDist`; pinned `10.1.3` |
| PostgreSQL 16 | `apps/api/src/db/postgres.ts` | `PostgresDb` | implemented | `pg.Pool({ max: 10, idleTimeoutMillis: 30_000 })` lines 32–36 |
| Vercel Cron | `vercel.json` + `apps/api/src/routes/index.ts:190` | `GET /api/cron/sweep` | implemented | `"schedule": "0 3 * * *"`, bearer `CRON_SECRET`, timing-safe compare |
| In-process sweeper | `apps/api/src/index.ts:21` | `setInterval(sweepTimers, SWEEP_INTERVAL_MS)` | conditional | container entry only; not started by the serverless handler |
| “No queue / no cache / no auth” | — | — | absent | no broker, cache or session dependency in any `package.json`; `argon2` is declared but unused (see §14) |

## 2. Frame 01 — deployment

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| install command | `vercel.json` | `installCommand` | implemented | `npm ci --include=dev --no-audit --no-fund` |
| build command | `vercel.json` → `package.json` | `buildCommand` = `npm run build:service` | implemented | runs `build:web:service` then `build:api` |
| web install | `package.json` | `install:web` | implemented | `npm ci --prefix apps/web --include=dev --no-audit --no-fund` |
| web build | `apps/web/package.json` → Vite | `vite build` | implemented | emits `apps/web/dist` (13 asset chunks observed) |
| SPA embedding | `scripts/embed-web-assets.mjs` | `embed-web-assets.mjs` (no `--stub`) | implemented | writes `apps/api/src/generated/web-assets.ts`; count 16 |
| API compile | `apps/api/tsconfig.json` | `tsc -p .` | implemented | emits `apps/api/dist/{app.js,entrypoints,db}` |
| deployed entrypoint | `apps/api/src/entrypoints/index.ts` | default export / `PORT` | implemented | `vercel.json` names this file; it owns the listening socket |
| function-shaped handler | `api/index.js` → `apps/api/src/entrypoints/vercel.ts` | `handler(req,res)`, `getApp()`, `maybeSweep()` | conditional | retained for a function deployment and for tests |
| rewrite | `vercel.json` | `rewrites[0]` | implemented | `/(.*)` → `{ service: "app" }` |
| build-time vs runtime split | `apps/api/src/db/migrate.ts:131` | `migrate()` on boot | implemented | `SKIP_MIGRATE=1` disables; `ensureOperator` runs after |
| environment variables | `apps/api/src/config.ts` | `config` (Proxy) | implemented | `DATABASE_URL`, `CRON_SECRET`, `PORT`, `HOST`, `LOG_LEVEL`, `WEB_DIST`, `OPERATOR_USER_ID`, `RATE_LIMIT_*`, `SWEEP_INTERVAL_MS`, `DB_PATH` (dev), `CORS_ORIGIN`, `INTERNAL_ERROR_DETAIL` |
| Deployment Protection caveat | Vercel project settings (external) | — | unverified | every deployment URL answers `302 → vercel.com/login`; runtime unobservable from outside the account |

## 3. Frame 02 — frontend

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| React root | `apps/web/src/main.tsx` | `createRoot`, `QueryClientProvider`, `BrowserRouter` | implemented | `staleTime: 15_000`, retry only for ≥500 |
| app shell + routes | `apps/web/src/App.tsx` | `<Routes>`, `ErrorBoundary`, `Suspense` | implemented | 13 real routes; `/login`, `/signin`, `/sign-in` → `<Navigate to="/">`; `*` → dashboard |
| navigation | `apps/web/src/components/Shell.tsx` | `navItems` (lines 20–41) | implemented | Command Deck, Board, Pipeline, Turnover Clocks, Projects, Planning, QA, Releases, Clients, Partners, Intelligence, Knowledge |
| API client | `apps/web/src/lib/api.ts` | `BASE = '/api'` (line 7), `request()` (85), `api` (348) | implemented | relative base, `credentials: 'omit'` (line 146), per-call deadline via `AbortSignal` |
| error classes | `apps/web/src/lib/api.ts` | `ApiError` (29), `NetworkError` (50) | implemented | distinguish “API said no” from “API never answered” |
| query state | `apps/web/src/lib/query-state.ts` | `useQueryState` (52), `useMutationFailure` (91) | implemented | loading / error / empty / data branches |
| live updates | `apps/web/src/lib/live.ts` | `useLiveUpdates` (69) | implemented | polls `/api/changes`, invalidates query keys |
| failure UI | `apps/web/src/components/ApiFailure.tsx`, `QueryFailure.tsx`, `ErrorBoundary.tsx` | — | implemented | rendered by `scripts/smoke-web.mjs` assertions |

## 4. Frame 03 — backend

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| entrypoint | `apps/api/src/entrypoints/index.ts` | `createServer` handler | implemented | drives `app.server.emit('request')` |
| plugins | `apps/api/src/app.ts:145,153` | `@fastify/helmet`, `@fastify/cors` | implemented | CSP and COEP disabled deliberately |
| body parsers | `apps/api/src/app.ts:163,180` | `addContentTypeParser` | implemented | JSON parsed as string (2 MB limit), `*` lenient |
| request log + metrics | `apps/api/src/app.ts:205` | `onResponse` hook | implemented | `routeTemplate()`, never the raw URL |
| change feed hook | `apps/api/src/app.ts:250` | `onResponse` write hook | implemented | one `INSERT INTO change_log` per successful mutation |
| error handler | `apps/api/src/app.ts:267` | `setErrorHandler` | implemented | maps `HttpError`, hides internals unless `INTERNAL_ERROR_DETAIL=1` |
| not found | `apps/api/src/app.ts:362` | `setNotFoundHandler` | implemented | JSON 404 for `/api/*`, SPA document otherwise |
| identity hook | `apps/api/src/app.ts:493` | `onRequest` operator resolution | implemented | `auth/operator-middleware.ts:68` |
| route module | `apps/api/src/routes/index.ts` | ~100 handlers, 3 370 lines | implemented | grouped in frame 03 |
| validation | `apps/api/src/routes/index.ts` | `zod` schemas per write route | implemented | e.g. `createSchema.safeParse` in `POST /api/tasks` (line 412) |
| response envelope | `apps/api/src/lib/http.ts` | `ok()`, `page()`, `HttpError` | implemented | `{ data }` / `{ data, meta }` / `{ error: { code, message, … } }` |
| business rules | `apps/api/src/services/*.ts`, `apps/api/src/domain/**/*.ts` | see frames 06/12 | implemented | `tasks.ts`, `clocks.ts`, `lifecycle.ts`, `shipgate.ts`, `partners.ts`, `legal.ts`, `communications.ts`; `turnover.ts`, `planner.ts`, `risk.ts` |
| data access | `apps/api/src/db/index.ts` | `getDb`, `createDb`, `setDb` | implemented | PostgreSQL by `DATABASE_URL`; SQLite only when explicitly asked for |
| dialect layer | `apps/api/src/db/sql.ts` | `Dialect`, `translate`, `upsertInto`, `placeholderCount` | implemented | `?` → `$n` for PostgreSQL |
| row mappers (not a repository layer) | `apps/api/src/repositories/query.ts` | `TASK_SELECT`, `mapTask`, `mapProject`, `mapClient`, `mapDeal` | implemented | pure mapping functions; handlers still call SQL directly |

### Route inventory (exact paths, from `apps/api/src/routes/index.ts`)

| Group | Routes | Lines |
| --- | --- | --- |
| Ops | `GET /api/health`, `/api/live`, `/api/ready`, `/api/cron/sweep`, `/api/metrics`, `/api/meta`, `/api/users` | 116–310 |
| Tasks | `GET /api/tasks`, `/api/tasks/:id`, `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`, `POST …/comments`, `POST …/checklist`, `PATCH …/checklist/:itemId`, `PATCH …/turnover/:gateId`, `POST …/acceptance` | 317–596 |
| Planning | `GET /api/planner`, `POST /api/planner/runs` | 596–674 |
| Clocks | `GET /api/clocks`, `POST /api/clocks/sweep`, `POST /api/clocks/timers/:id/resolve`, `…/acknowledge`, `GET …/history`, `POST …/pause`, `…/resume` | 674–900 |
| Projects | `POST /api/projects`, `DELETE /api/projects/:id`, `GET /api/projects`, `GET /api/projects/:id`, `PATCH /api/projects/:id/phases/:phaseRowId` | 861–1117 |
| Pipeline | `GET /api/pipeline`, `PATCH /api/deals/:id`, `POST /api/deals`, `DELETE /api/deals/:id` | 1117–1331 |
| Clients | `POST /api/clients`, `PATCH /api/clients/:id`, `DELETE /api/clients/:id`, `GET /api/clients` | 1331–1486 |
| Partners | `GET /api/partners`, `POST /api/partners`, `DELETE /api/partners/:id`, `GET …/entitlements`, `GET/POST …/devices`, `PATCH /api/partners/:id`, `POST …/devices/:deviceId/activate`, `…/revoke`, `POST …/usage` | 1486–1800 |
| QA | `GET /api/qa`, `POST /api/qa`, `PATCH /api/qa/:id` | 1800–1871 |
| Releases | `GET /api/releases/:id/gate`, `PATCH /api/releases/:id`, `POST …/acknowledgements`, `POST /api/releases`, `DELETE /api/releases/:id`, `GET /api/releases` | 1975–2176 |
| Read models | `GET /api/dashboard`, `/api/activity`, `/api/notifications`, `POST …/read`, `GET /api/insights`, `POST/DELETE /api/insights/:key/dismiss`, `GET /api/changes`, `/api/audit`, `/api/search`, `/api/search/suggest` | 2204–2763 |
| Lifecycle | `GET /api/clients/:id/lifecycle`, `POST …/:stageKey/transitions`, `…/evidence`, `GET /api/lifecycle` | 2808–2860 |
| Comms | `GET /api/comms/providers`, `GET /api/comms`, `GET/POST /api/comms/threads`, `POST …/messages`, `POST /api/comms/follow-ups`, `POST /api/meetings` | 2923–3017 |
| Legal | `GET /api/legal/esign`, `GET /api/legal`, `GET /api/legal/:id`, `POST /api/legal`, `POST …/signatories`, `…/decision`, `…/status`, `…/upload`, `POST /api/change-requests`, `…/decision` | 3055–3196 |
| Knowledge | `GET /api/docs`, `POST /api/docs`, `PATCH /api/docs/:id`, `DELETE /api/docs/:id` | 3213–3354 |
| Identity (retired) | `GET /api/auth/session`; `POST /api/auth/login`, `/api/auth/dev-login`, `/api/auth/logout` → **410** | `routes/operator.ts:32,61` |

## 5. Frame 04 — database

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| 17 migrations | `db/migrations/pg/0001…0017_*.sql` | — | implemented | `npm run db:migrate` → “✓ applied 0017”; ledger in `schema_migrations` |
| 81 tables | `db/migrations/pg/*.sql` | — | implemented | backup drill reports 81 tables; 83 `CREATE TABLE` statements including the `*_new` rebuilds in 0010/0014 |
| `clients` | `0001_core.sql` | table | implemented | PK `id`, `slug UNIQUE`, CHECKs on `tier`/`health` |
| `projects` | `0001_core.sql` | table | implemented | `client_id → clients ON DELETE RESTRICT`, `deal_id → deals SET NULL`, `key UNIQUE` |
| `users` | `0001_core.sql` | table | implemented | `email UNIQUE`, CHECK on `role` |
| `tasks` | `0002_work.sql` | table | implemented | `project_id → projects CASCADE`, `board_id → boards CASCADE`, `column_id → columns`, `parent_id → tasks`, `key UNIQUE` |
| `boards` / `columns` | `0002_work.sql` | tables | implemented | `columns UNIQUE (board_id, key)` — the constraint `createTask` relies on |
| `turnover_gates` / `turnover_checks` | `0002_work.sql` | tables | implemented | `checks.gate_id → gates CASCADE`, CHECK one of task/phase |
| `releases` | `0004_delivery_os.sql` | table | implemented | `project_id → projects CASCADE`, status CHECK (7 states) |
| `qa_reports` | `0004_delivery_os.sql` | table | implemented | `project_id → projects CASCADE`, `task_id → tasks SET NULL`, `release_id` TEXT **without** FK |
| `sla_clocks` / `sla_timers` | `0004_delivery_os.sql` (+ `0010`) | tables | implemented | `clock_key → sla_clocks(key)`; `entity_type`+`entity_id` polymorphic, no FK |
| `acceptance_records` | `0004_delivery_os.sql` | table | implemented | `UNIQUE (task_id, step)` |
| `project_phases` / `milestones` | `0001_core.sql` | tables | implemented | `UNIQUE (project_id, phase_id)` |
| `partners` | `0004_delivery_os.sql` | table | implemented | `client_id → clients CASCADE`, `slug UNIQUE` |
| `deals` / `pipeline_stages` | `0001_core.sql` | tables | implemented | `stage_id → pipeline_stages NOT NULL`, `client_id → clients RESTRICT` |
| `audit_log` | `0003_intel.sql` | table | implemented | identity PK, `before_json`/`after_json`, no FKs |
| `change_log` | `0017_change_log.sql` | table | implemented | identity PK, written by one hook |
| Cross-column arrows (users→tasks, tasks→turnover_checks, deals→projects) | `0002_work.sql` | FKs | implemented | `tasks.assignee_id → users`, `turnover_checks.task_id → tasks`, `projects.deal_id → deals` |

## 6. Frame 05 — request lifecycle

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| `GET /api/projects` | `apps/api/src/routes/index.ts:945` | handler | implemented | joins `clients`, `users`, 4 correlated subqueries; `mapProject`; `ok(rows)` |
| read path frontend | `apps/web/src/pages/Projects.tsx` | `useQuery(['projects'], api.projects)` | implemented | line 43 |
| `POST /api/tasks` | `apps/api/src/routes/index.ts:412` | handler | implemented | zod `createSchema` → `badRequest` with issues |
| task creation rules | `apps/api/src/services/tasks.ts:98` | `createTask()` | implemented | title ≥ 4; board must exist; column resolved by `(board_id, key)` |
| task key | `apps/api/src/services/tasks.ts:22` | `nextKey()` | implemented | highest existing suffix + 1, not the row count |
| success response | `apps/api/src/routes/index.ts:412` | `reply.code(201)` + `ok(taskDetail(...))` | implemented | full joined task |
| cache invalidation | `apps/web/src/pages/Projects.tsx:64-65` | `invalidateQueries` | implemented | `['projects']`, `['dashboard']` |

## 7. Frame 06 — business domain

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| 12 pipeline stages | `apps/api/src/db/scaffolding.ts:47` | `PIPELINE_STAGES` | implemented | seeded only when `pipeline_stages` is empty |
| pipeline transition guard | — | — | absent | stage changes are a plain `PATCH /api/deals/:id`; no server-side order rule |
| 18 lifecycle stages | `apps/api/src/services/lifecycle.ts:57` | `STAGE_KEYS` | implemented | — |
| lifecycle transitions | `apps/api/src/services/lifecycle.ts:66` | `TRANSITIONS`, `transition()` | implemented | absent transitions are refused; prerequisites checked |
| acceptance ladder | `apps/api/src/services/tasks.ts:19` | `ACCEPTANCE_LADDER` | implemented | 4 steps, index checked before write |
| turnover rules | `apps/api/src/domain/turnover.ts:77` | `AUTO_RULES` | implemented | 8 rules incl. `review_approved`, `tests_recorded`, `client_signoff` |
| ship gate | `apps/api/src/services/shipgate.ts` | `evaluateShipGate`, `markShipped` | implemented | refuses while a required check is open |
| SLA clocks | `apps/api/src/services/clocks.ts` | `startTimer`, `sweepTimers`, `pauseTimerFor`, `resolveTimer` | implemented | outcomes `running/met/missed/paused/waived` |

## 8. Frame 07 — background work

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| Vercel cron trigger | `vercel.json` | `crons[0]` | implemented | `0 3 * * *` → `/api/cron/sweep` |
| cron authorisation | `apps/api/src/routes/index.ts:190` | `crypto.timingSafeEqual` | implemented | 503 when `CRON_SECRET` unset, 401 on mismatch |
| interval sweeper | `apps/api/src/index.ts:21` | `setInterval` | conditional | container path only |
| inline sweep | `apps/api/src/entrypoints/vercel.ts` | `maybeSweep()` | implemented | throttle `SWEEP_THROTTLE_MS` (60 s) |
| sweep semantics | `apps/api/src/services/clocks.ts` | `sweepTimers()` | implemented | only `outcome='running' AND due_at <= now` → `missed` |
| change feed writer | `apps/api/src/app.ts:250` | `onResponse` hook | implemented | excludes `/api/cron/*` and non-2xx |
| queue / worker / scheduler table | — | — | absent | no broker dependency, no job table |

## 9. Frame 08 — security

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| authentication | — | — | absent | no session middleware mounted; `buildApp` comment states it |
| identity for attribution | `apps/api/src/auth/operator-middleware.ts:68` | `resolveOperator()` | implemented | resolves `usr_owner`, cached per instance |
| retired endpoints | `apps/api/src/routes/operator.ts:61` | 410 handlers | implemented | `/api/auth/login`, `/dev-login`, `/logout` |
| session description | `apps/api/src/routes/operator.ts:32` | `GET /api/auth/session` | implemented | `authMode: 'none'`, `permissions` Proxy returning true |
| read scope machinery | `apps/api/src/auth/scope.ts:46` | `resolveReadScope()` | implemented | admin/lead unrestricted; partner and client scopes resolved from join tables |
| project access check | `apps/api/src/auth/middleware.ts` | `requireProjectAccess()` | implemented | called by mutating task/project routes |
| rate limiting | `apps/api/src/lib/rate-limit.ts`; `config.ts:78` | `RateLimiter`, budgets 1200/30/240 per minute | implemented | per IP, `trustProxy: true` |
| shared limiter store | `db/migrations/pg/0015_db_rate_limits.sql` | `rate_limit_counters` | conditional | used when the database is shared |
| SQL safety | `apps/api/src/db/sql.ts` + handlers | parameterised statements | implemented | placeholders only; guarded by `scripts/guard-sql-portability.mjs` |
| CSRF | — | — | absent | no cookie is ever sent (`credentials: 'omit'`) |
| secrets | `apps/api/src/config.ts` | `process.env` at access time | implemented | no secret in the repository; CI secret scan |
| audit trail coverage | `apps/api/src/routes/index.ts` | 5 `INSERT INTO audit_log` sites | partial | the complete record of mutations is `change_log`, which has no content |

## 10. Frame 09 — failure handling

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| boot failure record | `apps/api/src/lib/misconfigured.ts` | `recordBootFailure`, `bootFailureBody` | implemented | 503 JSON under `/api`, setup page for a browser |
| no-database refusal | `apps/api/src/db/index.ts` | `getDb()` | implemented | serving runtime without `DATABASE_URL` throws instead of writing a file |
| error envelope | `apps/api/src/app.ts:267` | `setErrorHandler` | implemented | same shape for 400/404/409/500 |
| 404 behaviour | `apps/api/src/app.ts:362` | `setNotFoundHandler` | implemented | JSON for `/api/*`, SPA otherwise |
| module-load hardening | `apps/api/src/app.ts:558`; `apps/api/src/db/index.ts` `loadSqlite()` | lazy `import()` | implemented | regression test `apps/api/test/module-format.test.mjs` (4 tests) |
| health endpoints | `apps/api/src/routes/index.ts:116,157,160` | `/api/health`, `/api/live`, `/api/ready` | implemented | readiness reports `engine: 'postgres'` |
| metrics | `apps/api/src/lib/metrics.ts`; `routes/index.ts:224` | `renderMetrics` | implemented | Prometheus text; business gauges computed on scrape |
| transactions | `apps/api/src/db/postgres.ts` | `tx<T>()` | implemented | one client held, rollback on throw |
| migrations | `apps/api/src/db/migrate.ts:86,131` | `ensureLedger`, `migrate` | implemented | checksum per file; applied on boot unless `SKIP_MIGRATE=1` |
| backups | `scripts/backup.mjs` | `backup`, `drill` | implemented | drill compares 81 tables and every row (last run: 2330 rows) |
| retries | — | — | absent (server) | client retries once, only for ≥500 |

## 11. Frame 10 — testing and CI

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| local gate | `package.json` | `verify` | implemented | guard → typecheck → test → test:pg → build:service → verify:routing → smoke:web → verify:boot → test:persistence → backup:verify |
| API tests | `apps/api/test/*.test.mjs` (24 files) | `node:test` | implemented | 283 tests, 0 failures, 2 PG-only skips in SQLite mode |
| PostgreSQL conformance | `scripts/test-pg.mjs` | embedded PostgreSQL 16 | implemented | 19 tests against a real cluster |
| screen smoke | `scripts/smoke-web.mjs` | server render per screen | implemented | asserts real data and every failure branch |
| routing checks | `scripts/verify-web-routing.mjs` | — | implemented | deep links, asset bytes, JSON 404 for `/api` |
| production boot | `scripts/production-boot.mjs` | — | implemented | boots `dist` with no auth environment |
| restart persistence | `scripts/persistence-restart.mjs` | — | implemented | write → restart → read back |
| deployment shape | `apps/api/test/deployment-layout.test.mjs`, `service-entry.test.mjs`, `platform-launcher.test.mjs` | — | implemented | dist-only boot, spawned entry, socket |
| dependency module format | `apps/api/test/module-format.test.mjs` | 4 tests | implemented | child process with `--no-experimental-require-module` |
| CI workflows | `.github/workflows/ci.yml`, `backup.yml` | jobs `verify`, `single-service-build`, `node-24 compatibility`, traceability | implemented | all green on `ad79aa1` |
| browser e2e | `scripts/e2e-browser.mjs`, CI “Install headless Chromium” step | Playwright | implemented (CI only) | not run in this sandbox |

## 12. Frame 11 — technology

| Diagram component | Source path | Symbol | Status | Evidence |
| --- | --- | --- | --- | --- |
| Runtime/engines | `package.json` | `engines.node` | implemented | `>=22.18.0 <25`; guard asserts the range |
| Fastify 5 | `apps/api/package.json` | `fastify ^5.12.8` | implemented | router, hooks, lifecycle |
| pg 8 | `apps/api/package.json` | `pg ^8.23.1` | implemented | pool in `db/postgres.ts` |
| zod 4 | `apps/api/package.json` | `zod ^4.6.7` | implemented | request bodies in `routes/index.ts` |
| `@fastify/static` | `apps/api/package.json` | `"10.1.3"` exact | implemented | pin + lazy import; see PR #19 |
| React 19 / router 7 / Query 5 / Vite 7 | `apps/web/package.json` | — | implemented | — |
| recharts / lucide-react | `apps/web/package.json` | — | implemented | charts and icons |
| node:sqlite | `apps/api/src/db/sqlite.ts` | `SqliteDb` | conditional | dev/tests only, lazily imported |
| node:test | `package.json` | `npm test` | implemented | no other runner for the API |
| embedded-postgres | `package.json` (dev) | `scripts/pg-dev.mjs` | implemented | real PG 16 for tests |
| Docker | `Dockerfile`, `docker-compose.yml` | — | implemented (CI only) | built and started on the runner |
| argon2 | `apps/api/package.json` | declared, unimported | unused | `grep -rn argon2 apps/api/src` → no hits |

## 13. Frame 12 — source map

Every path in frame 12 was listed from the working tree at the inspected commit
(`find apps/api/src apps/web/src db/migrations/pg scripts`), and each description matches the file's
leading comment or its exports. No entry names a file that does not exist.

## 14. Frame 13 — gaps

| Claim on the board | Evidence |
| --- | --- |
| No authentication | `apps/api/src/app.ts:54-140` — the auth block is removed and explained; `routes/operator.ts` returns 410 |
| Single identity | `auth/operator-middleware.ts:68` resolves `OPERATOR_USER_ID` (default `usr_owner`); `/api/auth/session` reports it |
| RBAC unused in practice | tables exist (`0006_auth_identity.sql`), `scope.ts:46` can enforce, but the operator is `admin`, so scope is unrestricted |
| Comms is data only | `services/communications.ts:41` `providerStatuses()` reads env and reports; no send call exists |
| E-sign is status only | `services/legal.ts:36` `esignStatus()`; `POST …/signatories/:id/decision` records a decision, no provider call |
| Renewals not scheduled | `legal_documents.renewal_notice_days` has no reader outside the API response |
| `argon2` unused | `grep -rn "argon2" apps/api/src` → nothing |
| `routes/index.ts` size | 3 370 lines (`wc -l`) |
| Audit coverage partial | 5 `INSERT INTO audit_log` sites vs 1 generic `change_log` hook |
| `*_new` tables are rebuilds | `0010_clock_pause.sql`, `0014_password_login.sql`: create `*_new`, copy, drop, rename |
| No web unit tests | no test file under `apps/web`; coverage comes from `scripts/smoke-web.mjs` and CI e2e |
| Vercel runtime unverified | deployment URLs answer `302 → vercel.com/login` (Deployment Protection) |

---

### How to re-run the evidence

```bash
git rev-parse HEAD
npm ls @fastify/static content-disposition fastify
node --test apps/api/test/module-format.test.mjs
npm run guard && npm run typecheck && npm test
npm run test:pg                 # real PostgreSQL 16
npm run verify                  # the whole gate, in the documented order
grep -c "CREATE TABLE" db/migrations/pg/*.sql | tail -1
grep -n "app\.\(get\|post\|patch\|delete\)('/api" apps/api/src/routes/index.ts | wc -l
```
