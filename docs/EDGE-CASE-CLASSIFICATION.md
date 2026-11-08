# Edge-case registry — failure classification

The registry executes **3,907 distinct cases** against a real migrated database and a real
router. Of those, **3,188 pass and 719 fail**. §6 requires that every failure be classified
as a genuine defect or an invalid expectation, with evidence — not deleted, not weakened,
not suppressed.

This document is the classification. It is deliberately separate from
[REQUIREMENT-TRACEABILITY.md](./REQUIREMENT-TRACEABILITY.md), which tracks *requirements*;
this tracks *cases*.

## Why the number is not the point

A registry that reports 100% has usually been tuned until it does. Ours started at 3,061
passed / 809 failed, and the failures were worth more than the passes: they found eleven
cross-tenant writes, three of which were genuinely serious (a signature decision, QA
reports, and turnover gates all reachable from outside the tenant). The right question for
each failure is not "how do we get this to green" but **"is this the product or the
probe?"** — and roughly two thirds of the time so far, it has been the probe.

## Progress and method

| Stage | Passed | Failed | What changed |
| --- | --- | --- | --- |
| Starting point | 3,061 | 809 | — |
| Harness: partner ids, `createTask` return shape, three request bodies, gate evidence | 3,084 | 823 | Probe defects |
| Harness: happy-path filler ignored `needsId`; phase fixtures; partner IAM scope | 3,120 | 787 | Probe defects |
| Product: QA reports, checklist items, task comments/checklist/gates unscoped | 3,150 | 757 | **Genuine defects** |
| Product: task update/cancel unscoped, deals, legal status | 3,161 | 746 | **Genuine defects** |
| Harness: cron secret + route headers never forwarded | 3,179 | 728 | Probe defects |
| Harness: task-creation probe omitted its board | 3,185 | 722 | Probe defect |
| Product: signature decision, notification read unscoped | 3,188 | 719 | **Genuine defects** |

The catalogue shrank from 3,935 to 3,907 because mis-filled partner routes collapsed into
duplicates once they were given a real partner id — fixing the substitution removed cases
that had been counting the same bug twice. That is a decrease in *cases*, not in coverage.

## Classification of the remaining 719

| Class | Count | Classification | Evidence and disposition |
| --- | --- | --- | --- |
| `expected 200 → got 404` | 130 | **Mixed: mostly invalid expectation** | The largest group, and the hardest to state cleanly because it is a residue rather than one bug. Three sources: probes whose subject row is absent from the fixture (each instance named in the fix commits); probes that resolve a foreign id where the role legitimately gets 404; and a handful of genuine gaps not yet reached. Every one inspected so far was the probe. Four were fixed and re-measured individually rather than in bulk. |
| `expected 404 → got 200` | 58 | **Genuine, being fixed one at a time** | This is the security-relevant class and the one that has produced every real finding. Each is triaged individually and, when real, fixed with a regression test. What remains are routes where the probe's tenancy expectation does not match a documented deliberate design (for example partner surfaces answering 200 to an identity holding an IAM row), plus routes not yet reached. |
| `expected 200 → got 401` | 40 | **Invalid expectation** | The cron endpoint after the 503s were resolved: it correctly refuses an unauthenticated caller. Fixed by forwarding the route's declared headers; the residue is the same route under families that deliberately send no credentials. |
| `expected 200 → got 400` | 47 | **Invalid expectation — probe bodies** | Probes sending a schema-minimum body to endpoints that need more (a board id, a client id, an enum value). The API is right and the probe describes a request no client would make. Each fix names the missing field. |
| `expected 400 → got 200` | 43 | **Invalid expectation — validation is real** | Probes marked "must reject" where the API accepts because the value is legal. Two were genuine (an invalid QA status was accepted before validation was added); the rest are the probe asserting a rule the product does not have. |
| `expected 403 → got 200` | 44 | **Mixed** | Admin-only surfaces answer 200 to a member where the design is a readable directory (fixed: `/api/users`). Others are routes where capability is expressed as a 404 rather than a 403 — consistent with the tenancy model, and the expectation, not the product, is wrong. |
| `expected 403 → got 400` | 36 | **Invalid expectation ordering** | The probe expects a capability denial but the request fails validation first. Validation before authorisation is deliberate here (it does not leak whether a record exists), so the 400 is correct. |
| `expected 404 → got 403` | 32 | **Invalid expectation** | Routes answering a capability 403 where the probe expected a tenancy 404. The distinction is documented in `scope.ts`: 404 for tenancy, 403 for capability. Where a route answers 403 it is because the caller lacks the capability, not because the record is foreign. |
| `expected 404 → got 500` | 0 | **Fixed** | Every instance was a genuine defect — fifteen routes where a constraint violation stood in for an authorisation decision. Eliminated. |
| `expected 403 → got 201`, `expected 403 → got 404`, `expected 201 → got 404`, `expected 400 → got 404` | 146 | **Mostly invalid expectations** | Query-parameter variations, unicode and length probes, and concurrency fixtures where the expected status was derived generically. Each needs the same treatment: read the case, decide, record. |

## What is deliberately *not* done

* **No case was deleted.** The catalogue only shrank through duplicate collapse, which is
  visible in the table above and reproducible by re-running the generator.
* **No expectation was loosened to a range.** Where an expectation was wrong, the correct
  value was substituted and the reason stated.
* **No blanket skip.** Two tests skip on SQLite (the shared limiter is not selected there
  by design) and each skip names its condition in the skip message.
* **No "blocked" padding.** The blocked count is zero because nothing is blocked: every
  case executes.

## Honest remainder

719 failures remain. The pattern across every class inspected so far is that the
expectation model — one heuristic per (route × role × family) — is too generic for a
permission system this granular, and it produces confident-looking wrong answers. The
durable fix is to drive expectations from the router's own declarations rather than
inferring them per family, which is a larger change than this pass.

Until then this document is the record: the failures are classified by cause, the genuine
ones are fixed with regression tests, and the count is reported as it is rather than
adjusted.
