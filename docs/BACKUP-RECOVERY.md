# Backup and recovery

The rule for this document: **a backup that has never been restored is a
rumour.** Every number below came from a drill executed in this environment.

---

## 1. Commands

```bash
node scripts/backup.mjs backup              # take a backup
node scripts/backup.mjs verify <file>        # inspect an artefact
node scripts/backup.mjs restore <file>       # restore in place (needs FORCE=1)
node scripts/backup.mjs drill                # backup → restore to scratch → compare
npm run backup:verify                        # alias for drill (runs in CI)
```

Engine is chosen by `DATABASE_URL`, exactly like the API.

## 2. Artifacts

| Engine | Format | Path |
| --- | --- | --- |
| PostgreSQL, `pg_dump` available | custom-format dump | `backups/relay-<ts>.dump` |
| PostgreSQL, no `pg_dump` | logical NDJSON | `backups/relay-<ts>.ndjson` |
| SQLite | file copy after WAL checkpoint | `backups/relay-<ts>.sqlite` |

Each backup also writes a `.manifest` (engine, format, byte size, timestamp,
table count) so an artefact can be identified without opening it. `backups/` is
git-ignored.

### Why NDJSON exists

`pg_dump` is not part of the embedded PostgreSQL distribution available here
(only `initdb`, `pg_ctl`, `postgres`). Rather than declare PostgreSQL backups
"not possible", `scripts/backup.mjs` implements a logical dump: one JSON object
per line, with a `header` line (engine, schema version, table list), one `table`
line per table, and a `footer` line. A truncated file is therefore *detectable*
— `verify` checks header, footer and table count.

It is slower and larger than a physical dump, and it does not capture roles,
grants, extensions or indexes beyond the schema itself. It does restore data
losslessly, which is the property that matters in an incident.

## 3. Measured drill results

Executed on 2026-11-08, PostgreSQL 16.15 and SQLite (WAL), production-shaped
seed data (8 users, 6 clients, 6 projects, 89 tasks, 666 turnover checks).

| Engine | Tables | Result | Restore time | Total |
| --- | --- | --- | --- | --- |
| SQLite | 55 / 55 | integrity ok, row counts identical | 34 ms | 1188 kB artefact |
| PostgreSQL (logical) | 54 / 54 | identical row counts per table | 1316 ms | 1709 ms, 562 kB artefact |

The drill is deliberately strict:

* It restores into a **scratch database** (`relay_drill`), not over production.
* It `DELETE`s existing rows in every dumped table before inserting, so it
  cannot report success while silently skipping conflicting rows. (An earlier
  version used `ON CONFLICT DO NOTHING` and passed while losing data — the kind
  of false green this suite exists to prevent.)
* It compares **row counts per table** between source and restored copy and
  fails on any mismatch.
* It refuses to overwrite a live database unless `FORCE=1`.

## 4. Restore procedure (incident)

1. Stop writers: `docker compose stop app` (or stop the API process). A restore
   into a database that is being written to is not a restore.
2. Take a safety copy of the current state first — even when it is broken:
   `node scripts/backup.mjs backup`.
3. Verify the artefact you intend to use:
   `node scripts/backup.mjs verify backups/relay-<ts>.ndjson`
   Check the schema version matches the deployment you are about to run.
4. Restore: `FORCE=1 node scripts/backup.mjs restore backups/relay-<ts>.ndjson`
5. Run `DATABASE_URL=… node apps/api/src/db/cli.ts status` and confirm the
   schema version and table counts.
6. Start the API, then check `GET /api/ready` and `GET /api/health`
   (`schemaVersion`, `storage`, `database.ok`).
7. Run the drill on a *fresh* backup to prove the restored state is itself
   backed up.

## 5. Verification cadence

| When | What |
| --- | --- |
| Every CI run | `npm run backup:verify` (full drill on the seeded SQLite database) |
| Before every release | full drill on PostgreSQL |
| After every schema migration | drill, because a new table is an untested table |

## 6. Recovery objectives (stated, not implied)

| Objective | Current position |
| --- | --- |
| RPO | Whatever the backup interval is — nothing runs a scheduled backup automatically yet (**gap**) |
| RTO | ~2 s for the logical path at demo scale; dominated by container start and migration checks |
| Tested | Yes, both engines, this environment |
| Untested | Point-in-time recovery, WAL archiving, cross-region restore, restore into a managed provider |

## 7. Known gaps

| # | Gap | Risk |
| --- | --- | --- |
| B1 | No scheduled/cron backup; only manual and CI invocation | Data loss window equals the operator's discipline |
| B2 | No physical `pg_dump`/WAL archiving proved here | No PITR; recovery granularity is "the last logical dump" |
| B3 | Backups are local files; no off-host replication or encryption at rest | Host loss loses both data and backups |
| B4 | No retention/expiry policy applied to `backups/` | Disk growth |
| B5 | Restore into a managed PostgreSQL (RDS/Cloud SQL) untested | Provider-specific extensions/roles may differ |

B1 and B3 are the two that must be closed before any real client data is stored.
