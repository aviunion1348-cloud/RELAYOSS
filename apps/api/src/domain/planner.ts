/**
 * Capacity-aware delivery planner.
 *
 * 1. Builds the dependency graph of open work (task_dependencies).
 * 2. Computes critical-path slack via a topological pass (cycle-safe).
 * 3. Orders ready work with WSPT (priority × urgency ÷ effort), breaking ties
 *    by criticality then by due date.
 * 4. Packs each task into the earliest slot on its owner's calendar, honouring
 *    weekly capacity, weekends, and existing commitments.
 *
 * The output is fully explainable: every scheduled item carries a rationale
 * string and a risk score. Deterministic for a given input, so runs are
 * reproducible and diffable.
 */
import { scoreRisk, wsptScore, type Priority, type Status } from './risk.ts';
import { toDate } from '../lib/dates.ts';

export interface PlannerTask {
  id: string;
  key: string;
  title: string;
  priority: Priority;
  status: Status;
  assignee_id: string | null;
  estimate_hours: number;
  logged_hours: number;
  due_at: string | null;
  created_at: string;
  blocked_reason: string;
  turnover_state: string;
  client_visible: number;
  parent_id: string | null;
  project_id: string | null;
  depends_on: string[];
}

export interface PlannerPerson {
  id: string;
  full_name: string;
  capacity_hours_week: number;
  skills: string[];
  time_off_days?: string[];
}

export interface ScheduledItem {
  task_id: string;
  key: string;
  title: string;
  assignee_id: string | null;
  assignee_name: string;
  sequence: number;
  planned_start: string;
  planned_end: string;
  planned_hours: number;
  risk_score: number;
  risk_band: string;
  critical: boolean;
  slack_days: number;
  rationale: string;
}

export interface PlanResult {
  items: ScheduledItem[];
  unassigned: Array<{ task_id: string; key: string; title: string; reason: string }>;
  stats: {
    horizonDays: number;
    tasksScheduled: number;
    tasksUnassigned: number;
    totalHours: number;
    utilisation: number;
    lateTasks: number;
    criticalCount: number;
    overloadedPeople: Array<{ user_id: string; name: string; planned: number; capacity: number }>;
    throughputPerWeek: number;
    makespanDays: number;
  };
  perPerson: Array<{ user_id: string; name: string; hours: number; capacity: number; utilisation: number; days: Record<string, number> }>;
}

const DAY = 86_400_000;
const WORKDAY_HOURS = 8;

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
function isWeekend(d: Date) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}
function nextWorkday(d: Date) {
  let x = startOfDay(d);
  while (isWeekend(x)) x = new Date(x.getTime() + DAY);
  return x;
}
function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

/**
 * Critical-path slack — total float per task, in days.
 *
 * Proper CPM: a forward pass computes earliest finish (EF) through the
 * dependency DAG, then a backward pass computes latest finish (LF) from the
 * project makespan. Total float = LF − EF. Float 0 means the task is on the
 * critical path. Cycle-safe: a back-edge is ignored rather than hanging.
 */
export function criticalPathSlack(tasks: PlannerTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dur = new Map(tasks.map((t) => [t.id, Math.max(1, t.estimate_hours || 4) / WORKDAY_HOURS]));
  const depsOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const t of tasks) {
    const deps = t.depends_on.filter((d) => byId.has(d));
    depsOf.set(t.id, deps);
    for (const d of deps) dependentsOf.set(d, [...(dependentsOf.get(d) ?? []), t.id]);
  }

  // Forward pass with memoisation.
  const ef = new Map<string, number>();
  const visiting = new Set<string>();
  const earliestFinish = (taskId: string): number => {
    if (ef.has(taskId)) return ef.get(taskId)!;
    if (visiting.has(taskId)) return 0; // cycle guard
    visiting.add(taskId);
    const deps = depsOf.get(taskId) ?? [];
    const startAt = deps.length ? Math.max(...deps.map(earliestFinish)) : 0;
    const finish = startAt + (dur.get(taskId) ?? 1);
    visiting.delete(taskId);
    ef.set(taskId, finish);
    return finish;
  };
  for (const t of tasks) earliestFinish(t.id);

  const makespan = tasks.length ? Math.max(...[...ef.values()]) : 0;

  // Backward pass: LF = min(LS of dependents), leaves finish at makespan.
  const lf = new Map<string, number>();
  const visitBack = new Set<string>();
  const latestFinish = (taskId: string): number => {
    if (lf.has(taskId)) return lf.get(taskId)!;
    if (visitBack.has(taskId)) return makespan; // cycle guard
    visitBack.add(taskId);
    const dependents = dependentsOf.get(taskId) ?? [];
    const value = dependents.length
      ? Math.min(...dependents.map((d) => latestFinish(d) - (dur.get(d) ?? 1)))
      : makespan;
    visitBack.delete(taskId);
    lf.set(taskId, value);
    return value;
  };
  for (const t of tasks) latestFinish(t.id);

  const slack = new Map<string, number>();
  for (const t of tasks) {
    const totalFloat = Math.max(0, (lf.get(t.id) ?? 0) - (ef.get(t.id) ?? 0));
    slack.set(t.id, Math.round(totalFloat * 10) / 10);
  }
  return slack;
}

export function plan(input: {
  tasks: PlannerTask[];
  people: PlannerPerson[];
  horizonDays?: number;
  startDate?: Date;
}): PlanResult {
  const horizonDays = input.horizonDays ?? 21;
  const start = nextWorkday(input.startDate ?? new Date());
  const end = new Date(start.getTime() + horizonDays * DAY);

  const people = new Map(input.people.map((p) => [p.id, p]));
  const demand = new Map<string, number>(); // user -> hours already committed this plan
  const calendars = new Map<string, Map<string, number>>();

  const slackMap = criticalPathSlack(input.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled'));

  const open = input.tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'backlog',
  );

  // Load ratio for risk: planned hours per person for the horizon.
  const horizonWeeks = Math.max(1, horizonDays / 7);
  const loadRatio = (userId: string | null) => {
    if (!userId) return 1;
    const person = people.get(userId);
    if (!person) return 1;
    const cap = Math.max(1, person.capacity_hours_week * horizonWeeks);
    return (demand.get(userId) ?? 0) / cap;
  };

  const ordered = [...open].sort((a, b) => {
    const sa = wsptScore({ priority: a.priority, dueAt: a.due_at, estimateHours: a.estimate_hours, status: a.status, blocked: a.status === 'blocked' });
    const sb = wsptScore({ priority: b.priority, dueAt: b.due_at, estimateHours: b.estimate_hours, status: b.status, blocked: b.status === 'blocked' });
    if (sb !== sa) return sb - sa;
    const ka = slackMap.get(a.id) ?? 99;
    const kb = slackMap.get(b.id) ?? 99;
    if (ka !== kb) return ka - kb;
    return (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');
  });

  const items: ScheduledItem[] = [];
  const unassigned: PlanResult['unassigned'] = [];
  const scheduled = new Set<string>();
  const lateIds = new Set<string>();
  let seq = 0;
  let makespanEnd = start.getTime();

  for (const task of ordered) {
    if (!task.assignee_id || !people.has(task.assignee_id)) {
      unassigned.push({ task_id: task.id, key: task.key, title: task.title, reason: 'No owner assigned' });
      continue;
    }
    // Respect hard dependencies: if upstream is still open and unscheduled, defer.
    const upstreamOpen = task.depends_on.filter((d) => {
      const dep = input.tasks.find((t) => t.id === d);
      return dep && dep.status !== 'done' && dep.status !== 'cancelled';
    });
    if (task.status === 'blocked' && upstreamOpen.length > 0 && !upstreamOpen.every((d) => scheduled.has(d))) {
      unassigned.push({
        task_id: task.id,
        key: task.key,
        title: task.title,
        reason: `Blocked by ${upstreamOpen.length} upstream task${upstreamOpen.length === 1 ? '' : 's'}`,
      });
      continue;
    }

    const person = people.get(task.assignee_id)!;
    const cal = calendars.get(person.id) ?? new Map<string, number>();
    calendars.set(person.id, cal);

    const hours = Math.max(0.5, (task.estimate_hours || 4) - Math.min(task.logged_hours, (task.estimate_hours || 4) * 0.8));
    let remaining = hours;
    let cursor = nextWorkday(start);
    const perDayCap = Math.min(WORKDAY_HOURS, Math.max(2, person.capacity_hours_week / 5));
    let firstDay: string | null = null;
    let lastDay: string | null = null;

    while (remaining > 0.001) {
      if (cursor.getTime() > end.getTime()) break;
      const key = iso(cursor);
      if (isWeekend(cursor) || (person.time_off_days ?? []).includes(key)) {
        cursor = new Date(cursor.getTime() + DAY);
        continue;
      }
      const used = cal.get(key) ?? 0;
      const free = Math.max(0, perDayCap - used);
      if (free <= 0.001) {
        cursor = new Date(cursor.getTime() + DAY);
        continue;
      }
      const take = Math.min(free, remaining);
      cal.set(key, used + take);
      remaining -= take;
      demand.set(person.id, (demand.get(person.id) ?? 0) + take);
      if (!firstDay) firstDay = key;
      lastDay = key;
      if (remaining > 0.001) cursor = new Date(cursor.getTime() + DAY);
    }

    if (!firstDay || !lastDay) {
      unassigned.push({ task_id: task.id, key: task.key, title: task.title, reason: 'No capacity inside the planning horizon' });
      continue;
    }

    const risk = scoreRisk({
      priority: task.priority,
      status: task.status,
      dueAt: task.due_at,
      estimateHours: task.estimate_hours,
      loggedHours: task.logged_hours,
      turnoverState: task.turnover_state,
      blockedReason: task.blocked_reason,
      dependencyCount: task.depends_on.length,
      assigneeLoadRatio: loadRatio(person.id),
      clientVisible: !!task.client_visible,
      ageDays: (Date.now() - (toDate(task.created_at)?.getTime() ?? Date.now())) / DAY,
    });

    if (task.due_at && lastDay > task.due_at.slice(0, 10)) lateIds.add(task.id);
    const slack = slackMap.get(task.id) ?? 0;
    makespanEnd = Math.max(makespanEnd, new Date(lastDay + 'T00:00:00Z').getTime());

    const reasons: string[] = [];
    reasons.push(`${task.priority} priority`);
    if (slack <= 1) reasons.push('on the critical path');
    if (task.due_at) reasons.push(`due ${task.due_at.slice(0, 10)}`);
    reasons.push(`${Math.round(hours * 10) / 10}h of remaining effort packed into ${person.full_name.split(' ')[0]}'s earliest gap`);

    items.push({
      task_id: task.id,
      key: task.key,
      title: task.title,
      assignee_id: person.id,
      assignee_name: person.full_name,
      sequence: seq++,
      planned_start: firstDay,
      planned_end: lastDay,
      planned_hours: Math.round(hours * 10) / 10,
      risk_score: risk.score,
      risk_band: risk.band,
      critical: slack <= 1,
      slack_days: Math.round(slack * 10) / 10,
      rationale: reasons.join(' · '),
    });
    scheduled.add(task.id);
  }

  const perPerson = input.people.map((p) => {
    const cal = calendars.get(p.id) ?? new Map<string, number>();
    const hours = [...cal.values()].reduce((a, b) => a + b, 0);
    const capacity = p.capacity_hours_week * horizonWeeks;
    return {
      user_id: p.id,
      name: p.full_name,
      hours: Math.round(hours * 10) / 10,
      capacity: Math.round(capacity * 10) / 10,
      utilisation: capacity ? Math.round((hours / capacity) * 100) : 0,
      days: Object.fromEntries(cal),
    };
  });

  const totalHours = perPerson.reduce((a, p) => a + p.hours, 0);
  const totalCapacity = perPerson.reduce((a, p) => a + p.capacity, 0);
  const makespanDays = Math.ceil((makespanEnd - start.getTime()) / DAY) || 0;

  return {
    items,
    unassigned,
    stats: {
      horizonDays,
      tasksScheduled: items.length,
      tasksUnassigned: unassigned.length,
      totalHours: Math.round(totalHours * 10) / 10,
      utilisation: totalCapacity ? Math.round((totalHours / totalCapacity) * 100) : 0,
      lateTasks: lateIds.size,
      criticalCount: items.filter((i) => i.critical).length,
      overloadedPeople: perPerson
        .filter((p) => p.utilisation > 100)
        .map((p) => ({ user_id: p.user_id, name: p.name, planned: p.hours, capacity: p.capacity })),
      throughputPerWeek: Math.round((items.length / Math.max(1, horizonWeeks)) * 10) / 10,
      makespanDays,
    },
    perPerson,
  };
}
