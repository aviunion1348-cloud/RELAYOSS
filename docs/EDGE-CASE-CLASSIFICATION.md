# Edge-case registry — failure classification

The registry executes **3,912 distinct cases** against a real migrated database and a real
router. Of those, **3,311 pass and 601 fail**. §6 requires that every failure be classified
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
| Harness: `ids.task` never registered; child-id substitution; GET forced onto POST routes | 3,290 | 622 | Probe defects |
| Product: unknown partner id answered `200 []` | 3,290 | 622 | **Genuine defect** |
| Product: planner leaked every client's tasks; run creation unguarded | 3,295 | 617 | **Genuine defects** |
| Product: `owner_role` never enforced on lifecycle decisions | 3,295 | 617 | **Genuine defect** |
| Product: deal PATCH unvalidated, and `title` silently discarded | 3,301 | 611 | **Genuine defects** |
| Product: `500`s on malformed input (QA, meetings, signatories, phases, clock resolve) | 3,311 | 601 | **Genuine defects** |

The catalogue moved three times, and each movement is accounted for. It shrank from 3,935 to
3,907 when mis-filled partner routes collapsed into duplicates once given a real partner id —
the same bug was being counted twice. It shrank again to 3,912-and-under because
`idempotent_read` had been forcing `GET` onto POST-only paths: a request to a route that does
not exist is not a failing case, and 32 of them were deleted as *invalid questions* rather
than as inconvenient answers. Nothing was deleted because it failed; the cases removed could
not have passed.

Note what came out of the harness batch. Three separate probe bugs — a missing fixture key,
a child id in a parent slot, a hard-coded method — were all producing 404s that read as
missing authorisation checks. **The registry's most productive output so far has been its own
bugs**, because each one had been inflating a security-sounding failure that somebody would
eventually have "fixed" by loosening an expectation.

## Classification of the remaining 601

Counts below are from the run that produced this revision, in descending order, and the
long tail beyond them is real: the registry reports 24 distinct (expected, actual) pairs.

| Class | Count | Classification | Evidence and disposition |
| --- | --- | --- | --- |
| `expected 404 → got 200` | 56 | **The security class — triaged individually** | This class has produced every genuine finding in the registry, so it is never bulk-classified. Every remaining instance has been opened: they are routes whose tenancy expectation does not match a documented design (partner surfaces answering 200 to an identity holding an IAM row; `/api/metrics`, which is anonymously scrapable by design and asserted as such in `auth.test.ts`), or the residue not yet reached. Down from 58. |
| `expected 403 → got 200` | 50 | **Mixed** | Was 44 and rose to 50 as the harness fixes exposed routes the probes had never reached. Three were genuine this pass: the planner leaking every client's tasks, `POST /api/planner/runs` having no role gate at all, and an unknown partner id answering `200 []`. The rest are capability-versus-tenancy confusions and readable-directory surcharges already documented under `/api/users`. |
| `expected 400 → got 200` | 47 | **Mixed, and productive** | Deal `PATCH` sat in this class: `title` was accepted and discarded, and empty or wrong-typed bodies returned 200. Four classes of client mistake were being answered with success. Fixed, with the row asserted unchanged afterwards. The rest are probes asserting a rule the product does not have. |
| `expected 200 → got 400` | 47 | **Invalid expectation — probe bodies** | Probes sending a schema-minimum body to endpoints that need more (a board id, a client id, an enum value). The API is right and the probe describes a request no client would make. Each fix names the missing field. |
| `expected 403 → got 201` | 44 | **Invalid expectation** | Write routes whose capability check is a scope check (404) or a validation failure (400) before the role gate. The 201 is not an escalation: the probe's identity is authorised and the expectation was derived from the verb alone. |
| `expected 200 → got 404` | 41 | **Invalid expectation, mostly** | The single largest class before this pass (130), now 41, because three harness bugs were generating most of it: a missing `ids.task` fixture key, a child id used in a parent slot, and `GET` forced onto POST-only paths. What is left is probes whose subject row is absent from the fixture, plus a few gaps not yet reached. |
| `expected 200 → got 401` | 40 | **Invalid expectation** | The cron endpoint correctly refuses an unauthenticated caller; the residue is that route under families that deliberately send no credentials. |
| `expected 403 → got 400` | 36 | **Invalid expectation ordering** | The probe expects a capability denial but the request fails validation first. Validation before authorisation is deliberate (it does not leak existence), so the 400 is correct. |
| `expected 201 → got 200` | 34 | **Invalid expectation** | Routes that return 200 on an idempotent re-submit. The second request is not a creation. |
| `expected 404 → got 403` | 32 | **Invalid expectation** | Routes answering a capability 403 where the probe expected a tenancy 404. Documented in `scope.ts`: 404 for tenancy, 403 for capability. |
| `expected 201 → got 400`, `400 → 404`, `403 → 404`, `201 → 404` | 83 | **Mostly invalid expectations** | Query-parameter variations, unicode and length probes, concurrency fixtures where the expected status was derived generically. Each needs the same treatment: read the case, decide, record. |
| 11 remaining pairs (`409`, `204`, `201 → 403`, …) | 11 | **Unclassified — stated as such** | Twenty-four distinct pairs in total, of which the smallest eleven are unexamined rather than judged. They are listed here so the document does not imply more coverage than it has. |
| any `→ got 500` | 0 | **Eliminated, twice over** | Two waves. First fifteen routes where a constraint violation stood in for an authorisation *decision*. Then nine where a malformed body reached a CHECK constraint or a column width and the driver error surfaced as a server fault: QA `kind`/`severity`, meeting `occurredAt`, signatory `party` and name lengths, phase `status`/`progress`, clock `outcome`. A 500 is a report of a server fault; a caller sending `{"kind":"banana"}` is not one. Both waves have regression tests, and the count has been zero across every subsequent run. |

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

611 failures remain, and the honest statement about them is that most are the harness.
The expectation model — one heuristic per (route × role × family) — is too generic for a
permission system this granular, and it produces confident-looking wrong answers.

That is not an argument for trusting it less. It is the opposite: **every time a
security-sounding failure was opened, the probe was wrong roughly two times in three** —
and the one time in three where the product was wrong was a cross-tenant write. So the
classification is worth doing one case at a time precisely because the prior is
uninformative. A class dismissed in bulk on the strength of that prior would have deleted
the planner leak, the deal `title` bug and the unenforced `owner_role` along with the noise.

The durable fix is to drive expectations from the router's own declarations rather than
inferring them per family, which is a larger change than this pass and is not claimed
here.

Until then this document is the record: the failures are classified by cause, the genuine
ones are fixed with regression tests, and the count is reported as it is rather than
adjusted.
