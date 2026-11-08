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
| `SESSION_SECRET is required` | missing env | set it; the process refuses to boot rather than run unsigned |
| `AUTH_MODE=dev is refused in production` | wrong mode in a production build | set `AUTH_MODE=oidc` and the three OIDC vars — **do not** add the opt-in |
| `AUTH_MODE=oidc requires OIDC_ISSUER…` | partial OIDC config | set all three |
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

## 6. Authentication problems

| Symptom | Likely cause | Check |
| --- | --- | --- |
| everyone logged out at once | `SESSION_SECRET` changed (sessions are HMAC-signed) | deploy the old secret, or accept the logout |
| `403 forbidden` on POST/PATCH only | missing CSRF token | the SPA sends `x-csrf-token`; a script must fetch it from `/api/auth/me` |
| `401` immediately after login | cookie rejected — cross-site or `Secure` over http | check `CORS_ORIGIN`, TLS termination |
| login works, data is empty | permission grant missing | `project_members` / `client_portal_users` |
| `INSECURE AUTHENTICATION` at boot | `ALLOW_DEV_AUTH_IN_PRODUCTION=1` is set | remove it; configure OIDC |

Revoke a compromised session: `POST /api/auth/sessions/:id/revoke`, or all of a
user's sessions with `POST /api/auth/sessions/revoke-all`. Both are audited in
`auth_events`.

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
