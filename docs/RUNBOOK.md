# Runbook

Operational procedures for a running Relay instance. Commands assume the
repository root. Each entry states how you know it worked — a symptom to watch,
not a feeling.

---

## 0. First five minutes after an alert

1. `curl -fsS localhost:4000/api/live` → if this fails, the process is gone: see
   [Process down](#1-process-is-down).
2. `curl -fsS localhost:4000/api/ready` → `503` means the database is the
   problem: see [Database unreachable](#2-database-unreachable).
3. `curl -s localhost:4000/api/health | jq` → note `schemaVersion`, `storage`,
   `database.ok`, `worker`, `memoryMb`.
4. `curl -s localhost:4000/api/metrics | grep relay_http_slow_total` → slow
   requests by route template.
5. Check the log tail for `"level":50` (error) and `INSECURE AUTHENTICATION`.

## 1. Process is down

```bash
docker compose ps                 # or: systemctl status relay
docker compose logs --tail=200 app
docker compose up -d app
curl -fsS localhost:4000/api/ready
```

Common causes, in the order they actually happen:

| Symptom in the log | Cause | Fix |
| --- | --- | --- |
| `No users exist in the database, so requests cannot be attributed` | migrated but not seeded | `npm run db:seed`, or set `OPERATOR_USER_ID` to an existing user id |
| `SQLite is unavailable in this runtime, and no DATABASE_URL is configured` | no database at all | set `DATABASE_URL`; the deployment has no other dependency |
| `checksum mismatch` on a migration | an applied migration file was edited | restore the file; if it must change, add a new migration |
| `EADDRINUSE` | stale process on 4000 | find and stop the old PID |

## 2. Database unreachable

`/api/ready` returns `503`, `/api/health` returns `503` with `database.ok:false`.

```bash
docker compose ps postgres
docker compose logs --tail=100 postgres
node -e "const {Pool}=require('pg');new Pool({connectionString:process.env.DATABASE_URL}).query('select 1').then(()=>console.log('ok')).catch(e=>console.error(e.message))"
```

The API keeps serving `/api/live` and returns `503` — never stale data or an
empty `200`. If PostgreSQL will not start, go to
[restore](./BACKUP-RECOVERY.md#4-restore-procedure-incident).

## 3. Missed clocks piling up

`GET /api/metrics | grep relay_clocks_overdue` is the leading indicator;
`GET /api/clocks` is the dashboard the team sees.

A missed clock is **not** cleared by editing it. Procedure:

1. Read the timer: `GET /api/clocks` → the timer id, clock key, entity, due time.
2. Establish the cause (client delay, vendor outage, internal miss).
3. Acknowledge it — this is mandatory and auditable:
   `POST /api/clocks/timers/:id/acknowledge {reason, escalatedTo}`
   The reason must be ≥12 characters; the miss itself is never erased.
4. If the clock was started in error (wrong anchor event), a lead may waive it
   **with a written exception**: `POST /api/clocks/timers/:id/resolve
   {outcome:"waived", note:"…"}`. A waiver without a note is refused.

A missed external deadline must be communicated to the client the same day —
that is a delivery-policy obligation, not a system one.

## 4. A release is blocked

`GET /api/releases/:id/gate` returns every check with `passed`, `detail`,
`actual` and `required`. The same text is stored on the release in
`ship_blocked_reason`, so the refusal is explainable later.

Work the checks in this order — the later ones usually need the earlier ones:

1. `edge_cases_catalogued` / `edge_cases_verified` — 3500 catalogued, 90%
   verified. Do not lower `edge_case_target` to pass the gate; that is exactly
   the safeguard the client paid for.
2. `no_blocking_defects` — close or `verified` every P0/P1.
3. `project_turnover_gates` — every required project gate needs `pass` **with
   evidence**.
4. `exec_summary_lead_time` — the summary must be *prepared* ≥48 h before the
   planned ship. Adding the link late does not retroactively satisfy it.
5. `demo_approved` — record the demo approval or the client acceptance.
6. Then, and only then, `shipped` becomes reachable — and still requires a
   `deployment_ack` and a `post_ship_verification` with a source.

## 5. Post-ship verification

`POST /api/releases/:id/acknowledgements {signal, state, source, detail}`

| Signal | Source example |
| --- | --- |
| `deployment_ack` | pipeline run URL, deploy id |
| `post_ship_verification` | smoke-run report id |
| `device_ack` | device fleet confirmation (partner console) |

Never record `received` without a real source; the API refuses it. If the
deployment failed, record `failed` with the error — a failure recorded honestly
is worth more than silence.

## 6. Access problems

There is no authentication to troubleshoot — see `docs/AUTH-REMOVAL.md`. The
questions that come up instead:

| Symptom | Likely cause | Check |
| --- | --- | --- |
| the dashboard is reachable by anyone | by design | if that is wrong for this deployment, put it behind Vercel Deployment Protection or an SSO proxy; nothing in the app does this |
| `401` from `/api/cron/sweep` | `CRON_SECRET` unset or not sent as `Authorization: Bearer …` | this is not user auth; it deliberately stays closed |
| `503 misconfigured` naming `npm run db:seed` | the `users` table is empty, so no identity can be attributed | seed the database |
| `403 forbidden` — should not happen | would mean a role check survived the removal | treat it as a bug: `grep -rn "forbidden(" apps/api/src` |
| a stale `AUTH_MODE` or `SESSION_SECRET` in the environment | inert | harmless; delete when convenient so it does not imply a login |
| `authMode` in `/api/health` is not `none` | a mode was reintroduced | it should read `none`; anything else is a regression |

## 6a. What a first run creates

A migrated-but-empty database is not usable until two things exist, and boot creates
them automatically (`apps/api/src/db/scaffolding.ts`):

| Created | Why it cannot wait |
| --- | --- |
| One `users` row (the operator, named from `OPERATOR_NAME`) | every `created_by` is a foreign key; nothing can be written without an identity |
| One studio board + its six columns | `tasks.column_id` is `NOT NULL` and references `columns`; with no board the first task is refused |
| The twelve `pipeline_stages` | `deals.stage_id` is `NOT NULL`; with no gates the first deal is refused with "Unknown stage" |

**Nothing else.** No clients, projects, tasks, deals, partners, releases, QA reports
or activity — a first run reports zeros for all of them, and `npm run db:seed` is still
the only way to get demo content. This is the difference between *scaffolding* (the
product's own method: which columns a board has, which gates the pipeline has) and
*content* (a record of work somebody did).

If a first run looks empty to the point of being broken, check the three rows above
exist before suspecting the UI:

```sql
SELECT (SELECT COUNT(*) FROM boards) AS boards,
       (SELECT COUNT(*) FROM columns) AS columns,
       (SELECT COUNT(*) FROM pipeline_stages) AS stages;
-- expect 1 | 6 | 12
```

## 7. Worker / sweeper

`/api/health` → `worker: {name:"clock-sweeper", intervalMs}`.

* `relay_worker_sweeps_total` not increasing → the loop is not running (check
  the log for a thrown error inside the interval).
* `relay_worker_failures_total` increasing → the sweeper is failing; the cause
  is in the log as a structured error with the same `requestId` correlation id.
* Sweeping twice is safe and tested (`resilience.test.mjs` → sweeper
  idempotency). A duplicate sweep must never create a second notification.

## 8. Restore from backup

See [BACKUP-RECOVERY.md](./BACKUP-RECOVERY.md#4-restore-procedure-incident).
Verify the artefact before restoring, and take a safety copy of the broken
state first.

## 9. Routine maintenance

| Task | Cadence | Command |
| --- | --- | --- |
| Backup drill | every release | `npm run backup:verify` |
| Dependency audit | monthly | `npm audit --audit-level=high` |
| Rate-limit review | quarterly | compare `relay_http_requests_total` with `RATE_LIMIT_*` |
| Retention sweep | quarterly | `SELECT * FROM retention_policies` |
| Session hygiene | monthly | expired sessions are rejected on read; old rows can be deleted |

## 10. Escalation

The delivery board's escalation ladder is encoded in `sla_clocks.escalation`
(e.g. `admin`, `lead`) and surfaced on the Clocks screen. When a clock breaches,
escalation goes to the role named there — not to whoever is online.
