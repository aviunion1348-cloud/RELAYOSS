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
];
for (const [id, email, name, role] of users) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [id, email, name, role, name.slice(0, 2)]);
}
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_client','c1')");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

async function login(userId) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/dev-login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ userId }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return { cookie: res.headers['set-cookie'].split(';')[0], csrf: res.json().data.csrfToken };
}
function post(session, url, payload) {
  return app.inject({
    method: 'POST', url,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}
async function get(session, url) {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
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

test('lifecycle: a member cannot approve a stage outside their authority', async () => {
  const res = await post(member, '/api/clients/c1/lifecycle/triage_qualify/transitions', { to: 'in_progress' });
  // Starting is allowed (member is a valid owner), but let's prove approval is not:
  assert.equal(res.statusCode, 200);
  await seedEvidence('triage_qualify');
  await post(member, '/api/clients/c1/lifecycle/triage_qualify/transitions', { to: 'awaiting_approval' });
  const approve = await post(member, '/api/clients/c1/lifecycle/triage_qualify/transitions', { to: 'approved' });
  assert.equal(approve.statusCode, 403);
  assert.match(approve.json().error.message, /requires .* approver/);
});

test('lifecycle: a client cannot drive agency stages, only decide its own approvals', async () => {
  const drive = await post(client, '/api/clients/c1/lifecycle/initial_consultation/transitions', { to: 'in_progress' });
  assert.equal(drive.statusCode, 403);
  assert.match(drive.json().error.message, /only record an approval decision/i);
});

test('lifecycle: client sign-off on a plan cannot be self-served by the delivery team', async () => {
  // Advance to client_review.
  for (const key of ['triage_qualify', 'initial_consultation', 'technical_consultation', 'product_specification', 'implementation_plan', 'dev_meeting']) {
    await post(lead, `/api/clients/c1/lifecycle/${key}/transitions`, { to: 'in_progress' });
    await seedEvidence(key);
    await post(lead, `/api/clients/c1/lifecycle/${key}/transitions`, { to: 'awaiting_approval' });
    const ok = await post(lead, `/api/clients/c1/lifecycle/${key}/transitions`, { to: 'approved' });
    assert.equal(ok.statusCode, 200, `${key}: ${ok.body}`);
  }
  await post(lead, '/api/clients/c1/lifecycle/client_review/transitions', { to: 'in_progress' });
  await seedEvidence('client_review');
  await post(lead, '/api/clients/c1/lifecycle/client_review/transitions', { to: 'awaiting_approval' });

  // A member (delivery team) must not be able to decide the client's review.
  const byMember = await post(member, '/api/clients/c1/lifecycle/client_review/transitions', { to: 'approved' });
  assert.equal(byMember.statusCode, 403);

  // The client decides. This is the only path that should work.
  const byClient = await post(client, '/api/clients/c1/lifecycle/client_review/transitions', { to: 'approved' });
  assert.equal(byClient.statusCode, 200, byClient.body);
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

test('lifecycle: an exception needs an authoriser and a reason, and is permanent', async () => {
  // hypercare is late in the journey; starting it now skips a lot.
  const noReason = await post(lead, '/api/clients/c1/lifecycle/hypercare/transitions', { to: 'in_progress', exception: true });
  assert.equal(noReason.statusCode, 400);
  assert.match(noReason.json().error.message, /written reason/);

  const byMember = await post(member, '/api/clients/c1/lifecycle/hypercare/transitions', {
    to: 'in_progress', exception: true, reason: 'Client asked us to jump straight to ops.',
  });
  assert.equal(byMember.statusCode, 403);

  const granted = await post(admin, '/api/clients/c1/lifecycle/hypercare/transitions', {
    to: 'in_progress', exception: true, reason: 'Existing account with a signed maintenance rider; legal already on file.',
  });
  assert.equal(granted.statusCode, 200, granted.body);

  const row = await db.get("SELECT exception_granted_by, exception_reason FROM lifecycle_instances WHERE client_id='c1' AND stage_key='hypercare'");
  assert.equal(row.exception_granted_by, 'u_admin');
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

test('lifecycle dashboard: shows position, overdue stages and client waits, scoped', async () => {
  const res = await get(lead, '/api/lifecycle');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.data.clients;
  assert.ok(rows.some((r) => r.clientId === 'c1'));
  assert.ok(rows.some((r) => r.clientId === 'c2' && r.progress.pct === 100));
  const c1 = rows.find((r) => r.clientId === 'c1');
  assert.ok(c1.current, 'an in-progress client must report a current stage');
  assert.ok(typeof c1.overdueCount === 'number');

  // A member with no relationship to these clients must not enumerate them.
  const asMember = await get(member, '/api/lifecycle');
  assert.equal(asMember.status, 200);
  assert.deepEqual(asMember.body.data.clients, [], 'lifecycle dashboard leaked clients to an unrelated member');
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
