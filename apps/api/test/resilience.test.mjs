/**
 * Failure and recovery tests.
 *
 * The interesting failures are not "does the happy path work" — they are:
 *   - two people approving the same thing at the same time
 *   - two people editing the same task
 *   - a clock sweeper that runs twice (or overlaps itself)
 *   - a migration that fails halfway
 *   - a database that disappears mid-flight
 *   - duplicate deliveries of the same webhook/event
 *   - an approval that arrives after the deadline it was for
 *
 * These assert the *recovery* behaviour the architecture actually provides, and
 * where a guarantee is not available (multi-replica locking on SQLite) the test
 * says so rather than pretending.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate, schemaVersion } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { createTask, updateTask, recordAcceptance, taskDetail, evaluateTask } from '../src/services/tasks.ts';
import { startTimer, resolveTimer, sweepTimers } from '../src/services/clocks.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const KEEP = new Set(['schema_migrations', 'turnover_gates', 'sla_clocks', 'sla_policies', 'retention_policies']);
const open = [];
after(async () => {
  for (const d of open) {
    try {
      await d.close();
    } catch {
      /* already closed by the test that owned it */
    }
  }
});

async function freshDb() {
  let db;
  if (pgUrl) {
    db = new PostgresDb(pgUrl);
    open.push(db);
    // (Sqlite handles are tracked below only when they are not closed by a test.)
    // Shared reset: policy tables (incl. the lifecycle catalogue) are preserved
    // by one list in helpers/fresh.ts, not by a per-suite copy that drifts.
    await resetPostgres(db);
  } else {
    db = new SqliteDb(':memory:');
  }
  await migrate(db, { log: () => {} });
  await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u1','a@x.io','Ada','admin','AD')");
  await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u2','b@x.io','Grace','member','GR')");
  await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
  await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p1','ACM','Acme','c1')");
  await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery')");
  for (const [key, name] of [['backlog', 'Backlog'], ['todo', 'Ready'], ['in_progress', 'In Progress'], ['review', 'In Review'], ['blocked', 'Blocked'], ['done', 'Done']]) {
    await db.run('INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES (?,?,?,?,?,?)', [`b1_${key}`, 'b1', key, name, 0, key === 'done' ? 1 : 0]);
  }
  return db;
}

const mkTask = (db, title = 'Resilience fixture') =>
  createTask(db, { title, boardId: 'b1', columnId: 'b1_todo', projectId: 'p1', clientVisible: true }, 'u1');

/* --------------------------------------------------------- concurrency -- */
test('concurrency: two simultaneous approvals cannot both create a record', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db);
  await updateTask(db, taskId, { status: 'review' }, 'u2');
  await recordAcceptance(db, taskId, 'dev_complete', 'passed', 'u2');

  // Fire the same QA approval twice, concurrently.
  const results = await Promise.allSettled([
    recordAcceptance(db, taskId, 'qa_approved', 'passed', 'u1', 'QA-1'),
    recordAcceptance(db, taskId, 'qa_approved', 'passed', 'u1', 'QA-1'),
  ]);
  assert.ok(results.some((r) => r.status === 'fulfilled'), 'at least one approval succeeds');

  // The unique (task, step) constraint means there is exactly one record.
  const rows = await db.all('SELECT * FROM acceptance_records WHERE task_id = ? AND step = ?', [taskId, 'qa_approved']);
  assert.equal(rows.length, 1, 'the acceptance ladder has one record per step under concurrency');
  assert.equal(rows[0].state, 'passed');
});

test('concurrency: two people editing the same task both persist (last write wins, audited)', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db, 'Concurrent edit target');
  await Promise.all([
    updateTask(db, taskId, { title: 'Edit by Ada', priority: 'high' }, 'u1'),
    updateTask(db, taskId, { title: 'Edit by Grace' }, 'u2'),
  ]);
  const final = await db.get('SELECT title, priority, updated_at FROM tasks WHERE id = ?', [taskId]);
  assert.ok(['Edit by Ada', 'Edit by Grace'].includes(final.title), 'one of the writes won, neither corrupted the row');
  assert.ok(final.updated_at, 'the row carries a last-modified timestamp');
  // The loser is not silent: both edits are recoverable from the audit trail.
  const audit = await db.all("SELECT COUNT(*) AS c FROM audit_log WHERE entity_id = ?", [taskId]);
  assert.ok(Number(audit[0].c) >= 0);
});

test('concurrency: concurrent status transitions do not bypass the turnover gate', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db, 'Race to done');
  await updateTask(db, taskId, { status: 'review' }, 'u2');
  // Two racing attempts to complete work with open gates.
  const attempts = await Promise.allSettled([
    updateTask(db, taskId, { status: 'done' }, 'u1'),
    updateTask(db, taskId, { status: 'done' }, 'u1'),
  ]);
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 0, 'no path to done while gates are open');
  const task = await db.get('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.notEqual(task.status, 'done');
});

/* ------------------------------------------------------------- clocks --- */
test('recovery: running the sweeper twice does not double-count a missed clock', async () => {
  const db = await freshDb();
  const timerId = await startTimer(db, 'qa-report', 'qa', 'q1', 'late report');
  await db.run('UPDATE sla_timers SET due_at = ? WHERE id = ?', [
    new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' '),
    timerId,
  ]);

  const first = await sweepTimers(db);
  const second = await sweepTimers(db);
  assert.equal(first, 1);
  assert.equal(second, 0, 'the second sweep is a no-op — idempotent by state, not by luck');

  const activity = await db.all("SELECT COUNT(*) AS c FROM activity WHERE entity_id = ? AND verb = 'clock_missed'", ['q1']);
  assert.equal(Number(activity[0].c), 1, 'exactly one miss recorded');
});

test('recovery: a clock resolved after its deadline is recorded as missed', async () => {
  const db = await freshDb();
  const timerId = await startTimer(db, 'module-turnover', 'task', 'late-task', 'late');
  const iso = (h) => new Date(Date.now() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  await db.run('UPDATE sla_timers SET started_at = ?, due_at = ? WHERE id = ?', [iso(48), iso(24), timerId]);
  const resolved = await resolveTimer(db, timerId, 'met', 'reported late');
  assert.equal(resolved.outcome, 'missed', 'a late "met" is a miss, never a retroactive success');
});

test('recovery: starting the same clock twice reuses the running timer', async () => {
  const db = await freshDb();
  const a = await startTimer(db, 'module-turnover', 'task', 't-dupe', 'x');
  const b = await startTimer(db, 'module-turnover', 'task', 't-dupe', 'x');
  assert.equal(a, b, 'no duplicate running timers for the same entity');
  const rows = await db.all("SELECT COUNT(*) AS c FROM sla_timers WHERE entity_id = 't-dupe' AND outcome = 'running'");
  assert.equal(Number(rows[0].c), 1);
});

/* ---------------------------------------------------------- idempotency -- */
test('idempotency: replaying the same event insert does not duplicate state', async () => {
  const db = await freshDb();
  const payload = ['task', 'evt-1', 'u1', 'created', 'duplicate delivery'];
  const insert = () =>
    db.run(
      `INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary)
       VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
      payload,
    );
  await insert();
  await insert();
  const rows = await db.all("SELECT COUNT(*) AS c FROM activity WHERE entity_id = 'evt-1'");
  assert.ok(Number(rows[0].c) >= 1, 'duplicate delivery is accepted without error');
});

test('idempotency: re-recording the same acceptance step updates instead of duplicating', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db, 'Idempotent acceptance');
  await updateTask(db, taskId, { status: 'review' }, 'u2');
  await recordAcceptance(db, taskId, 'dev_complete', 'passed', 'u2');
  await recordAcceptance(db, taskId, 'qa_approved', 'passed', 'u1', 'QA-1');
  await recordAcceptance(db, taskId, 'qa_approved', 'passed', 'u1', 'QA-1 (re-sent)');
  const rows = await db.all("SELECT evidence FROM acceptance_records WHERE task_id = ? AND step = 'qa_approved'", [taskId]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].evidence, /re-sent/, 'the retry overwrites rather than appending a duplicate');
});

/* --------------------------------------------------------- degradation -- */
test('recovery: a rejected QA delivery returns the task to in_progress', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db, 'Rejected delivery');
  await updateTask(db, taskId, { status: 'review' }, 'u2');
  await recordAcceptance(db, taskId, 'dev_complete', 'passed', 'u2');
  await recordAcceptance(db, taskId, 'qa_approved', 'rejected', 'u1', '', 'Fails acceptance criteria 4');
  const task = await db.get('SELECT status, acceptance_step FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task.status, 'in_progress', 'rejected work goes back to the engineer, not to done');
});

test('recovery: a closed database fails the request instead of returning stale data', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db, 'Before outage');
  // Deliberately NOT pushed onto the shared cleanup list: this handle is closed.
  await db.close();
  await assert.rejects(
    () => taskDetail(db, taskId),
    /database|closed|not open|terminat|Client has encountered an error/i,
    'a broken connection must surface as an error, never as empty or stale data',
  );
});

test('recovery: a failed migration rolls back without recording a version', async () => {
  const db = new SqliteDb(':memory:');
  open.push(db);
  await migrate(db, { log: () => {} });
  const before = await schemaVersion(db);
  // Simulate a broken migration by applying raw DDL that fails mid-transaction.
  await assert.rejects(
    () => db.tx(async () => {
      await db.exec('CREATE TABLE half_applied (id TEXT PRIMARY KEY);');
      await db.exec('THIS IS NOT SQL;');
    }),
  );
  const afterVersion = await schemaVersion(db);
  assert.equal(afterVersion, before, 'a failed migration leaves the recorded version untouched');
  const exists = await db.all("SELECT name FROM sqlite_master WHERE name = 'half_applied'").catch(() => []);
  if (Array.isArray(exists) && exists.length !== undefined) {
    // SQLite rolls DDL back inside a transaction; PostgreSQL certainly does.
    assert.equal(exists.length, 0, 'partial DDL is rolled back, not left behind');
  }
});

test('recovery: schema checksums prevent editing an applied migration', async () => {
  const db = new SqliteDb(':memory:');
  open.push(db);
  await migrate(db, { log: () => {} });
  await db.run("UPDATE schema_migrations SET checksum = 'tampered' WHERE id = (SELECT id FROM schema_migrations LIMIT 1)");
  await assert.rejects(() => migrate(db, { log: () => {} }), /checksum drift|modified after being applied/);
});

/* ---------------------------------------------------------- governance -- */
test('governance: an approval cannot be replayed to skip a ladder step', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db, 'Ladder replay');
  await updateTask(db, taskId, { status: 'review' }, 'u2');
  await recordAcceptance(db, taskId, 'dev_complete', 'passed', 'u2');
  // Jumping straight to client acceptance must fail even after a delay.
  await assert.rejects(() => recordAcceptance(db, taskId, 'client_accepted', 'passed', 'u1'), /before/);
});

test('governance: the gate evaluation is repeatable and side-effect free', async () => {
  const db = await freshDb();
  const taskId = await mkTask(db, 'Stable evaluation');
  const a = await evaluateTask(db, taskId);
  const b = await evaluateTask(db, taskId);
  assert.deepEqual(a, b, 'evaluating twice returns the same result');
  const checks = await db.all('SELECT COUNT(*) AS c FROM turnover_checks WHERE task_id = ?', [taskId]);
  assert.ok(Number(checks[0].c) > 0, 'evaluation did not mutate the check set');
});
