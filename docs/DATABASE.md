# Database

PostgreSQL 16 is the authoritative store. SQLite is a development and test
engine that runs the **same migrations and the same application code** — not a
second implementation, and never a production target.

---

## 1. Engines and selection

| | Production | Development / tests |
| --- | --- | --- |
| Engine | PostgreSQL 16 | SQLite (`node:sqlite`, WAL) |
| Selected by | `DATABASE_URL` set | `DATABASE_URL` unset |
| Driver | `apps/api/src/db/postgres.ts` (`pg`) | `apps/api/src/db/sqlite.ts` |
| Migrations | `db/migrations/pg/*.sql` | `db/migrations/*.sql` |

The PostgreSQL migration set is **generated** from the SQLite set by
`scripts/gen-pg-migrations.mjs` with an auditable rule table (booleans as
`SMALLINT` + `CHECK`, timestamps as ISO-8601 UTC text, `AUTOINCREMENT` as
identity columns, `datetime('now')` as `to_char(now() AT TIME ZONE 'UTC', …)`).
`npm run guard` fails if the generated files are stale, so the two can never
drift silently.

Typed columns are registered with `pg` so `INT8`/`NUMERIC` come back as numbers,
not strings — the bug that usually shows up as "the UI shows 0".

## 2. Running it

```bash
# Local PostgreSQL 16 (embedded distribution, no Docker needed)
node scripts/pg-dev.mjs start          # → postgres://relay:relay_local_dev@127.0.0.1:55432/relay
node scripts/pg-dev.mjs stop

# Schema
DATABASE_URL=… node --no-warnings apps/api/src/db/cli.ts migrate
DATABASE_URL=… node --no-warnings apps/api/src/db/cli.ts seed
DATABASE_URL=… node --no-warnings apps/api/src/db/cli.ts status
DATABASE_URL=… node --no-warnings apps/api/src/db/cli.ts reset    # drops + recreates

# Conformance: migrations, seed, then every suite on the same code
npm run test:pg
```

`npm run test:pg` starts a dedicated cluster, creates `relay_test`, migrates it
from empty, seeds the production-shaped dataset, and runs the domain, auth,
resilience, ship-gate and HTTP contract suites against it.

## 3. Schema

57 relations across seven migrations (56 application tables plus
`schema_migrations`), verified by `db/cli.ts status` on both engines.

| Migration | Contents |
| --- | --- |
| `0001_core` | users, teams, clients, contacts, pipeline stages, deals, phases, projects, project phases, milestones, boards, columns |
| `0002_work` | tasks, labels, watchers, dependencies, checklists, comments, activity, time entries, turnover gates + checks, SLA policies, automation rules, notifications, saved views |
| `0003_intel` | capacity snapshots, schedule runs/items, risk scores, audit log, handoffs, retention policies, SLA clocks, SLA timers |
| `0004_delivery_os` | acceptance records, QA reports, edge cases, releases, partners, partner IAM, device licences, usage metrics, docs |
| `0005_baseline_policy` | the seeded governance baseline: turnover gate ladder, 10 clock policies, retention policy |
| `0006_auth_identity` | identity subjects, sessions, project members, partner invitations, auth events, client portal users |
| `0007_ship_gate` | ship acknowledgements, clock acknowledgements, release evidence columns |

### The four states that must never be conflated

`acceptance_records` models `dev_complete → qa_approved → lead_approved →
client_accepted` as **separate rows** with their own actor, evidence, notes and
timestamp, unique on `(task_id, step)`. A task can be `done` while
`client_accepted` is still pending — that is the point, not a bug.

`turnover_checks` is the per-gate evidence record; `tasks.turnover_state`
(`draft → in_review → passed/failed`) is derived from it.

### Constraints, not conventions

* Foreign keys on every relation, `ON DELETE CASCADE` where the child has no
  meaning without the parent (tested: *foreign keys are enforced (no orphan rows)*).
* `CHECK` constraints on every enumerated column (status, severity, phase,
  acceptance step, release status). An invalid state cannot be inserted, so a
  code path that forgets validation still cannot persist nonsense.
* `UNIQUE` where duplication is a bug: `(task_id, step)` acceptance,
  `(release_id, signal)` acknowledgement, `(timer_id)` clock acknowledgement,
  `(project_id, phase_id)` phase instance, `(project_id, code)` edge case.
* Timestamps are ISO-8601 UTC text (`YYYY-MM-DDTHH:MM:SS`), comparable and
  timezone-free by construction. The driver never converts them.

## 4. Integrity and migrations

`apps/api/src/db/migrate.ts`:

1. Creates `schema_migrations` if absent.
2. For each pending file (ordered, prefixed), runs it **inside a transaction**.
3. Records the version **with a sha256 checksum** of the file.
4. Refuses to start if an already-applied file's checksum changed.

That last rule is why the resilience suite can assert *a failed migration rolls
back without recording a version* and *schema checksums prevent editing an
applied migration*. Editing history is a build failure, not a judgement call.

`SKIP_MIGRATE=1` skips migration at boot (used by the container's one-shot
migrator); it never skips checksum verification.

## 5. Concurrency

Writes that must not interleave run in `db.tx()`. PostgreSQL uses a pooled
client with `BEGIN … COMMIT`, SQLite uses `IMMEDIATE` transactions, so both give
the same guarantee: the whole unit is atomic.

Two races are covered explicitly by tests, because they are the ones that would
silently corrupt governance:

* **Concurrent approvals** — two simultaneous approvals cannot both create a
  record (`UNIQUE`) and the loser receives a conflict, not a silent success.
* **Approval racing a gate** — a transition re-checks gates inside the
  transaction, so passing a gate concurrently with a ship attempt cannot yield a
  ship that skipped it.

## 6. Backup and restore

See [BACKUP-RECOVERY.md](./BACKUP-RECOVERY.md). Measured: PostgreSQL logical
backup and restore-to-scratch of 54 tables in 1.3 s; SQLite file backup with
integrity check in 27 ms.

## 7. Data governance

`retention_policies` records retention per table. `audit_log` is append-only.
Export: `GET /api/audit` (governance record) and the logical NDJSON dump
(every table, one JSON object per line, with a header and footer so a truncated
file is detectable).

## 8. Known limits

| # | Limit | Consequence |
| --- | --- | --- |
| D1 | No `pg_dump`/`pg_restore` in this environment; logical NDJSON is the tested path | Physical backup and PITR are unproven here |
| D2 | No connection-pool sizing under load | Pool is `pg`'s default; a load test would be needed |
| D3 | No partitioning on `audit_log` / `activity` | Fine at demo scale; growth plan is time-based partitions |
| D4 | No row-level security (RLS) — isolation is enforced in the application layer and tested | A bug in `requireProjectAccess` is the blast radius; RLS would add defence in depth |
