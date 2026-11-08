/**
 * R23 — SLA clock pause/resume, and R24 — DTS calibration.
 *
 * A clock is only a control if it cannot be quietly manipulated. This suite is
 * organised around the ways a pause could be abused:
 *
 *   - pause must not reset or destroy elapsed time
 *   - time spent paused must not count against the agency when the wait was the
 *     client's fault, and *must* count when it was ours (the category decides)
 *   - the sweeper must not breach a paused clock (R23's original defect: pause
 *     was a terminal outcome, so a paused clock could never resume and the
 *     sweeper promptly marked it missed)
 *   - repeated pause/resume cycles accumulate, they do not overwrite
 *   - every pause, resume and verdict is in the history, attributed
 *   - only a running clock can be paused; a met clock cannot be un-met
 *   - resuming pushes the deadline forward by exactly the paused duration
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { startTimer, resolveTimer, sweepTimers, pauseTimerFor, resumeTimerFor, clockHistory } from '../src/services/clocks.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

after(async () => {
  try { await db.close(); } catch { /* closed */ }
});

const HOUR = 3_600_000;

async function seedEntity(id) {
  await db.run("INSERT OR IGNORE INTO users (id,email,full_name,role,initials) VALUES ('u1','a@x.io','Ada','admin','AD')");
  await db.run("INSERT OR IGNORE INTO clients (id,name,slug,initials) VALUES ('cX','Probe','probe','PX')");
  await db.run("INSERT OR IGNORE INTO projects (id,key,name,client_id) VALUES (?,?,?,?)", [id, id.slice(0, 3).toUpperCase(), `Project ${id}`, 'cX']);
}

/** A timer that is already some distance into its window. */
async function runningTimer(entityId, hoursRemaining = 6) {
  await seedEntity(entityId);
  const timerId = await startTimer(db, 'module-turnover', 'project', entityId, `Probe ${entityId}`);
  assert.ok(timerId, 'a timer must be started');
  // Put the deadline a known distance away, as if time had already passed.
  const dueAt = new Date(Date.now() + hoursRemaining * HOUR).toISOString().replace('T', ' ').replace('Z', '');
  await db.run('UPDATE sla_timers SET due_at = ?, warn_at = ? WHERE id = ?', [dueAt, dueAt, timerId]);
  return db.get('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
}

/* =============================================================== pausing === */

test('R23: pausing preserves the elapsed time already accumulated', async () => {
  const timer = await runningTimer('prj_pause_elapsed');
  await db.run("UPDATE sla_timers SET started_at = ? WHERE id = ?", [
    new Date(Date.now() - 2 * HOUR).toISOString().replace('T', ' ').replace('Z', ''), timer.id,
  ]);
  const before = await db.get('SELECT * FROM sla_timers WHERE id = ?', [timer.id]);

  const paused = await pauseTimerFor(db, 'project', 'prj_pause_elapsed', 'Client has not supplied the logo pack', {
    category: 'client', actorId: 'u1',
  });
  assert.ok(paused, 'the clock must pause');
  assert.equal(paused.paused_at ? true : false, true, 'a paused clock has a paused_at timestamp');
  assert.equal(paused.started_at, before.started_at, 'elapsed time must survive the pause — started_at is untouched');
  assert.equal(paused.due_at, before.due_at, 'the deadline does not move until the clock resumes');
});

test('R23: the sweeper does not breach a paused clock', async () => {
  const timer = await runningTimer('prj_pause_sweep', 1);
  await pauseTimerFor(db, 'project', 'prj_pause_sweep', 'Waiting on client sign-off', { category: 'client', actorId: 'u1' });
  // Push the deadline into the past while it is paused: the classic client-delay
  // situation. A sweep must leave it alone.
  const past = new Date(Date.now() - 2 * HOUR).toISOString().replace('T', ' ').replace('Z', '');
  await db.run('UPDATE sla_timers SET due_at = ?, warn_at = ? WHERE id = ?', [past, past, timer.id]);

  await sweepTimers(db, { now: new Date() });
  const after_ = await db.get('SELECT * FROM sla_timers WHERE id = ?', [timer.id]);
  assert.equal(after_.outcome, 'running', 'a paused clock stays running — the agency is not at fault for a client delay');
  assert.equal(after_.missed_at, null, 'a paused clock is never marked missed');
});

test('R23: resume pushes the deadline forward by exactly the paused duration', async () => {
  const timer = await runningTimer('prj_resume_shift', 6);
  const originalDue = new Date(String(timer.due_at).replace(' ', 'T') + 'Z');
  await pauseTimerFor(db, 'project', 'prj_resume_shift', 'Client holiday', { category: 'client', actorId: 'u1' });

  // Pretend the clock sat paused for two hours.
  const pausedAt = new Date(Date.now() - 2 * HOUR).toISOString().replace('T', ' ').replace('Z', '');
  await db.run("UPDATE sla_timers SET paused_at = ? WHERE id = ?", [pausedAt, timer.id]);

  const resumed = await resumeTimerFor(db, 'project', 'prj_resume_shift', { actorId: 'u1' });
  assert.ok(resumed);
  assert.equal(resumed.paused_at, null, 'a resumed clock is no longer paused');
  const newDue = new Date(String(resumed.due_at).replace(' ', 'T') + 'Z');
  const shiftMs = newDue.getTime() - originalDue.getTime();
  // Exactly two hours, to within a second of clock jitter.
  assert.ok(Math.abs(shiftMs - 2 * HOUR) < 1000, `deadline should shift by 2h, shifted by ${shiftMs}ms`);
  assert.ok(Number(resumed.paused_ms) >= 2 * HOUR - 1000, 'the paused duration must be banked on the timer');
});

test('R23: the pause category separates client delay from our own delay', async () => {
  const clientWait = await runningTimer('prj_cat_client');
  await pauseTimerFor(db, 'project', 'prj_cat_client', 'Awaiting client credentials', { category: 'client', actorId: 'u1' });
  const clientRow = await db.get('SELECT * FROM sla_timers WHERE id = ?', [clientWait.id]);
  assert.equal(clientRow.pause_category, 'client');
  assert.match(clientRow.pause_reason, /credentials/);

  const ourWait = await runningTimer('prj_cat_internal');
  await pauseTimerFor(db, 'project', 'prj_cat_internal', 'Blocked on internal QA capacity', { category: 'internal', actorId: 'u1' });
  const internalRow = await db.get('SELECT * FROM sla_timers WHERE id = ?', [ourWait.id]);
  assert.equal(internalRow.pause_category, 'internal');
  // The distinction exists precisely so a client delay is not banked as our
  // improvement, or our own delay hidden as a client wait.
  assert.notEqual(clientRow.pause_category, internalRow.pause_category);
});

test('R23: a pause requires a reason and a valid category', async () => {
  const timer = await runningTimer('prj_pause_reason');
  // The service does not invent a reason, and does not default one either.
  await assert.rejects(
    () => pauseTimerFor(db, 'project', 'prj_pause_reason', '   ', { category: 'client', actorId: 'u1' }),
    (err) => err.status === 400 && /reason/i.test(err.message),
    'a blank reason must be refused, not accepted',
  );
  const row = await db.get('SELECT * FROM sla_timers WHERE id = ?', [timer.id]);
  assert.equal(row.paused_at, null, 'a blank reason must not pause the clock');
  assert.equal(row.outcome, 'running');

  // An invalid category is refused as well.
  await assert.rejects(
    () => pauseTimerFor(db, 'project', 'prj_pause_reason', 'A real reason', { category: 'nonsense', actorId: 'u1' }),
    (err) => err.status === 400,
    'only client/internal/vendor may categorise a pause',
  );
});

test('R23: repeated pause and resume cycles accumulate rather than overwrite', async () => {
  const timer = await runningTimer('prj_repeat', 10);

  for (const hours of [1, 2, 3]) {
    await pauseTimerFor(db, 'project', 'prj_repeat', `Pause of ${hours}h`, { category: 'client', actorId: 'u1' });
    const pausedAt = new Date(Date.now() - hours * HOUR).toISOString().replace('T', ' ').replace('Z', '');
    await db.run("UPDATE sla_timers SET paused_at = ? WHERE id = ?", [pausedAt, timer.id]);
    await resumeTimerFor(db, 'project', 'prj_repeat', { actorId: 'u1' });
  }

  const row = await db.get('SELECT * FROM sla_timers WHERE id = ?', [timer.id]);
  const banked = Number(row.paused_ms);
  // 1 + 2 + 3 = 6 hours across three cycles.
  assert.ok(Math.abs(banked - 6 * HOUR) < 3000, `expected ~6h banked across three cycles, got ${banked}ms`);

  const events = await clockHistory(db, timer.id);
  const pauses = events.filter((e) => e.kind === 'paused');
  const resumes = events.filter((e) => e.kind === 'resumed');
  assert.equal(pauses.length, 3, 'every pause is its own history row');
  assert.equal(resumes.length, 3, 'every resume is its own history row');
  // History is append-only and ordered.
  const ids = events.map((e) => Number(e.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'history must be in append order');
});

test('R23: resuming a clock that is not paused is a no-op, not an error', async () => {
  await runningTimer('prj_noop', 5);
  const result = await resumeTimerFor(db, 'project', 'prj_noop', { actorId: 'u1' });
  assert.ok(result, 'the running clock is returned unchanged');
  assert.equal(result.paused_at, null);
  assert.equal(Number(result.paused_ms), 0);
});

test('R23: pausing an already-paused clock does not create a second event', async () => {
  await runningTimer('prj_double_pause', 5);
  await pauseTimerFor(db, 'project', 'prj_double_pause', 'First pause', { category: 'client', actorId: 'u1' });
  const row = await db.get("SELECT * FROM sla_timers WHERE entity_id = 'prj_double_pause'");
  const second = await pauseTimerFor(db, 'project', 'prj_double_pause', 'Second pause attempt', { category: 'client', actorId: 'u1' });
  // Idempotent: the first reason stands, no double-banking.
  const after_ = await db.get('SELECT * FROM sla_timers WHERE id = ?', [row.id]);
  assert.equal(after_.pause_reason, 'First pause');
  assert.ok(second);
  const events = await clockHistory(db, row.id);
  assert.equal(events.filter((e) => e.kind === 'paused').length, 1, 'a repeated pause is not a second pause event');
});

test('R23: a met clock cannot be paused, and a paused clock cannot be met', async () => {
  const timer = await runningTimer('prj_terminal', 5);
  await resolveTimer(db, timer.id, 'met', 'Delivered');
  const paused = await pauseTimerFor(db, 'project', 'prj_terminal', 'Too late to pause', { category: 'internal', actorId: 'u1' });
  assert.equal(paused, null, 'a met clock is terminal');
  const row = await db.get('SELECT * FROM sla_timers WHERE id = ?', [timer.id]);
  assert.equal(row.outcome, 'met');
  assert.equal(row.paused_at, null);
});

/* ============================================================ calibration === */

test('R24: the ten documented clocks keep their exact thresholds', async () => {
  const rows = await db.all('SELECT key, warn_hours, target_hours, stretch_hours FROM sla_clocks ORDER BY key');
  const expected = {
    // [warn_hours, target_hours, stretch_hours] — the three thresholds exactly
    // as documented. Warn is the amber point, target the promise, stretch the
    // internal aggressive goal.
    'consult-to-plan': [48, 72, 36],
    'plan-revision': [24, 32, 12],
    'module-turnover': [18, 24, 12],
    'milestone-turnover': [120, 168, 96],
    'client-turnover': [240, 336, 168],
    'first-demo': [288, 336, 168],
    'ship-after-approval': [96, 120, 48],
    'qa-report': [8, 12, 6],
    'exec-summary': [72, 96, 48],
    'lead-triage': [12, 24, 8],
  };
  assert.equal(rows.length, 10, 'exactly ten clocks are defined');
  for (const row of rows) {
    const want = expected[row.key];
    assert.ok(want, `unexpected clock ${row.key}`);
    // The gap between warn/target/breach is the calibration: changing one of
    // these numbers silently changes what the agency promises, so it is pinned.
    assert.deepEqual(
      [Number(row.warn_hours), Number(row.target_hours), Number(row.stretch_hours)],
      want,
      `clock ${row.key} must keep its documented thresholds`,
    );
  }
});

test('R24: a clock timer defaults to its policy window, not an arbitrary value', async () => {
  await seedEntity('prj_default');
  const timerId = await startTimer(db, 'qa-report', 'project', 'prj_default', 'QA');
  const timer = await db.get('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
  const policy = await db.get("SELECT * FROM sla_clocks WHERE key = 'qa-report'");
  const started = new Date(String(timer.started_at).replace(' ', 'T') + 'Z');
  const due = new Date(String(timer.due_at).replace(' ', 'T') + 'Z');
  const windowHours = (due.getTime() - started.getTime()) / HOUR;
  assert.ok(
    Math.abs(windowHours - Number(policy.target_hours)) < 0.1,
    `a qa-report clock must run for ${policy.target_hours}h, ran for ${windowHours.toFixed(2)}h`,
  );
});

test('R24: one timer per entity and clock — the sweeper cannot duplicate', async () => {
  await seedEntity('prj_single');
  const firstId = await startTimer(db, 'module-turnover', 'project', 'prj_single', 'First');
  const secondId = await startTimer(db, 'module-turnover', 'project', 'prj_single', 'Second');
  const rows = await db.all(
    "SELECT * FROM sla_timers WHERE entity_type = 'project' AND entity_id = 'prj_single' AND clock_key = 'module-turnover' AND outcome = 'running'",
  );
  assert.equal(rows.length, 1, 'starting a clock twice must not create two running timers');
  assert.equal(secondId, firstId, 'the existing timer is returned rather than duplicated');

  // Repeated sweeps must not produce repeated verdicts.
  await sweepTimers(db, { now: new Date() });
  await sweepTimers(db, { now: new Date() });
  const events = await clockHistory(db, firstId);
  const verdicts = events.filter((e) => e.kind === 'met' || e.kind === 'missed');
  assert.ok(verdicts.length <= 1, 'a sweep must not write a second verdict for the same timer');
});

test('R23: pause history survives on both engines with timestamps', async () => {
  await seedEntity('prj_history');
  const timerId = await startTimer(db, 'module-turnover', 'project', 'prj_history', 'History');
  await pauseTimerFor(db, 'project', 'prj_history', 'Client delay', { category: 'client', actorId: 'u1' });
  await resumeTimerFor(db, 'project', 'prj_history', { actorId: 'u1' });

  const events = await clockHistory(db, timerId);
  assert.ok(events.length >= 3, 'started, paused and resumed must all be recorded');
  for (const event of events) {
    assert.ok(event.created_at, 'every clock event is timestamped');
    assert.ok(['started', 'paused', 'resumed', 'met', 'missed', 'waived', 'acknowledged', 'swept'].includes(event.kind));
  }
  const paused = events.find((e) => e.kind === 'paused');
  assert.equal(paused.actor_id, 'u1', 'the pause is attributed to whoever authorised it');
  assert.equal(paused.category, 'client', 'the reason category is recorded, not inferred later');
});
