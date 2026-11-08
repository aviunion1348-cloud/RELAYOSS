/**
 * Ship-gate and clock-lifecycle tests.
 *
 * These exist because the delivery board's hardest promise is a refusal: a
 * feature with an outstanding requirement must not ship, a clock must not be
 * quietly erased, and a deployment must not be called successful because a
 * pipeline exited zero. A test that only proves the happy path would miss the
 * entire point.
 *
 * Runs on SQLite by default and on PostgreSQL 16 under `npm run test:pg`.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { evaluateShipGate } from '../src/services/shipgate.ts';
import { startTimer, sweepTimers } from '../src/services/clocks.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

/* --------------------------------------------------------------- fixtures -- */
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u_lead','lead@x.io','Lee Lead','lead','LL')");
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u_member','mem@x.io','Mia Member','member','MM')");
// An admin is needed to exercise an authorised waiver.
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u_admin','admin@x.io','Ada Admin','admin','AA')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Shipco','shipco','SC')");
await db.run("INSERT INTO projects (id,key,name,client_id,status,edge_case_target) VALUES ('p1','SHP','Ship Project','c1','active',10)");
await db.run("INSERT INTO project_members (project_id,user_id,access) VALUES ('p1','u_lead','admin')");
await db.run("INSERT INTO project_members (project_id,user_id,access) VALUES ('p1','u_member','member')");
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Board')");
await db.run("INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES ('b1_todo','b1','todo','Ready',1,0)");
await db.run("INSERT INTO releases (id,project_id,version,name,status) VALUES ('r1','p1','v1.0.0','Launch','in_qa')");

// A project phase with the two project-scope required gates instantiated.
await db.run("INSERT INTO phases (id,key,name,position) VALUES ('ph_build','build','Build',40)");
await db.run("INSERT INTO project_phases (id,project_id,phase_id,status) VALUES ('pp1','p1','ph_build','active')");
const projectGates = await db.all("SELECT id FROM turnover_gates WHERE scope = 'project' AND required = 1 ORDER BY key");
assert.ok(projectGates.length >= 2, 'baseline policy must seed required project gates');
for (const g of projectGates) {
  await db.run("INSERT INTO turnover_checks (id,gate_id,project_phase_id,status) VALUES (?,?,'pp1','pending')", [`tc_${g.id}`, g.id]);
}

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try {
    await app.close();
  } catch { /* already closed by a test */ }
  try {
    await db.close();
  } catch { /* already closed by a test */ }
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

function req(method, url, session, payload) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

const lead = await login('u_lead');
const member = await login('u_member');

/* =========================================================== ship gate === */

test('ship gate: refuses to ship with zero edge cases catalogued', async () => {
  const res = await req('PATCH', '/api/releases/r1', lead, { status: 'shipped' });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /Ship refused/);
  assert.match(body.error.message, /Edge cases catalogued/);
});

test('ship gate: names every outstanding requirement, not just the first', async () => {
  const gate = await evaluateShipGate(db, 'r1');
  const failed = gate.checks.filter((c) => !c.passed).map((c) => c.key);
  // Unbuilt project: nothing is proven, so nothing is shippable.
  assert.deepEqual(
    failed.sort(),
    // no_blocking_defects is genuinely clean here (no P0/P1 exists yet); the
    // point of the test is that every *other* requirement is enumerated.
    ['demo_approved', 'edge_cases_catalogued', 'edge_cases_verified', 'exec_summary_lead_time', 'project_turnover_gates'].sort(),
  );
  assert.equal(gate.shippable, false);
  assert.match(gate.blockedReason, /;/, 'the reason must enumerate, not summarise');
});

test('ship gate: an executive summary linked inside 48h does not satisfy the rule', async () => {
  const shipAt = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const preparedAt = new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  await db.run('UPDATE releases SET exec_summary_url = ?, exec_summary_at = ?, ship_planned_at = ? WHERE id = ?', [
    'https://notion.so/exec-summary', preparedAt, shipAt, 'r1',
  ]);
  const gate = await evaluateShipGate(db, 'r1');
  const exec = gate.checks.find((c) => c.key === 'exec_summary_lead_time');
  assert.equal(exec.passed, false, 'a 2h-old summary cannot claim a 48h lead');
  assert.match(exec.detail, /need ≥ 48h/);
});

test('ship gate: a summary prepared 72h ahead satisfies the rule', async () => {
  const shipAt = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const preparedAt = new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  await db.run('UPDATE releases SET exec_summary_at = ?, ship_planned_at = ? WHERE id = ?', [preparedAt, shipAt, 'r1']);
  const gate = await evaluateShipGate(db, 'r1');
  assert.equal(gate.checks.find((c) => c.key === 'exec_summary_lead_time').passed, true);
});

test('ship gate: an unrelated ticket does not count as edge-case coverage', async () => {
  // 10 edge cases, but only 4 verified — coverage alone must not pass.
  for (let i = 0; i < 10; i += 1) {
    await db.run(
      // The gate reads `execution`: four were genuinely run and passed, six were
      // catalogued but never executed — which is not evidence of anything.
      "INSERT INTO edge_cases (id,project_id,module,code,scenario,status,execution) VALUES (?,?,?,?,?,?,?)",
      [`ec${i}`, 'p1', 'checkout', `EC-${i}`, `scenario ${i}`, 'covered', i < 4 ? 'passed' : 'not_executed'],
    );
  }
  const gate = await evaluateShipGate(db, 'r1');
  assert.equal(gate.checks.find((c) => c.key === 'edge_cases_catalogued').passed, true);
  const verified = gate.checks.find((c) => c.key === 'edge_cases_verified');
  assert.equal(verified.passed, false, '4 of 9 required verified must fail');
  assert.equal(verified.required, 9);
});

test('ship gate: an open P0 defect blocks, a verified one does not', async () => {
  await db.run("INSERT INTO qa_reports (id,project_id,kind,severity,title,status) VALUES ('qa1','p1','bug','p0','Payment double-charge','open')");
  let gate = await evaluateShipGate(db, 'r1');
  assert.equal(gate.checks.find((c) => c.key === 'no_blocking_defects').passed, false);
  await db.run("UPDATE qa_reports SET status = 'verified' WHERE id = 'qa1'");
  gate = await evaluateShipGate(db, 'r1');
  assert.equal(gate.checks.find((c) => c.key === 'no_blocking_defects').passed, true);
});

test('ship gate: a turnover gate passed without evidence still blocks', async () => {
  for (const g of projectGates) {
    await db.run("UPDATE turnover_checks SET status = 'pass', evidence = '' WHERE id = ?", [`tc_${g.id}`]);
  }
  const gate = await evaluateShipGate(db, 'r1');
  const check = gate.checks.find((c) => c.key === 'project_turnover_gates');
  assert.equal(check.passed, false, 'a pass with no evidence is not a pass');
  for (const g of projectGates) {
    await db.run("UPDATE turnover_checks SET evidence = 'signed acceptance record' WHERE id = ?", [`tc_${g.id}`]);
  }
  assert.equal((await evaluateShipGate(db, 'r1')).checks.find((c) => c.key === 'project_turnover_gates').passed, true);
});

test('ship gate: every requirement can be met and the gate still reports it', async () => {
  /**
   * This replaced an assertion that a *member* was refused with `403` when the
   * gate was green. Roles no longer refuse anyone, so the refusal cannot be
   * asserted — but the gate's own evaluation can, and that is the part that
   * matters for correctness: a green gate must say green, and a red one must name
   * the reason.
   */
  await db.run("UPDATE edge_cases SET execution = 'passed', status = 'verified' WHERE project_id = 'p1'");
  await db.run("UPDATE releases SET demo_approved_at = ? WHERE id = 'r1'", [new Date().toISOString()]);
  const gate = await evaluateShipGate(db, 'r1');
  assert.equal(gate.shippable, true, 'fixture should now be shippable: ' + gate.blockedReason);
  assert.ok(gate.checks.every((c) => c.passed), 'a shippable release must pass every gate check');
  assert.equal(gate.blockedReason, '', 'a shippable release must name no reason for being blocked');
});

test('ship gate: shipping without a deployment acknowledgement is refused', async () => {
  const res = await req('PATCH', '/api/releases/r1', lead, { status: 'shipped' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /deployment_ack/);
});

test('ship gate: an acknowledgement needs a real source', async () => {
  const res = await req('POST', '/api/releases/r1/acknowledgements', lead, { signal: 'deployment_ack', state: 'received' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /needs a source/);
});

test('ship gate: with gate green and both acks received, the release ships', async () => {
  await req('POST', '/api/releases/r1/acknowledgements', lead, {
    signal: 'deployment_ack', state: 'received', source: 'https://ci.example.com/runs/42',
  });
  await req('POST', '/api/releases/r1/acknowledgements', lead, {
    signal: 'post_ship_verification', state: 'received', source: 'verify/report-42',
  });
  const res = await req('PATCH', '/api/releases/r1', lead, { status: 'shipped' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;
  assert.equal(body.release.status, 'shipped');
  assert.ok(body.release.shipped_at, 'ship time is recorded, not inferred');
  /*
   * The approver is the operator, not the `lead` marker passed to `req()`.
   *
   * On an unauthenticated deployment every request is attributed to the configured
   * operator, so `u_admin` here is the correct value and `u_lead` would be a claim
   * that someone authenticated. What must not change is that an approver is
   * recorded at all — an unattributed ship would be an unaccountable one.
   */
  assert.equal(body.release.ship_approved_by, 'u_admin');
});

test('ship gate: a refused ship attempt is audited, not silently dropped', async () => {
  await db.run("INSERT INTO releases (id,project_id,version,name,status) VALUES ('r4','p1','v2.0.0','Audited','in_qa')");
  const res = await req('PATCH', '/api/releases/r4', lead, { status: 'shipped' });
  assert.equal(res.statusCode, 400);
  const rows = await db.all("SELECT action, after_json FROM audit_log WHERE entity_id = 'r4' AND action = 'release.ship_refused'");
  assert.equal(rows.length, 1, 'the refusal must be recorded');
  const recorded = JSON.parse(rows[0].after_json).blocked;
  assert.ok(recorded.length > 0, 'the audit row must name what blocked it');
  // The fixture is partly green by this point, so assert against the actual
  // verdict rather than a hard-coded key.
  const gate = await evaluateShipGate(db, 'r4');
  const actual = gate.checks.filter((c) => !c.passed).map((c) => c.key).sort();
  assert.deepEqual(recorded.map(([key]) => key).sort(), actual);
});

test('ship gate: the lifecycle does not move backwards', async () => {
  // Uses its own release so the assertion does not depend on a prior test
  // having reached `shipped`.
  await db.run("INSERT INTO releases (id,project_id,version,name,status) VALUES ('r3','p1','v1.2.0','Later','approved')");
  const res = await req('PATCH', '/api/releases/r3', lead, { status: 'in_qa' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /only moves forward/);
});

test('ship gate: the persisted verdict explains a refusal after the fact', async () => {
  await db.run("INSERT INTO releases (id,project_id,version,name,status) VALUES ('r2','p1','v1.1.0','Patch','in_qa')");
  const gate = await evaluateShipGate(db, 'r2');
  assert.equal(gate.shippable, false);
  const row = await db.get('SELECT ship_blocked_reason FROM releases WHERE id = ?', ['r2']);
  assert.ok(row.ship_blocked_reason.length > 0, 'the refusal is stored on the release, not only returned');
});

/* =============================================================== clocks === */

test('clocks: a phase moved into client review starts the client-turnover clock', async () => {
  const res = await req('PATCH', '/api/projects/p1/phases/pp1', lead, { status: 'blocked' });
  assert.equal(res.statusCode, 200, res.body);
  const timer = await db.get(
    "SELECT outcome, clock_key FROM sla_timers WHERE clock_key = 'client-turnover' AND entity_id = 'ph_build'",
  );
  assert.ok(timer, 'client-turnover clock must be running');
  assert.equal(timer.outcome, 'running');
});

test('clocks: starting the same clock twice does not create a second timer', async () => {
  const before = await db.get("SELECT COUNT(*) AS c FROM sla_timers WHERE clock_key = 'client-turnover'");
  await startTimer(db, 'client-turnover', 'phase', 'ph_build', 'duplicate');
  const afterCount = await db.get("SELECT COUNT(*) AS c FROM sla_timers WHERE clock_key = 'client-turnover'");
  assert.equal(Number(afterCount.c), Number(before.c));
});

test('clocks: a missed clock cannot be acknowledged with a throwaway reason', async () => {
  // A timer hangs off an entity, and the clock routes are tenancy-checked against
  // that entity — so the task must exist and be on a project the caller can see.
  await db.run(
    "INSERT INTO tasks (id,key,title,board_id,column_id,project_id,status,priority,assignee_id) VALUES ('x1','SHP-999','Clock fixture','b1','b1_todo','p1','todo','medium','u_lead') ON CONFLICT (id) DO NOTHING",
  );
  const created = await startTimer(db, 'module-turnover', 'task', 'x1', 'turnover');
  assert.ok(created);
  await db.run('UPDATE sla_timers SET due_at = ? WHERE id = ?', [
    new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' '), created,
  ]);
  await sweepTimers(db);
  const short = await req('POST', `/api/clocks/timers/${created}/acknowledge`, lead, { reason: 'oops' });
  assert.equal(short.statusCode, 400);
  const ok = await req('POST', `/api/clocks/timers/${created}/acknowledge`, lead, {
    reason: 'Vendor sandbox was down; escalated to the client DBA on call.',
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const ack = ok.json().data;
  // Attributed to the operator: every request is, on a deployment with no sessions.
  assert.equal(ack.acknowledged_by, 'u_admin');
  assert.ok(ack.created_at);
});

test('clocks: a miss is never erased by acknowledging it', async () => {
  const missed = await db.all("SELECT id, outcome FROM sla_timers WHERE outcome = 'missed'");
  assert.ok(missed.length > 0);
  for (const m of missed) assert.equal(m.outcome, 'missed', 'the breach record survives the acknowledgement');
});

test('clocks: a running clock cannot be acknowledged as if it had already missed', async () => {
  const created = await startTimer(db, 'first-demo', 'project', 'p1', 'demo');
  const res = await req('POST', `/api/clocks/timers/${created}/acknowledge`, lead, {
    reason: 'This clock has not been missed yet at all.',
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /Only a missed clock/);
});

test('clocks: a waiver without a written exception is refused', async () => {
  const created = await startTimer(db, 'milestone-turnover', 'phase', 'ph_build', 'ms');
  const res = await req('POST', `/api/clocks/timers/${created}/resolve`, lead, { outcome: 'waived' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /written exception/);
});

test('clocks: resolving a clock inside its window records "met", not "missed"', async () => {
  // The qa clock hangs off a real QA report; the tenancy check resolves the
  // report to its project, so a fabricated id is correctly refused.
  await db.run(
    "INSERT INTO qa_reports (id,project_id,kind,title,severity,status) VALUES ('qa_fresh','p1','test','Fresh report','p3','open') ON CONFLICT (id) DO NOTHING",
  );
  const created = await startTimer(db, 'qa-report', 'qa', 'qa_fresh', 'report');
  const res = await req('POST', `/api/clocks/timers/${created}/resolve`, lead, { outcome: 'met' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.outcome, 'met');
});

test('clocks: a late "met" is recorded as missed — the clock decides, not the caller', async () => {
  await db.run(
    "INSERT INTO qa_reports (id,project_id,kind,title,severity,status) VALUES ('qa_late','p1','test','Late report','p3','open') ON CONFLICT (id) DO NOTHING",
  );
  const created = await startTimer(db, 'qa-report', 'qa', 'qa_late', 'report');
  await db.run('UPDATE sla_timers SET due_at = ? WHERE id = ?', [
    new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '), created,
  ]);
  const res = await req('POST', `/api/clocks/timers/${created}/resolve`, lead, { outcome: 'met' });
  assert.equal(res.json().data.outcome, 'missed');
});

test('clocks: all ten board policies exist and are reachable in the dashboard', async () => {
  const policies = await db.all('SELECT key FROM sla_clocks');
  assert.equal(policies.length, 10);
  const health = await req('GET', '/api/clocks', lead);
  assert.equal(health.statusCode, 200);
  const keys = new Set(health.json().data.clocks.map((c) => c.key));
  for (const p of policies) assert.ok(keys.has(p.key), `${p.key} missing from the SLA dashboard`);
});

test('ship gate: one unresolved edge-case failure blocks the release outright', async () => {
  // Everything else is green; a single executed-and-failed case must still block.
  // A pass rate cannot average away a known defect.
  await db.run("UPDATE edge_cases SET execution = 'passed', status = 'verified' WHERE project_id = 'p1'");
  await db.run("UPDATE edge_cases SET execution = 'failed' WHERE code = 'EC-7'");
  const blocked = await evaluateShipGate(db, 'r1');
  const check = blocked.checks.find((c) => c.key === 'edge_cases_no_failures');
  assert.ok(check, 'the gate must include an explicit no-failures check');
  assert.equal(check.passed, false, 'an unresolved failure blocks');
  assert.equal(blocked.shippable, false, 'the release must not be shippable');
  assert.match(blocked.blockedReason ?? '', /failed/i);

  // A written waiver from an authorised user resolves it, and is itself recorded.
  await db.run(
    "UPDATE edge_cases SET execution = 'waived', waiver_reason = 'Known cosmetic defect, tracked as RLY-999, accepted for this release.', waived_by = 'u_admin' WHERE code = 'EC-7'",
  );
  const waived = await evaluateShipGate(db, 'r1');
  assert.equal(waived.checks.find((c) => c.key === 'edge_cases_no_failures').passed, true, 'a written waiver from an admin resolves it');

  // A waiver without a reason or author is not a resolution: the case leaves the
  // failing set, but it also stops counting as resolved, so the 90% threshold
  // must fail while the no-failures check still passes.
  await db.run("UPDATE edge_cases SET waiver_reason = '', waived_by = NULL WHERE code = 'EC-7'");
  const bare = await evaluateShipGate(db, 'r1');
  assert.equal(bare.checks.find((c) => c.key === 'edge_cases_no_failures').passed, true, 'it is not failing any more');
  // The waiver must not add to the resolved count: 9 genuinely passed, and the
  // tenth contributes nothing because it carries neither reason nor author.
  assert.equal(bare.checks.find((c) => c.key === 'edge_cases_verified').actual, 9, 'nine passed; the bare waiver adds nothing');
  assert.ok(
    !/1 waived/.test(bare.checks.find((c) => c.key === 'edge_cases_verified').detail),
    'the detail must not claim the bare waiver resolved anything',
  );
});

test('ship gate: catalogued but never executed is not verification', async () => {
  await db.run("UPDATE edge_cases SET execution = 'not_executed', status = 'verified' WHERE project_id = 'p1'");
  const gate = await evaluateShipGate(db, 'r1');
  const check = gate.checks.find((c) => c.key === 'edge_cases_verified');
  assert.equal(check.passed, false, 'a row marked verified in the catalogue but never run must not count');
  assert.equal(check.actual, 0);
  await db.run("UPDATE edge_cases SET execution = 'passed' WHERE project_id = 'p1'");
});
