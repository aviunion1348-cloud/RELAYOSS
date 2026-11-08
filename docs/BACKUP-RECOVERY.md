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

---

## 8. Operations: scheduling, retention, integrity, PITR

`scripts/backup-ops.mjs` is the operational wrapper. It answers four questions
that the drill alone cannot.

### 8.1 What is actually possible here

```bash
npm run backup:status      # engine, whether a local backup is possible, what is missing
npm run backup:pitr        # point-in-time recovery readiness, with the exact requirements
npm run backup:retention   # apply the tiered retention policy
npm run backup:verify-all  # re-verify the checksum of every archive on disk
```

Nothing in that output is assumed. `backup:status` reports `localBackupPossible`
as a function of the binaries it actually found; `backup:pitr` reports one of
`AVAILABLE`, `BLOCKED` or `NOT_APPLICABLE` and, when blocked, names the exact
server setting required.

### 8.2 Point-in-time recovery: the honest position

PITR needs continuous archiving on the **server**: `archive_mode=on` (or an
`archive_library`), `wal_level=replica` or better, retained WAL segments, and a
`pg_basebackup` base. The embedded PostgreSQL used for local testing has none of
these, and a managed provider only has them if the operator enabled them.

Verified state in this environment:

```
$ npm run backup:pitr
{
  "available": false,
  "verdict": "BLOCKED",
  "reason": "Continuous archiving is not configured on this server, so recovery can only
             restore the most recent logical backup. A point in time between backups cannot
             be recovered.",
  "requirements": [
    "archive_mode=on (or archive_library set) on the PostgreSQL server",
    "wal_level=replica or logical (currently unknown)",
    "psql client to verify server settings"
  ]
}
```

On SQLite the answer is `NOT_APPLICABLE`: there is no WAL archive to replay, so
the recovery point objective is the most recent verified backup.

**Consequence for RPO.** Without PITR the RPO equals the backup interval. With
daily backups that is up to 24 hours of loss; with the hourly schedule below it is
up to one hour. This is stated rather than implied, because an RPO that is
believed to be five minutes and is actually a day is worse than a known day.

### 8.3 Retention

Retention is tiered, not age-based. Deleting purely by age eventually removes
every long-range restore point, leaving seven recent copies and nothing older.

| Tier | Default | Env |
| --- | --- | --- |
| Always keep the newest N backups | 7 | `BACKUP_KEEP_DAILY` |
| Newest of each of the last N weeks | 4 | `BACKUP_KEEP_WEEKLY` |
| Newest of each of the last N months | 6 | `BACKUP_KEEP_MONTHLY` |
| Hard ceiling on age | 200 days | `BACKUP_MAX_AGE_DAYS` |

Verified: given 40 daily archives, retention keeps the newest 7 in full, plus the
newest of each week and month beyond that, and removes the rest. The test asserts
both halves — that long-range points survive and that noise is removed.

### 8.4 Integrity: a manifest, not a timestamp

A file that exists is not a backup. Every archive now carries a `.sha256`
manifest recording the digest, byte size, creation time and engine. `verify-all`
recomputes the digest and fails if it differs, so an archive altered — or
truncated by a full disk — is detected rather than restored.

Verified: flipping a single byte in an archive causes `verify-all` to report
`checksum mismatch`; restoring the bytes restores the proof. An archive with no
manifest is reported as *unprovable*, never as verified.

### 8.5 Scheduling

`.github/workflows/backup.yml` runs the full drill daily at 02:17 UTC against a
fresh PostgreSQL 16: migrate, seed, PITR report, drill, integrity sweep over every
archive, retention, then uploads the archives and manifests as an artifact with a
14-day retention.

It has no production credentials and no network path to a production database —
by design. It proves the machinery, not the production backup.

**Production scheduling is an operator responsibility** and requires, at minimum:

- a scheduler (cron, systemd timer, Kubernetes CronJob, or the provider's own)
  invoking `node scripts/backup.mjs backup` on the production connection string;
- offsite replication: an archive on the same volume as the database is not a
  backup (an operator copies to object storage with its own retention);
- an alert on a failed run — `backup:run` exits non-zero, so any scheduler that
  surfaces exit codes will escalate it;
- a quarterly restore rehearsal against a scratch instance, recording the
  elapsed time and comparing row counts, which is exactly what `drill` prints.

### 8.6 Verified results in this environment

| Engine | Command | Result |
| --- | --- | --- |
| SQLite | `backup.mjs drill` | 76 tables and 68 rows identical, integrity ok, 25 ms |
| PostgreSQL 16 | `backup.mjs drill` | 76 tables identical, restore 1,473–1,559 ms |
| PostgreSQL 16 | `backup-ops.mjs verify-all` | 1 archive, 1 checked, 0 failed |
| both | `backup-ops.mjs pitr` | SQLite `NOT_APPLICABLE`, PostgreSQL `BLOCKED` — never `AVAILABLE` without server configuration |

The row-for-row comparison replaced a table-count comparison during this work:
counting tables passes on an archive of empty tables, which is not evidence that
anything was restored.
