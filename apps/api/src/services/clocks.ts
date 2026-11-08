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
import { notFound } from '../lib/http.ts';
import { toDate } from '../lib/dates.ts';

const HOUR = 3600_000;

export function getClock(db: Db, key: string) {
  const clock = db.get<Record<string, any>>('SELECT * FROM sla_clocks WHERE key = ?', [key]);
  if (!clock) throw notFound(`Unknown clock: ${key}`);
  return clock;
}

/**
 * Start a clock. Best-effort by design: a missing or renamed clock *policy*
 * must never block a legitimate workflow transition — observability should not
 * be able to break delivery. Returns null when the policy is absent.
 */
export function startTimer(
  db: Db,
  clockKey: string,
  entityType: string,
  entityId: string,
  label = '',
  startedAt = new Date(),
): string | null {
  const clock = db.get<Record<string, any>>('SELECT * FROM sla_clocks WHERE key = ?', [clockKey]);
  if (!clock) return null;
  const existing = db.get<{ id: string }>(
    "SELECT id FROM sla_timers WHERE clock_key = ? AND entity_type = ? AND entity_id = ? AND outcome = 'running'",
    [clockKey, entityType, entityId],
  );
  if (existing) return existing.id;
  const due = new Date(startedAt.getTime() + clock.target_hours * HOUR);
  const warn = new Date(startedAt.getTime() + clock.warn_hours * HOUR);
  const timerId = id('tmr');
  db.run(
    `INSERT INTO sla_timers (id,clock_key,entity_type,entity_id,label,started_at,due_at,warn_at,outcome)
     VALUES (?,?,?,?,?,?,?,?,'running')`,
    [timerId, clockKey, entityType, entityId, label,
      startedAt.toISOString().slice(0, 19).replace('T', ' '),
      due.toISOString().slice(0, 19).replace('T', ' '),
      warn.toISOString().slice(0, 19).replace('T', ' ')],
  );
  return timerId;
}

export function closeTimersFor(db: Db, entityType: string, entityId: string, outcome: 'met' | 'missed' | 'waived' = 'met') {
  db.run(
    "UPDATE sla_timers SET outcome = ?, met_at = CASE WHEN ? = 'met' THEN ? ELSE met_at END, missed_at = CASE WHEN ? = 'missed' THEN ? ELSE missed_at END WHERE entity_type = ? AND entity_id = ? AND outcome = 'running'",
    [outcome, outcome, nowIso(), outcome, nowIso(), entityType, entityId],
  );
}

export function resolveTimer(db: Db, timerId: string, outcome: 'met' | 'missed' | 'paused' | 'waived', note = '') {
  const timer = db.get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
  if (!timer) throw notFound('Timer not found');
  const now = new Date();
  const due = toDate(timer.due_at) ?? now;
  const minutesUsed = Math.round((now.getTime() - (toDate(timer.started_at)?.getTime() ?? now.getTime())) / 60000);
  const finalOutcome = outcome === 'met' && now > due ? 'missed' : outcome;
  db.run('UPDATE sla_timers SET outcome = ?, met_at = ?, missed_at = ?, exception_note = ?, minutes_used = ? WHERE id = ?', [
    finalOutcome,
    finalOutcome === 'met' ? nowIso() : null,
    finalOutcome === 'missed' ? nowIso() : null,
    note || timer.exception_note || '',
    minutesUsed,
    timerId,
  ]);
  return db.get('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
}

/** Sweep: mark every overdue running timer as missed and raise notifications. */
export function sweepTimers(db: Db) {
  const now = nowIso();
  const overdue = db.all<Record<string, any>>(
    "SELECT * FROM sla_timers WHERE outcome = 'running' AND due_at < ?",
    [now],
  );
  db.tx(() => {
    for (const t of overdue) {
      db.run("UPDATE sla_timers SET outcome = 'missed', missed_at = ? WHERE id = ?", [now, t.id]);
      db.run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
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

export function clockHealth(db: Db): ClockHealth[] {
  const clocks = db.all<Record<string, any>>('SELECT * FROM sla_clocks ORDER BY target_hours ASC');
  const now = Date.now();
  return clocks.map((c) => {
    const timers = db.all<Record<string, any>>('SELECT * FROM sla_timers WHERE clock_key = ?', [c.key]);
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
    return {
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
  });
}

export function liveTimers(db: Db, limit = 50) {
  const rows = db.all<Record<string, any>>(
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
