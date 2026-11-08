# Architecture

## Principles

1. **The server is the only authority.** The UI may hide a button; the API
   refuses the transition. Governance that lives in a React component is a
   suggestion.
2. **Explainability over cleverness.** Every score, plan and insight returns the
   factors that produced it. No opaque model decides what a person does next.
3. **Fail closed.** Missing policy means *not certified*, not *approved*. A
   governance system with a vacuous pass is worse than none.
4. **No file-as-database.** Relational schema, versioned migrations, FKs,
   transactions, an audit trail. Enforced in CI.
5. **Zero-dependency dev.** `npm install && npm run dev` must work with no
   external services; production parity is a separate, documented path.

## Runtime topology

```
Browser ──▶ Vite dev server (5173) ──proxy /api──▶ Fastify (4000) ──▶ SQLite (WAL)
   │                                                    │
   └──── production: Fastify serves the built SPA ───────┘  (single origin)
```

One origin in production means no CORS surface, no localhost references in
client code, and no mixed-content surprises behind a proxy. The dev server binds
`0.0.0.0` and proxies `/api`, so the browser still only ever sees one origin.

## Layering

| Layer | Files | May import | Must never |
| --- | --- | --- | --- |
| HTTP | `routes/index.ts` | services, repositories, lib | contain SQL joins of business logic |
| Service | `services/tasks.ts`, `services/clocks.ts` | db, domain, lib | know about HTTP |
| Domain | `domain/turnover.ts`, `risk.ts`, `planner.ts` | lib only (pure) | touch the database |
| Repository | `repositories/query.ts` | nothing | contain policy decisions |
| Driver | `db/index.ts` | node:sqlite | leak above the boundary |

The domain layer being pure is what makes the engines unit-testable without a
database and reusable by the UI (the drawer shows the same gate evaluation the
server enforced).

## Governance flow

```
PATCH /api/tasks/:id { status: "done" }
        │
        ├─ assertTurnoverComplete()
        │     ├─ evaluateGates(gates, checks)   → every required check pass|waived?
        │     └─ acceptance_records             → qa_approved + (lead|client)_approved?
        │
        ├─ fail → 409 { details: { blockers, required } }
        └─ pass → UPDATE + completed_at
                  + audit_log row
                  + activity row
                  + closeTimersFor(task) (module turnover → met)
```

The same invariant exists in Postgres as a trigger
(`enforce_turnover_before_done`), so even a manual `UPDATE` cannot bypass it.

## Clock lifecycle

```
startTimer(clock, entity)  ── running ──┬── resolveTimer(met)    → met_at
                                        ├── resolveTimer(paused) → paused_at
                                        ├── sweeper (60s)        → missed_at
                                        └── resolveTimer(waived) → exception_note required
```

`resolveTimer(met)` after the deadline records a **miss**, not a retroactive
success. That single rule is what makes the compliance number trustworthy.

## Data volume and performance

- 89 tasks / 666 checks / 219 edge cases in the seed — realistic but small.
- Every list endpoint is paginated (`limit`/`offset`, max 500) and returns
  `meta.total`.
- Indices cover the hot predicates: `tasks(board, column, position)`,
  `tasks(assignee, status)`, `tasks(sla_due_at) WHERE not done`,
  `turnover_checks(task_id)`, `sla_timers(outcome, due_at)`,
  `activity(created_at DESC)`.
- The dashboard performs a bounded number of queries (task list, workload
  aggregate, project rollup, deals, clocks) — no per-row queries in render paths.
- Typical response times on the seeded dataset: dashboard ~20ms, planner ~25ms,
  task detail ~5ms.

## Security posture

| Concern | Current | Production step |
| --- | --- | --- |
| Identity | `x-actor-id` header, `DEMO_USER_ID` default | OIDC / SSO; set `actor()` from verified claims |
| Authorisation | `requireRole` on waive/cancel/audit/acceptance | Keep the calls; add project-scoped checks |
| Transport | behind proxy (`trustProxy`), helmet headers | TLS at the edge |
| Input | Zod schemas on write routes; typed 400s | same |
| Injection | parameterised statements only | same |
| Body limits | 2 MB, JSON parser hardened | same |
| Audit | `audit_log` on every governance action | append-only trigger (already in PG schema) |
| Secrets | none in the image; env only | secret manager |

## Failure modes and what happens

| Failure | Behaviour |
| --- | --- |
| Missing turnover policy | turnover fails closed, blocker named "policy missing" |
| Missing clock policy | clock start is skipped; the transition is **not** blocked (observability must not break delivery) |
| Malformed JSON body | 400 `bad_request` |
| Empty JSON body on POST | treated as `{}` |
| Unknown API route | JSON 404, never HTML |
| Unhandled exception | 500 with request id; message hidden in production |
| Overdue clock | sweeper marks `missed` + activity row, surfaced in the top bar |
| Database write failure | transaction rolls back; 500 with request id |
