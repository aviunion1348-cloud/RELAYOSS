/**
 * Operational clock engine.
 *
 * Every hard deadline from the delivery board is a row in `sla_clocks` and
 * every live countdown is a row in `sla_timers`. Timers can be met, missed,
 * paused (waiting on the client) or waived with a written exception — so a
 * missed turnaround is always attributable, never invisible.
 */
import type { Db } from '../db/index.ts';
import { id, nowIso } from '../lib/ids.ts';
import { badRequest, notFound } from '../lib/http.ts';
import { toDate } from '../lib/dates.ts';

const HOUR = 3600_000;

export async function getClock(db: Db, key: string) {
  const clock = await db.get<Record<string, any>>('SELECT * FROM sla_clocks WHERE key = ?', [key]);
  if (!clock) throw notFound(`Unknown clock: ${key}`);
  return clock;
}

/**
 * Start a clock. Best-effort by design: a missing or renamed clock *policy*
 * must never block a legitimate workflow transition — observability should not
 * be able to break delivery. Returns null when the policy is absent.
 */
export async function startTimer(
  db: Db,
  clockKey: string,
  entityType: string,
  entityId: string,
  label = '',
  startedAt = new Date(),
): Promise<string | null> {
  const clock = await db.get<Record<string, any>>('SELECT * FROM sla_clocks WHERE key = ?', [clockKey]);
  if (!clock) return null;
  const existing = await db.get<{ id: string }>(
    "SELECT id FROM sla_timers WHERE clock_key = ? AND entity_type = ? AND entity_id = ? AND outcome = 'running'",
    [clockKey, entityType, entityId],
  );
  if (existing) return existing.id;
  const due = new Date(startedAt.getTime() + clock.target_hours * HOUR);
  const warn = new Date(startedAt.getTime() + clock.warn_hours * HOUR);
  const timerId = id('tmr');
  await db.run(
    `INSERT INTO sla_timers (id,clock_key,entity_type,entity_id,label,started_at,due_at,warn_at,outcome)
     VALUES (?,?,?,?,?,?,?,?,'running')`,
    [timerId, clockKey, entityType, entityId, label,
      startedAt.toISOString().slice(0, 19).replace('T', ' '),
      due.toISOString().slice(0, 19).replace('T', ' '),
      warn.toISOString().slice(0, 19).replace('T', ' ')],
  );
  // The clock's own log starts at the moment it starts. Without this the history
  // begins at the first pause, and a clock that ran and met its deadline has no
  // record of when it began — which is exactly the question an audit asks.
  await db.run(
    `INSERT INTO clock_events (id, timer_id, clock_key, kind, reason, category, actor_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id('cev'), timerId, clockKey, 'started',
      `Started: ${label || clockKey} (target ${clock.target_hours}h, warn ${clock.warn_hours}h)`,
      '', null, startedAt.toISOString().slice(0, 19).replace('T', ' ')],
  );
  return timerId;
}

export async function closeTimersFor(db: Db, entityType: string, entityId: string, outcome: 'met' | 'missed' | 'waived' = 'met'): Promise<void> {
  await db.run(
    "UPDATE sla_timers SET outcome = ?, met_at = CASE WHEN ? = 'met' THEN ? ELSE met_at END, missed_at = CASE WHEN ? = 'missed' THEN ? ELSE missed_at END WHERE entity_type = ? AND entity_id = ? AND outcome = 'running'",
    [outcome, outcome, nowIso(), outcome, nowIso(), entityType, entityId],
  );
}

export async function resolveTimer(db: Db, timerId: string, outcome: 'met' | 'missed' | 'paused' | 'waived', note = '') {
  const timer = await db.get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
  if (!timer) throw notFound('Timer not found');
  const now = new Date();
  const due = toDate(timer.due_at) ?? now;
  const minutesUsed = Math.round((now.getTime() - (toDate(timer.started_at)?.getTime() ?? now.getTime())) / 60000);
  const finalOutcome = outcome === 'met' && now > due ? 'missed' : outcome;
  await db.run('UPDATE sla_timers SET outcome = ?, met_at = ?, missed_at = ?, exception_note = ?, minutes_used = ? WHERE id = ?', [
    finalOutcome,
    finalOutcome === 'met' ? nowIso() : null,
    finalOutcome === 'missed' ? nowIso() : null,
    note || timer.exception_note || '',
    minutesUsed,
    timerId,
  ]);
  return await db.get('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
}

/** Sweep: mark every overdue running timer as missed and raise notifications. */
export async function sweepTimers(db: Db): Promise<number> {
  const now = nowIso();
  // A paused timer is waiting on somebody else. Sweeping it would breach the
  // agency for the client's delay, which is precisely the failure mode the
  // board warns about.
  const overdue = await db.all<Record<string, any>>(
    "SELECT * FROM sla_timers WHERE outcome = 'running' AND paused_at IS NULL AND due_at < ?",
    [now],
  );
  await db.tx(async () => {
    for (const t of overdue) {
      await db.run("UPDATE sla_timers SET outcome = 'missed', missed_at = ? WHERE id = ?", [now, t.id]);
      await db.run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
        t.entity_type, t.entity_id, null, 'clock_missed', `missed ${t.clock_key} — ${t.label || t.entity_id}`,
      ]);
    }
  });
  return overdue.length;
}

export interface ClockHealth {
  key: string;
  name: string;
  scope: string;
  targetHours: number;
  warnHours: number;
  stretchHours: number | null;
  policyNote: string;
  boardRef: string;
  escalation: string;
  running: number;
  met: number;
  missed: number;
  waived: number;
  compliancePct: number;
  avgHours: number | null;
  atRisk: number;
}

export async function clockHealth(db: Db): Promise<ClockHealth[]> {
  const clocks = await db.all<Record<string, any>>('SELECT * FROM sla_clocks ORDER BY target_hours ASC');
  const now = Date.now();
  const out: ClockHealth[] = [];
  for (const c of clocks) {
    const timers = await db.all<Record<string, any>>('SELECT * FROM sla_timers WHERE clock_key = ?', [c.key]);
    const met = timers.filter((t) => t.outcome === 'met').length;
    const missed = timers.filter((t) => t.outcome === 'missed').length;
    const waived = timers.filter((t) => t.outcome === 'waived').length;
    const running = timers.filter((t) => t.outcome === 'running');
    const decided = met + missed;
    const completed = timers.filter((t) => t.met_at);
    const avgHours = completed.length
      ? Math.round(
          (completed.reduce((sum, t) => {
            const end = toDate(t.met_at)?.getTime();
            const start = toDate(t.started_at)?.getTime();
            return sum + (end && start ? end - start : 0);
          }, 0) / completed.length / HOUR) * 10,
        ) / 10
      : null;
    const health: ClockHealth = {
      key: c.key,
      name: c.name,
      scope: c.scope,
      targetHours: c.target_hours,
      warnHours: c.warn_hours,
      stretchHours: c.stretch_hours,
      policyNote: c.policy_note,
      boardRef: c.board_ref,
      escalation: c.escalation,
      running: running.length,
      met,
      missed,
      waived,
      compliancePct: decided ? Math.round((met / decided) * 100) : 100,
      avgHours,
      atRisk: running.filter((t) => (toDate(t.due_at)?.getTime() ?? now) - now < c.warn_hours * 0.3 * HOUR).length,
    };
    out.push(health);
  }
  return out;
}

export async function liveTimers(db: Db, limit = 50) {
  const rows = await db.all<Record<string, any>>(
    `SELECT t.*, c.name AS clock_name, c.scope, c.escalation, c.target_hours
     FROM sla_timers t JOIN sla_clocks c ON c.key = t.clock_key
     WHERE t.outcome IN ('running','missed')
     ORDER BY CASE t.outcome WHEN 'missed' THEN 0 ELSE 1 END, t.due_at ASC LIMIT ?`,
    [limit],
  );
  const now = Date.now();
  return rows.map((r) => {
    const due = toDate(r.due_at)?.getTime() ?? now;
    const started = toDate(r.started_at)?.getTime() ?? now;
    const total = Math.max(1, due - started);
    const elapsed = now - started;
    return {
      id: r.id,
      clock: r.clock_key,
      clockName: r.clock_name,
      scope: r.scope,
      entityType: r.entity_type,
      entityId: r.entity_id,
      label: r.label,
      startedAt: r.started_at,
      dueAt: r.due_at,
      outcome: r.outcome,
      exceptionNote: r.exception_note,
      hoursLeft: Math.round(((due - now) / HOUR) * 10) / 10,
      progressPct: Math.min(100, Math.round((elapsed / total) * 100)),
      targetHours: r.target_hours,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Pause / resume.
 *
 * A clock's `outcome` is the terminal verdict (met/missed/waived); its
 * `paused_at` is a transient sub-state. Keeping them separate means a pause can
 * never be mistaken for completion, and a sweep can never close a paused timer.
 *
 * Authorised pause time is banked in `paused_ms` and excluded from the elapsed
 * measurement. When a pause ends, `due_at` is pushed forward by exactly the time
 * the clock spent paused — so a clock paused for two days does not silently
 * breach while waiting on a client.
 *
 * Pause categories are recorded because "we were waiting on the client" and "we
 * were slow" are different facts, and only one of them is the agency's fault:
 *   client   — waiting on the client (does not count against us)
 *   internal — our own delay (counts; recorded so it cannot be disguised)
 *   vendor   — third-party dependency
 * -------------------------------------------------------------------------*/

export type PauseCategory = 'client' | 'internal' | 'vendor';

export async function pauseTimerFor(
  db: Db,
  entityType: string,
  entityId: string,
  reason: string,
  options: { category?: PauseCategory; actorId?: string | null } = {},
): Promise<Record<string, any> | null> {
  const timer = await db.get<Record<string, any>>(
    "SELECT * FROM sla_timers WHERE entity_type = ? AND entity_id = ? AND outcome = 'running' ORDER BY started_at DESC",
    [entityType, entityId],
  );
  if (!timer) return null;
  // Idempotent: pausing an already-paused clock is a no-op, not a second event.
  if (timer.paused_at) return timer;
  // A pause removes time from the agency's measurement, so it is only legitimate
  // when someone states why. A blank reason is refused rather than defaulted:
  // an unexplained pause is indistinguishable from hiding a delay.
  const trimmed = String(reason ?? '').trim();
  if (!trimmed) throw badRequest('A pause needs a reason — paused time is excluded from the clock.');
  const category = options.category ?? 'client';
  // The category is what separates a client-caused wait from our own delay, so
  // an unknown value is refused rather than coerced to a default.
  if (!['client', 'internal', 'vendor'].includes(String(category))) {
    throw badRequest('A pause category must be client, internal or vendor.');
  }
  const now = nowIso();
  await db.run(
    'UPDATE sla_timers SET paused_at = ?, pause_reason = ?, pause_category = ?, paused_by = ? WHERE id = ?',
    [now, trimmed, category, options.actorId ?? null, timer.id],
  );
  await db.run(
    `INSERT INTO clock_events (id, timer_id, clock_key, kind, reason, category, actor_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id('cev'), timer.id, timer.clock_key, 'paused', trimmed, category, options.actorId ?? null, now],
  );
  return (await db.get('SELECT * FROM sla_timers WHERE id = ?', [timer.id])) ?? null;
}

export async function resumeTimerFor(
  db: Db,
  entityType: string,
  entityId: string,
  options: { actorId?: string | null } = {},
): Promise<Record<string, any> | null> {
  const timer = await db.get<Record<string, any>>(
    "SELECT * FROM sla_timers WHERE entity_type = ? AND entity_id = ? AND outcome = 'running' ORDER BY started_at DESC",
    [entityType, entityId],
  );
  if (!timer || !timer.paused_at) return timer ?? null;
  const pausedAt = toDate(timer.paused_at);
  const pausedFor = pausedAt ? Math.max(0, Date.now() - pausedAt.getTime()) : 0;
  const total = Number(timer.paused_ms ?? 0) + pausedFor;
  // Push the deadline forward by exactly the paused duration.
  const due = toDate(timer.due_at);
  const newDue = due ? new Date(due.getTime() + pausedFor) : null;
  const warn = toDate(timer.warn_at);
  const newWarn = warn ? new Date(warn.getTime() + pausedFor) : null;
  await db.run(
    `UPDATE sla_timers SET paused_at = NULL, paused_ms = ?,
       due_at = COALESCE(?, due_at), warn_at = COALESCE(?, warn_at)
     WHERE id = ?`,
    [total, newDue ? newDue.toISOString().slice(0, 19).replace('T', ' ') : null,
      newWarn ? newWarn.toISOString().slice(0, 19).replace('T', ' ') : null, timer.id],
  );
  await db.run(
    `INSERT INTO clock_events (id, timer_id, clock_key, kind, reason, category, actor_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id('cev'), timer.id, timer.clock_key, 'resumed', `${Math.round(pausedFor / 60000)}m paused`, timer.pause_category ?? '', options.actorId ?? null, nowIso()],
  );
  return (await db.get('SELECT * FROM sla_timers WHERE id = ?', [timer.id])) ?? null;
}

/** Complete history for one timer, oldest first. */
export async function clockHistory(db: Db, timerId: string) {
  return db.all<Record<string, any>>(
    `SELECT e.*, u.full_name AS actor_name FROM clock_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.timer_id = ? ORDER BY e.id ASC`,
    [timerId],
  );
}
