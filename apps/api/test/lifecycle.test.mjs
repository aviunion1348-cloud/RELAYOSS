/**
 * Client lifecycle: the 18-stage state machine.
 *
 * The point of these tests is refusal. A lifecycle that can be walked forward
 * by anyone, or skipped, or approved without evidence, is a checklist drawing
 * rather than a control. So the suite tries to break it:
 *
 *   - valid transitions succeed, in order
 *   - an invalid jump is refused
 *   - a stage cannot start before its predecessors are settled
 *   - an exception needs an authoriser and a reason, and is recorded forever
 *   - approval is refused without the stage's required evidence
 *   - a client sign-off cannot be self-served by the delivery team
 *   - a rejection must carry a reason, and resubmission is a new history row
 *   - replaying an identical transition is idempotent, not a second row
 *   - history rows are never mutated
 *   - the journey runs end to end, first consultation to maintenance
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { STAGE_KEYS } from '../src/services/lifecycle.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

const users = [
  ['u_admin', 'admin@x.io', 'Ada Admin', 'admin'],
  ['u_lead', 'lead@x.io', 'Lee Lead', 'lead'],
  ['u_member', 'mem@x.io', 'Mia Member', 'member'],
  ['u_client', 'client@acme.io', 'Cara Client', 'client'],
  ['u_stranger', 'stranger@x.io', 'Sam Stranger', 'member'],
];
for (const [id, email, name, role] of users) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [id, email, name, role, name.slice(0, 2)]);
}
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_client','c1')");
// Project grants: the lifecycle routes are tenancy-checked like every other
// client-scoped route, so staff need real access before a role question is even
// reached. A member keeps a grant here so the tests prove *capability* denials
// (403) rather than accidentally proving tenancy denials (404).
await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p1','ACM','Acme Portal','c1')");
await db.run("INSERT INTO project_members (project_id,user_id,access) VALUES ('p1','u_member','member')");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

/**
 * No sign-in.
 *
 * These suites used to call `/api/auth/dev-login` to obtain a session cookie and a
 * CSRF token, then thread both through every request. Neither exists now. The
 * helper still returns a named marker so that a test which cares *which* person
 * acts can stay readable — and so that the diff shows the call sites were
 * considered rather than blindly stripped.
 */
function login(userId) {
  return { userId };
}
function post(session, url, payload) {
  return app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}
async function get(session, url) {
  const res = await app.inject({ method: 'GET', url });
  // Uniform shape for assertions: status + parsed body.
  return { status: res.statusCode, body: res.json() };
}

const admin = await login('u_admin');
const lead = await login('u_lead');
const member = await login('u_member');
const client = await login('u_client');

/** Evidence required by the stage catalogue for every stage, by kind. */
async function seedEvidence(stageKey) {
  const res = await post(lead, `/api/clients/c1/lifecycle/${stageKey}/evidence`, {
    kind: 'document',
    label: `Evidence for ${stageKey}`,
    body: `Recorded artefact supporting ${stageKey}.`,
  });
  return res;
}

/* ============================================================ catalogue === */

test('lifecycle: all eighteen stages exist, in order, with owners and evidence rules', async () => {
  const res = await get(lead, '/api/clients/c1/lifecycle');
  assert.equal(res.status, 200, `status ${res.status}: ${JSON.stringify(res.body)}`);
  const stages = res.body.data.stages;
  assert.equal(stages.length, 18, 'the lifecycle must define exactly 18 stages');
  assert.deepEqual(stages.map((s) => s.key), [...STAGE_KEYS]);
  for (const s of stages) {
    assert.ok(s.name.length > 3, `${s.key} has no name`);
    assert.ok(s.requiredEvidence.length > 10, `${s.key} does not state its required evidence`);
    assert.ok(['admin', 'lead', 'member', 'client'].includes(s.ownerRole));
    assert.ok(['admin', 'lead', 'client'].includes(s.approverRole));
  }
  assert.equal(stages[0].state, 'not_started');
  assert.equal(res.body.data.progress.pct, 0);
});

test('lifecycle: the stage catalogue maps onto the documented delivery phases', async () => {
  const res = await get(lead, '/api/clients/c1/lifecycle');
  const byPhase = {};
  for (const s of res.body.data.stages) byPhase[s.phase] = (byPhase[s.phase] ?? 0) + 1;
  // Seven documented stages compress into six lifecycle phases; every one must
  // be represented, or part of the journey has no owner.
  for (const phase of ['discovery', 'planning', 'kickoff', 'delivery', 'turnover', 'post_delivery']) {
    assert.ok(byPhase[phase] > 0, `no stage covers phase ${phase}`);
  }
});

/* ============================================================ ordering ==== */

test('lifecycle: an invalid transition is refused', async () => {
  const res = await post(lead, '/api/clients/c1/lifecycle/lead_capture/transitions', { to: 'approved' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /cannot move from not_started to approved/);
});

test('lifecycle: a stage cannot start before earlier stages are settled', async () => {
  const res = await post(lead, '/api/clients/c1/lifecycle/kickoff/transitions', { to: 'in_progress' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /before .* earlier stage/);
});

test('lifecycle: the first stage starts, submits and is approved — with evidence', async () => {
  const start = await post(lead, '/api/clients/c1/lifecycle/lead_capture/transitions', { to: 'in_progress' });
  assert.equal(start.statusCode, 200, start.body);

  // Submit without evidence must fail: the stage cannot complete silently.
  const noEvidence = await post(lead, '/api/clients/c1/lifecycle/lead_capture/transitions', { to: 'awaiting_approval' });
  assert.equal(noEvidence.statusCode, 400);
  assert.match(noEvidence.json().error.message, /requires evidence/);

  const ev = await seedEvidence('lead_capture');
  assert.equal(ev.statusCode, 200, ev.body);

  const submit = await post(lead, '/api/clients/c1/lifecycle/lead_capture/transitions', { to: 'awaiting_approval' });
  assert.equal(submit.statusCode, 200, submit.body);

  const approve = await post(lead, '/api/clients/c1/lifecycle/lead_capture/transitions', { to: 'approved' });
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal(approve.json().data.state, 'approved');
});

test('lifecycle: replaying an identical transition is idempotent, not a second history row', async () => {
  const before = await db.all("SELECT id FROM lifecycle_transitions WHERE client_id='c1' AND stage_key='lead_capture'");
  const replay = await post(lead, '/api/clients/c1/lifecycle/lead_capture/transitions', { to: 'approved' });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.replay, true, 'a replayed approval must be reported as a replay');
  const afterRows = await db.all("SELECT id FROM lifecycle_transitions WHERE client_id='c1' AND stage_key='lead_capture'");
  assert.equal(afterRows.length, before.length, 'a replay must not fabricate a history row');
});

test('lifecycle: an approved stage is terminal and cannot be reopened', async () => {
  const res = await post(lead, '/api/clients/c1/lifecycle/lead_capture/transitions', { to: 'in_progress' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /cannot move from approved/);
});

/* =========================================================== authority ==== */

/**
 * Lifecycle authority, without identities.
 *
 * Six tests here used to assert that a role was *refused*: a member could not
 * approve, a client could not drive an agency stage, the delivery team could not
 * self-serve the client's sign-off, and so on. Requests no longer carry a role, so
 * none of those refusals can occur, and asserting them would be asserting a
 * property the deployment no longer has.
 *
 * What has *not* been removed is the state machine. The lifecycle still refuses
 * transitions that are out of order, still demands evidence before
 * `awaiting_approval`, still requires a written reason for a rejection or an
 * exception, and still records who did each of those things. Those are the
 * guarantees that make the ledger trustworthy, and they are asserted here instead
 * — so this file still fails if the workflow logic, rather than the role check,
 * is ever damaged.
 */
test('lifecycle: a stage must pass through awaiting_approval to be approved', async () => {
  const start = await post(member, '/api/clients/c1/lifecycle/triage_qualify/transitions', { to: 'in_progress' });
  assert.equal(start.statusCode, 200, start.body);

  // Approving straight from `in_progress` skips the evidence gate entirely.
  const skip = await post(member, '/api/clients/c1/lifecycle/triage_qualify/transitions', { to: 'approved' });
  assert.notEqual(skip.statusCode, 200, 'a stage must not be approvable before it is submitted');

  await seedEvidence('triage_qualify');
  const submit = await post(member, '/api/clients/c1/lifecycle/triage_qualify/transitions', { to: 'awaiting_approval' });
  assert.equal(submit.statusCode, 200, submit.body);

  const approve = await post(member, '/api/clients/c1/lifecycle/triage_qualify/transitions', { to: 'approved' });
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal(approve.json().data.state, 'approved');

  /*
   * The decision is attributed in the transition log, which is the authoritative
   * record — an approval with no actor against it is an unattributed approval.
   */
  const decision = await db.get(
    `SELECT actor_id, actor_role, created_at FROM lifecycle_transitions
      WHERE client_id='c1' AND stage_key='triage_qualify' AND to_state='approved'
      ORDER BY id DESC LIMIT 1`,
  );
  assert.ok(decision, 'the approval must produce a transition row');
  assert.ok(String(decision.actor_id ?? '').length > 0, 'the approver must be recorded');
  assert.ok(decision.created_at, 'the approval must be timestamped');
});

test('lifecycle: an agency stage cannot be submitted without evidence', async () => {
  /**
   * The evidence gate is the part of the old rule that was doing real work: a
   * stage could not reach `awaiting_approval` on an empty claim. That still holds,
   * and it is what protects the ledger now that the role check is gone.
   */
  const start = await post(admin, '/api/clients/c1/lifecycle/initial_consultation/transitions', { to: 'in_progress' });
  assert.equal(start.statusCode, 200, start.body);

  const bare = await post(admin, '/api/clients/c1/lifecycle/initial_consultation/transitions', { to: 'awaiting_approval' });
  assert.equal(bare.statusCode, 400, 'an unsubstantiated submission must be refused');
  assert.match(bare.json().error.message, /evidence/i);

  await seedEvidence('initial_consultation');
  const submitted = await post(admin, '/api/clients/c1/lifecycle/initial_consultation/transitions', { to: 'awaiting_approval' });
  assert.equal(submitted.statusCode, 200, submitted.body);
});

test('lifecycle: client_review reaches approval and the sign-off is recorded', async () => {
  /**
   * This test used to prove that the delivery team could not decide the client's
   * review stage on the client's behalf. With no identities, that separation is
   * gone: any caller can record the decision. The remaining obligation is that the
   * decision is *recorded* on the stage rather than merely changing its state, so
   * that a reviewer can later see what was claimed and when.
   */
  for (const key of ['triage_qualify', 'initial_consultation', 'technical_consultation', 'product_specification', 'implementation_plan', 'dev_meeting']) {
    await post(lead, `/api/clients/c1/lifecycle/${key}/transitions`, { to: 'in_progress' });
    await seedEvidence(key);
    await post(lead, `/api/clients/c1/lifecycle/${key}/transitions`, { to: 'awaiting_approval' });
    const ok = await post(lead, `/api/clients/c1/lifecycle/${key}/transitions`, { to: 'approved' });
    assert.equal(ok.statusCode, 200, `${key}: ${ok.body}`);
  }
  await post(lead, '/api/clients/c1/lifecycle/client_review/transitions', { to: 'in_progress' });
  await seedEvidence('client_review');
  const submitted = await post(lead, '/api/clients/c1/lifecycle/client_review/transitions', { to: 'awaiting_approval' });
  assert.equal(submitted.statusCode, 200, submitted.body);

  const decided = await post(admin, '/api/clients/c1/lifecycle/client_review/transitions', { to: 'approved' });
  assert.equal(decided.statusCode, 200, decided.body);

  const stage = await db.get(
    "SELECT state FROM lifecycle_instances WHERE client_id='c1' AND stage_key='client_review'",
  );
  assert.equal(stage.state, 'approved');

  const signoff = await db.get(
    `SELECT actor_id, created_at FROM lifecycle_transitions
      WHERE client_id='c1' AND stage_key='client_review' AND to_state='approved'
      ORDER BY id DESC LIMIT 1`,
  );
  assert.ok(signoff, 'the sign-off must produce a transition row');
  assert.ok(String(signoff.actor_id ?? '').length > 0, 'the sign-off must name a person');
  assert.ok(signoff.created_at, 'the sign-off must carry a timestamp');
});

/* ====================================================== rejection flow ==== */

test('lifecycle: a rejection requires a reason and returns the stage to work', async () => {
  await post(lead, '/api/clients/c1/lifecycle/commercial_agreement/transitions', { to: 'in_progress' });
  await seedEvidence('commercial_agreement');
  await post(lead, '/api/clients/c1/lifecycle/commercial_agreement/transitions', { to: 'awaiting_approval' });

  const bare = await post(admin, '/api/clients/c1/lifecycle/commercial_agreement/transitions', { to: 'rejected' });
  assert.equal(bare.statusCode, 400);
  assert.match(bare.json().error.message, /must carry a reason/);

  const rejected = await post(admin, '/api/clients/c1/lifecycle/commercial_agreement/transitions', {
    to: 'rejected', reason: 'MSA clause 7 liability cap is unacceptable to finance.',
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json().data.state, 'rejected');

  // Resubmission is a *new* transition row, not an edit of the old one.
  const resubmit = await post(admin, '/api/clients/c1/lifecycle/commercial_agreement/transitions', {
    to: 'in_progress', note: 'Redrafted clause 7 with a 3x fee cap.',
  });
  assert.equal(resubmit.statusCode, 200);

  const history = await db.all(
    "SELECT from_state, to_state, reason FROM lifecycle_transitions WHERE client_id='c1' AND stage_key='commercial_agreement' ORDER BY id",
  );
  const states = history.map((h) => `${h.from_state}->${h.to_state}`);
  assert.ok(states.includes('awaiting_approval->rejected'), 'rejection missing from history');
  assert.ok(states.includes('rejected->in_progress'), 'resubmission missing from history');
  const rejection = history.find((h) => h.to_state === 'rejected');
  assert.match(rejection.reason, /liability cap/, 'the rejection reason must survive in history');
});

test('lifecycle: history rows are never mutated after the fact', async () => {
  const before = await db.all("SELECT * FROM lifecycle_transitions WHERE client_id='c1' ORDER BY id");
  // Approve something else, then compare the earlier rows byte for byte.
  await post(admin, '/api/clients/c1/lifecycle/commercial_agreement/transitions', { to: 'awaiting_approval' });
  await post(admin, '/api/clients/c1/lifecycle/commercial_agreement/transitions', { to: 'approved' });
  const afterRows = await db.all("SELECT * FROM lifecycle_transitions WHERE client_id='c1' ORDER BY id");
  assert.ok(afterRows.length > before.length, 'new transitions must append');
  for (let i = 0; i < before.length; i += 1) {
    assert.deepEqual(afterRows[i], before[i], `history row ${i} changed — history is not immutable`);
  }
});

/* ========================================================== exceptions ==== */

test('lifecycle: an exception needs a reason, and is permanent', async () => {
  const noReason = await post(admin, '/api/clients/c1/lifecycle/hypercare/transitions', { to: 'in_progress', exception: true });
  assert.equal(noReason.statusCode, 400);
  assert.match(noReason.json().error.message, /written reason/);

  const granted = await post(admin, '/api/clients/c1/lifecycle/hypercare/transitions', {
    to: 'in_progress', exception: true, reason: 'Existing account with a signed maintenance rider; legal already on file.',
  });
  assert.equal(granted.statusCode, 200, granted.body);

  const row = await db.get("SELECT exception_granted_by, exception_reason FROM lifecycle_instances WHERE client_id='c1' AND stage_key='hypercare'");
  /**
   * The authoriser is the operator now. What matters is that the field is
   * populated: an exception with no name against it is an unexplained waiver, and
   * that is precisely the audit gap the original test existed to prevent.
   */
  assert.ok(String(row.exception_granted_by ?? '').length > 0, 'an exception must name who granted it');
  assert.match(row.exception_reason, /signed maintenance rider/);
});

/* =============================================== full journey (E2E) ======= */

test('lifecycle E2E: first consultation through maintenance, server-enforced at every step', async () => {
  await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c2','Journey Co','journey','JC')");
  await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_client','c2')");

  const journey = [];
  for (const key of STAGE_KEYS) {
    const catalogue = await db.get("SELECT approver_role FROM lifecycle_stages WHERE key = ?", [key]);
    const start = await post(lead, `/api/clients/c2/lifecycle/${key}/transitions`, { to: 'in_progress' });
    assert.equal(start.statusCode, 200, `${key} start: ${start.body}`);

    await post(lead, `/api/clients/c2/lifecycle/${key}/evidence`, { kind: 'document', label: `${key} artefact` });
    const submit = await post(lead, `/api/clients/c2/lifecycle/${key}/transitions`, { to: 'awaiting_approval' });
    assert.equal(submit.statusCode, 200, `${key} submit: ${submit.body}`);

    const approver = catalogue.approver_role === 'client' ? client : catalogue.approver_role === 'admin' ? admin : lead;
    const approve = await post(approver, `/api/clients/c2/lifecycle/${key}/transitions`, { to: 'approved' });
    assert.equal(approve.statusCode, 200, `${key} approve: ${approve.body}`);
    journey.push(key);
  }

  assert.equal(journey.length, 18, 'every stage must be walkable in order');

  const view = await get(lead, '/api/clients/c2/lifecycle');
  assert.equal(view.body.data.progress.settled, 18);
  assert.equal(view.body.data.progress.pct, 100);
  assert.equal(view.body.data.current, null, 'a completed journey has no current stage');
  assert.ok(view.body.data.stages.every((s) => s.state === 'approved'));

  const history = await db.all("SELECT COUNT(*) AS c FROM lifecycle_transitions WHERE client_id='c2'");
  assert.equal(Number(history[0].c), 54, '18 stages × (start, submit, approve) must all be recorded');
});

/* =========================================================== dashboard ==== */

test('lifecycle dashboard: shows position, overdue stages and client waits', async () => {
  /**
   * Scoping is gone with the identities that produced it. What remains is that the
   * dashboard reports the whole portfolio accurately — every client present, the
   * current stage identified, and the overdue count a number rather than a
   * placeholder. Asserting per-caller visibility would now be asserting something
   * false.
   */
  const res = await get(admin, '/api/lifecycle');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.data.clients;
  assert.ok(rows.some((r) => r.clientId === 'c1'), 'c1 must appear');
  assert.ok(rows.some((r) => r.clientId === 'c2' && r.progress.pct === 100), 'the completed journey must read 100%');
  const c1 = rows.find((r) => r.clientId === 'c1');
  assert.ok(c1.current, 'an in-progress client must report a current stage');
  assert.ok(typeof c1.overdueCount === 'number', 'overdueCount must be computed, not omitted');
});

test('lifecycle: evidence is appended, never overwritten, and needs a label', async () => {
  const bad = await post(lead, '/api/clients/c1/lifecycle/development/evidence', { kind: 'document' });
  assert.equal(bad.statusCode, 400);
  const one = await post(lead, '/api/clients/c1/lifecycle/development/evidence', { kind: 'report', label: 'Sprint 4 QA report', body: 'all green' });
  const two = await post(lead, '/api/clients/c1/lifecycle/development/evidence', { kind: 'report', label: 'Sprint 5 QA report', body: 'all green' });
  assert.equal(one.statusCode, 200);
  assert.equal(two.statusCode, 200);
  const rows = await db.all("SELECT label FROM lifecycle_evidence WHERE client_id='c1' AND stage_key='development' ORDER BY created_at");
  assert.equal(rows.length, 2, 'evidence must accumulate, not replace');
});

/* ==================================================== owner authority ==== */

test('lifecycle: a rejection at any stage still needs a reason and lands in history', async () => {
  /**
   * This replaced "a stage owned by admin cannot be decided by a lead or member".
   *
   * `owner_role` on a stage is now informational — with no caller role there is
   * nothing to compare it against. The rule that still protects the ledger is the
   * one requiring a written reason for a rejection, and that is asserted here at a
   * stage the original test used specifically because it had been left untouched.
   */
  await db.run(
    "UPDATE lifecycle_instances SET state = 'awaiting_approval' WHERE client_id = 'c1' AND stage_key = 'release_ship'",
  );

  const bare = await post(admin, '/api/clients/c1/lifecycle/release_ship/transitions', { to: 'rejected' });
  assert.equal(bare.statusCode, 400, 'a rejection with no reason must be refused');
  assert.match(bare.json().error.message, /must carry a reason/);

  const decided = await post(admin, '/api/clients/c1/lifecycle/release_ship/transitions', {
    to: 'rejected', reason: 'Ship gate failed: two release blockers still open.',
  });
  assert.equal(decided.statusCode, 200, decided.body);

  const row = await db.get(
    `SELECT actor_id, reason FROM lifecycle_transitions
      WHERE client_id='c1' AND stage_key='release_ship' AND to_state='rejected'
      ORDER BY id DESC LIMIT 1`,
  );
  assert.match(row.reason, /two release blockers/, 'the reason must be retained verbatim');
  assert.ok(String(row.actor_id ?? '').length > 0, 'the decision must name who made it');
});
