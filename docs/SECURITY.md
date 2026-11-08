# Security

**Read this first.** This deployment has no authentication. Every page and every
API endpoint is reachable by anyone who can reach the URL, and every request is
attributed to one configured operator. The threat model of a multi-tenant agency
tool — staff, clients and partners reaching one API without seeing each other's
data — **does not hold on this deployment.** The single compensating control is
outside this repository: put the deployment behind access control at the hosting
layer.

This document states what is still enforced, what is not, and how each claim is
verified. Anything not proven by code and a test is listed under
[Known gaps](#known-gaps) rather than asserted.

---

## 1. Authentication: none

| Property | Status | Evidence |
| --- | --- | --- |
| Sign-in | **Removed.** No page, no endpoint, no session. | `App.tsx` renders the dashboard at `/`; `/api/auth/login` answers `410 Gone` — `auth.test.mjs` → *the login endpoints are gone, and say so* |
| Session cookie | **Removed.** No cookie is set or read. | `lib/api.ts` sends `credentials: 'omit'`; `auth/middleware.ts` reads no cookies |
| CSRF | **Removed.** No token, no header, no check. | CORS omits `x-csrf-token`; `auth.test.mjs` → *writes succeed with no cookie and no CSRF token* |
| Session revocation | **N/A.** There is nothing to revoke — and no way to cut off one client. | — |
| Identity for attribution | **A fixed operator**, resolved once per process: `OPERATOR_USER_ID`, else the first administrator, else any user. | `auth/operator-middleware.ts`; `auth.test.mjs` → *mutations are attributed to the operator, not left null* |

The reasoning, and the record of what was removed and why, is in
[`AUTH-REMOVAL.md`](./AUTH-REMOVAL.md). It includes the protections that were
genuinely lost — cross-tenant isolation, role separation, per-person
accountability — because those are the costs of this change and they should not be
discoverable only by reading the diff.

## 2. What is still enforced

Removing authentication did **not** remove validation, constraints or business
rules. These are asserted, and the tests fail if they regress.

| Control | Implementation | Evidence |
| --- | --- | --- |
| Input validation | zod schemas per route; unknown enum values, short titles and missing fields are `400` | `auth.test.mjs` → *input validation still rejects bad payloads* |
| Database constraints | `UNIQUE` slugs and project keys surface as `409`; `CHECK` constraints and `FOREIGN KEY`s still fire | `auth.test.mjs` → *client and project creation work, with the schema enforcing itself* |
| Absence is `404`, not `200` | A missing row answers `404` with a JSON error envelope | *unknown ids still 404* |
| Unknown API paths | `404` JSON, never the SPA document — the fallback cannot swallow `/api` | `vercel.test.mjs` → */api 404s are JSON* |
| Cron endpoint | `Authorization: Bearer $CRON_SECRET`, independent of user auth. Unset → `503`, never open. | `vercel.test.mjs` → *cron is reachable only with the bearer secret* |
| Rate limiting | Global, write and auth budgets; the retired login paths still draw the strictest budget | `lib/rate-limit-store.ts`, `rate-limit-store.test.mjs` |
| Secret hygiene | `/api/health` and error responses carry variable **names** only, never values; no hash or connection string appears in a public response | `vercel.test.mjs` → *an instance with no authentication environment still boots and serves* |
| No client-asserted identity | `x-actor-id` is still ignored. The operator comes from configuration, not from a header. | `auth.test.mjs` |
| Row-level integrity | `assertTimerInScope`, `assertClientInScope`, `notFound` guards: an entity must exist and belong where the caller claims | `clocks-pause.test.mjs`, `comms-legal.test.mjs` |

## 3. Scope predicates

`resolveReadScope` and the `*Where` predicates are unchanged and still run on every
request. They are the multi-tenant authorisation logic, and they are still correct
code — they are simply always evaluated for an administrator, so they return
everything.

They remain covered directly, without a transport, for all six kinds of identity
the algorithm supports (admin, lead, member, two client portals and a partner):
`search-scope.test.mjs` → *scope: …*. This matters because the alternative —
deleting the predicates — would mean two divergent query paths and no test at all.

## 4. Transport and deployment

| Control | Status |
| --- | --- |
| TLS | Terminated by the platform. `Secure` cookie attributes are moot: there is no cookie. |
| CORS | Same-origin by default; `CORS_ORIGIN` narrows it. `credentials: true` was removed, because nothing is credential-bearing. |
| Helmet | Enabled, unchanged. |
| Rate limits | Enabled, unchanged. |
| Secrets in the client bundle | No secret is read by the frontend. Nothing `VITE_*`-prefixed is a secret. |
| Health endpoints | Anonymous, and expose no user data — `auth.test.mjs` → *operational probes stay anonymous and expose no user data* |

## 5. Known gaps

Stated plainly, because a security document that omits them is worse than none.

1. **No access control at the application layer.** Anyone with the URL can read and
   write every record. This is the deliberate consequence of the removal and the
   largest gap by far. It must be compensated at the hosting layer; nothing in this
   repository does so.

2. **SQLite without `DATABASE_URL` is not durable.** Data lives in the instance's
   temporary directory and is lost on cold start, and concurrent instances do not
   see each other's writes. `/api/ready` reports `"engine":"sqlite"` so this is
   detectable rather than silent.

3. **No per-person audit trail.** Every action is attributed to the operator.

4. **The frontend render checks are `renderToStaticMarkup`, not a browser.** They
   prove the components produce HTML for real API data; they do not prove event
   handlers, routing or focus behaviour in a browser. The HTTP-level behaviour
   behind them *is* tested against a real server.

5. **No live OIDC provider is tested** — the OIDC path was removed with the rest of
   authentication. The deleted `test-idp.ts` helper is recoverable from git history
   if the flow is ever restored.

6. **The backup and restore drill covers SQLite.** PostgreSQL conformance is
   covered by migrations and the full test suite against a real PostgreSQL 16
   instance, but a production-size restore has not been rehearsed on PostgreSQL.
