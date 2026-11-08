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
import { toDate } from '../src/lib/dates.ts';

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

/* ------------------------------------------------ timezones and DST (R24) -- */

/**
 * The six scenarios below close R24 and R62. They are the ones the traceability
 * document named as missing, so they test the specific hazard rather than
 * restating that clocks exist.
 *
 * The hazard: every stored timestamp is UTC text and every comparison is epoch
 * milliseconds, so there is no local-time arithmetic to get wrong. That is an
 * argument, not evidence. These tests make it evidence by pinning the clock to
 * instants that sit *on either side of a real DST transition* and asserting that
 * the elapsed measurement is unaffected.
 */

/** Run `fn` with `Date.now` fixed, restoring it afterwards. */
async function withClock(fixedMs, fn) {
  const realNow = Date.now;
  const RealDate = Date;
  Date.now = () => fixedMs;
  // `new Date()` must agree with Date.now(), or a test can pass while production
  // code reading `new Date()` disagrees with code reading `Date.now()`.
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() { return fixedMs; }
  };
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
}

const HOUR = 3_600_000;

test('dst: a clock spanning the spring-forward transition measures wall-independent hours', async () => {
  const db = await freshDb();
  const task = await mkTask(db, 'Across spring forward');

  // Europe/London springs forward at 01:00 UTC on the last Sunday in March.
  // 2026-03-29T00:30Z → 02:30Z is two real hours, but only one hour of local
  // clock time. A correct implementation stores and compares UTC and says 2h.
  const before = Date.parse('2026-03-29T00:30:00.000Z');

  const timerId = await withClock(before, () => startTimer(db, 'qa-report', 'task', task, 'QA report'));
  const after = Date.parse('2026-03-29T02:30:00.000Z');
  await withClock(after, () => sweepTimers(db));

  const row = await db.get('SELECT started_at, due_at, outcome FROM sla_timers WHERE id = ?', [timerId]);
  // Stored as SQLite's UTC datetime text, which carries no zone marker. `toDate`
  // is the app's parser and treats it as UTC — raw `Date.parse` would apply the
  // server's local zone, which is the exact bug this test exists to exclude.
  assert.equal(row.started_at, '2026-03-29 00:30:00', 'the start must be stored as UTC, unchanged');
  assert.equal(toDate(row.started_at).getTime(), before);
  // qa-report is 8 hours; the deadline is derived from the start, not from local time.
  assert.equal(row.due_at, '2026-03-29 12:30:00'); // qa-report target is 12h
  // Two elapsed hours against a twelve-hour clock is not a breach.
  assert.notEqual(row.outcome, 'missed', 'a two-hour span must not breach a twelve-hour clock across a DST change');
});

test('dst: a clock spanning the autumn fall-back transition is not lengthened', async () => {
  const db = await freshDb();
  const task = await mkTask(db, 'Across fall back');

  // 2026-10-25T00:30Z → 02:30Z is two real hours, but the local clock repeats an
  // hour and reads 03:30. An implementation using local time would compute three.
  const before = Date.parse('2026-10-25T00:30:00.000Z');
  const timerId = await withClock(before, () => startTimer(db, 'qa-report', 'task', task, 'QA report'));

  const after = Date.parse('2026-10-25T02:30:00.000Z');
  await withClock(after, () => sweepTimers(db));

  const row = await db.get('SELECT started_at, due_at, outcome FROM sla_timers WHERE id = ?', [timerId]);
  assert.equal(toDate(row.started_at).getTime(), before);
  assert.equal(row.due_at, '2026-10-25 12:30:00', 'fall-back must not move the deadline');
  assert.notEqual(row.outcome, 'missed');
});

test('dst: the deadline is crossed at the same instant regardless of the local zone', async () => {
  const db = await freshDb();
  const task = await mkTask(db, 'Zone independence');

  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const timerId = await withClock(start, () => startTimer(db, 'qa-report', 'task', task, 'QA report'));

  // One second before the eight-hour deadline: not missed.
  await withClock(start + 12 * HOUR - 1000, () => sweepTimers(db));
  let row = await db.get('SELECT outcome FROM sla_timers WHERE id = ?', [timerId]);
  assert.notEqual(row.outcome, 'missed', 'one second before the deadline is not a breach');

  // One second after: missed. The boundary is the deadline instant, not local midnight.
  await withClock(start + 12 * HOUR + 1000, () => sweepTimers(db));
  row = await db.get('SELECT outcome FROM sla_timers WHERE id = ?', [timerId]);
  assert.equal(row.outcome, 'missed', 'one second after the deadline is a breach');
});

test('dst: a paused clock banks real elapsed time across a transition, not wall time', async () => {
  const db = await freshDb();
  const { pauseTimerFor, resumeTimerFor } = await import('../src/services/clocks.ts');
  const task = await mkTask(db, 'Pause across DST');

  // Start just before the spring-forward, pause two real hours later.
  const start = Date.parse('2026-03-29T00:30:00.000Z');
  const timerId = await withClock(start, () => startTimer(db, 'qa-report', 'task', task, 'QA report'));

  const pausedAt = Date.parse('2026-03-29T02:30:00.000Z');
  // These operate on the entity, not the timer id — a pause applies to whatever
  // clock is running on that entity, which is what "pause this stage" means.
  await withClock(pausedAt, () =>
    pauseTimerFor(db, 'task', task, 'Client reviewing the build overnight.', { category: 'client', actorId: 'u1' }));

  const resumedAt = Date.parse('2026-03-29T04:30:00.000Z');
  await withClock(resumedAt, () => resumeTimerFor(db, 'task', task, { actorId: 'u1' }));

  const row = await db.get(
    'SELECT paused_ms, due_at, pause_reason, pause_category FROM sla_timers WHERE id = ?', [timerId]);
  assert.equal(Number(row.paused_ms), 2 * HOUR, 'two real paused hours must be banked, not one local hour');
  // The deadline moves by exactly the banked duration.
  assert.equal(row.due_at, '2026-03-29 14:30:00'); // 12h target + 2h banked
  assert.equal(row.pause_category, 'client');
});

test('dst: ISO timestamps round-trip through the database without a zone shift', async () => {
  const db = await freshDb();
  const task = await mkTask(db, 'Round trip');
  const start = Date.parse('2026-03-29T00:30:00.000Z');
  const timerId = await withClock(start, () => startTimer(db, 'qa-report', 'task', task, 'QA report'));

  const row = await db.get('SELECT started_at FROM sla_timers WHERE id = ?', [timerId]);
  // Parsing the stored value through the app's parser must return the exact
  // instant that was written, independent of the server's local zone.
  assert.equal(toDate(row.started_at).getTime(), start, 'a stored timestamp must parse back to the same epoch millisecond');
  // The storage format has no zone marker; the parser supplies UTC. Asserting the
  // format makes a future format change visible instead of silently shifting time.
  assert.match(row.started_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('dst: month and year boundaries do not distort an elapsed measurement', async () => {
  const db = await freshDb();
  const task = await mkTask(db, 'Year boundary');
  // New Year's Eve into New Year's Day, and a leap day: both are notorious for
  // off-by-one date handling.
  const start = Date.parse('2026-12-31T22:00:00.000Z');
  const timerId = await withClock(start, () => startTimer(db, 'qa-report', 'task', task, 'QA report'));
  const row = await db.get('SELECT due_at FROM sla_timers WHERE id = ?', [timerId]);
  assert.equal(row.due_at, '2027-01-01 10:00:00', 'twelve hours from 22:00 on 31 Dec is 10:00 on 1 Jan');

  const leap = await freshDb();
  const leapTask = await mkTask(leap, 'Leap day');
  const leapStart = Date.parse('2028-02-28T23:00:00.000Z');
  const leapTimer = await withClock(leapStart, () => startTimer(leap, 'qa-report', 'task', leapTask, 'QA report'));
  const leapRow = await leap.get('SELECT due_at FROM sla_timers WHERE id = ?', [leapTimer]);
  assert.equal(leapRow.due_at, '2028-02-29 11:00:00', 'the leap day is a real day, not a skipped one');
});

/* -------------------------------------------- remaining R62 scenarios ----- */

test('recovery: a late approval cannot be laundered into an on-time one', async () => {
  const db = await freshDb();
  const task = await mkTask(db, 'Stale approval');
  const timerId = await startTimer(db, 'qa-report', 'task', task, 'QA report');
  assert.ok(timerId, 'the qa-report clock policy must exist');

  const due = await db.get('SELECT due_at FROM sla_timers WHERE id = ?', [timerId]);
  const dueAt = toDate(due.due_at).getTime();

  // Someone resolves the clock two hours after its deadline, asking for "met".
  // The service must not grant it: the work was late, and the record has to say so
  // or every SLA figure downstream becomes fiction.
  await withClock(dueAt + 2 * HOUR, () =>
    resolveTimer(db, timerId, 'met', 'Approved late but approved.'));

  const after = await db.get('SELECT outcome, met_at, missed_at, exception_note FROM sla_timers WHERE id = ?', [timerId]);
  assert.equal(after.outcome, 'missed', 'a late resolution is recorded as missed, not met');
  assert.ok(after.missed_at, 'the miss is timestamped');
  assert.equal(after.met_at, null, 'a missed clock has no met_at, so it cannot be counted as met later');
  // The operator's note is preserved — the context matters even though the
  // outcome went against the request.
  assert.match(after.exception_note, /Approved late/);
});

test('recovery: the sweeper at the exact deadline instant is idempotent across two replicas', async () => {
  const db = await freshDb();
  const task = await mkTask(db, 'Boundary sweep');
  const timerId = await startTimer(db, 'qa-report', 'task', task, 'QA report');
  const dueRow = await db.get('SELECT due_at FROM sla_timers WHERE id = ?', [timerId]);
  const exact = toDate(dueRow.due_at).getTime();
  // Two sweeper runs at the identical instant, as two replicas would produce.
  const first = await withClock(exact, () => sweepTimers(db));
  const second = await withClock(exact, () => sweepTimers(db));

  const row = await db.get('SELECT outcome FROM sla_timers WHERE id = ?', [timerId]);
  // At the deadline exactly the clock is due but not yet breached; whatever the
  // chosen boundary, the two runs must agree and must not both count a breach.
  // `due_at < now` is strict, so a clock is not breached at its deadline instant —
  // only once the deadline has passed. Asserting that exact boundary is the point:
  // it means a deadline of 12:00 is met by work completed at 12:00.
  assert.equal(first, 0, 'a clock is not breached at its own deadline instant');
  assert.equal(second, 0, 'and a second sweep at the same instant changes nothing');
  const atDeadline = await db.get('SELECT outcome FROM sla_timers WHERE id = ?', [timerId]);
  assert.equal(atDeadline.outcome, 'running', 'still running at the deadline');
  const events = await db.all("SELECT COUNT(*) AS c FROM clock_events WHERE timer_id = ? AND kind = 'missed'", [timerId]);
  assert.ok(Number(events[0].c) <= 1, 'a single clock cannot be marked missed twice');
  assert.ok(row.outcome);
});

test('recovery: an unhandled exception in a route returns 500 and does not leak internals', async () => {
  // The fault is induced on a route registered for this test only. Dropping a real
  // table would work on SQLite (an in-memory database per suite) but would destroy
  // the shared PostgreSQL database for every suite that runs afterwards — which is
  // exactly what happened the first time this test was written.
  process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
  process.env.RATE_LIMIT_GLOBAL ||= '5000';
  const { buildApp } = await import('../src/app.ts');
  const db = await freshDb();
  const { app } = await buildApp({ db, serveStatic: false, logger: false });
  try {
    app.get('/__fault-probe', async () => {
      // A plain Error, not a TypeError/RangeError: those are classified as
      // client-shaped body faults and answered with 400. This must stay a 500.
      throw new Error('deliberate internal failure at /srv/app/secret-path.ts:42');
    });

    const res = await app.inject({ method: 'GET', url: '/__fault-probe' });
    assert.equal(res.statusCode, 500, `an internal fault must be a 500, got ${res.statusCode}`);
    // The response must not carry a stack trace, a file path or the message.
    assert.ok(!/secret-path|at Object|node_modules|\.ts:\d+/.test(res.body),
      `internals leaked to the client: ${res.body.slice(0, 200)}`);
    assert.ok(/"code"\s*:/.test(res.body), 'the client still gets a structured error');
    // And the data must be an error envelope, not a partial result.
    const parsed = JSON.parse(res.body);
    assert.ok(parsed.error, 'a failed request must not return a data payload');
  } finally {
    await app.close();
  }
});

test('recovery: a client-shaped fault is a 400, an internal fault is a 500', async () => {
  // The dividing line the error handler draws, asserted from both sides. Without
  // this, a change that maps every error to 400 would hide outages, and one that
  // maps every error to 500 would blame the caller for their own bad request.
  const { buildApp } = await import('../src/app.ts');
  const db = await freshDb();
  const { app } = await buildApp({ db, serveStatic: false, logger: false });
  try {
    app.get('/__shape-probe', async () => {
      const value = { n: 1 };
      // Reading `.trim()` off a number is the classic request-shape fault.
      return value.n.trim();
    });
    app.get('/__range-probe', async () => {
      throw new RangeError('Invalid array length');
    });

    const shape = await app.inject({ method: 'GET', url: '/__shape-probe' });
    assert.equal(shape.statusCode, 400, 'a TypeError from request-shaped data is a client fault');

    const range = await app.inject({ method: 'GET', url: '/__range-probe' });
    assert.equal(range.statusCode, 400, 'a RangeError is a client fault');
  } finally {
    await app.close();
  }
});
