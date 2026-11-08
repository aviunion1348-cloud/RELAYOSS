# Relay OSS — Delivery OS

The internal operating system for an engineering studio that runs client work
from the **first technical consultation** to **post-launch support**: a revenue
pipeline, an agile delivery board, turnover gates that actually block shipping,
operational clocks that measure every promise, a QA centre, a partner console,
and an explainable planning engine.

Built as a real product, not a demo: relational schema with versioned
migrations, server-enforced governance, an audited API, tests, CI and a
production image.

---

## Quick start

```bash
npm install
npm run db:reset     # migrate + seed a realistic studio (89 tasks, 6 projects, 12 deals)
npm run dev          # API :4000 + SPA :5173
```

Open <http://localhost:5173>. No database server, no Docker, no `.env` needed.

Production-style (single origin, SPA served by the API):

```bash
npm run build && npm start     # http://localhost:4000
```

Docker:

```bash
docker compose up --build      # app on :4000, Postgres 16 alongside
```

---

## Why the `db.json` is gone

There is no JSON file pretending to be a database, and a CI guard enforces that
(`npm run guard`). What replaced it:

| Layer | Implementation |
| --- | --- |
| Schema | 5 forward-only SQL migrations, checksum-pinned ledger (`db/migrations`) |
| Production schema | PostgreSQL 16 with native enums, JSONB, partial indexes, triggers (`db/postgres/schema.sql`) |
| Access | Repository/service boundary — no driver imports outside `apps/api/src/db` |
| Transactions | `db.tx()` with `BEGIN IMMEDIATE`, joinable nesting |
| Integrity | FKs enforced, CHECK constraints, append-only `audit_log` |
| Governance | Turnover gates + acceptance ladder enforced in the service layer *and* the Postgres schema |
| Migrations | Auto-applied on boot, or `SKIP_MIGRATE=1` + a migration job |

---

## The model that matches the board

### 1. Revenue pipeline — consultation to kickoff

Twelve data-driven stages, each carrying its own entry criteria, exit criteria
and SLA: **Inbound → Triage → Technical Consultation → Scope & Architecture →
Proposal → Contract → Kickoff → In Delivery → Handover → Retainer → Expansion**
(plus `Closed / Parked` for win-loss analysis).

A deal is not just money: it has phase runs (`deal_phase_runs`) so the
consultation, architecture and kickoff are tracked as real work with real
turnaround.

### 2. Projects and the phase spine

Six phases with turnover policies attached as data: *Technical Consultation →
Solution Architecture → Product Design → Implementation → QA & Hardening →
Launch & Observability → Handover → Growth*. A phase cannot close without its
gate checks, a named sign-off and (for client-facing phases) the Excaliboard
artefact.

### 3. Board with real governance

Six columns (Backlog, Ready, In Progress, In Review, Blocked, Shipped) with WIP
limits. Dragging a card is a UI gesture; **the state change is a server
decision**:

- `done` requires every required turnover check to be `pass`/`waived`
  **and** the acceptance ladder to reach `qa_approved` + (`lead_approved` |
  `client_accepted` for client-visible work).
- A required gate cannot be passed without written evidence.
- Only `admin`/`lead` may waive a gate, and the waiver is audited.
- A task cannot become `blocked` without a reason of at least 8 characters.
- If no gate policy exists, turnover **fails closed** — the system never
  certifies work it cannot check.

### 4. Acceptance ladder (dev ≠ shipped)

```
dev_complete → qa_approved → lead_approved → client_accepted
```

Climbable only in order, each step recording actor, evidence and timestamp.
This is the distinction the delivery board insisted on: *a task marked complete
is not a feature accepted for turnover.*

### 5. Operational clocks

Every commitment from the board is a policy row with a hard target, an amber
warning and an aggressive stretch goal:

| Clock | Target | Note |
| --- | --- | --- |
| Consultation → implementation plan | 72h | 3 days maximum |
| Plan revision after major change | 32h | 12–32h window, 12h stretch |
| Module turnover | 24h | a module never sits in review > 1 day |
| Milestone turnover | 7d | includes QA evidence |
| Client turnover | 336h (≤2w) | 1 week internal target |
| First demo | 336h (≤2w) | from kickoff — no exceptions |
| Ship after demo approval | 120h (≤5d) | once approved |
| QA report turnover | 12h | bug/testing reports |
| Executive shipping summary | 96h | ≥2 days before ship |
| Lead triage of inbound | 24h | qualify or decline |

Timers can be met, missed, paused or waived — a waiver requires a written
exception. A background sweeper converts every overdue clock into a missed
record plus an activity entry, so nothing slips silently.

### 6. QA centre and the 3,500-edge-case ship gate

Reports are severity-ranked, evidence-linked and have a 12-hour clock. The ship
gate is five conditions per project: 3,500 edge cases catalogued, 90% verified,
no open P0/P1, an executive summary on file, and recorded client acceptance.

### 7. Partner console

Per-partner IAM users, device licences, API quota, seat limits, usage metering
and uptime — with the enforcement policy documented and limits that fail closed.

### 8. Intelligence (explainable, not magical)

- **Risk score**: weighted additive model over priority, overdue pressure,
  blockers, failed turnover, owner overload, dependency chain, estimate burn,
  staleness and client visibility. Returns the factors that produced the number.
- **Planner**: critical-path total float (forward + backward pass, cycle-safe) →
  WSPT ordering → calendar packing against real capacity. Every placement
  carries a rationale string.
- **Insights**: rule-based detectors for bottlenecks, reviewer concentration,
  estimate drift, stale WIP, recurring gate failures and client-facing risk.

No LLM sits in the decision path. Every number is reproducible from the
database, which matters when the system decides what a human works on next.

---

## Architecture

```
relay-oss/
├── apps/
│   ├── api/                     Fastify 5 · TypeScript (native type stripping)
│   │   └── src/
│   │       ├── app.ts           app factory (testable, port-free)
│   │       ├── index.ts         bootstrap + background sweeper
│   │       ├── config.ts        validated env config
│   │       ├── db/              driver, migration runner, seed, CLI
│   │       ├── domain/          pure engines: turnover, risk, planner
│   │       ├── services/        governance: tasks, clocks
│   │       ├── repositories/    row → domain mappers, shared SQL
│   │       ├── routes/          HTTP surface (thin: validate → service)
│   │       └── lib/             ids, dates, typed HTTP errors
│   └── web/                     React 19 · Vite 7 · Tailwind 4
│       └── src/
│           ├── components/      design system + shell + task drawer
│           ├── pages/           13 surfaces
│           └── lib/             api client, formatting, class names
├── db/
│   ├── migrations/              SQLite dev schema (forward-only)
│   └── postgres/                production schema + adapter guide
├── scripts/guard-no-json-store.mjs
└── .github/workflows/ci.yml
```

**Request path**: route (validate) → service (governance, transactions) →
repository (SQL) → driver. Nothing above `repositories/` knows what the storage
engine is.

### API surface

```
GET    /api/health               GET  /api/meta              GET  /api/dashboard
GET    /api/tasks                POST /api/tasks             GET  /api/tasks/:id
PATCH  /api/tasks/:id            POST /api/tasks/:id/comments
PATCH  /api/tasks/:id/turnover/:gateId
POST   /api/tasks/:id/acceptance
GET    /api/planner              POST /api/planner/runs
GET    /api/clocks               POST /api/clocks/sweep      POST /api/clocks/timers/:id/resolve
GET    /api/projects             GET  /api/projects/:id      PATCH /api/projects/:id/phases/:rowId
GET    /api/pipeline             POST /api/deals             PATCH /api/deals/:id
GET    /api/clients              GET  /api/partners
GET    /api/qa                   POST /api/qa                PATCH /api/qa/:id
GET    /api/releases             GET  /api/insights          GET  /api/activity
GET    /api/notifications        POST /api/notifications/:id/read
GET    /api/docs                 GET  /api/search            GET  /api/audit
```

Errors are uniform:

```json
{ "error": { "code": "conflict", "message": "…", "details": { … } }, "requestId": "req_…" }
```

`409` from a blocked transition always includes the blocking gates, so the UI can
explain *why* rather than just refusing.

---

## Verification

```bash
npm run guard       # no JSON-file store, no JSON-db dependencies
npm run typecheck   # strict on both apps
npm test            # 34 tests: domain engines + HTTP contract
npm run build       # SPA production build
```

Tests cover the parts that would hurt if they broke: gate evaluation, the
`pass`-needs-evidence rule, ladder ordering, the fail-closed policy, CPM float
on parallel branches, calendar packing, clock met/missed semantics, the clock
sweeper, migration idempotency, FK enforcement, and every HTTP route's contract
(including the 403 role guard and JSON 404s).

---

## Design

Dark, dense and quiet: near-black surfaces (`#07080b`), hairline borders, one
accent (iris `#7c5cff`), tabular numerals everywhere a number matters, and a
signature aurora only on the command deck. Information density over decoration —
this is a tool someone stares at for eight hours.

- 228px rail, 48px top bar, no wasted chrome.
- `⌘K` command palette, `/` to search, `n` for a new task, `Esc` to dismiss.
- Every list is filterable; every metric has a tooltip explaining its formula.
- Skeleton loaders, no layout shift, `prefers-reduced-motion` respected.

---

## What is deliberately not here

Honest scope boundaries rather than half-built features:

- **Auth** is a demo identity (`x-actor-id` header / `DEMO_USER_ID`) with a role
  guard on privileged actions. The shape is ready for OIDC: swap `actor()` in
  `routes/index.ts` for a JWT/session claim and keep every `requireRole` call.
- **Real-time** is polling (15–60s). The schema has what a websocket layer needs
  (`activity` as an event log); adding it is additive, not a rewrite.
- **Postgres adapter**: the schema is complete and the interface is defined;
  the runtime binding is SQLite. See `db/postgres/README.md` for the four steps.
- **Automation rules** are stored and displayed, with a documented trigger/action
  vocabulary, but the executor is a stub — a rules engine without an audit trail
  is how internal tools lose trust.

---

## Licence

Internal tool. Not for redistribution.
