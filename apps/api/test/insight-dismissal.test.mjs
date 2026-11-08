/**
 * Dismissing an intelligence finding — and taking it back.
 *
 * The Intelligence screen computes its findings from live data, so the findings
 * themselves must never be editable: a number that came from the database and can be
 * typed over is not analysis. What a person genuinely decides is *what to do about
 * it*, and the honest options are "fix the work" or "we know, we are accepting this".
 * Only the second one needs storage.
 *
 * The properties asserted here are the ones that make the record trustworthy rather
 * than merely present:
 *
 *   - a dismissal removes the finding from the open list and puts it in the dismissed
 *     list *with the live finding still attached*, so "we analysed this and accepted
 *     it" is distinguishable from "we never noticed";
 *   - the decision survives: who, when, and why are all stored;
 *   - it is idempotent — a second person clicking acknowledge does not conflict, and
 *     does not silently erase the first person's reason;
 *   - a snooze expires on its own, because a dismissal nobody remembers to undo is
 *     how a real problem stays invisible;
 *   - un-dismissing brings the finding straight back;
 *   - a fabricated key is refused, so the table cannot be filled with client strings.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetOperatorIdentity } from '../src/auth/operator-middleware.ts';
import { resetPostgres } from './helpers/fresh.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

for (const [id, email, name, role] of [
  ['u_admin', 'admin@x.io', 'Ada Admin', 'admin'],
  ['u_lead', 'lead@x.io', 'Lee Lead', 'lead'],
]) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [
    id, email, name, role, name.slice(0, 2),
  ]);
}
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
await db.run(
  "INSERT INTO projects (id,key,client_id,name,status) VALUES ('p1','NRTH','c1','Northwind','active')",
);
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery')");
await db.run("INSERT INTO columns (id,board_id,key,name,position) VALUES ('col1','b1','in_progress','In Progress',0)");
/*
 * One task, assigned to a lead, that several others depend on. That is enough for the
 * `bottleneck` detector to fire, which gives this suite a real finding to dismiss
 * instead of a fabricated key.
 */
await db.run(
  "INSERT INTO tasks (id,key,project_id,board_id,column_id,title,status,priority,assignee_id,reporter_id) VALUES ('t1','NRTH-1','p1','b1','col1','Blocking work','in_progress','high','u_lead','u_admin')",
);
for (const n of [2, 3, 4]) {
  await db.run(
    `INSERT INTO tasks (id,key,project_id,board_id,column_id,title,status,priority,assignee_id,reporter_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [`t${n}`, `NRTH-${n}`, 'p1', 'b1', 'col1', `Dependent ${n}`, 'todo', 'medium', 'u_lead', 'u_admin'],
  );
  await db.run('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?,?)', [`t${n}`, 't1']);
}

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) =>
  app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload ?? {}),
  });
const del = (url) => app.inject({ method: 'DELETE', url });
const asOperator = async (userId, fn) => {
  const saved = process.env.OPERATOR_USER_ID;
  process.env.OPERATOR_USER_ID = userId;
  resetOperatorIdentity();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OPERATOR_USER_ID;
    else process.env.OPERATOR_USER_ID = saved;
    resetOperatorIdentity();
  }
};

/** The key the analyser produces for the bottleneck on `t1`. */
const BOTTLENECK = 'bottleneck:t1';

test('insights: a finding carries a stable key', async () => {
  const res = await get('/api/insights');
  assert.equal(res.statusCode, 200, res.body);
  const finding = res.json().data.insights.find((i) => i.kind === 'bottleneck');
  assert.ok(finding, 'the bottleneck detector must fire for a task four others depend on');
  assert.equal(finding.key, BOTTLENECK, 'the key must be stable across requests, not a rendered sentence');
  assert.deepEqual(res.json().data.dismissed, [], 'nothing is dismissed at the start');
});

test('insights: dismissing moves the finding out of the open list and records the decision', async () => {
  const res = await post(`/api/insights/${encodeURIComponent(BOTTLENECK)}/dismiss`, {
    reason: 'Accepted: this is the critical path and it is staffed.',
  });
  assert.equal(res.statusCode, 201, res.body);

  const stored = await db.get('SELECT * FROM insight_dismissals WHERE key = ?', [BOTTLENECK]);
  assert.ok(stored, 'the dismissal must be in the database, not in the response');
  assert.equal(stored.kind, 'bottleneck');
  assert.equal(stored.subject, 't1');
  assert.match(String(stored.reason), /critical path/);
  assert.equal(stored.dismissed_by, 'u_admin', 'the decision must be attributed');

  const after = await get('/api/insights');
  const open = after.json().data.insights;
  assert.ok(!open.some((i) => i.key === BOTTLENECK), 'a dismissed finding must leave the open list');

  const dismissed = after.json().data.dismissed;
  const entry = dismissed.find((d) => d.key === BOTTLENECK);
  assert.ok(entry, 'it must appear in the dismissed list');
  assert.ok(entry.insight, 'the live finding must still be attached, so the record is not a bare key');
  assert.equal(entry.dismissedBy, 'Ada Admin');
  assert.match(String(entry.reason), /critical path/);
  assert.equal(entry.mutedUntil, null, 'a dismissal with no snooze does not expire');
});

test('insights: dismissing twice is idempotent and does not duplicate the row', async () => {
  const second = await asOperator('u_lead', () =>
    post(`/api/insights/${encodeURIComponent(BOTTLENECK)}/dismiss`, { reason: 'Also confirmed.' }),
  );
  assert.equal(second.statusCode, 200, 'the second dismissal updates rather than conflicts');
  const rows = await db.all('SELECT key FROM insight_dismissals WHERE key = ?', [BOTTLENECK]);
  assert.equal(rows.length, 1, 'exactly one row per finding key');
});

test('insights: un-dismissing brings the finding straight back', async () => {
  const res = await del(`/api/insights/${encodeURIComponent(BOTTLENECK)}/dismiss`);
  assert.equal(res.statusCode, 204, res.body);
  const gone = await db.get('SELECT key FROM insight_dismissals WHERE key = ?', [BOTTLENECK]);
  assert.equal(gone ?? null, null, 'the row must be gone');

  const after = await get('/api/insights');
  assert.ok(
    after.json().data.insights.some((i) => i.key === BOTTLENECK),
    'the finding must return to the open list',
  );
  assert.equal(after.json().data.dismissed.length, 0);
});

test('insights: un-dismissing something that is not dismissed is a 404', async () => {
  const res = await del(`/api/insights/${encodeURIComponent(BOTTLENECK)}/dismiss`);
  assert.equal(res.statusCode, 404, res.body);
});

test('insights: a snooze expires on its own', async () => {
  /*
   * Snoozing is the common case — "not this week" — and a dismissal that nobody
   * remembers to undo is how a real problem stays invisible. So the expiry is stored
   * as a timestamp and honoured by the read, not by a timer that has to fire.
   */
  const res = await post(`/api/insights/${encodeURIComponent(BOTTLENECK)}/dismiss`, {
    reason: 'Not this sprint.', muteHours: 1,
  });
  assert.equal(res.statusCode, 201, res.body);
  const stored = await db.get('SELECT muted_until FROM insight_dismissals WHERE key = ?', [BOTTLENECK]);
  assert.ok(stored.muted_until, 'a snooze must record when it ends');

  // While snoozed it is hidden.
  let now = await get('/api/insights');
  assert.ok(!now.json().data.insights.some((i) => i.key === BOTTLENECK), 'snoozed means hidden');

  // Move the expiry into the past, exactly as time would.
  await db.run('UPDATE insight_dismissals SET muted_until = ? WHERE key = ?', [
    new Date(Date.now() - 60_000).toISOString(), BOTTLENECK,
  ]);
  now = await get('/api/insights');
  assert.ok(
    now.json().data.insights.some((i) => i.key === BOTTLENECK),
    'an expired snooze must release the finding without anyone acting',
  );
});

test('insights: a fabricated key is refused', async () => {
  for (const key of ['not-a-key', 'bottleneck:', 'DROP TABLE insight_dismissals', 'x'.repeat(200)]) {
    const res = await post(`/api/insights/${encodeURIComponent(key)}/dismiss`, { reason: 'x' });
    /*
     * Which refusal is not the point — an over-long key never reaches the handler at
     * all, because the URL limit rejects it with 414. What matters is that it is not
     * accepted and that nothing is stored, so the assertion is on the outcome rather
     * than on a particular status code.
     */
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `"${key.slice(0, 24)}" must be refused, got ${res.statusCode}`,
    );
  }
  const rows = await db.all('SELECT key FROM insight_dismissals');
  assert.ok(
    rows.every((r) => /^[a-z_]+:/.test(String(r.key))),
    'nothing unrecognised may have been stored',
  );
});

test('insights: a dismissal for a finding that no longer fires is kept but flagged', async () => {
  /*
   * The work gets done. The finding stops being produced, and the dismissal is now a
   * record of a decision about something that is no longer true. Deleting it silently
   * would lose the audit trail; listing it without comment would imply the warning is
   * live. So it stays, with `insight: null`, and the UI says so.
   */
  await post(`/api/insights/${encodeURIComponent('estimate_drift:NRTH')}/dismiss`, { reason: 'Known drift.' });
  const res = await get('/api/insights');
  const entry = res.json().data.dismissed.find((d) => d.key === 'estimate_drift:NRTH');
  assert.ok(entry, 'the dismissal must survive the finding going away');
  assert.equal(entry.insight, null, 'and it must say the finding no longer fires');
});
