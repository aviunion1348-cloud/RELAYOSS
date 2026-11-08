# Security

This document describes the security model **as implemented**, with the file and
test that proves each control. Anything not proven by code and a test is listed
under [Known gaps](#known-gaps) — it is not claimed.

Threat model in one line: an agency staff member, a client stakeholder and a
partner operator all reach the same API; none of them may see another tenant's
data, assert their own identity, or approve their own work.

---

## 1. Identity

| Control | Implementation | Evidence |
| --- | --- | --- |
| No client-asserted identity | `x-actor-id` is **ignored**; identity is re-derived from the session on every request | `auth.test.mjs` → *x-actor-id header is ignored unless explicitly enabled* |
| Session cookie | `relay_session`, `HttpOnly`, `SameSite=Lax`, `Secure` when the request is TLS | `auth/index.ts` → `sessionCookie()` |
| Session lifetime | 8 hours (one working day), stored in `sessions` with `expires_at` | `routes/auth.ts` → `SESSION_TTL_MS` |
| Token at rest | Only the **sha256 hash** of the session token is stored (`token_hash`) | `auth/index.ts` → `createSession()` |
| Revocation | Logout, per-session revoke and revoke-all delete/hard-expire server-side; cookie replay fails | *logout revokes the session server-side* |
| Immediate deactivation | Deactivating a user invalidates live sessions on the next request | *deactivating a user invalidates live sessions immediately* |
| Expiry | Expired sessions rejected before any handler runs | *an expired session is rejected* |

### Auth modes

There are four values, and the resolution order matters:

| `AUTH_MODE` | Meaning |
| --- | --- |
| `auto` (default) | `password` if a shared credential is provisioned, else `dev` |
| `password` | The single shared login. The intended production mode. |
| `oidc` | Verified bearer/session identity from an external IdP. Supported, never required. |
| `dev` | Local demonstration identities. Refused in production. |

`auto` is what lets one repository work unchanged on a laptop, on a deployment with
one shared password, and behind an IdP. Two properties make it safe:

* A **provisioned credential always beats `dev`.** If a shared credential exists,
  the effective mode is `password` regardless of the default — so demo identities
  can never remain reachable alongside a real password. This is the §9 "no alternate
  bypass" requirement expressed as a resolution rule rather than a runtime check.
* An **explicit `AUTH_MODE` always wins**, so an operator is never argued with.

### The single shared login

The requested access model is one username and one password, not a per-person
identity. That is a real reduction in accountability, and it is implemented with the
controls that actually bite for a shared secret.

| Control | Implementation | Evidence |
| --- | --- | --- |
| Storage | **Argon2id**, `m=65536` KiB, `t=3`, `p=4` (OWASP baseline). Only the hash is stored, never the password | `auth/password.ts` → `hashPassword` |
| Comparison | `argon2.verify`, which is constant-time and salt-aware. Never `===` | `auth/password.ts` → `verifyPassword` |
| No username oracle | Unknown user, wrong password, disabled credential and inactive user all return the same 401 with the same body; a **dummy verification runs when the user does not exist** so absence is not faster | `password-login.test.mjs` → *failures are indistinguishable* |
| Brute force | Two counters — per client address **and** per username — with exponential backoff to a 30-minute lockout. Login also draws on the stricter auth rate-limit budget | `lib/rate-limit.ts`, `routes/password-login.ts` |
| Bypass | `/api/auth/dev-login` returns **403** the moment a credential is provisioned; `dev` mode cannot boot in production | `vercel.test.mjs` → *a provisioned credential selects password mode, not dev* |
| No identity headers | `x-actor-id`, `x-user-id`, `x-authenticated-user`, `x-relay-user` establish nothing — all 401 | `password-login.test.mjs` |
| Session fixation | A fresh session id is minted on login; the previous one is not reused | `auth/index.ts` → `createSession` |
| Rotation | Re-provisioning bumps `credential_version`; sessions record the version they were minted with and are refused afterwards. No row enumeration needed | `password-login.test.mjs` → *rotating invalidates live sessions* |
| CSRF | Cookie sessions require a signed CSRF token on every mutating request | `auth/index.ts` → `issueCsrf` / `verifyCsrf` |
| Logout | Server-side revocation, then the cookie is cleared. Replay fails | `routes/auth.ts` |
| No secret leakage | Neither the password nor the hash appears in any response, log line, or `auth_events` row. Asserted by scanning every response and every audit row | `password-login.test.mjs` |
| Boot validation | A malformed `RELAY_ADMIN_PASSWORD_HASH` fails startup with an explanatory message, before any connection is opened | `vercel.test.mjs` → *a malformed hash is refused at boot* |

**What a shared login cannot do**, stated so it is not mistaken for a solved problem:

* No per-person attribution. The audit trail records the shared identity, so "who
  approved this release" is answerable only to the level of "the shared account".
* No account recovery. Losing the password is a database operation
  (`db:pg:assign-login`), not a self-service flow.
* No per-person revocation. Signing one person out means signing everybody out.
* A single leaked password is total access. The mitigations above reduce the chance
  of a leak being *usable* (cost, throttling, audit); they cannot reduce the blast
  radius, because by design there is only one account.

If those limits matter more than the convenience, `AUTH_MODE=oidc` is fully
supported — the shared login is the requested baseline, not the ceiling.

### Development identities

`AUTH_MODE=dev` exists for local work and for a demonstration container stack, and
it is deliberately awkward:

* `NODE_ENV=production` + `AUTH_MODE=dev` → **boot fails** unless
  `ALLOW_DEV_AUTH_IN_PRODUCTION=1` is set to exactly `1`.
* When that opt-in *is* set, boot prints a structured
  `INSECURE AUTHENTICATION` warning, and `/api/auth/dev-login` continues to work
  so the demonstration stack can sign in.
* Any other value (`0`, `true`, `yes`, unset) leaves the endpoint at `403`.

Tested in `auth.test.mjs`:
*production boot refuses AUTH_MODE=dev without an explicit opt-in*,
*production refuses dev-login even with the opt-in unless it is exactly 1*,
*the explicit demo opt-in re-enables dev-login and is announced, not silent*.

> Configuration is read at request time (`config.ts` is a live view over
> `process.env`). This is what makes those three tests describe real behaviour
> rather than the contents of a comment.

### OIDC

`oidc/exchange` verifies an ID token against the configured issuer + JWKS:
signature (RS256/ES256), `iss`, `aud`, `exp`, `nbf`, `sub` presence. JWKS is
cached with a TTL. Tampering, expiry and wrong issuer are all rejected —
`auth.test.mjs` → *OIDC token verification rejects tampering, expiry and wrong issuer*.

## 2. Authorisation

Roles: `admin`, `lead`, `member`, `client`. Capabilities are computed
server-side from the role, never accepted from the client.

* **Role escalation** is impossible through the request body or headers —
  *role cannot be escalated through the request body*.
* **Project isolation** is enforced per request by `requireProjectAccess()`:
  staff need a `project_members` grant (leads/admins are org-wide), client users
  need a `client_portal_users` row for the owning client.
  Tested for four distinct cases, including that a denial and a missing project
  are indistinguishable (`404`, no enumeration oracle — the access check runs
  before the row read).
* **Turnover waivers** require the `lead`/`admin` capability: *a member cannot
  waive a turnover gate*.
* **Partner console** routes are scoped by partner id from the session, not from
  the URL; cross-partner reads are tested (see traceability `R11`).

## 3. CSRF and cookies

Every mutating verb (`POST`, `PATCH`, `PUT`, `DELETE`) requires a
`x-csrf-token` header of the form `nonce.hmac`, HMAC-signed with
`SESSION_SECRET` and **bound to the session id**. Verified in constant time.
Missing token → `403 forbidden` (verified live against the production build).

Cross-origin: CORS is restricted by `CORS_ORIGIN` (comma-separated); `*` is only
the local default and is required to be set explicitly for a deployment.

## 4. Injection and output

* **SQL injection** — every query uses positional parameters (`?`). The
  portability guard (`npm run guard`) additionally rejects string-concatenated
  SQL and dialect-specific syntax, so a statement that would fail on either
  engine never reaches `main`.
* **XSS** — React escapes by default; `dangerouslySetInnerHTML` is not used
  anywhere in `apps/web` (guard-verified by grep in CI's secret/quality scan).
  `@fastify/helmet` sets the standard header set; CSP is intentionally disabled
  because the API serves the SPA and inline styles are used — see gaps.
* **SSRF** — the server never fetches a user-supplied URL. Artifact links
  (Excaliboard, Figma, Notion) are stored and rendered as links only, with
  `rel="noopener noreferrer"`.
* **Uploads** — there is no file upload endpoint. Artifacts are URLs. This is a
  deliberate scope choice, not an oversight: it removes a whole class of risk
  (path traversal, content-type sniffing, storage quotas) at the cost of not
  hosting binaries. See gaps.

## 5. Abuse resistance

Per-address budgets with three families:

| Budget | Default | Env |
| --- | --- | --- |
| Global (reads) | 1200 / min | `RATE_LIMIT_GLOBAL` |
| Writes | 240 / min | `RATE_LIMIT_WRITE` |
| Auth (login, dev-login, OIDC) | 30 / min | `RATE_LIMIT_AUTH` |

### Distributed enforcement

The budget is enforced **in the database when PostgreSQL is configured**, and in
process memory only for a single-container SQLite run. This matters because a
per-process counter is not a counter: three replicas give an attacker three times
the allowance, and on a serverless platform the number of instances is not even
fixed — every cold start would begin with an empty map.

The mechanism is a conditional upsert, so the decision is made by the storage
engine rather than by a read-then-write in application code:

```sql
INSERT INTO rate_limit_counters (bucket_key, count, reset_at, window_start)
VALUES (?, 1, ?, ?)
ON CONFLICT (bucket_key) DO UPDATE SET
  count = CASE WHEN rate_limit_counters.reset_at <= ? THEN 1 ELSE count + 1 END,
  …
  WHERE rate_limit_counters.reset_at <= ? OR rate_limit_counters.count < ?
```

A live window at the limit suppresses the update and reports zero changed rows,
which is the refusal. Two concurrent callers cannot both consume the last token —
verified by firing 40 parallel requests against a limit of 10, and by splitting
eight requests across two independent application instances against a budget of
five (five succeed, three are refused).

Windows are **fixed**, not sliding. A fixed window permits a burst of up to twice
the limit across a boundary; a sliding window avoids that at the cost of many more
rows or an approximate sketch. For budgets of this size the boundary burst is
bounded and harmless, and the simpler mechanism is the one whose correctness can be
demonstrated. The counter tables are pruned by the cron sweep, not on a request path.

### Login lockout

Five consecutive failures lock the identity, with exponential backoff capped at 30
minutes. Two counters are kept — by client address **and** by username — because a
single shared username means one counter alone would let an attacker rotate the
other dimension.

The lockout is database-backed too, so it survives an instance restart, which the
in-process version could not: a test earns a lockout on one application instance and
asserts that a *second* instance refuses the correct password.

Auth responses are constant-shaped: an unknown user and a wrong credential are
indistinguishable, both are throttled, and a dummy verification runs when the user
does not exist so absence is not measurably faster — *failed logins are throttled
and do not reveal whether a user exists*. `retry-after` is returned, and the limiter
is unit-tested with a lowered budget rather than disabled for tests.

> Remaining limitation: one round-trip per request is added when the DB-backed
> limiter is active. That is the price of a correct cross-instance budget; a Redis
> or provider-native edge limiter would remove it, and is the natural upgrade if the
> added latency ever matters.

## 6. Secrets

* Nothing is committed. `.env.example` documents every variable with safe local
  defaults; real values come from the environment.
* CI runs a `git grep` secret scan for private keys, AWS keys, GitHub/Slack
  tokens and long `*_SECRET=` assignments, and fails the build on a hit.
* `SESSION_SECRET` is mandatory: the API refuses to boot without it
  (`assertAuthConfiguration`). Test suites supply a throwaway value.
* Docker images take secrets from the environment or an orchestrator secret
  store — never `ARG`/`ENV` in the Dockerfile.

## 7. Auditability

`auth_events` records every login attempt, rejection, session revocation and
role change with actor, IP, user agent and timestamp. `audit_log` records
governance actions (turnover checks, waivers, acceptance steps) with
before/after payloads. Both are append-only by convention and covered by tests —
*every rejected authentication attempt is recorded*, *successful and failed
logins are recorded with actor and ip*.

Logs are structured JSON with a correlation `requestId` and a route **template**
(`/api/tasks/:id`), never raw ids or bodies; passwords, tokens and cookies are
never logged.

## 8. Operational endpoints

`/api/live`, `/api/ready`, `/api/health`, `/api/metrics` are anonymous so a load
balancer can reach them, and they expose **no user data**: counts by status,
clock health, worker state, latency, memory. Asserted by
*auth.test.mjs → operational endpoints are anonymous but expose no user data*
and by the HTTP suite.

## 9. Dependency and data handling

* `npm audit --audit-level=high` runs in CI (advisory, not blocking — see gaps).
* Postgres access uses a single least-privilege application role on the app
  database; test databases are created and dropped by the test runner.
* Row retention is expressed in `retention_policies`; export is
  `GET /api/audit` plus the logical backup (NDJSON) in `scripts/backup.mjs`.

## Known gaps

| # | Gap | Effect | Mitigation in place |
| --- | --- | --- | --- |
| S1 | No OIDC provider was available in the build environment, so the exchange path is proven against a locally generated keypair and JWKS, not a live IdP | The wiring is tested; a real-IdP smoke test is not | `auth.test.mjs` covers signature/iss/aud/exp paths; documented in DEPLOYMENT |
| S2 | Rate limits are in-process | Budgets multiply across replicas | Single-instance deployment documented; Redis noted as the fix |
| S3 | CSP disabled | Weaker XSS defence-in-depth | Helmet's other headers; no `dangerouslySetInnerHTML`; escaping relies on React |
| S4 | No upload endpoint | Cannot host binary artifacts | URL-based artifacts with provenance fields |
| S5 | `npm audit` is advisory | A vulnerable transitive dep would not fail CI | Reviewed at each release; recorded in the runbook |
| S7 | A dependency can exist by accident | `pg` was imported but undeclared, resolved only via a dev tool, and the production image crashed on boot | Fixed; `scripts/guard-declared-deps.mjs` now fails the build on an undeclared or dev-only runtime import |
| S6 | No penetration test, no WAF, no IDS | This is an application-level review, not a certified one | Explicitly not claimed as certified |
