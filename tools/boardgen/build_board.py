#!/usr/bin/env python3
"""
board_v4 — overview-first layout.

Frame 00 is an index: a hero card and a numbered grid of nine sections.
Frames 01-09 are those nine sections, each in the same two-column grid, carrying
the depth: real paths, real line numbers, real SQL, with plain English on top.

Run:  python3 tools/boardgen/build_board.py
"""
from __future__ import annotations
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib as L
from lib import (INK, MUTED, FAINT, BLUE, GREEN, AMBER, VIOLET, ROSE, GREY, RED,
                 WHITE, rect, txt, wrap, measure)

L.OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     '..', '..', 'docs', 'architecture'))
L.NAME = 'RELAYOS_GUIDED_TOUR'

COL_L, COL_R, CARD_W = 60, 1220, 1120


# ---------------------------------------------------------------- layout
def hero(f, title, subtitle, h=200):
    y = f.cursor
    rect(60, y, 2280, h, ('#dbeafe', '#93c5fd'), width=2, frame=f.id)
    txt(60 + (2280 - measure(title, 42, bold=True)) / 2, y + 52, [title], 42, INK, True, False, f.id)
    txt(60 + (2280 - measure(subtitle, 19)) / 2, y + 116, [subtitle], 19, MUTED, False, False, f.id)
    f.place(y + h)
    f.cursor = y + h
    return f.cursor


def tile(f, x, y, w, num, title, keywords, mono, tone, h=196):
    rect(x, y, w, h, tone, width=2, frame=f.id)
    txt(x + 28, y + 22, ['%s — %s' % (num, title)], 26, INK, True, False, f.id)
    txt(x + 28, y + 66, wrap(keywords, 17, w - 56), 17, MUTED, False, False, f.id)
    f.codebox(x + 28, y + h - 60, w - 56, [mono], f.id)
    f.place(y + h)


def header(f, num, title, subtitle):
    y = f.cursor
    txt(60, y, ['%s — %s' % (num, title)], 32, INK, True, False, f.id)
    txt(62, y + 48, wrap(subtitle, 17, 2210), 17, MUTED, False, False, f.id)
    f.place(y + 86)
    f.cursor = y + 96


def full(f, s, w=2280):
    """One wide card."""
    f.card(60, f.cursor, w, s[0], s[1], s[3], code=s[2])
    f.cursor += f.last_h + 18
    f.place(f.cursor)


def columns(f, left, right, w=CARD_W):
    """Two stacks starting at the same top; advances the frame cursor."""
    y0 = f.cursor
    b1 = y0
    for title, body, code, tone in left:
        f.card(COL_L, b1, w, title, body, tone, code=code)
        b1 += f.last_h + 18
    b2 = y0
    for title, body, code, tone in right:
        f.card(COL_R, b2, w, title, body, tone, code=code)
        b2 += f.last_h + 18
    f.cursor = max(b1 - 18, b2 - 18)
    f.place(f.cursor)


def section(title, subtitle, y):
    """A frame whose visible header is drawn by header(), not by the frame itself."""
    return L.Frame(title, subtitle, y, bare=True)


def label(f, x, s, size=19):
    txt(x, f.cursor, [s], size, INK, True, False, f.id)
    f.place(f.cursor + size * 1.25)
    f.cursor += size * 1.25 + 12


# ---------------------------------------------------------------- content
def build():
    y = 0

    # ============================================================ 00
    f = L.Frame('00 — EXECUTIVE SYSTEM OVERVIEW', '', y, bare=True)
    hero(f, '00 — EXECUTIVE SYSTEM OVERVIEW',
         'Users · Browser · Web · API · PostgreSQL · Vercel', h=176)
    hb = f.band(f.cursor + 24,
                'How to read every card: the bold heading is plain English · the grey sentence is the detail · the mono block is the exact file, line or statement. Read only the bold lines and the board still makes complete sense.',
                size=17)
    ty = f.cursor + 24 + hb + 34
    tiles = [
        ('01', 'FRONTEND', 'React · Router · Pages · Components · API client',
         'apps/web/src · 13 pages · lib/api.ts', GREEN),
        ('02', 'BACKEND', 'Entrypoint · Fastify · Routes · Validation · Logic',
         '94 handlers · routes/index.ts · 3,370 lines', AMBER),
        ('03', 'DATABASE', 'PostgreSQL · Tables · Relationships · Migrations',
         '81 live tables · 17 migrations · the real DDL', VIOLET),
        ('04', 'DEPLOYMENT', 'GitHub · Vercel services · Builds · Runtime',
         'one service "app" · embed-web-assets.mjs', ROSE),
        ('05', 'REQUEST FLOWS', 'Read project · Create task · Error handling',
         'GET :945 · POST :412 · one envelope', GREEN),
        ('06', 'BUSINESS LOGIC', 'Client journey · Projects · QA · Releases',
         '18 stages · 4-step ladder · 8 gate rules', AMBER),
        ('07', 'RELIABILITY', 'Health · Jobs · Logs · Backups · Recovery',
         '/api/live · /api/ready · daily sweep · 2 outages', VIOLET),
        ('08', 'ENGINEERING', 'Tests · CI/CD · Security · Technical debt',
         '283 tests · 10 gates · no authentication', ROSE),
    ]
    for i, (num, title, kw, mono, tone) in enumerate(tiles):
        tile(f, COL_L + (i % 2) * 1160, ty + (i // 2) * 216, CARD_W, num, title, kw, mono, tone)
    ty9 = ty + 4 * 216
    rect(60, ty9, 2280, 172, ('#f8fafc', '#cbd5e1'), width=2, frame=f.id)
    txt(88, ty9 + 22, ['09 — SOURCE-CODE MAP + EXPLANATION GUIDE'], 26, INK, True, False, f.id)
    txt(88, ty9 + 68, wrap('Where every file is · reading order for a new engineer · the thirty words you need · how to verify every claim on this board', 17, 2100), 17, MUTED, False, False, f.id)
    f.codebox(88, ty9 + 108, 1120, ['tools/boardgen/build_board.py draws this board from the repository'], f.id)
    f.place(ty9 + 172)
    f.cursor = ty9 + 172
    y = f.finish()

    # ============================================================ 01
    f = section('01 — FRONTEND',
              'React 19, thirteen screens, one API client, and a build that ships the result inside the server.', y)
    header(f, '01', 'FRONTEND',
           'What the operator actually loads: a compiled React app that talks to exactly one address, on its own origin.')
    columns(f, [
        ('One entry, one router', 'main.tsx creates a single query client and mounts the app. App.tsx owns every route, the error boundary and the suspense fallback. No second router, no state library.',
         ['apps/web/src/main.tsx', 'apps/web/src/App.tsx  ·  13 routes'], BLUE),
        ('Server state lives in one cache', 'Every request goes through TanStack Query: fifteen-second stale time, one retry and only for 5xx, no refetch on focus. A mutation invalidates the keys it touched, so a save and a list cannot disagree.',
         ['staleTime: 15_000    retry: 1 (only ≥ 500)', "invalidate(['projects','dashboard'])"], BLUE),
        ('One client, no configuration', 'The whole backend contract is one file. The base URL is the literal string /api, so the browser calls the address it was already loaded from — no hostname, no CORS rule, no per-environment variable.',
         ["const BASE = '/api'", "credentials: 'omit'"], GREEN),
        ('Two failure kinds, told apart', 'ApiError means the server answered and refused. NetworkError means it never answered. The UI shows different text for each, and the smoke suite asserts both.',
         ['class ApiError     { code, message }', 'class NetworkError { cause }'], WHITE),
    ], [
        ('Thirteen screens', 'Dashboard, Projects, Tasks, Clients, Partners, QA, Releases, Contracts, Insights, Activity, Workload, Settings, plus a catch-all. Retired URLs (/login, /sign-in) redirect rather than 404.',
         ['apps/web/src/pages/*.tsx  ·  13 files', 'removed auth screens → redirect'], GREEN),
        ('One shape for every screen', 'useQueryState normalises loading / error / empty / data, so no page invents its own spinner or its own failure text.',
         ['lib/query-state.ts', 'loading · error · empty · data'], GREEN),
        ('Live-ish updates', 'Open tabs poll /api/changes and invalidate whatever changed. Not websockets, not a queue — one endpoint that answers "what changed since X".',
         ['useLiveUpdates() → GET /api/changes', 'the same hook writes the log it reads'], VIOLET),
        ('The build', 'Vite compiles the screens to static files, and the service build turns those files into a TypeScript module so they travel inside the API (frame 04).',
         ['vite build → apps/web/dist', 'scripts/embed-web-assets.mjs → 16 assets'], AMBER),
    ])
    y = f.finish()

    # ============================================================ 02
    f = section('02 — BACKEND',
              'One Fastify application: build it once, then route, validate, apply rules, and answer in one envelope.', y)
    header(f, '02', 'BACKEND',
           'app.ts defines the request path; routes/index.ts holds every handler; services and domain hold the rules.')
    columns(f, [
        ('The request path, in order', 'Thirteen lines are the entire lifecycle. Order is the design: the error handler sits after the hooks so it can catch their failures.',
         [':54   buildApp()', ':145  helmet', ':153  cors', ':163  body limit 2 MB',
          ':191  onRequest', ':205  onResponse → RED metrics',
          ':250  onResponse → change_log', ':267  setErrorHandler',
          ':362  setNotFoundHandler', ':476  rate limits',
          ':493  operator hook → req.identity', ':530  operator routes',
          ':558  static (lazy import)'], BLUE),
        ('Layers, honestly', 'Handlers call SQL directly for reads. Services own multi-step writes and invariants. repositories/ is a mapper module, not a repository layer. No ORM, no DI, no per-resource routers.',
         ['services/tasks.ts · clocks · lifecycle · shipgate', 'domain/turnover.ts  (pure functions)',
          'repositories/query.ts  (row → object)'], WHITE),
    ], [
        ('Routing', 'Ninety-four handlers in one file, grouped by domain with blank-line sections. Every route is easy to find; the file is 3,370 lines, which is the largest single piece of debt here.',
         ['app.get / post / patch / delete', 'routes/index.ts  ·  94 handlers'], AMBER),
        ('Validation', 'Zod at the route, before any business logic; small helpers for scalars. A failure throws badRequest with the field named.',
         ['routes/index.ts:392   title: z.string().min(4)', 'lib/http.ts  requireString / optionalNumber'], AMBER),
        ('One envelope', 'ok() gives {data}, page() adds meta, and every error — 400/404/409/500 — is rendered by the same handler, so the client parses one shape.',
         ['{ data } · { data, meta } · { error }', 'setErrorHandler   app.ts:267'], VIOLET),
        ('Identity', 'One onRequest hook resolves the single operator row and caches it per instance. Every write is attributed to that user.',
         ['app.ts:493 → auth/operator-middleware.ts:68', 'resolveOperator(db) → usr_owner'], WHITE),
    ])
    y = f.finish()

    # ============================================================ 03
    f = section('03 — DATABASE',
              'PostgreSQL 16, eighty-one tables, and the constraints that make bad data impossible rather than unlikely.', y)
    header(f, '03', 'DATABASE',
           'The interesting part of a table is not its columns — it is what it refuses to store. This is the DDL that actually runs.')
    columns(f, [
        ('The table that is actually created', 'Read the constraints as sentences: rules the application cannot bypass.',
         ['-- db/migrations/pg/0002_work.sql',
          'CREATE TABLE tasks (',
          '  key        TEXT NOT NULL UNIQUE,',
          '  project_id TEXT REFERENCES projects(id)',
          '             ON DELETE CASCADE,',
          '  column_id  TEXT NOT NULL',
          '             REFERENCES columns(id),',
          '  title      TEXT NOT NULL,',
          '  status     task_status NOT NULL',
          "             CHECK (status IN ('backlog',",
          "               'todo','in_progress',",
          "               'review','blocked','done',",
          "               'cancelled')),",
          '  position   DOUBLE PRECISION DEFAULT 1000);'], AMBER),
        ('Ids and timestamps are decided in code', 'Ids are prefixed and time-sortable, so a row says what it is and roughly when. Timestamps are stored as "YYYY-MM-DD HH:MM:SS" UTC — deliberately not ISO with a T, because a space sorts before a T and mixing the two silently reorders every comparison.',
         ['id("tsk") → tsk_m3k9x1a + 8 random chars',
          'nowIso()   → 2026-11-08 09:14:02'], WHITE),
    ], [
        ('The chain that matters', 'A client has projects; a project has boards and phases; a board has columns; a column holds tasks; a task has checks. Every arrow is a real foreign key except the two below.',
         ['clients → projects → boards → columns → tasks',
          'tasks.parent_id → tasks  (self)'], VIOLET),
        ('Two references deliberately not keys', 'A deadline timer points at any entity (deal, project, task, release), so it is polymorphic by design. A QA report outlives the release it tested, so it is not deleted with it.',
         ['sla_timers: entity_type + entity_id',
          'qa_reports.release_id  (no FK)'], VIOLET),
        ('Two schema sources, one inert', 'db/postgres/schema.sql calls itself "the production system of record" and carries CHECK (length(title) >= 4). Nothing applies it: boot migrates from db/migrations/pg, and CI never runs schema.sql. The title rule is really enforced at routes/index.ts:392 and services/tasks.ts:99.',
         ['scripts/test-pg.mjs → db/cli.ts migrate',
          'db/postgres/README.md → "psql -f", by hand'], RED),
        ('Migrations', 'Seventeen numbered files, applied in order at boot, each recorded with a checksum in schema_migrations. A slow migration delays every cold start; a broken one blocks it.',
         ['0001_core … 0017_change_log',
          'ensureLedger() → schema_migrations'], AMBER),
    ])
    y = f.finish()

    # ============================================================ 04
    f = section('04 — DEPLOYMENT',
              'Push, build, migrate, listen. One service, one address, and the SPA travelling inside the API.', y)
    header(f, '04', 'DEPLOYMENT',
           'Four build steps and five runtime steps. Nothing compiles while a page is loading.')
    label(f, 60, 'Build time — once per deploy, on Vercel')
    by = f.cursor
    build_steps = [('1 · Install', 'Dev dependencies included: the build needs vite and tsc.', 'npm ci --include=dev'),
                   ('2 · Screens', 'Vite compiles React into static files.', 'npm run build:web:service'),
                   ('3 · Embed', 'Those files become one TypeScript module.', 'scripts/embed-web-assets.mjs'),
                   ('4 · Compile', 'tsc emits apps/api/dist, screens included.', 'npm run build:api')]
    hb = max(f.card_h(540, t, b, [c]) for t, b, c in build_steps)
    for i, (t, b, c) in enumerate(build_steps):
        f.card(60 + i * 580, by, 540, t, b, BLUE, code=[c], force_h=hb)
    f.cursor = by + hb + 44
    label(f, 60, 'Runtime — on every cold start')
    ry = f.cursor
    run_steps = [('1 · Settings', 'DATABASE_URL must exist. Missing → refuse to boot.', 'db/index.ts (throws)'),
                 ('2 · Pool', 'Ten reusable connections, not one per request.', 'postgres.ts: max 10'),
                 ('3 · Migrate', '17 SQL files, in order, checksummed.', 'db/migrate.ts'),
                 ('4 · Operator', 'Ensure exactly one users row exists.', 'ensureOperator()'),
                 ('5 · Listen', 'Bind PORT on 0.0.0.0 and serve.', 'entrypoints/index.ts')]
    hr = max(f.card_h(430, t, b, [c]) for t, b, c in run_steps)
    for i, (t, b, c) in enumerate(run_steps):
        f.card(60 + i * 462, ry, 430, t, b, GREEN, code=[c], force_h=hr)
    f.place(ry + hr)
    f.band(ry + hr + 30,
           'Why step 3 of the build exists: Vercel bundles what is imported, not what sits in a folder — and the services schema rejects includeFiles. So the built screens are compiled into the API as a module (16 assets) instead of copied next to it.',
           size=17)
    y = f.finish()

    # ============================================================ 05
    f = section('05 — REQUEST FLOWS',
              'A read and a write, down to the statement — plus what every failure looks like.', y)
    header(f, '05', 'REQUEST FLOWS',
           'Two journeys cover almost everything: fetching a list, and creating a record. Both are single round trips.')
    columns(f, [
        ('Read — GET /api/projects', 'One request, one query. The counts are correlated subqueries, so there is no N+1, and the mapper turns snake_case into what the screen expects.',
         ['routes/index.ts:945',
          'SELECT p.*, c.name,',
          '  (SELECT COUNT(*) FROM tasks t',
          '    WHERE t.project_id = p.id) AS task_count,',
          '  … three more counts …',
          'FROM projects p JOIN clients c ON …',
          'mapProject(row)  snake_case → camelCase',
          'reply  { data: [ … ] }'], BLUE),
        ('Write — POST /api/tasks', 'Six steps, each able to stop the write with a named reason. The column is looked up by (board_id, key), never guessed; the key comes from the highest existing suffix, not the row count.',
         ['routes/index.ts:412',
          '1  zod.safeParse(body)     → 400 + field name',
          '2  board must exist        → 400 unknown board',
          '3  SELECT id FROM columns',
          '     WHERE board_id=? AND key=?  → 400',
          '4  nextKey()  highest suffix + 1',
          '5  INSERT tasks + checklist + gates (tx)',
          '6  201 { data: taskDetail }'], GREEN),
    ], [
        ('Errors, in one table', 'The status is a fact about the request, not a mood. Every one arrives in the same envelope.',
         ['400  validation, unknown board or column',
          '404  missing record',
          '409  conflict — duplicate key, bad transition',
          '500  anything uncaught'], ROSE),
        ('What the client can rely on', 'One parser for the whole API, because there is one error renderer.',
         ['{ data: … }',
          '{ data: […], meta: { total, limit, offset } }',
          '{ error: { code, message, detail? } }'], VIOLET),
        ('Eleven steps of a save', 'click → rewrite → router → onRequest → identity → zod → service → column → key → insert → response hooks (log, metric, change_log).',
         ['app.ts:191 · :493 · :205 · :250',
          'tasks.ts:119  (column)  ·  :40  (key)  ·  :138  (insert)'], WHITE),
    ])
    y = f.finish()

    # ============================================================ 06
    f = section('06 — BUSINESS LOGIC',
              'What the domain actually enforces — and, plainly, what is only a label.', y)
    header(f, '06', 'BUSINESS LOGIC',
           'The distinction most diagrams get wrong: a corridor with locked doors is not the same thing as a signpost.')
    columns(f, [
        ('Client lifecycle, 18 stages', 'A transition that is not in the table is refused with 409. Guarded moves require evidence rows.',
         ['services/lifecycle.ts', 'STAGE_KEYS (18)  ·  TRANSITIONS'], GREEN),
        ('Acceptance ladder, 4 steps', 'dev_complete → qa_approved → lead_approved → client_accepted, unique per task and step.',
         ['services/tasks.ts:19', 'ACCEPTANCE_LADDER = […4…]'], GREEN),
        ('Turnover gates, 8 rules', 'A task cannot be called done while a gate rule is unsatisfied: description written, owner assigned, estimate set, and five more.',
         ['domain/turnover.ts:77', 'AUTO_RULES = has_description, has_assignee, …'], GREEN),
        ('Ship gate and clock sweep', 'A release cannot ship while a required QA check is open. A running timer past its due date becomes missed — daily, and on boot.',
         ['services/shipgate.ts   evaluateShipGate()',
          "services/clocks.ts   outcome='running' → missed"], GREEN),
    ], [
        ('Pipeline stages, 12', 'A deal can be PATCHed to any stage. There is no rule about which may follow which — the arrows on any diagram of it are decoration.',
         ['PIPELINE_STAGES (12)', 'PATCH /api/deals/:id → any stage'], GREY),
        ('Task status', 'Seven allowed values in a CHECK constraint. A constraint is not a state machine: any allowed value can follow any other.',
         ["status CHECK (… 'done' …)", 'no transition guard anywhere'], GREY),
        ('WIP limits', 'columns.wip_limit is stored and seeded, and nothing reads it. No column refuses a card because it is full.',
         ['grep -r wip_limit apps/api/src/services', '→ no results (seed + scaffolding only)'], GREY),
        ('Why say it out loud', 'A diagram with arrows looks enforced, and a reader will believe it. Only the left column is code that can refuse you.',
         ['An earlier version of this board', 'got exactly this wrong.'], WHITE),
    ])
    y = f.finish()

    # ============================================================ 07
    f = section('07 — RELIABILITY',
              'How it fails, how it recovers, and the two outages that shaped the code.', y)
    header(f, '07', 'RELIABILITY',
           'There is no queue and no worker. Reliability here means health endpoints, one honest sweep, and tests written after real failures.')
    columns(f, [
        ('Health, in four endpoints', 'Liveness and readiness are separate questions, and the answers are different on purpose.',
         ['/api/live     :157   process up + uptime',
          '/api/ready    :160   database reachable',
          '/api/health   :116   config (authMode, storage)',
          '/api/metrics  :224   Prometheus text'], VIOLET),
        ('The only job that exists', 'A running timer past its due date must become missed. That is one UPDATE, so it runs wherever a process is awake: the Vercel cron at 03:00, an interval every 60 s in the container, and a throttled inline sweep on the serverless path.',
         ['0 3 * * * → /api/cron/sweep   :190',
          'CRON_SECRET compared in constant time',
          '503 when the secret is unset',
          'idempotent: only rows still running'], AMBER),
        ('Backups and recovery', 'A restore drill creates a fresh database, applies a dump and reads the data back — because an untested backup is a hope, not a backup.',
         ['npm run backup:verify', 'npm run test:persistence  (restart, read)'], GREEN),
    ], [
        ('Story 1 · the database that was not there', 'An earlier revision fell back to a file database when DATABASE_URL was missing. On a serverless host that file lives in /tmp and dies with the instance — the app booted, accepted writes, read them back, and lost them. The fix was to refuse to start and name the missing setting.',
         ['db/index.ts throws → 503 + setup page',
          'lib/misconfigured.ts names the variable'], RED),
        ('Story 2 · the outage with no route to report it', '@fastify/static was imported at the top of app.ts. 10.1.4 pulled in an ESM-only dependency; on a runtime without require(esm) that threw while the module loaded, before any route existed. Every request answered boot_failed.',
         ['fix: pin 10.1.3 + import inside the branch',
          'test: 4 child-process cases with',
          '      --no-experimental-require-module'], RED),
        ('Retries, stated honestly', 'There is no retry ladder and no dead-letter queue. A failed write returns its error to the client; the client decides. Nothing retries behind your back.',
         ['✗ queue   ✗ worker   ✗ dead-letter',
          '✓ idempotent sweep   ✓ one error envelope'], GREY),
    ])
    y = f.finish()

    # ============================================================ 08
    f = section('08 — ENGINEERING',
              'Tests, CI, the security truth, and the debt — with the numbers as they are.', y)
    header(f, '08', 'ENGINEERING',
           'What "green" means, what is actually protected, and what a new engineer should know before touching it.')
    columns(f, [
        ('npm run verify — ten gates', 'One command a person runs before pushing. It stops at the first failure.',
         ['guard · typecheck · test · test:pg · build:service',
          'verify:routing · smoke:web · verify:boot',
          'test:persistence · backup:verify'], BLUE),
        ('What the numbers are', '283 tests across 24 files; 19 of them run again against a real PostgreSQL 16, because SQLite and Postgres disagree about enough to matter.',
         ['apps/api/test/*.test.mjs  ·  24 files',
          'scripts/test-pg.mjs  ·  19 PG-only'], BLUE),
        ('Why "it built" is not "it works"', 'A build can pass while the server never starts. So CI builds the way production builds, then starts the artefact and calls it.',
         ['ci.yml → single-service-build',
          'npm ci --omit=dev → build → GET /api/live'], GREEN),
        ('Four tests that exist because of an outage', 'A child process loads the server with ESM require disabled — the runtime shape that broke in July — and asserts it still boots.',
         ['module-format.test.mjs',
          'service-entry  ·  platform-launcher'], ROSE),
    ], [
        ('Security, said out loud', 'There is no authentication, and the API says so in its own response rather than leaving you to guess.',
         ['{ authMode: "none", csrfToken: null }',
          'permissions: Proxy(all → true)',
          'POST /api/auth/login → 410 Gone'], RED),
        ('What is actually protecting it', 'Platform password protection on the deployment, plus these application controls.',
         ['helmet · cors · 2 MB body · rate limits',
          'parameterised SQL · DB constraints',
          'constant-time CRON_SECRET',
          'audit_log + change_log, append-only'], GREEN),
        ('RBAC: present and idle', 'project_members, partner_iam_users and client_portal_users exist, and scope.ts can restrict by membership. With one admin operator the scope resolves to everything, so it never fires.',
         ['apps/api/src/auth/scope.ts',
          'enforcement: none   ·   403 path: none'], AMBER),
        ('The debt, ranked', 'The router file is first, then the missing per-user identity, then the dashboard aggregates computed on every request.',
         ['1  routes/index.ts  3,370 lines',
          '2  no per-user identity',
          '3  no cache tier for aggregates'], AMBER),
    ])
    y = f.finish()

    # ============================================================ 09
    f = section('09 — SOURCE-CODE MAP + EXPLANATION GUIDE',
              'Where everything is, what to read first, and the vocabulary to read it with.', y)
    header(f, '09', 'SOURCE-CODE MAP + EXPLANATION GUIDE',
           'If you only have ten minutes: read the map on the left, then follow the reading order on the right.')
    columns(f, [
        ('The map', 'Six folders hold everything. Learn these and you can find any behaviour in the system.',
         ['apps/web/src        screens · 13 pages · lib/api.ts',
          'apps/api/src        server · app.ts 636 · routes 3,370',
          '  services/ domain/  rules: lifecycle, gates, clocks',
          '  db/                pool · migrations · dialect',
          'db/migrations/pg/   17 numbered SQL files',
          'scripts/            build, guards, smoke, backup',
          'apps/api/test/       24 test files, 283 tests'], VIOLET),
        ('How to verify every claim', 'Every statement on this board has a command or a file behind it. In a fresh clone:',
         ['npm ci --include=dev',
          'npm run verify        # all ten gates',
          'npm run test:pg       # needs a real PostgreSQL',
          'npm run build:service && node apps/api/dist/index.js',
          'grep -n "ACCEPTANCE_LADDER" apps/api/src/services/tasks.ts'], BLUE),
        ('The words you need', 'Twenty terms, each in one line, all of them used on this board.',
         ['handler · hook · route · envelope',
          'migration · ledger · constraint · FK/PK',
          'pool · transaction · cron · idempotent',
          'serverless · ORM · RBAC · CORS',
          'rate limit · embedded SPA · cold start'], GREY),
    ], [
        ('Reading order for a new engineer', 'Six files, in this order, is the whole system: how it starts, how it routes, how it writes, how it migrates, how the screen calls it, how it deploys.',
         ['1  apps/api/src/app.ts',
          '2  routes/index.ts  (the tasks group only)',
          '3  services/tasks.ts',
          '4  db/migrate.ts',
          '5  apps/web/src/lib/api.ts',
          '6  vercel.json'], WHITE),
        ('What is deliberately not claimed', 'Three things could not be observed from outside the deployment, so they are asserted nowhere on this board.',
         ['1  the exact Vercel runtime version',
          '2  the production environment variables',
          '3  the running function — the URL answers',
          '   302 → vercel.com/login (Deployment Protection)'], GREY),
        ('If you remember one thing', 'One program, one database, and the rules that matter enforced by the database itself — so it stays small, and it is hard to break.',
         ['94 endpoints · 81 tables · 283 tests · 0 logins'],
         ('#f0f9ff', '#0284c7')),
    ])
    y = f.finish(gap=20)


if __name__ == '__main__':
    build()
    probs = L.validate()
    n = {k: sum(1 for e in L._el if e['type'] == k) for k in ('frame', 'rectangle', 'text', 'arrow')}
    print(f"elements {len(L._el)}  frames {n['frame']}  rect {n['rectangle']}  text {n['text']}  arrow {n['arrow']}")
    print('problems:', len(probs))
    for p in probs[:25]:
        print('  -', p)
    print(L.export_excalidraw())
    print(L.export_svg())
    print(L.export_png())
    sys.exit(1 if probs else 0)
