# Storage: SQLite (dev) → PostgreSQL (production)

Relay OSS ships two physical schemas over **one logical model**.

| Concern | `db/migrations/*.sql` | `db/postgres/schema.sql` |
| --- | --- | --- |
| Engine | built-in `node:sqlite` (WAL) | PostgreSQL 16+ |
| Used for | local dev, CI, tests, single-node demos | staging + production |
| Zero install | yes — no daemon, no container | needs a server (or managed PG) |
| Enforcement | service layer + FK | service layer **+ DB constraints + triggers** |
| Concurrency | one writer (WAL readers) | MVCC, many writers |
| Migrations | `schema_migrations` ledger, checksum-pinned | `psql -f`, or your migration runner |

## Why not just one?

The brief was explicit: *no `db.json` pretending to be a backend*. A relational
store with versioned migrations, FKs, indexes and a transactional service layer
is the requirement — the engine is an operational choice.

SQLite is used for development because it makes `git clone && npm run dev`
work with no external service, which is the single biggest cause of abandoned
internal tools. Postgres is used in production because it gives you real
concurrency, `JSONB`, `TEXT[]`, partial indexes, and constraints that a client
cannot bypass.

## Swapping the adapter

All data access goes through one interface in `apps/api/src/db/index.ts`:

```ts
interface Db {
  all<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | undefined;
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string): void;
  tx<T>(fn: () => T): T;
}
```

To move to Postgres:

1. Add `pg` and implement `Db` with a pool + `?` → `$n` parameter rewriting, or
   swap the repositories to an async signature.
2. Apply `db/postgres/schema.sql`.
3. Set `DATABASE_URL` (the health endpoint then reports `storage: "postgres"`).
4. Run the same test suite — the SQL is standard enough that only date
   functions (`datetime('now')`) and `INSERT OR REPLACE` need translation.

## Migrations in production

```bash
psql "$DATABASE_URL" -f db/postgres/schema.sql     # first boot
psql "$DATABASE_URL" -f db/postgres/0002_....sql   # subsequent, forward-only
```

Rules:

- **Forward-only.** Never edit an applied migration; add a new one.
- **Backwards compatible.** Deploy code that tolerates the old and new shape,
  then drop the old shape a release later.
- **One writer.** Take an advisory lock (`pg_advisory_lock`) around DDL so two
  replicas cannot race — the SQLite runner does the equivalent with
  `BEGIN IMMEDIATE`.

## Retention

`retention_policies` is the machine-readable list: audit 7 years (2555 days),
activity 400 days, notifications 90 days, time entries 7 years. A nightly job
should delete by `created_at` where the policy says so — never for `audit_log`,
which is immutable by trigger.
