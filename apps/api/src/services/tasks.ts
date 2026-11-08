/**
 * Task service — the governance core.
 *
 * Invariants enforced here (never in the UI alone):
 *  1. A task may only enter `done` when every required turnover check passes
 *     AND the acceptance ladder reached `client_accepted` (or `lead_approved`
 *     for internal, non client-visible work).
 *  2. Every status change writes an audit row + an activity feed entry.
 *  3. Moving a task to `review` starts the module-turnover clock (24h).
 *  4. Blocked tasks must carry a human-readable reason.
 */
import type { Db } from '../db/index.ts';
import { id, nowIso, positionBetween } from '../lib/ids.ts';
import { badRequest, conflict, notFound, unprocessable } from '../lib/http.ts';
import { evaluateGates, type GateDef, type CheckState } from '../domain/turnover.ts';
import { SLA_HOURS, slaDueAt } from '../domain/risk.ts';
import { startTimer, closeTimersFor } from './clocks.ts';

export const ACCEPTANCE_LADDER = ['dev_complete', 'qa_approved', 'lead_approved', 'client_accepted'] as const;
export type AcceptanceStep = (typeof ACCEPTANCE_LADDER)[number];

/**
 * The next task key for a project.
 *
 * Derived from the **highest existing suffix**, not from the row count. The count
 * version was off by one in a way that only appears once a project has any tasks:
 * with N rows numbered 101..100+N, `100 + N` *is* the last key, so the generator
 * returned a value already in use and every subsequent creation failed on
 * `UNIQUE (board_id, key)`. Seeding masked it, because a freshly seeded project has
 * enough rows that the collision lands on the next insert — which is exactly the
 * first thing a new user does.
 *
 * Counting also cannot survive a deletion: remove one row and the count goes
 * backwards while the keys do not, producing a collision that depends on unrelated
 * history. The maximum is stable under deletes, under gaps, and under imported data.
 *
 * Keys that do not match `<prefix>-<digits>` are ignored rather than parsed, so a
 * hand-created row cannot poison the sequence.
 */
export async function nextKey(db: Db, projectId: string | null): Promise<string> {
  let prefix = 'RLY';
  if (projectId) {
    const project = await db.get<{ key: string }>('SELECT key FROM projects WHERE id = ?', [projectId]);
    if (!project) throw badRequest('Unknown project');
    prefix = project.key;
  }
  const rows = projectId
    ? await db.all<{ key: string }>('SELECT key FROM tasks WHERE project_id = ?', [projectId])
    : await db.all<{ key: string }>('SELECT key FROM tasks WHERE project_id IS NULL');
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^" + escaped + "-(\\d+)$");
  let highest = 100;
  for (const row of rows) {
    const match = pattern.exec(String(row.key ?? ''));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${highest + 1}`;
}

export async function gatesFor(db: Db, scope: 'task' | 'phase' | 'project'): Promise<GateDef[]> {
  return await db.all<GateDef>(
    'SELECT id,key,name,scope,description,required,owner_role,auto_rule FROM turnover_gates WHERE scope = ? ORDER BY key',
    [scope],
  );
}

export async function checksForTask(db: Db, taskId: string): Promise<CheckState[]> {
  return await db.all<CheckState>('SELECT gate_id,status,evidence FROM turnover_checks WHERE task_id = ?', [taskId]);
}

export async function ensureTaskChecks(db: Db, taskId: string) {
  const gates = await gatesFor(db, 'task');
  const existing = new Set((await db.all<{ gate_id: string }>('SELECT gate_id FROM turnover_checks WHERE task_id = ?', [taskId])).map((r) => r.gate_id));
  for (const g of gates) {
    if (!existing.has(g.id)) {
      await db.run('INSERT INTO turnover_checks (id,gate_id,task_id,status) VALUES (?,?,?,?)', [id('tchk'), g.id, taskId, 'pending']);
    }
  }
}

export async function evaluateTask(db: Db, taskId: string) {
  const gates = await gatesFor(db, 'task');
  // Fail closed: if no gate policy is configured we cannot certify turnover.
  // A governance system that says "ready" when it has nothing to check is worse
  // than one that refuses. The policy catalogue is seeded and versioned.
  if (gates.length === 0) {
    return {
      ready: false,
      passed: 0,
      required: 0,
      score: 0,
      blockers: [{ gate_id: 'policy', name: 'Turnover policy missing', reason: 'No task-scope turnover gates are configured for this environment.' }],
    };
  }
  return evaluateGates(gates, await checksForTask(db, taskId));
}

export async function createTask(db: Db, input: Record<string, any>, actorId: string) {
  if (!input.title || String(input.title).trim().length < 4) throw badRequest('Title must be at least 4 characters');
  const boardId = input.boardId ?? input.board_id;
  if (!boardId) throw badRequest('boardId is required');
  const board = await db.get<{ id: string; project_id: string | null }>('SELECT id, project_id FROM boards WHERE id = ?', [boardId]);
  if (!board) throw notFound('Board not found');

  const columnId = input.columnId ?? `${boardId}_${input.status ?? 'backlog'}`;
  const projectId = input.projectId ?? board.project_id ?? null;
  const priority = input.priority ?? 'medium';

  return await db.tx(async () => {
    const taskId = id('tsk');
    const maxPos = (await db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM tasks WHERE column_id = ?', [columnId]))?.m ?? 0;
    const slaHours = SLA_HOURS[priority as keyof typeof SLA_HOURS]?.resolve ?? SLA_HOURS.medium.resolve;
    const createdAt = nowIso();
    await db.run(
      `INSERT INTO tasks (id,key,project_id,board_id,column_id,project_phase_id,parent_id,title,description,type,priority,status,
        assignee_id,reporter_id,story_points,estimate_hours,position,due_at,sla_hours,sla_due_at,turnover_criteria,client_visible,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [taskId, await nextKey(db, projectId), projectId, boardId, columnId, input.projectPhaseId ?? null, input.parentId ?? null,
        String(input.title).trim(), input.description ?? '', input.type ?? 'feature', priority, input.status ?? 'backlog',
        input.assigneeId ?? null, actorId, input.storyPoints ?? 0, input.estimateHours ?? 0, maxPos + 1000,
        input.dueAt ?? null, slaHours, slaDueAt(createdAt, priority).toISOString().slice(0, 19).replace('T', ' '),
        input.turnoverCriteria ?? '', input.clientVisible ? 1 : 0, createdAt, createdAt],
    );
    await ensureTaskChecks(db, taskId);
    for (const labelId of input.labelIds ?? []) {
      await db.run('INSERT OR IGNORE INTO task_labels (task_id,label_id) VALUES (?,?)', [taskId, labelId]);
    }
    for (const depId of input.dependsOn ?? []) {
      if (depId !== taskId) await db.run('INSERT OR IGNORE INTO task_dependencies (task_id,depends_on_id) VALUES (?,?,?)', [taskId, depId, 'blocks']);
    }
    await db.run(
      'INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)',
      ['task', taskId, actorId, 'created', `created ${input.title}`.slice(0, 140)],
    );
    return taskId;
  });
}

export async function updateTask(db: Db, taskId: string, patch: Record<string, any>, actorId: string) {
  const current = await db.get<Record<string, any>>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!current) throw notFound('Task not found');

  const columnMap: Record<string, Record<string, unknown> | undefined> = {
    title: patch.title !== undefined ? { title: String(patch.title).trim() } : undefined,
    description: patch.description !== undefined ? { description: patch.description } : undefined,
    priority: patch.priority !== undefined ? { priority: patch.priority } : undefined,
    type: patch.type !== undefined ? { type: patch.type } : undefined,
    assigneeId: patch.assigneeId !== undefined ? { assignee_id: patch.assigneeId || null } : undefined,
    storyPoints: patch.storyPoints !== undefined ? { story_points: patch.storyPoints } : undefined,
    estimateHours: patch.estimateHours !== undefined ? { estimate_hours: patch.estimateHours } : undefined,
    dueAt: patch.dueAt !== undefined ? { due_at: patch.dueAt || null } : undefined,
    blockedReason: patch.blockedReason !== undefined ? { blocked_reason: patch.blockedReason ?? '' } : undefined,
    turnoverCriteria: patch.turnoverCriteria !== undefined ? { turnover_criteria: patch.turnoverCriteria } : undefined,
    clientVisible: patch.clientVisible !== undefined ? { client_visible: patch.clientVisible ? 1 : 0 } : undefined,
    branch: patch.branch !== undefined ? { branch: patch.branch } : undefined,
    prUrl: patch.prUrl !== undefined ? { pr_url: patch.prUrl } : undefined,
    projectPhaseId: patch.projectPhaseId !== undefined ? { project_phase_id: patch.projectPhaseId || null } : undefined,
  };

  const sets: string[] = [];
  const params: unknown[] = [];
  const changed: string[] = [];
  for (const entry of Object.values(columnMap)) {
    if (!entry) continue;
    for (const [col, val] of Object.entries(entry)) {
      sets.push(`${col} = ?`);
      params.push(val);
      changed.push(col);
    }
  }

  // Position / column moves (drag & drop).
  if (patch.columnId && patch.columnId !== current.column_id) {
    const col = await db.get<{ key: string; is_done: number }>('SELECT key,is_done FROM columns WHERE id = ?', [patch.columnId]);
    if (!col) throw badRequest('Unknown column');
    sets.push('column_id = ?', 'status = ?');
    params.push(patch.columnId, col.key);
    changed.push('status');
    patch.status = col.key;
  }
  if (patch.position !== undefined && patch.position !== null) {
    sets.push('position = ?');
    params.push(patch.position);
  } else if (patch.beforeId || patch.afterId) {
    const b = patch.beforeId ? (await db.get<{ position: number }>('SELECT position FROM tasks WHERE id = ?', [patch.beforeId]))?.position ?? null : null;
    const a = patch.afterId ? (await db.get<{ position: number }>('SELECT position FROM tasks WHERE id = ?', [patch.afterId]))?.position ?? null : null;
    sets.push('position = ?');
    params.push(positionBetween(b, a));
  }

  // Status transition — this is where governance bites.
  if (patch.status && patch.status !== current.status) {
    const next = patch.status as string;
    sets.push('status = ?');
    params.push(next);
    changed.push('status');

    if (next === 'blocked') {
      const reason = patch.blockedReason ?? current.blocked_reason;
      if (!reason || String(reason).trim().length < 8) {
        throw unprocessable('A blocked task must record a reason (min 8 chars) so the daily standup can unblock it.');
      }
    }
    if (next === 'in_progress' && !current.started_at) {
      sets.push('started_at = ?');
      params.push(nowIso());
    }
    if (next === 'review') {
      await startTimer(db, 'module-turnover', 'task', taskId, `Module turnover: ${current.key}`);
    }
    if (next === 'done') {
      await assertTurnoverComplete(db, taskId, current);
      sets.push('completed_at = ?');
      params.push(nowIso());
      await closeTimersFor(db, 'task', taskId, 'met');
    }
    if (next === 'review' || next === 'done') {
      await db.run(
        `INSERT INTO acceptance_records (id,task_id,step,state,actor_id,decided_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(task_id,step) DO UPDATE SET state = excluded.state, actor_id = excluded.actor_id, decided_at = excluded.decided_at`,
        [id('acc'), taskId, 'dev_complete', 'passed', actorId, nowIso()],
      );
      await db.run("UPDATE tasks SET acceptance_step = CASE WHEN acceptance_step = 'dev_complete' THEN 'qa_approved' ELSE acceptance_step END WHERE id = ?", [taskId]);
    }
  }

  if (!sets.length) return current;

  sets.push('updated_at = ?');
  params.push(nowIso());

  await db.tx(async () => {
    await db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, [...params, taskId]);
    if (patch.labelIds) {
      await db.run('DELETE FROM task_labels WHERE task_id = ?', [taskId]);
      for (const lid of patch.labelIds) await db.run('INSERT OR IGNORE INTO task_labels (task_id,label_id) VALUES (?,?)', [taskId, lid]);
    }
    if (patch.status && patch.status !== current.status) {
      await db.run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
        'task', taskId, actorId, 'status_changed', `moved ${current.key} ${current.status} → ${patch.status}`,
      ]);
      await db.run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,?,?,?,?)', [
        actorId, 'task.status_changed', 'task', taskId, JSON.stringify({ status: current.status }), JSON.stringify({ status: patch.status }),
      ]);
    }
  });
  return await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
}

/**
 * The turnover gate. Two independent conditions:
 *  - every required turnover check is pass/waived
 *  - the acceptance ladder reached the level required for the task's visibility
 */
export async function assertTurnoverComplete(db: Db, taskId: string, current: Record<string, any>) {
  const evaluation = await evaluateTask(db, taskId);
  const acceptance = await db.all<{ step: string; state: string }>('SELECT step,state FROM acceptance_records WHERE task_id = ?', [taskId]);
  const passed = new Set(acceptance.filter((a) => a.state === 'passed').map((a) => a.step));
  const needsClient = !!current.client_visible;
  const requiredLadder = needsClient ? 'client_accepted' : 'lead_approved';

  if (!evaluation.ready) {
    throw conflict(
      `Turnover gate blocked: ${evaluation.blockers.length} required check(s) outstanding.`,
      { blockers: evaluation.blockers, score: evaluation.score, required: requiredLadder },
    );
  }
  if (!passed.has('qa_approved') || !passed.has(requiredLadder)) {
    throw conflict(
      `Acceptance ladder incomplete for a ${needsClient ? 'client-visible' : 'internal'} task: QA approval and ${requiredLadder.replace('_', ' ')} are required before it can ship.`,
      {
        required: requiredLadder,
        passed: [...passed],
        hint: 'Record the missing approvals through POST /tasks/:id/acceptance.',
      },
    );
  }
  return true;
}

export async function recordAcceptance(
  db: Db,
  taskId: string,
  step: AcceptanceStep,
  state: 'passed' | 'rejected' | 'skipped',
  actorId: string,
  evidence = '',
  notes = '',
) {
  const task = await db.get<Record<string, any>>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) throw notFound('Task not found');
  const idx = ACCEPTANCE_LADDER.indexOf(step);
  if (idx < 0) throw badRequest('Unknown acceptance step');

  // Ladder must be climbed in order — QA cannot approve before dev is complete.
  if (state === 'passed' && idx > 0) {
    const prior = ACCEPTANCE_LADDER[idx - 1];
    const priorRow = await db.get<{ state: string }>('SELECT state FROM acceptance_records WHERE task_id = ? AND step = ?', [taskId, prior]);
    if (!priorRow || priorRow.state !== 'passed') {
      throw conflict(`Cannot pass ${step.replace('_', ' ')} before ${prior.replace('_', ' ')} is passed.`, { step, prior });
    }
  }

  await db.tx(async () => {
    await db.run(
      `INSERT INTO acceptance_records (id,task_id,step,state,actor_id,evidence,notes,decided_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(task_id,step) DO UPDATE SET state=excluded.state, actor_id=excluded.actor_id,
         evidence=excluded.evidence, notes=excluded.notes, decided_at=excluded.decided_at`,
      [id('acc'), taskId, step, state, actorId, evidence, notes, nowIso()],
    );
    if (state === 'passed') {
      const col =
        step === 'qa_approved' ? 'qa_verified_by, acceptance_step' :
        step === 'lead_approved' ? 'lead_approved_by, acceptance_step' :
        step === 'client_accepted' ? 'client_accepted_at, acceptance_step' : null;
      if (step === 'qa_approved') await db.run("UPDATE tasks SET qa_verified_by = ?, acceptance_step = 'lead_approved' WHERE id = ?", [actorId, taskId]);
      else if (step === 'lead_approved') await db.run("UPDATE tasks SET lead_approved_by = ?, acceptance_step = 'client_accepted' WHERE id = ?", [actorId, taskId]);
      else if (step === 'client_accepted') await db.run("UPDATE tasks SET client_accepted_at = ?, acceptance_step = 'client_accepted' WHERE id = ?", [nowIso(), taskId]);
      else await db.run("UPDATE tasks SET acceptance_step = 'qa_approved' WHERE id = ?", [taskId]);
      void col;
    } else if (state === 'rejected') {
      await db.run("UPDATE tasks SET status = 'in_progress', acceptance_step = ? WHERE id = ? AND status = 'review'", [step, taskId]);
    }
    await db.run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      'task', taskId, actorId, `acceptance_${state}`, `${step.replace('_', ' ')} → ${state}`,
    ]);
    await db.run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'task.acceptance', 'task', taskId, JSON.stringify({ step, state, evidence }),
    ]);
  });
  return await db.all('SELECT step,state,actor_id,evidence,notes,decided_at FROM acceptance_records WHERE task_id = ?', [taskId]);
}

export async function taskDetail(db: Db, taskId: string) {
  const task = await db.get<Record<string, any>>(
    `SELECT t.*, a.full_name AS assignee_name, a.initials AS assignee_initials, a.avatar_color AS assignee_color,
            p.key AS project_key, p.name AS project_name, c.name AS client_name, c.accent_color AS client_color,
            ph.name AS phase_name, ph.color AS phase_color
     FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
     LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN clients c ON c.id = p.client_id
     LEFT JOIN project_phases pp ON pp.id = t.project_phase_id LEFT JOIN phases ph ON ph.id = pp.phase_id
     WHERE t.id = ? OR t.key = ?`,
    [taskId, taskId],
  );
  if (!task) throw notFound('Task not found');
  const id = task.id as string;

  const labels = await db.all<{ id: string; name: string; color: string }>(
    'SELECT l.id,l.name,l.color FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = ?', [id],
  );
  const comments = (await db.all<Record<string, any>>(
    `SELECT c.id,c.body,c.created_at,u.full_name AS author,u.initials,u.avatar_color FROM task_comments c
     JOIN users u ON u.id = c.author_id WHERE c.task_id = ? ORDER BY c.created_at ASC`, [id],
  )).map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at, author: { name: c.author, initials: c.initials, color: c.avatar_color } }));
  const checklist = await db.all<Record<string, any>>('SELECT id,label,done FROM task_checklist WHERE task_id = ? ORDER BY position', [id]);
  const acceptance = await db.all<Record<string, any>>('SELECT step,state,actor_id,evidence,notes,decided_at FROM acceptance_records WHERE task_id = ?', [id]);
  const evaluation = await evaluateTask(db, id);
  const gates = await gatesFor(db, 'task');
  const checks = new Map((await db.all<Record<string, any>>('SELECT gate_id,status,evidence,checked_by,checked_at FROM turnover_checks WHERE task_id = ?', [id])).map((c) => [c.gate_id, c]));
  const timers = await db.all<Record<string, any>>('SELECT * FROM sla_timers WHERE entity_type = ? AND entity_id = ? ORDER BY due_at', ['task', task.key]);
  const activity = await db.all<Record<string, any>>(
    `SELECT a.verb,a.summary,a.created_at,u.full_name AS actor,u.initials,u.avatar_color FROM activity a
     LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity_type='task' AND a.entity_id IN (?,?) ORDER BY a.created_at DESC LIMIT 20`, [id, task.key],
  );
  const dependencies = await db.all<Record<string, any>>(
    `SELECT t.id,t.key,t.title,t.status,t.priority FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ?`, [id],
  );
  const blockedBy = await db.all<Record<string, any>>(
    `SELECT t.id,t.key,t.title,t.status FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = ?`, [id],
  );
  const subtasks = await db.all<Record<string, any>>('SELECT id,key,title,status,priority,assignee_id FROM tasks WHERE parent_id = ? ORDER BY position', [id]);
  const timeEntries = await db.all<Record<string, any>>(
    `SELECT te.minutes,te.note,te.worked_on,u.full_name AS user FROM time_entries te JOIN users u ON u.id = te.user_id WHERE te.task_id = ? ORDER BY te.worked_on DESC LIMIT 20`, [id],
  );

  return {
    id: task.id,
    key: task.key,
    title: task.title,
    description: task.description,
    type: task.type,
    priority: task.priority,
    status: task.status,
    project: task.project_id ? { id: task.project_id, key: task.project_key, name: task.project_name } : null,
    client: task.client_name ? { name: task.client_name, color: task.client_color } : null,
    phase: task.phase_name ? { name: task.phase_name, color: task.phase_color } : null,
    assignee: task.assignee_id ? { id: task.assignee_id, name: task.assignee_name, initials: task.assignee_initials, color: task.assignee_color } : null,
    storyPoints: task.story_points,
    estimateHours: task.estimate_hours,
    loggedHours: task.logged_hours,
    dueAt: task.due_at,
    slaDueAt: task.sla_due_at,
    blockedReason: task.blocked_reason,
    turnoverState: task.turnover_state,
    turnoverCriteria: task.turnover_criteria,
    acceptanceStep: task.acceptance_step,
    clientVisible: !!task.client_visible,
    branch: task.branch,
    prUrl: task.pr_url,
    createdAt: task.created_at,
    labels,
    comments,
    checklist: checklist.map((c) => ({ id: c.id, label: c.label, done: !!c.done })),
    acceptance: acceptance.map((a) => ({ step: a.step, state: a.state, actorId: a.actor_id, evidence: a.evidence, notes: a.notes, decidedAt: a.decided_at })),
    turnover: {
      ...evaluation,
      checks: gates.map((g) => {
        const c = checks.get(g.id);
        return {
          gateId: g.id,
          key: g.key,
          name: g.name,
          description: g.description,
          required: !!g.required,
          ownerRole: g.owner_role,
          autoRule: g.auto_rule,
          status: c?.status ?? 'pending',
          evidence: c?.evidence ?? '',
          checkedAt: c?.checked_at ?? null,
        };
      }),
    },
    timers: timers.map((t) => ({ id: t.id, label: t.label, clock: t.clock_key, dueAt: t.due_at, outcome: t.outcome, minutesUsed: t.minutes_used })),
    activity: activity.map((a) => ({ verb: a.verb, summary: a.summary, createdAt: a.created_at, actor: a.actor ? { name: a.actor, initials: a.initials, color: a.avatar_color } : null })),
    dependencies,
    blockedBy,
    subtasks,
    timeEntries: timeEntries.map((t) => ({ minutes: t.minutes, note: t.note, workedOn: t.worked_on, user: t.user })),
  };
}
