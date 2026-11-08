/**
 * HTTP surface. Every route is thin: validate → service → serialise.
 * Grouped by bounded context so the OpenAPI/REST contract stays legible.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, notFound, ok, page, queryInt, queryList, queryStr, forbidden } from '../lib/http.ts';
import { id, nowIso } from '../lib/ids.ts';
import { toDate } from '../lib/dates.ts';
import { TASK_SELECT, mapTask, mapUser, mapClient, mapProject, mapDeal } from '../repositories/query.ts';
import { SLA_HOURS, scoreRisk, slaState } from '../domain/risk.ts';
import { plan } from '../domain/planner.ts';
import { createTask, updateTask, taskDetail, recordAcceptance, ensureTaskChecks, ACCEPTANCE_LADDER } from '../services/tasks.ts';
import { clockHealth, liveTimers, resolveTimer, startTimer, sweepTimers, closeTimersFor } from '../services/clocks.ts';

const db = () => getDb();

/** Demo identity resolution — swap for OIDC claims in production. */
function actor(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers['x-actor-id'];
  const candidate = typeof raw === 'string' && raw.trim() ? raw.trim() : config.demoUserId;
  const user = db().get<{ id: string }>('SELECT id FROM users WHERE id = ?', [candidate]);
  return user?.id ?? config.demoUserId;
}

function requireRole(actorId: string, roles: string[]) {
  const user = db().get<{ role: string }>('SELECT role FROM users WHERE id = ?', [actorId]);
  if (!user || !roles.includes(user.role)) throw forbidden(`Requires role: ${roles.join(' | ')}`);
}

export async function registerRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------- health -- */
  app.get('/api/health', async () => {
    const started = Date.now();
    const { c } = db().get<{ c: number }>('SELECT COUNT(*) AS c FROM schema_migrations') ?? { c: 0 };
    return ok({
      status: 'ok',
      service: 'relay-api',
      env: config.env,
      schemaVersion: c,
      latencyMs: Date.now() - started,
      uptimeSec: Math.round(process.uptime()),
      storage: config.databaseUrl ? 'postgres' : 'sqlite-wal',
    });
  });

  /* -------------------------------------------------------------- meta --- */
  app.get('/api/meta', async () => {
    const users = db().all('SELECT * FROM users WHERE is_active = 1 ORDER BY full_name').map(mapUser);
    const labels = db().all('SELECT id,name,color,description FROM labels ORDER BY name');
    const clients = db().all('SELECT * FROM clients ORDER BY name').map(mapClient);
    const projects = db().all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color
       FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.status != 'archived' ORDER BY p.name`,
    ).map(mapProject);
    const boards = db().all<Record<string, any>>(
      `SELECT b.*, p.key AS project_key, p.name AS project_name, c.accent_color AS client_color
       FROM boards b LEFT JOIN projects p ON p.id = b.project_id LEFT JOIN clients c ON c.id = p.client_id
       ORDER BY b.kind DESC, p.name`,
    );
    return ok({
      users,
      labels,
      clients,
      projects,
      boards: boards.map((b) => ({ id: b.id, name: b.name, kind: b.kind, projectId: b.project_id, projectKey: b.project_key, projectName: b.project_name, color: b.client_color })),
      currentUser: users.find((u) => u.id === config.demoUserId) ?? users[0],
      priorities: ['urgent', 'high', 'medium', 'low'],
      types: ['feature', 'bug', 'research', 'design', 'ops', 'meeting', 'content'],
      acceptanceLadder: ACCEPTANCE_LADDER,
      slaHours: SLA_HOURS,
    });
  });

  app.get('/api/users', async () => ok(db().all('SELECT * FROM users ORDER BY full_name').map(mapUser)));

  /* -------------------------------------------------------------- tasks -- */
  app.get('/api/tasks', async (req) => {
    const limit = Math.min(queryInt(req, 'limit', 200), 500);
    const offset = queryInt(req, 'offset', 0);
    const where: string[] = [];
    const params: unknown[] = [];

    const boardId = queryStr(req, 'boardId');
    if (boardId) { where.push('t.board_id = ?'); params.push(boardId); }
    const projectId = queryStr(req, 'projectId');
    if (projectId) { where.push('t.project_id = ?'); params.push(projectId); }
    const assignee = queryStr(req, 'assignee');
    if (assignee === 'me') { where.push('t.assignee_id = ?'); params.push(actor(req as never)); }
    else if (assignee) { where.push('t.assignee_id = ?'); params.push(assignee); }
    const priorities = queryList(req, 'priority');
    if (priorities.length) { where.push(`t.priority IN (${priorities.map(() => '?').join(',')})`); params.push(...priorities); }
    const statuses = queryList(req, 'status');
    if (statuses.length) { where.push(`t.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    const types = queryList(req, 'type');
    if (types.length) { where.push(`t.type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
    const labelId = queryStr(req, 'labelId');
    if (labelId) { where.push('EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)'); params.push(labelId); }
    const search = queryStr(req, 'q');
    if (search) { where.push('(t.title LIKE ? OR t.description LIKE ? OR t.key LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (queryStr(req, 'clientVisible') === 'true') where.push('t.client_visible = 1');
    if (queryStr(req, 'mine') === 'true') { where.push('t.assignee_id = ?'); params.push(actor(req as never)); }

    const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.position ASC, t.created_at DESC LIMIT ? OFFSET ?`;
    const rows = db().all<Record<string, any>>(sql, [...params, limit, offset]);
    const total = db().get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params)?.c ?? 0;

    const tasks = rows.map((r) => {
      const mapped = mapTask(r);
      const sla = slaState({
        status: mapped.status,
        priority: mapped.priority,
        sla_due_at: mapped.slaDueAt,
        completed_at: mapped.completedAt,
      });
      const risk = scoreRisk({
        priority: mapped.priority,
        status: mapped.status,
        dueAt: mapped.dueAt,
        estimateHours: mapped.estimateHours,
        loggedHours: mapped.loggedHours,
        turnoverState: mapped.turnoverState,
        blockedReason: mapped.blockedReason,
        dependencyCount: mapped.counts.dependencies,
        clientVisible: mapped.clientVisible,
        ageDays: (Date.now() - (toDate(mapped.createdAt)?.getTime() ?? Date.now())) / 86400000,
      });
      const labelRows = db().all<{ id: string; name: string; color: string }>(
        'SELECT l.id,l.name,l.color FROM task_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.task_id=?', [mapped.id],
      );
      return { ...mapped, labels: labelRows, sla: sla.state, slaHoursLeft: sla.hoursLeft, risk: { score: risk.score, band: risk.band, factors: risk.factors } };
    });

    return page(tasks, { total, limit, offset });
  });

  app.get('/api/tasks/:id', async (req) => {
    const { id: taskId } = req.params as { id: string };
    return ok(taskDetail(db(), taskId));
  });

  const createSchema = z.object({
    title: z.string().min(4),
    boardId: z.string().optional(),
    columnId: z.string().optional(),
    projectId: z.string().nullable().optional(),
    projectPhaseId: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
    status: z.string().optional(),
    assigneeId: z.string().nullable().optional(),
    storyPoints: z.number().optional(),
    estimateHours: z.number().optional(),
    dueAt: z.string().nullable().optional(),
    labelIds: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    clientVisible: z.boolean().optional(),
    turnoverCriteria: z.string().optional(),
  });

  app.post('/api/tasks', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid task payload', parsed.error.issues);
    const taskId = createTask(db(), parsed.data as Record<string, any>, actor(req as never));
    reply.code(201);
    return ok(taskDetail(db(), taskId));
  });

  app.patch('/api/tasks/:id', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const row = db().get<{ id: string }>('SELECT id FROM tasks WHERE id = ? OR key = ?', [taskId, taskId]);
    if (!row) throw notFound('Task not found');
    updateTask(db(), row.id, req.body as Record<string, any>, actor(req as never));
    return ok(taskDetail(db(), row.id));
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const actorId = actor(req as never);
    requireRole(actorId, ['admin', 'lead']);
    const { id: taskId } = req.params as { id: string };
    db().run("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?", [nowIso(), taskId]);
    db().run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id) VALUES (?,?,?,?)', [actorId, 'task.cancelled', 'task', taskId]);
    reply.code(204);
    return null;
  });

  app.post('/api/tasks/:id/comments', async (req, reply) => {
    const { id: taskId } = req.params as { id: string };
    const body = (req.body as { body?: string })?.body?.trim();
    if (!body) throw badRequest('Comment body is required');
    const commentId = id('cmt');
    db().run('INSERT INTO task_comments (id,task_id,author_id,body) VALUES (?,?,?,?)', [commentId, taskId, actor(req as never), body]);
    db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      'task', taskId, actor(req as never), 'commented', body.slice(0, 120),
    ]);
    reply.code(201);
    return ok({ id: commentId });
  });

  app.post('/api/tasks/:id/checklist', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const { label } = req.body as { label: string };
    const itemId = id('chk');
    const pos = (db().get<{ m: number | null }>('SELECT MAX(position) AS m FROM task_checklist WHERE task_id = ?', [taskId])?.m ?? 0) + 1;
    db().run('INSERT INTO task_checklist (id,task_id,label,done,position) VALUES (?,?,?,0,?)', [itemId, taskId, label, pos]);
    return ok({ id: itemId });
  });

  app.patch('/api/tasks/:id/checklist/:itemId', async (req) => {
    const { itemId } = req.params as { id: string; itemId: string };
    const { done } = req.body as { done: boolean };
    db().run('UPDATE task_checklist SET done = ? WHERE id = ?', [done ? 1 : 0, itemId]);
    return ok({ id: itemId, done });
  });

  /* ------------------------------- turnover gates + acceptance ladder ----- */
  app.patch('/api/tasks/:id/turnover/:gateId', async (req) => {
    const { id: taskId, gateId } = req.params as { id: string; gateId: string };
    const actorId = actor(req as never);
    const { status, evidence } = req.body as { status: 'pending' | 'pass' | 'fail' | 'waived'; evidence?: string };
    if (!['pending', 'pass', 'fail', 'waived'].includes(status)) throw badRequest('Invalid check status');
    if (status === 'pass' && !evidence?.trim()) {
      throw badRequest('Passing a turnover gate requires written evidence — that is the whole point of the gate.');
    }
    if (status === 'waived') requireRole(actorId, ['admin', 'lead']);

    ensureTaskChecks(db(), taskId);
    db().run(
      `UPDATE turnover_checks SET status = ?, evidence = ?, checked_by = ?, checked_at = ?
       WHERE task_id = ? AND gate_id = ?`,
      [status, evidence ?? '', status === 'pending' ? null : actorId, status === 'pending' ? null : nowIso(), taskId, gateId],
    );
    const remaining = db().get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM turnover_checks c JOIN turnover_gates g ON g.id = c.gate_id
       WHERE c.task_id = ? AND g.required = 1 AND c.status NOT IN ('pass','waived')`, [taskId],
    )?.c ?? 0;
    const task = db().get<{ turnover_state: string }>('SELECT turnover_state FROM tasks WHERE id = ?', [taskId]);
    const nextState = status === 'fail' ? 'failed' : remaining === 0 ? 'passed' : 'in_review';
    db().run('UPDATE tasks SET turnover_state = ?, updated_at = ? WHERE id = ?', [nextState, nowIso(), taskId]);
    db().run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'turnover.check', 'task', taskId, JSON.stringify({ gateId, status, remaining }),
    ]);
    return ok(taskDetail(db(), taskId));
  });

  app.post('/api/tasks/:id/acceptance', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const { step, state, evidence, notes } = req.body as { step: string; state: 'passed' | 'rejected' | 'skipped'; evidence?: string; notes?: string };
    if (!ACCEPTANCE_LADDER.includes(step as never)) throw badRequest(`step must be one of ${ACCEPTANCE_LADDER.join(', ')}`);
    if (step === 'client_accepted') requireRole(actor(req as never), ['admin', 'lead']);
    const records = recordAcceptance(db(), taskId, step as never, state, actor(req as never), evidence, notes);
    return ok({ acceptance: records, task: taskDetail(db(), taskId) });
  });

  /* ----------------------------------------------------------- planning --- */
  app.get('/api/planner', async (req) => {
    const horizonDays = queryInt(req, 'horizon', 21);
    const tasks = db().all<Record<string, any>>(
      `SELECT t.*, a.capacity_hours_week FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.status NOT IN ('cancelled')`,
    );
    const deps = db().all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies');
    const depMap = new Map<string, string[]>();
    for (const d of deps) depMap.set(d.task_id, [...(depMap.get(d.task_id) ?? []), d.depends_on_id]);

    const people = db().all<Record<string, any>>("SELECT * FROM users WHERE role != 'bot' AND is_active = 1").map((u) => ({
      id: u.id,
      full_name: u.full_name,
      capacity_hours_week: u.capacity_hours_week,
      skills: JSON.parse(u.skills_json ?? '[]'),
    }));

    const result = plan({
      tasks: tasks.map((t) => ({
        id: t.id,
        key: t.key,
        title: t.title,
        priority: t.priority,
        status: t.status,
        assignee_id: t.assignee_id,
        estimate_hours: t.estimate_hours,
        logged_hours: t.logged_hours,
        due_at: t.due_at,
        created_at: t.created_at,
        blocked_reason: t.blocked_reason,
        turnover_state: t.turnover_state,
        client_visible: t.client_visible,
        parent_id: t.parent_id,
        project_id: t.project_id,
        depends_on: depMap.get(t.id) ?? [],
      })),
      people,
      horizonDays,
    });

    const projectRows = db().all<{ id: string; key: string; name: string }>('SELECT id,key,name FROM projects');
    const projectById = new Map(projectRows.map((p) => [p.id, p]));
    const keyByTask = new Map(tasks.map((t) => [t.id, t.project_id]));
    return ok({
      ...result,
      items: result.items.map((it) => ({ ...it, project: projectById.get(keyByTask.get(it.task_id) ?? '') ?? null })),
      generatedAt: nowIso(),
      horizonDays,
    });
  });

  app.post('/api/planner/runs', async (req) => {
    const actorId = actor(req as never);
    const horizonDays = Number((req.body as { horizonDays?: number })?.horizonDays ?? 21);
    const runId = id('run');
    db().run('INSERT INTO schedule_runs (id,created_by,algorithm,horizon_days) VALUES (?,?,?,?)', [runId, actorId, 'cpm+wspt', horizonDays]);
    return ok({ id: runId, horizonDays, createdAt: nowIso(), note: 'Plan persisted for audit; recompute via GET /api/planner.' });
  });

  /* ------------------------------------------------------------- clocks --- */
  app.get('/api/clocks', async () => ok({ clocks: clockHealth(db()), timers: liveTimers(db(), 40) }));

  app.post('/api/clocks/sweep', async () => {
    const swept = sweepTimers(db());
    return ok({ swept, at: nowIso() });
  });

  app.post('/api/clocks/timers/:id/resolve', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const { outcome, note } = req.body as { outcome: 'met' | 'missed' | 'paused' | 'waived'; note?: string };
    if (outcome === 'waived') requireRole(actor(req as never), ['admin', 'lead']);
    return ok(resolveTimer(db(), timerId, outcome, note));
  });

  /* ------------------------------------------------------------ projects -- */
  app.get('/api/projects', async () => {
    const rows = db().all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_count,
              (SELECT COALESCE(SUM(logged_hours),0) FROM tasks t WHERE t.project_id = p.id) AS logged_hours
       FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.status != 'archived' ORDER BY p.name`,
    ).map(mapProject);
    return ok(rows);
  });

  app.get('/api/projects/:id', async (req) => {
    const { id: projectId } = req.params as { id: string };
    const project = db().get<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_count,
              (SELECT COALESCE(SUM(logged_hours),0) FROM tasks t WHERE t.project_id = p.id) AS logged_hours
       FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.id = ? OR p.key = ?`, [projectId, projectId],
    );
    if (!project) throw notFound('Project not found');

    const phases = db().all<Record<string, any>>(
      `SELECT pp.*, ph.name, ph.key AS phase_key, ph.color, ph.description, ph.sla_days, ph.turnover_policy,
              u.full_name AS signoff_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_phase_id = pp.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_phase_id = pp.id AND t.status='done') AS done_count
       FROM project_phases pp JOIN phases ph ON ph.id = pp.phase_id
       LEFT JOIN users u ON u.id = pp.signoff_by
       WHERE pp.project_id = ? ORDER BY pp.position`, [project.id],
    );
    const phaseGates = db().all<Record<string, any>>('SELECT * FROM turnover_gates WHERE scope = ?', ['phase']);
    const phaseChecks = db().all<Record<string, any>>('SELECT * FROM turnover_checks WHERE project_phase_id IS NOT NULL');
    const checkByPhase = new Map<string, Record<string, any>[]>();
    for (const c of phaseChecks) {
      const list = checkByPhase.get(c.project_phase_id) ?? [];
      list.push(c);
      checkByPhase.set(c.project_phase_id, list);
    }

    const edgeStats = db().all<Record<string, any>>(
      'SELECT status, COUNT(*) AS c FROM edge_cases WHERE project_id = ? GROUP BY status', [project.id]);
    const edgeByCategory = db().all<Record<string, any>>(
      'SELECT category, COUNT(*) AS c FROM edge_cases WHERE project_id = ? GROUP BY category ORDER BY c DESC', [project.id]);
    const releases = db().all<Record<string, any>>('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
    const handoffs = db().all<Record<string, any>>('SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
    const qa = db().all<Record<string, any>>(
      `SELECT q.*, u.full_name AS reporter FROM qa_reports q LEFT JOIN users u ON u.id = q.reporter_id
       WHERE q.project_id = ? ORDER BY q.created_at DESC LIMIT 20`, [project.id]);
    const docs = db().all('SELECT id,title,kind,status,updated_at,client_visible FROM docs WHERE project_id = ? ORDER BY updated_at DESC', [project.id]);
    const timers = liveTimers(db(), 200).filter((t) => t.entityId === project.id || t.entityId === project.key);
    const edgeTotal = edgeStats.reduce((a, e) => a + e.c, 0);
    const edgeVerified = edgeStats.find((e) => e.status === 'verified')?.c ?? 0;

    return ok({
      ...mapProject(project),
      phases: phases.map((p) => {
        const checks = checkByPhase.get(p.id) ?? [];
        const required = phaseGates.filter((g) => g.required);
        const passed = checks.filter((c) => c.status === 'pass' || c.status === 'waived').length;
        return {
          id: p.id,
          key: p.phase_key,
          name: p.name,
          color: p.color,
          description: p.description,
          status: p.status,
          progress: p.progress,
          slaDays: p.sla_days,
          turnoverPolicy: p.turnover_policy,
          startedAt: p.started_at,
          dueAt: p.due_at,
          completedAt: p.completed_at,
          signoff: p.signoff_name,
          turnoverPassed: !!p.turnover_passed,
          taskCount: p.task_count,
          doneCount: p.done_count,
          gateScore: Math.round((passed / Math.max(1, required.length)) * 100),
          gates: phaseGates.map((g) => {
            const c = checks.find((x) => x.gate_id === g.id);
            return { id: g.id, key: g.key, name: g.name, required: !!g.required, status: c?.status ?? 'pending', evidence: c?.evidence ?? '' };
          }),
        };
      }),
      edgeCases: {
        total: edgeTotal,
        target: project.edge_case_target,
        verified: edgeVerified,
        progressPct: Math.min(100, Math.round((edgeTotal / Math.max(1, project.edge_case_target)) * 100)),
        byStatus: Object.fromEntries(edgeStats.map((e) => [e.status, e.c])),
        byCategory: edgeByCategory.map((e) => ({ category: e.category, count: e.c })),
      },
      releases,
      handoffs,
      qa,
      docs,
      timers,
      shipGate: {
        edgeCases: edgeTotal >= project.edge_case_target,
        edgeVerified: edgeVerified >= Math.floor(project.edge_case_target * 0.9),
        openP0: qa.filter((q) => ['p0', 'p1'].includes(q.severity) && !['verified', 'wont_fix', 'duplicate'].includes(q.status)).length === 0,
        execSummary: releases.some((r) => r.exec_summary_url),
        clientAccepted: (db().get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM tasks t JOIN acceptance_records a ON a.task_id = t.id
           WHERE t.project_id = ? AND a.step='client_accepted' AND a.state='passed'`, [project.id])?.c ?? 0) > 0,
      },
    });
  });

  app.patch('/api/projects/:id/phases/:phaseRowId', async (req) => {
    const { id: projectId, phaseRowId } = req.params as { id: string; phaseRowId: string };
    const actorId = actor(req as never);
    const body = req.body as { status?: string; progress?: number; turnoverPassed?: boolean };
    const rows = db().get<Record<string, any>>('SELECT * FROM project_phases WHERE id = ? AND project_id = ?', [phaseRowId, projectId]);
    if (!rows) throw notFound('Phase not found');
    if (body.status) {
      db().run('UPDATE project_phases SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?', [
        body.status, body.status === 'active' ? nowIso() : null, phaseRowId,
      ]);
      if (body.status === 'active') startTimer(db(), 'milestone-turnover', 'phase', rows.phase_id, `Phase turnover: ${rows.phase_id}`);
      if (body.status === 'done') closeTimersFor(db(), 'phase', rows.phase_id, 'met');
    }
    if (body.progress !== undefined) db().run('UPDATE project_phases SET progress = ? WHERE id = ?', [body.progress, phaseRowId]);
    if (body.turnoverPassed !== undefined) {
      db().run('UPDATE project_phases SET turnover_passed = ?, signoff_by = ?, signoff_at = ? WHERE id = ?', [
        body.turnoverPassed ? 1 : 0, body.turnoverPassed ? actorId : null, body.turnoverPassed ? nowIso() : null, phaseRowId,
      ]);
    }
    db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      'phase', phaseRowId, actorId, 'updated', `phase ${phaseRowId} → ${body.status ?? 'updated'}`,
    ]);
    return ok({ ok: true });
  });

  /* ------------------------------------------------------------ pipeline -- */
  app.get('/api/pipeline', async () => {
    const stages = db().all<Record<string, any>>('SELECT * FROM pipeline_stages ORDER BY position');
    const deals = db().all<Record<string, any>>(
      `SELECT d.*, c.name AS client_name, c.accent_color AS client_color, s.key AS stage_key, s.name AS stage_name,
              s.phase AS stage_phase, s.color AS stage_color, s.default_sla_days, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color
       FROM deals d JOIN clients c ON c.id = d.client_id JOIN pipeline_stages s ON s.id = d.stage_id
       LEFT JOIN users u ON u.id = d.owner_id ORDER BY d.value_cents DESC`,
    ).map(mapDeal);

    const phaseRuns = db().all<Record<string, any>>(
      `SELECT r.*, ph.name, ph.color, ph.key AS phase_key FROM deal_phase_runs r JOIN phases ph ON ph.id = r.phase_id ORDER BY r.position`,
    );
    const runsByDeal = new Map<string, Record<string, any>[]>();
    for (const r of phaseRuns) {
      const list = runsByDeal.get(r.deal_id) ?? [];
      list.push(r);
      runsByDeal.set(r.deal_id, list);
    }

    const columns = stages.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      phase: s.phase,
      color: s.color,
      icon: s.icon,
      description: s.description,
      entryCriteria: s.entry_criteria,
      exitCriteria: s.exit_criteria,
      slaDays: s.default_sla_days,
      position: s.position,
      deals: deals.filter((d) => d.stageKey === s.key),
      valueCents: deals.filter((d) => d.stageKey === s.key && d.status === 'open').reduce((a, d) => a + d.valueCents, 0),
    }));

    const open = deals.filter((d) => d.status === 'open');
    return ok({
      columns,
      deals: deals.map((d) => ({ ...d, phases: runsByDeal.get(d.id) ?? [] })),
      summary: {
        pipelineValueCents: open.reduce((a, d) => a + d.valueCents, 0),
        weightedCents: Math.round(open.reduce((a, d) => a + (d.valueCents * d.probability) / 100, 0)),
        openDeals: open.length,
        wonValueCents: deals.filter((d) => d.status === 'won').reduce((a, d) => a + d.valueCents, 0),
        lostValueCents: deals.filter((d) => d.status === 'lost').reduce((a, d) => a + d.valueCents, 0),
        avgAgeDays: open.length ? Math.round(open.reduce((a, d) => a + d.ageDays, 0) / open.length) : 0,
        byPhase: Object.fromEntries(
          ['origin', 'discovery', 'proposal', 'delivery', 'growth'].map((p) => [
            p, open.filter((d) => d.stagePhase === p).reduce((a, d) => a + d.valueCents, 0),
          ]),
        ),
      },
    });
  });

  app.patch('/api/deals/:id', async (req) => {
    const { id: dealId } = req.params as { id: string };
    const actorId = actor(req as never);
    const body = req.body as { stageId?: string; stageKey?: string; status?: string; nextStep?: string; probability?: number; ownerId?: string };
    const deal = db().get<Record<string, any>>('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) throw notFound('Deal not found');
    if (body.stageId || body.stageKey) {
      const stage = body.stageId
        ? db().get<Record<string, any>>('SELECT * FROM pipeline_stages WHERE id = ?', [body.stageId])
        : db().get<Record<string, any>>('SELECT * FROM pipeline_stages WHERE key = ?', [body.stageKey!]);
      if (!stage) throw badRequest('Unknown stage');
      db().run('UPDATE deals SET stage_id = ?, probability = ?, updated_at = ? WHERE id = ?', [
        stage.id, body.probability ?? Math.min(100, Math.round(stage.position / 1.2)), nowIso(), dealId,
      ]);
      db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
        'deal', dealId, actorId, 'stage_changed', `${deal.title} → ${stage.name}`,
      ]);
      if (stage.key === 'tech_consult') startTimer(db(), 'consult-to-plan', 'deal', dealId, `${deal.title} — plan due`);
      if (stage.key === 'proposal') startTimer(db(), 'plan-revision', 'deal', dealId, `${deal.title} — proposal`) ;
    }
    if (body.status) {
      db().run('UPDATE deals SET status = ?, won_at = ?, lost_at = ?, updated_at = ? WHERE id = ?', [
        body.status, body.status === 'won' ? nowIso() : deal.won_at, body.status === 'lost' ? nowIso() : deal.lost_at, nowIso(), dealId,
      ]);
    }
    if (body.nextStep !== undefined) db().run('UPDATE deals SET next_step = ? WHERE id = ?', [body.nextStep, dealId]);
    if (body.probability !== undefined) db().run('UPDATE deals SET probability = ? WHERE id = ?', [body.probability, dealId]);
    if (body.ownerId !== undefined) db().run('UPDATE deals SET owner_id = ? WHERE id = ?', [body.ownerId, dealId]);
    return ok(db().get('SELECT * FROM deals WHERE id = ?', [dealId]));
  });

  app.post('/api/deals', async (req, reply) => {
    const body = req.body as Record<string, any>;
    if (!body.clientId || !body.title) throw badRequest('clientId and title are required');
    const dealId = id('dl');
    const stage = db().get<{ id: string }>('SELECT id FROM pipeline_stages WHERE key = ?', [body.stageKey ?? 'inbound']);
    if (!stage) throw badRequest('Unknown stage');
    db().run(
      `INSERT INTO deals (id,client_id,title,value_cents,status,stage_id,owner_id,probability,next_step)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealId, body.clientId, body.title, body.valueCents ?? 0, 'open', stage.id, body.ownerId ?? actor(req as never), body.probability ?? 20, body.nextStep ?? ''],
    );
    reply.code(201);
    return ok({ id: dealId });
  });

  /* ------------------------------------------------------------- clients -- */
  app.get('/api/clients', async () => {
    const clients = db().all<Record<string, any>>('SELECT * FROM clients ORDER BY name').map(mapClient);
    const deals = db().all<Record<string, any>>('SELECT client_id, value_cents, status FROM deals');
    const projects = db().all<Record<string, any>>('SELECT client_id, status FROM projects');
    return ok(clients.map((c) => ({
      ...c,
      contactEmail: db().get<{ e: string }>('SELECT primary_contact_email AS e FROM clients WHERE id = ?', [c.id])?.e ?? '',
      openValueCents: deals.filter((d) => d.client_id === c.id && d.status === 'open').reduce((a, d) => a + d.value_cents, 0),
      wonValueCents: deals.filter((d) => d.client_id === c.id && d.status === 'won').reduce((a, d) => a + d.value_cents, 0),
      projectCount: projects.filter((p) => p.client_id === c.id && p.status !== 'archived').length,
    })));
  });

  app.get('/api/partners', async () => {
    const partners = db().all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color FROM partners p JOIN clients c ON c.id = p.client_id ORDER BY p.name`,
    );
    const iam = db().all<Record<string, any>>('SELECT partner_id, role, mfa_enabled, status FROM partner_iam_users');
    const devices = db().all<Record<string, any>>('SELECT partner_id, status FROM device_licenses');
    const usage = db().all<Record<string, any>>('SELECT partner_id, day, api_calls, active_users, storage_mb, uptime_pct FROM usage_metrics ORDER BY day');
    return ok(partners.map((p) => {
      const rows = usage.filter((u) => u.partner_id === p.id);
      const last30 = rows.slice(-30);
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        consoleUrl: p.console_url,
        plan: p.plan,
        status: p.status,
        clientName: p.client_name,
        clientColor: p.client_color,
        deviceLimit: p.device_limit,
        devicesActive: devices.filter((d) => d.partner_id === p.id && d.status === 'active').length,
        apiQuota: p.api_quota_month,
        apiCalls: last30.reduce((a, u) => a + u.api_calls, 0),
        seatLimit: p.seat_limit,
        seats: iam.filter((i) => i.partner_id === p.id && i.status !== 'disabled').length,
        mfaPct: Math.round((iam.filter((i) => i.partner_id === p.id && i.mfa_enabled).length / Math.max(1, iam.filter((i) => i.partner_id === p.id).length)) * 100),
        uptimePct: last30.length ? Math.round((last30.reduce((a, u) => a + u.uptime_pct, 0) / last30.length) * 100) / 100 : 100,
        usage: last30.map((u) => ({ day: u.day, apiCalls: u.api_calls, activeUsers: u.active_users })),
      };
    }));
  });

  /* --------------------------------------------------------------- QA ----- */
  app.get('/api/qa', async (req) => {
    const projectId = queryStr(req, 'projectId');
    const status = queryStr(req, 'status');
    const where: string[] = [];
    const params: unknown[] = [];
    if (projectId) { where.push('q.project_id = ?'); params.push(projectId); }
    if (status) { where.push('q.status = ?'); params.push(status); }
    const rows = db().all<Record<string, any>>(
      `SELECT q.*, p.name AS project_name, p.key AS project_key, u.full_name AS reporter, a.full_name AS assignee
       FROM qa_reports q JOIN projects p ON p.id = q.project_id
       LEFT JOIN users u ON u.id = q.reporter_id LEFT JOIN users a ON a.id = q.assignee_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE q.severity WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 ELSE 4 END, q.created_at DESC
       LIMIT 200`,
      params,
    );
    const now = Date.now();
    return ok(rows.map((q) => ({
      id: q.id,
      title: q.title,
      kind: q.kind,
      severity: q.severity,
      status: q.status,
      project: { id: q.project_id, name: q.project_name, key: q.project_key },
      reporter: q.reporter,
      assignee: q.assignee,
      reproduction: q.reproduction,
      evidenceUrl: q.evidence_url,
      submittedAt: q.submitted_at,
      resolvedAt: q.resolved_at,
      dueAt: q.due_at,
      hoursLeft: q.due_at ? Math.round((((toDate(q.due_at)?.getTime() ?? now) - now) / 3600000) * 10) / 10 : null,
      overdue: q.due_at ? (toDate(q.due_at)?.getTime() ?? now) < now && !['verified', 'wont_fix', 'duplicate'].includes(q.status) : false,
    })));
  });

  app.post('/api/qa', async (req, reply) => {
    const actorId = actor(req as never);
    const b = req.body as Record<string, any>;
    if (!b.projectId || !b.title) throw badRequest('projectId and title are required');
    const reportId = id('qa');
    const due = new Date(Date.now() + 12 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    db().run(
      `INSERT INTO qa_reports (id,project_id,kind,severity,title,body,status,reproduction,evidence_url,reporter_id,assignee_id,due_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [reportId, b.projectId, b.kind ?? 'bug', b.severity ?? 'p2', b.title, b.body ?? '', 'open',
        b.reproduction ?? '', b.evidenceUrl ?? '', actorId, b.assigneeId ?? null, due],
    );
    startTimer(db(), 'qa-report', 'qa', reportId, `QA report: ${b.title}`);
    reply.code(201);
    return ok({ id: reportId, dueAt: due });
  });

  app.patch('/api/qa/:id', async (req) => {
    const { id: reportId } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of [['status', 'status'], ['severity', 'severity'], ['assigneeId', 'assignee_id'], ['title', 'title']] as const) {
      if (b[key] !== undefined) { sets.push(`${col} = ?`); params.push(b[key]); }
    }
    if (b.status && ['fixed', 'verified', 'wont_fix', 'duplicate'].includes(b.status)) {
      sets.push('resolved_at = ?');
      params.push(nowIso());
      closeTimersFor(db(), 'qa', reportId, 'met');
    }
    if (!sets.length) throw badRequest('Nothing to update');
    db().run(`UPDATE qa_reports SET ${sets.join(', ')} WHERE id = ?`, [...params, reportId]);
    return ok(db().get('SELECT * FROM qa_reports WHERE id = ?', [reportId]));
  });

  /* ------------------------------------------------------------ releases -- */
  app.get('/api/releases', async () => {
    const rows = db().all<Record<string, any>>(
      `SELECT r.*, p.name AS project_name, p.key AS project_key, c.name AS client_name, c.accent_color AS client_color
       FROM releases r JOIN projects p ON p.id = r.project_id JOIN clients c ON c.id = p.client_id
       ORDER BY COALESCE(r.ship_planned_at, r.created_at) DESC`,
    );
    return ok(rows.map((r) => ({
      id: r.id,
      version: r.version,
      name: r.name,
      status: r.status,
      project: { id: r.project_id, name: r.project_name, key: r.project_key },
      clientName: r.client_name,
      clientColor: r.client_color,
      demoAt: r.demo_at,
      demoApprovedAt: r.demo_approved_at,
      execSummaryDueAt: r.exec_summary_due_at,
      execSummaryUrl: r.exec_summary_url,
      shipPlannedAt: r.ship_planned_at,
      shippedAt: r.shipped_at,
      branch: r.branch,
      deployTarget: r.deploy_target,
      rollbackPlan: r.rollback_plan,
      demoFeedback: r.demo_feedback,
    })));
  });

  /* ----------------------------------------------------------- dashboard -- */
  app.get('/api/dashboard', async (req) => {
    const actorId = actor(req as never);
    const now = Date.now();
    const tasks = db().all<Record<string, any>>(
      `${TASK_SELECT} WHERE t.status NOT IN ('cancelled')`,
    );
    const taskList = tasks.map((r) => mapTask(r));
    const withRisk = taskList.map((t) => {
      const risk = scoreRisk({
        priority: t.priority, status: t.status, dueAt: t.dueAt, estimateHours: t.estimateHours,
        loggedHours: t.loggedHours, turnoverState: t.turnoverState, blockedReason: t.blockedReason,
        dependencyCount: t.counts.dependencies, clientVisible: t.clientVisible,
        ageDays: (now - (toDate(t.createdAt)?.getTime() ?? now)) / 86400000,
      });
      const sla = slaState({ status: t.status, priority: t.priority, sla_due_at: t.slaDueAt, completed_at: t.completedAt });
      return { ...t, risk, sla: sla.state };
    });

    const open = withRisk.filter((t) => t.status !== 'done');
    const byStatus = Object.fromEntries(
      ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'].map((s) => [s, taskList.filter((t) => t.status === s).length]),
    );

    const throughput: Array<{ day: string; completed: number; created: number }> = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
      throughput.push({
        day,
        completed: taskList.filter((t) => t.completedAt && String(t.completedAt).slice(0, 10) === day).length,
        created: taskList.filter((t) => String(t.createdAt).slice(0, 10) === day).length,
      });
    }

    const clients = db().all<Record<string, any>>('SELECT * FROM clients');
    const projects = db().all<Record<string, any>>(
      `SELECT p.id,p.key,p.name,p.status,p.health,c.name AS client_name,c.accent_color,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) AS total,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='done') AS done
       FROM projects p JOIN clients c ON c.id=p.client_id WHERE p.status!='archived'`,
    );
    const deals = db().all<Record<string, any>>(
      `SELECT d.*, s.name AS stage_name, s.phase FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.status='open'`,
    );
    const workload = db().all<Record<string, any>>(
      `SELECT u.id,u.full_name,u.initials,u.avatar_color,u.capacity_hours_week,
              COALESCE(SUM(CASE WHEN t.status NOT IN ('done','cancelled') THEN t.estimate_hours - MIN(t.logged_hours, t.estimate_hours*0.8) ELSE 0 END),0) AS open_hours,
              COUNT(CASE WHEN t.status IN ('in_progress','review') THEN 1 END) AS active_tasks
       FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id
       WHERE u.is_active = 1 GROUP BY u.id ORDER BY open_hours DESC`,
    );

    return ok({
      kpis: {
        openTasks: open.length,
        inFlight: byStatus.in_progress + byStatus.review,
        blocked: byStatus.blocked,
        shippedThisWeek: taskList.filter((t) => t.completedAt && now - (toDate(t.completedAt)?.getTime() ?? 0) < 7 * 86400000).length,
        atRisk: open.filter((t) => t.risk.band === 'high' || t.risk.band === 'critical').length,
        slaBreaches: open.filter((t) => t.sla === 'breached').length,
        turnoverBlocked: open.filter((t) => t.turnoverState === 'failed').length,
        pipelineValueCents: deals.reduce((a, d) => a + d.value_cents, 0),
        weightedCents: Math.round(deals.reduce((a, d) => a + (d.value_cents * d.probability) / 100, 0)),
        openDeals: deals.length,
        clientHealth: {
          healthy: clients.filter((c) => c.health === 'healthy').length,
          watch: clients.filter((c) => c.health === 'watch').length,
          atRisk: clients.filter((c) => c.health === 'at_risk').length,
          churn: clients.filter((c) => c.health === 'churn').length,
        },
        billableHoursWeek: Math.round((db().get<{ m: number }>(
          "SELECT COALESCE(SUM(minutes),0) AS m FROM time_entries WHERE worked_on >= date('now','-7 day')")?.m ?? 0) / 60),
      },
      byStatus,
      throughput,
      focus: open.filter((t) => t.assignee?.id === actorId).sort((a, b) => b.risk.score - a.risk.score).slice(0, 6),
      escalations: open.filter((t) => t.risk.band === 'critical' || t.sla === 'breached')
        .sort((a, b) => b.risk.score - a.risk.score).slice(0, 8),
      workload: workload.map((w) => ({
        id: w.id,
        name: w.full_name,
        initials: w.initials,
        color: w.avatar_color,
        capacity: w.capacity_hours_week,
        planned: Math.round(w.open_hours),
        utilisation: w.capacity_hours_week ? Math.round((w.open_hours / w.capacity_hours_week) * 100) : 0,
        activeTasks: w.active_tasks,
      })),
      projects: projects.map((p) => ({
        id: p.id, key: p.key, name: p.name, status: p.status, health: p.health,
        clientName: p.client_name, color: p.accent_color,
        progress: p.total ? Math.round((p.done / p.total) * 100) : 0,
        total: p.total, done: p.done,
      })),
      clocks: clockHealth(db()),
      timers: liveTimers(db(), 12),
      pipelineByPhase: ['origin', 'discovery', 'proposal', 'delivery', 'growth'].map((phase) => ({
        phase,
        valueCents: deals.filter((d) => d.phase === phase).reduce((a, d) => a + d.value_cents, 0),
        count: deals.filter((d) => d.phase === phase).length,
      })),
    });
  });

  /* ---------------------------------------------------------- activity ---- */
  app.get('/api/activity', async (req) => {
    const limit = Math.min(queryInt(req, 'limit', 40), 200);
    const rows = db().all<Record<string, any>>(
      `SELECT a.*, u.full_name AS actor, u.initials, u.avatar_color FROM activity a
       LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC, a.id DESC LIMIT ?`, [limit],
    );
    return ok(rows.map((a) => ({
      id: a.id,
      entityType: a.entity_type,
      entityId: a.entity_id,
      verb: a.verb,
      summary: a.summary,
      createdAt: a.created_at,
      actor: a.actor ? { name: a.actor, initials: a.initials, color: a.avatar_color } : null,
    })));
  });

  app.get('/api/notifications', async (req) => {
    const rows = db().all<Record<string, any>>(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [actor(req as never)],
    );
    return ok(rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, readAt: n.read_at, createdAt: n.created_at })));
  });

  app.post('/api/notifications/:id/read', async (req) => {
    const { id: notifId } = req.params as { id: string };
    db().run('UPDATE notifications SET read_at = ? WHERE id = ?', [nowIso(), notifId]);
    return ok({ id: notifId });
  });

  /* -------------------------------------------------------- intelligence -- */
  app.get('/api/insights', async () => {
    const tasks = db().all<Record<string, any>>(`${TASK_SELECT} WHERE t.status NOT IN ('cancelled','done')`);
    const now = Date.now();
    const insights: Array<Record<string, unknown>> = [];

    // 1. Critical path / dependency bottlenecks.
    const deps = db().all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies');
    const blockingCount = new Map<string, number>();
    for (const d of deps) blockingCount.set(d.depends_on_id, (blockingCount.get(d.depends_on_id) ?? 0) + 1);
    for (const [taskId, count] of [...blockingCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
      const t = tasks.find((x) => x.id === taskId);
      if (t && count > 1) {
        insights.push({
          kind: 'bottleneck', severity: 'high', title: `${t.key} is blocking ${count} downstream tasks`,
          body: `“${t.title}” sits on the critical path for ${count} other units of work. Pull it forward or split it.`,
          action: { label: 'Open task', taskId: t.id },
        });
      }
    }

    // 2. Reviewer concentration (single point of failure).
    const reviewers = db().all<Record<string, any>>(
      `SELECT u.full_name, COUNT(*) AS c FROM acceptance_records a JOIN users u ON u.id = a.actor_id
       WHERE a.step = 'lead_approved' GROUP BY u.id ORDER BY c DESC`,
    );
    if (reviewers.length === 1) {
      insights.push({
        kind: 'concentration', severity: 'medium', title: 'Every lead approval is one person',
        body: `${reviewers[0].full_name} has approved 100% of lead gates. Add a second approver before Q4 to remove the bus factor.`,
        action: null,
      });
    }

    // 3. Estimate drift by project.
    const drift = new Map<string, { est: number; logged: number; name: string }>();
    for (const t of tasks) {
      if (!t.estimate_hours) continue;
      const key = t.project_key ?? 'Unassigned';
      const cur = drift.get(key) ?? { est: 0, logged: 0, name: key };
      cur.est += t.estimate_hours;
      cur.logged += t.logged_hours;
      drift.set(key, cur);
    }
    for (const [key, d] of drift) {
      const ratio = d.est ? d.logged / d.est : 0;
      if (ratio > 1.15) {
        insights.push({
          kind: 'estimate_drift', severity: ratio > 1.4 ? 'high' : 'medium',
          title: `${key} is burning ${Math.round((ratio - 1) * 100)}% over estimate`,
          body: `${Math.round(d.logged)}h logged against ${Math.round(d.est)}h estimated on open work. Re-baseline before the next demo promise.`,
          action: null,
        });
      }
    }

    // 4. Stale WIP (Little's law pressure).
    const stale = tasks.filter((t) => {
      const updated = toDate(t.updated_at)?.getTime() ?? now;
      return ['in_progress', 'review'].includes(t.status) && now - updated > 5 * 86400000;
    });
    if (stale.length) {
      insights.push({
        kind: 'stale_wip', severity: stale.length > 4 ? 'high' : 'medium',
        title: `${stale.length} tasks have not moved in 5+ days`,
        body: 'Work-in-progress is ageing, which raises cycle time for everything else. Consider a WIP limit on In Progress.',
        action: null,
      });
    }

    // 5. Turnover gate failure clustering.
    const failedGates = db().all<Record<string, any>>(
      `SELECT g.key, g.name, COUNT(*) AS c FROM turnover_checks c JOIN turnover_gates g ON g.id = c.gate_id
       WHERE c.status = 'fail' GROUP BY g.id ORDER BY c DESC LIMIT 3`,
    );
    for (const f of failedGates) {
      insights.push({
        kind: 'turnover_cluster', severity: 'medium',
        title: `${f.name} fails most often (${f.c}×)`,
        body: 'A gate that fails repeatedly usually means the policy is under-specified, not that the team is careless. Add the failing condition to the template.',
        action: null,
      });
    }

    // 6. Client-facing risk.
    const visibleLate = tasks.filter((t) => t.client_visible && t.due_at && (toDate(t.due_at)?.getTime() ?? Infinity) < now);
    if (visibleLate.length) {
      insights.push({
        kind: 'client_risk', severity: 'critical',
        title: `${visibleLate.length} client-visible commitments are past due`,
        body: 'These appear on the client status page. Send a written position with a date, or renegotiate the commitment today.',
        action: { label: 'View tasks', taskId: visibleLate[0].id },
      });
    }

    const order = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
    insights.sort((a, b) => order[String(a.severity)] - order[String(b.severity)]);
    return ok({ insights, generatedAt: nowIso() });
  });

  /* ------------------------------------------------------------- audit ---- */
  app.get('/api/audit', async (req) => {
    requireRole(actor(req as never), ['admin', 'lead']);
    const limit = Math.min(queryInt(req, 'limit', 50), 200);
    const rows = db().all<Record<string, any>>(
      `SELECT a.*, u.full_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.id DESC LIMIT ?`, [limit],
    );
    return ok(rows);
  });

  /* ------------------------------------------------------------- search --- */
  app.get('/api/search', async (req) => {
    const q = queryStr(req, 'q') ?? '';
    if (q.length < 2) return ok({ tasks: [], projects: [], clients: [], deals: [], docs: [] });
    const like = `%${q}%`;
    return ok({
      tasks: db().all(`${TASK_SELECT} WHERE t.title LIKE ? OR t.key LIKE ? LIMIT 8`, [like, like]).map(mapTask),
      projects: db().all<Record<string, any>>('SELECT * FROM projects WHERE name LIKE ? OR key LIKE ? LIMIT 5', [like, like]).map((p) => ({ id: p.id, key: p.key, name: p.name })),
      clients: db().all('SELECT id,name,initials,accent_color FROM clients WHERE name LIKE ? LIMIT 5', [like]),
      deals: db().all('SELECT id,title,value_cents FROM deals WHERE title LIKE ? LIMIT 5', [like]),
      docs: db().all('SELECT id,title,kind FROM docs WHERE title LIKE ? LIMIT 5', [like]),
    });
  });

  /* ----------------------------------------------------------- documents -- */
  app.get('/api/docs', async (req) => {
    const projectId = queryStr(req, 'projectId');
    const rows = projectId
      ? db().all<Record<string, any>>('SELECT d.*, p.name AS project_name FROM docs d LEFT JOIN projects p ON p.id = d.project_id WHERE d.project_id = ? ORDER BY d.updated_at DESC', [projectId])
      : db().all<Record<string, any>>('SELECT d.*, p.name AS project_name FROM docs d LEFT JOIN projects p ON p.id = d.project_id ORDER BY d.updated_at DESC');
    return ok(rows.map((d) => ({
      id: d.id, title: d.title, kind: d.kind, body: d.body, status: d.status,
      projectName: d.project_name, clientVisible: !!d.client_visible, updatedAt: d.updated_at,
    })));
  });
}
