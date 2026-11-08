# Delivery pipeline — the operating contract

This is the pipeline the product encodes, traced back to the delivery-ops
Excaliboard. Everything here is implemented as data and enforcement, not prose.

## Stage 1 — Initial consultation

| Field | Value |
| --- | --- |
| Owner | Growth lead (PM role) |
| Goal | Understand the client, the business, and the infrastructure they already run |
| Must establish | Value proposition fit · hosting/cloud reality · who their CTO or head of engineering is |
| Exit | Decision-maker identified and a technical consultation is booked |
| Clock | Lead triage — 24h (qualify or decline) |

## Stage 2 — Technical consultation

| Field | Value |
| --- | --- |
| Owner | CTO / HoE + delivery lead |
| Goal | Technical requirements, codebase and infrastructure audit, where we can actually help |
| Artefact | Initial product specification + systems map on **Excaliboard** |
| Exit | Spec drafted; risks and unknowns recorded |
| Clock | **Consultation → implementation plan: 72h hard** |

This is the first place the product creates value and the first place a slow
turnaround loses the deal — hence the hardest clock in the system.

## Stage 3 — Dev meeting & project planning

- Decide whether a second engineering session is required.
- Discuss human capital and required modules.
- **Create the dedicated agile board** for the project (`POST /projects` →
  board + columns + phase spine instantiated).
- CTO and HoE split implementation responsibility explicitly, with named owners.

Exit: phases scheduled, owners assigned, board live.

## Stage 4 — Client approval & kickoff

- Send the implementation plan with the phase turnover gates attached.
- Approved without major changes → kickoff starts immediately.
- Major changes → revise and return **within 12–32 hours** (`plan-revision`
  clock; 32h hard ceiling, 12h stretch).
- Create the client communication channel (WhatsApp group / shared channel) and
  record it as the system of record for decisions.

## Stage 5 — Development & QA

- Work branches from the designated project branch (`lear-backend`).
- Each module and each milestone is tested before turnover.
- QA submits bug and testing reports **within 12 hours** of the pass.
- Continuous passive feedback: weekly demo, written summary, no silent weeks.

Gates in play: `TG-01..06` (task), phase gates for architecture/design/build,
plus the edge-case ledger.

## Stage 6 — Client delivery & turnover

| Turnover | Limit | Clock |
| --- | --- | --- |
| Module | ≤ 1 day | `module-turnover` 24h |
| Milestone | ≤ 1 week | `milestone-turnover` 168h |
| Client turnover | ≤ 2 weeks (target 1 week) | `client-turnover` 336h |
| First demo | ≤ 2 weeks from kickoff | `first-demo` 336h |
| Ship after approval | ≤ 5 days | `ship-after-approval` 120h |

Before shipping, the **executive summary** must exist **at least 2 days** before
the proposed ship date (`exec-summary` 96h), alongside the edge-case report and
the written demo approval.

## Stage 7 — Post-deployment

- OTA updates and release notes.
- Maintenance, uptime monitoring, incident response.
- Client usage and API consumption tracking per partner.
- Partner-specific console: IAM users, device licences, quota, seats.

## The acceptance ladder (applies to every stage)

```
dev_complete → qa_approved → lead_approved → client_accepted
```

A module that is *dev complete* has not been accepted for turnover. The system
refuses `done` until the QAB step and the appropriate lead/client step are
recorded with evidence.

## Ship gate (per project)

1. 3,500 edge cases catalogued.
2. 90% of them verified.
3. No open P0/P1 QA reports.
4. Executive summary published.
5. Client acceptance recorded.

All five are visible on the project page and computed server-side.

## Exceptions

Anything missed is recorded, not erased:

- A grey deadline becomes `missed` with a timestamp.
- Waiving requires `admin`/`lead` and a written note.
- The exception note is shown on the clocks console and in the audit log.

The point is not to punish lateness; it is to make the promise legible.
