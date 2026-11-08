# Authentication removal

RelayOS runs here as a **single-tenant, unauthenticated internal application**.
There is no sign-in page, no session, no CSRF token and no credential. `/` opens
the dashboard directly, and every API request is attributed to one configured
operator.

This document records what was removed, why each removal is safe *as a removal*
rather than merely convenient, what protection was genuinely lost, and what has to
compensate for it. It is deliberately blunt about the last part: the honest
consequence of this change is that **the API no longer has a security boundary of
its own**, and pretending otherwise would be worse than the removal.

## Why

Two prior releases attempted to repair the deployed sign-in and failed, because the
failure was never in the sign-in itself. The API refused to boot when
`SESSION_SECRET` was absent, and the resulting request-level failure was a
non-JSON 500 — so the frontend, unable to read an error, showed a blank page behind
a gate that could not be passed. The root cause of *that* (a statically imported
version-gated built-in) was fixed, but the deeper problem remains: an
authentication system that can lock the owner out of their own deployment is a
liability when the deployment is one studio's private tool.

The instruction was to remove it completely. That is what this change does.

## What was removed

| Removed | Was | Why its removal is safe |
| --- | --- | --- |
| `apps/web/src/pages/SignIn.tsx` | The sign-in screen: password form, demo identity picker, deployment-failure copy. | Nothing else rendered it. The failure copy moved to `components/ApiFailure.tsx`, which every page already renders inline — so a broken API is now explained *inside* the product rather than instead of it. |
| `SessionGate` in `App.tsx` | Rendered nothing until `GET /api/auth/session` succeeded, and a sign-in screen when it failed. | This was the mechanism that turned an API failure into a locked door. The startup probe is now advisory: `Shell` falls back to the values `/api/meta` already returns, and the dashboard renders either way. |
| `apps/api/src/routes/auth.ts`, `password-login.ts` | Login, dev-login, logout, OIDC start/callback, session probe, user picker. | Every one of them existed to establish or describe a session. The retired paths answer `410 Gone` rather than 404, so a stale bookmark is diagnosable rather than mysterious. |
| `apps/api/src/auth/oidc.ts`, `provision.ts`, `password.ts` | OIDC authorization-code + PKCE, credential provisioning from the environment, Argon2id hashing and verification. | No request needs them. Their removal also removes the native `argon2` binding from the dependency graph entirely — the second instance of the bug class that caused the blank 500. |
| Session middleware in `auth/middleware.ts` | Cookie parsing, session lookup and expiry, bearer tokens, CSRF validation, dev-identity header trust, per-route allowlist. | See below — this is the one whose removal has a real cost. |
| CSRF token plumbing | Token issued on login, cached in memory in `lib/api.ts`, sent as `x-csrf-token`, verified per mutation. | CSRF protects against a third party riding a **victim's ambient cookie**. No cookie is set, so there is no ambient authority to ride. The check was protecting nothing, and leaving it would have implied a boundary that does not exist. |
| Auth-mode resolution | `AUTH_MODE` (`auto`/`dev`/`password`/`oidc`), the production refusal, `ALLOW_DEV_AUTH_IN_PRODUCTION` escape hatch. | This is what turned a missing variable into a dead deployment. |
| `assertStaticAuthConfiguration` / `assertAuthConfiguration` | Threw before the first database connection when `SESSION_SECRET` was absent or a credential malformed. | A fail-fast is correct when the credential is load-bearing. It is an outage when it is not. |
| `AUTH_EXPIRED_EVENT` and the `401` → navigate-to-sign-in handler | Any 401 dispatched an event that returned the whole application to the sign-in screen. | With no sign-in screen there is nowhere to return to. A 401 is now reported to the component that asked, which is the only place that can do anything about it. |
| Sign-out control in `Shell.tsx` | A button that called `auth.logout()` and reloaded. | It would have reloaded into the same dashboard. A control that does nothing implies a security boundary that does not exist, and someone will trust it. |
| `credentials: true` and `x-csrf-token` in CORS | Advertised cookie and CSRF semantics cross-origin. | Nothing sends either. Keeping the advertisement invites a future client to implement a token no server checks. |

## What was deliberately kept, and why

**A fixed operator identity.** Deleting identity entirely was the obvious move and
the wrong one. `created_by`, `reporter_id`, `auth_events.actor_id` and the
lifecycle transition log are foreign keys to `users`; writing `NULL` there would
violate constraints or leave the audit trail unable to name anyone. Identity also
drives `resolveReadScope` and `projectsWhere`. So a single operator is resolved
once per process — `OPERATOR_USER_ID`, else the first administrator, else any user
— and attached to every request by `auth/operator-middleware.ts`.

The consequence, stated plainly: **every write is attributed to the operator, and
the audit trail therefore names one person for all of them.** It records *that*
something happened and *when*, which is most of its value, but it can no longer
attribute an action to a colleague. On a single-operator deployment that is
accurate; it would be a lie on a shared one.

**The scope predicates.** `resolveReadScope`, `projectsWhere`, `tasksWhere`,
`docsWhere`, `clientsWhere`, `dealsWhere` and `assertProjectInScope` are untouched
and still run on every request. The operator is an administrator, so the answer is
always "everything" — but the *code path* is the one with tests, and there is no
second, divergent unscoped query path to drift out of sync. Those predicates are
still covered directly in `apps/api/test/search-scope.test.mjs`.

**`requireRole` and `requireProjectAccess` as pass-throughs.** Both are now no-ops
that return the acting user. Deleting them from their 21 call sites would have
produced a larger diff, obscured which operations were once privileged, and created
21 chances to alter a mutation's logic while editing its guard.

**Every business rule.** Validation, database constraints, state machines, SLA
arithmetic, turnover gates, ship gates, the lifecycle transition rules, rate
limiting, and `CRON_SECRET` on `/api/cron/sweep` are all unchanged. `CRON_SECRET` in
particular is *not* user authentication — it guards an endpoint that mutates SLA
state on demand, and removing it would leave an open endpoint, which is strictly
worse than an unreachable one.

## What protection was actually lost

This is the section that matters. Each row is a real capability that existed
before and does not now.

| Protection | Consequence now |
| --- | --- |
| **Anyone who can reach the URL can read and write everything.** | Clients, commercial pipeline, legal documents, partner consoles, all projects. |
| **Cross-tenant isolation between client portal users.** | A client could previously only see its own organisation's client-visible work. There is no client identity to confine, so anything marked internal is readable by anyone who reaches the app. |
| **Partner console tenancy.** | Previously partner A could not read partner B (answered 404 to avoid confirming existence). The queries are still partitioned by `partner_id`, so data does not *bleed* between partners — but every partner's console is reachable by every caller. |
| **Role separation for privileged actions.** | Waiving a turnover gate, shipping a release, granting a lifecycle exception, changing commercial state of a legal document: all were role-checked, none are now. Each is still recorded with a reason and an actor. |
| **Accountability per person.** | See above: every action is attributed to the operator. |
| **Session revocation.** | N/A — there is nothing to revoke, and equally no way to cut off a specific client. |

**The compensating control has to be outside this application.** Put it behind one
of:

- **Vercel Deployment Protection** (password, Vercel Authentication, or trusted
  IPs) — the smallest change, and it covers both services because it applies to the
  deployment, not to a route.
- An **SSO proxy** in front of the domain, if the organisation already has one.
- A **private network** or IP allowlist, if the deployment is internal-only.

None of these is configured by this repository, and none can be verified from here.
Until one is, treat the deployment URL as **public**.

## Verification

The behaviour is covered by tests that assert the new model rather than the old
one — inverted where the old assertion encoded the exact bug:

- `apps/api/test/auth.test.mjs` — every business route answers an anonymous
  caller; writes succeed with no cookie or CSRF token; mutations are attributed to
  a real `users` row; input validation, `404`s and database constraints still
  refuse; login endpoints answer `410`.
- `apps/api/test/vercel.test.mjs` — an instance with **no authentication
  environment at all** boots and serves; a stale `AUTH_MODE` changes nothing; a
  malformed credential cannot prevent boot; a cold start with no database
  configures itself, seeds itself and serves data; `/api/cron/sweep` is still
  closed without the bearer secret.
- `apps/api/test/search-scope.test.mjs` — the scope predicates, exercised directly
  for all six kinds of identity the algorithm still supports.
- `apps/api/test/lifecycle.test.mjs`, `partners.test.mjs`, `comms-legal.test.mjs`,
  `shipgate.test.mjs` — role assertions replaced with the invariants that still
  hold: state-machine ordering, mandatory reasons and evidence, mandatory
  attribution, query-level partitioning.
- `scripts/smoke-web.mjs` — all 13 screens still render against the live API, and
  `ApiFailure` still distinguishes a misconfiguration from an unreachable API.

Removed tests, and why their coverage did not simply vanish:

| Removed | Covered instead by |
| --- | --- |
| `oidc-flow.test.mjs` (20 tests) | Nothing — the feature is gone. `tests/helpers/test-idp.ts` was deleted with it. |
| `password-login.test.mjs` (20 tests) | `auth.test.mjs` asserts the endpoints answer `410`. |

## Reversal

If authentication is ever wanted again, the useful starting point is the git
history: `git log --diff-filter=D -- apps/api/src/auth/oidc.ts` and
`git log -- apps/api/src/auth/middleware.ts`. What must **not** be done is to
reintroduce a gate that can lock the owner out of a deployment whose database is
unseeded — the specific failure this change exists to end. Any replacement should
fail *open* on a configuration problem, and say what is wrong, rather than fail
closed with a blank page.
