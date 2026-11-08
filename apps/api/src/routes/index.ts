/**
 * HTTP surface. Every route is thin: validate → service → serialise.
 * Grouped by bounded context so the OpenAPI/REST contract stays legible.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, notFound, ok, page, queryInt, queryList, queryStr, forbidden, unauthorized } from '../lib/http.ts';
import type { Identity } from '../auth/index.ts';
import { requireProjectAccess } from '../auth/middleware.ts';
import { resolveReadScope, tasksWhere, projectsWhere, docsWhere, clientsWhere, dealsWhere, assertProjectInScope } from '../auth/scope.ts';
import { id, nowIso } from '../lib/ids.ts';
import { toDate } from '../lib/dates.ts';
import { TASK_SELECT, mapTask, mapUser, mapClient, mapProject, mapDeal } from '../repositories/query.ts';
import { SLA_HOURS, scoreRisk, slaState } from '../domain/risk.ts';
import { plan } from '../domain/planner.ts';
import { createTask, updateTask, taskDetail, recordAcceptance, ensureTaskChecks, ACCEPTANCE_LADDER } from '../services/tasks.ts';
import { clockHealth, liveTimers, resolveTimer, startTimer, sweepTimers, closeTimersFor, pauseTimerFor, resumeTimerFor, clockHistory } from '../services/clocks.ts';
import { transition, lifecycleView, addEvidence, getStages } from '../services/lifecycle.ts';
import { setGauge, renderMetrics, sweeperStats } from '../lib/metrics.ts';
import { evaluateShipGate, markShipped } from '../services/shipgate.ts';

const db = () => getDb();

/**
 * Verified identity for the current request.
 *
 * The identity comes from the auth boundary (session row or verified OIDC
 * token) and was re-read from the `users` table on this request — never from a
 * client-supplied header. `AUTH_MODE=dev` retains the demo identity so a fresh
 * clone is explorable; that path is refused in production by
 * `assertAuthConfiguration()`.
 */
async function actor(req: FastifyRequest): Promise<string> {
  const identity = req.identity ?? (await resolveFallbackIdentity());
  return identity.userId;
}

async function currentIdentity(req: FastifyRequest): Promise<Identity> {
  if (req.identity) return req.identity;
  return resolveFallbackIdentity();
}

/**
 * Used only when the auth hook was not installed (unit tests that inject a
 * database but no auth boundary). Production registers the hook unconditionally.
 */
let fallbackIdentity: Identity | null = null;
export function setFallbackIdentity(identity: Identity | null) {
  fallbackIdentity = identity;
}
async function resolveFallbackIdentity(): Promise<Identity> {
  if (fallbackIdentity) return fallbackIdentity;
  const user = await db().get<{ id: string; email: string; role: Identity['role']; full_name: string }>(
    'SELECT id,email,role,full_name FROM users WHERE id = ?',
    [config.demoUserId],
  );
  if (!user) throw unauthorized('No identity available');
  return { userId: user.id, email: user.email, role: user.role, name: user.full_name, method: 'dev', expiresAt: Date.now() + 60_000, claims: {} };
}

async function requireRole(req: FastifyRequest, roles: Identity['role'][]): Promise<string> {
  const identity = await currentIdentity(req);
  if (!roles.includes(identity.role)) {
    throw forbidden(`Requires role: ${roles.join(' | ')} (you are ${identity.role})`);
  }
  return identity.userId;
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: { auth?: import('../auth/middleware.ts').AuthApi } = {},
) {
  /* ------------------------------------------------------------- health -- */
  app.get('/api/health', async (_req, reply) => {
    const started = Date.now();
    const engine = db().dialect;
    let dbOk = true;
    let version = 0;
    try {
      dbOk = db().ping ? await db().ping!() : true;
      version = (await db().get<{ c: number }>('SELECT COUNT(*) AS c FROM schema_migrations'))?.c ?? 0;
    } catch {
      dbOk = false;
    }
    const latencyMs = Date.now() - started;
    const payload = {
      status: dbOk ? 'ok' : 'degraded',
      service: 'relay-api',
      version: process.env.APP_VERSION ?? '1.0.0',
      env: config.env,
      schemaVersion: version,
      latencyMs,
      uptimeSec: Math.round(process.uptime()),
      storage: engine === 'postgres' ? 'postgres' : 'sqlite-wal',
      database: { ok: dbOk, engine, latencyMs },
      worker: { name: 'clock-sweeper', intervalMs: config.sweepIntervalMs },
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      authMode: config.authMode,
    };
    // No secrets, no connection strings, no user data — safe for an
    // unauthenticated probe to read.
    if (!dbOk) return reply.code(503).send({ error: { code: 'unavailable', message: 'Database unreachable', details: payload } });
    return ok(payload);
  });

  /** Liveness: is the process running? Never touches the database. */
  app.get('/api/live', async () => ok({ live: true, uptimeSec: Math.round(process.uptime()) }));

  /** Readiness: can we serve traffic? Fails when the database is unreachable. */
  app.get('/api/ready', async (_req, reply) => {
    let ready = true;
    try {
      ready = db().ping ? await db().ping!() : true;
    } catch {
      ready = false;
    }
    if (!ready) return reply.code(503).send({ error: { code: 'unavailable', message: 'Database unreachable' } });
    return ok({ ready: true, engine: db().dialect });
  });

  /**
   * Prometheus text exposition. Business gauges are computed on scrape so the
   * delivery numbers cannot drift from the database they describe.
   */
  app.get('/api/metrics', async (req, reply) => {
    const wantsJson = String((req.headers.accept ?? '')).includes('application/json');
    const taskRows = await db().all<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status');
    for (const row of taskRows) setGauge(`relay_tasks_${row.status}`, Number(row.c), `Tasks in status ${row.status}`);

    const overdue = await db().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sla_timers WHERE outcome = 'running' AND due_at < ?",
      [new Date().toISOString().slice(0, 19).replace('T', ' ')],
    );
    setGauge('relay_clocks_overdue', Number(overdue?.c ?? 0), 'Running clocks past their deadline');

    const missed = await db().all<{ clock_key: string; c: number }>(
      "SELECT clock_key, COUNT(*) AS c FROM sla_timers WHERE outcome = 'missed' GROUP BY clock_key",
    );
    for (const row of missed) setGauge(`relay_clock_missed_${row.clock_key.replace(/-/g, '_')}`, Number(row.c), 'Missed clocks by key');

    setGauge('relay_worker_sweeps_total', sweeperStats().sweeps, 'Clock sweeper runs');
    setGauge('relay_worker_failures_total', sweeperStats().failures, 'Clock sweeper failures');
    setGauge('relay_process_uptime_seconds', Math.round(process.uptime()), 'Process uptime');
    setGauge('relay_process_resident_memory_bytes', process.memoryUsage().rss, 'Resident set size');

    const body = renderMetrics();
    reply.header('content-type', wantsJson ? 'application/json' : 'text/plain; version=0.0.4; charset=utf-8');
    return wantsJson ? { data: { text: body } } : body;
  });

  /* -------------------------------------------------------------- meta --- */
  app.get('/api/meta', async () => {
    const users = (await db().all('SELECT * FROM users WHERE is_active = 1 ORDER BY full_name')).map(mapUser);
    const labels = await db().all('SELECT id,name,color,description FROM labels ORDER BY name');
    const clients = (await db().all('SELECT * FROM clients ORDER BY name')).map(mapClient);
    const projects = (await db().all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color
       FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.status != 'archived' ORDER BY p.name`,
    )).map(mapProject);
    const boards = await db().all<Record<string, any>>(
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

  app.get('/api/users', async () => ok((await db().all('SELECT * FROM users ORDER BY full_name')).map(mapUser)));

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
    if (assignee === 'me') { where.push('t.assignee_id = ?'); params.push(await actor(req as never)); }
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
    if (queryStr(req, 'mine') === 'true') { where.push('t.assignee_id = ?'); params.push(await actor(req as never)); }

    const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.position ASC, t.created_at DESC LIMIT ? OFFSET ?`;
    const rows = await db().all<Record<string, any>>(sql, [...params, limit, offset]);
    const total = (await db().get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params))?.c ?? 0;

    const tasks: any[] = [];
    for (const r of rows) {
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
      const labelRows = await db().all<{ id: string; name: string; color: string }>(
        'SELECT l.id,l.name,l.color FROM task_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.task_id=?', [mapped.id],
      );
      tasks.push({ ...mapped, labels: labelRows, sla: sla.state, slaHoursLeft: sla.hoursLeft, risk: { score: risk.score, band: risk.band, factors: risk.factors } });
    }

    return page(tasks, { total, limit, offset });
  });

  app.get('/api/tasks/:id', async (req) => {
    const { id: taskId } = req.params as { id: string };
    // Authorise against the task's own project before returning anything. A
    // denial and a missing task are deliberately indistinguishable.
    const owner = await db().get<{ project_id: string; client_visible: number }>(
      'SELECT project_id, client_visible FROM tasks WHERE id = ?', [taskId],
    );
    if (!owner) throw notFound('Task not found');
    const scope = await resolveReadScope(db(), await currentIdentity(req));
    await assertProjectInScope(scope, owner.project_id);
    if (scope.externalOnly && !owner.client_visible) throw notFound('Task not found');
    return ok(await taskDetail(db(), taskId));
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
    const taskId = await createTask(db(), parsed.data as Record<string, any>, await actor(req as never));
    reply.code(201);
    return ok(await taskDetail(db(), taskId));
  });

  app.patch('/api/tasks/:id', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const row = await db().get<{ id: string }>('SELECT id FROM tasks WHERE id = ? OR key = ?', [taskId, taskId]);
    if (!row) throw notFound('Task not found');
    await updateTask(db(), row.id, req.body as Record<string, any>, await actor(req as never));
    return ok(await taskDetail(db(), row.id));
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const actorId = await requireRole(req, ['admin', 'lead']);
    const { id: taskId } = req.params as { id: string };
    await db().run("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?", [nowIso(), taskId]);
    await db().run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id) VALUES (?,?,?,?)', [actorId, 'task.cancelled', 'task', taskId]);
    reply.code(204);
    return null;
  });

  app.post('/api/tasks/:id/comments', async (req, reply) => {
    const { id: taskId } = req.params as { id: string };
    const body = (req.body as { body?: string })?.body?.trim();
    if (!body) throw badRequest('Comment body is required');
    const commentId = id('cmt');
    await db().run('INSERT INTO task_comments (id,task_id,author_id,body) VALUES (?,?,?,?)', [commentId, taskId, await actor(req as never), body]);
    await db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      'task', taskId, await actor(req as never), 'commented', body.slice(0, 120),
    ]);
    reply.code(201);
    return ok({ id: commentId });
  });

  app.post('/api/tasks/:id/checklist', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const { label } = req.body as { label: string };
    const itemId = id('chk');
    const pos = ((await db().get<{ m: number | null }>('SELECT MAX(position) AS m FROM task_checklist WHERE task_id = ?', [taskId]))?.m ?? 0) + 1;
    await db().run('INSERT INTO task_checklist (id,task_id,label,done,position) VALUES (?,?,?,0,?)', [itemId, taskId, label, pos]);
    return ok({ id: itemId });
  });

  app.patch('/api/tasks/:id/checklist/:itemId', async (req) => {
    const { itemId } = req.params as { id: string; itemId: string };
    const { done } = req.body as { done: boolean };
    await db().run('UPDATE task_checklist SET done = ? WHERE id = ?', [done ? 1 : 0, itemId]);
    return ok({ id: itemId, done });
  });

  /* ------------------------------- turnover gates + acceptance ladder ----- */
  app.patch('/api/tasks/:id/turnover/:gateId', async (req) => {
    const { id: taskId, gateId } = req.params as { id: string; gateId: string };
    const actorId = await actor(req as never);
    const { status, evidence } = req.body as { status: 'pending' | 'pass' | 'fail' | 'waived'; evidence?: string };
    if (!['pending', 'pass', 'fail', 'waived'].includes(status)) throw badRequest('Invalid check status');
    if (status === 'pass' && !evidence?.trim()) {
      throw badRequest('Passing a turnover gate requires written evidence — that is the whole point of the gate.');
    }
    if (status === 'waived') await requireRole(req, ['admin', 'lead']);

    await ensureTaskChecks(db(), taskId);
    await db().run(
      `UPDATE turnover_checks SET status = ?, evidence = ?, checked_by = ?, checked_at = ?
       WHERE task_id = ? AND gate_id = ?`,
      [status, evidence ?? '', status === 'pending' ? null : actorId, status === 'pending' ? null : nowIso(), taskId, gateId],
    );
    const remaining = (await db().get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM turnover_checks c JOIN turnover_gates g ON g.id = c.gate_id
       WHERE c.task_id = ? AND g.required = 1 AND c.status NOT IN ('pass','waived')`, [taskId],
    ))?.c ?? 0;
    const task = await db().get<{ turnover_state: string }>('SELECT turnover_state FROM tasks WHERE id = ?', [taskId]);
    const nextState = status === 'fail' ? 'failed' : remaining === 0 ? 'passed' : 'in_review';
    await db().run('UPDATE tasks SET turnover_state = ?, updated_at = ? WHERE id = ?', [nextState, nowIso(), taskId]);
    await db().run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'turnover.check', 'task', taskId, JSON.stringify({ gateId, status, remaining }),
    ]);
    return ok(await taskDetail(db(), taskId));
  });

  app.post('/api/tasks/:id/acceptance', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const { step, state, evidence, notes } = req.body as { step: string; state: 'passed' | 'rejected' | 'skipped'; evidence?: string; notes?: string };
    if (!ACCEPTANCE_LADDER.includes(step as never)) throw badRequest(`step must be one of ${ACCEPTANCE_LADDER.join(', ')}`);
    if (step === 'client_accepted') await requireRole(req, ['admin', 'lead']);
    const records = await recordAcceptance(db(), taskId, step as never, state, await actor(req as never), evidence, notes);
    return ok({ acceptance: records, task: await taskDetail(db(), taskId) });
  });

  /* ----------------------------------------------------------- planning --- */
  app.get('/api/planner', async (req) => {
    const horizonDays = queryInt(req, 'horizon', 21);
    const tasks = await db().all<Record<string, any>>(
      `SELECT t.*, a.capacity_hours_week FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.status NOT IN ('cancelled')`,
    );
    const deps = await db().all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies');
    const depMap = new Map<string, string[]>();
    for (const d of deps) depMap.set(d.task_id, [...(depMap.get(d.task_id) ?? []), d.depends_on_id]);

    const people = (await db().all<Record<string, any>>("SELECT * FROM users WHERE role != 'bot' AND is_active = 1")).map((u) => ({
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

    const projectRows = await db().all<{ id: string; key: string; name: string }>('SELECT id,key,name FROM projects');
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
    const actorId = await actor(req as never);
    const horizonDays = Number((req.body as { horizonDays?: number })?.horizonDays ?? 21);
    const runId = id('run');
    await db().run('INSERT INTO schedule_runs (id,created_by,algorithm,horizon_days) VALUES (?,?,?,?)', [runId, actorId, 'cpm+wspt', horizonDays]);
    return ok({ id: runId, horizonDays, createdAt: nowIso(), note: 'Plan persisted for audit; recompute via GET /api/planner.' });
  });

  /* ------------------------------------------------------------- clocks --- */
  app.get('/api/clocks', async () => ok({ clocks: await clockHealth(db()), timers: await liveTimers(db(), 40) }));

  app.post('/api/clocks/sweep', async () => {
    const swept = await sweepTimers(db());
    return ok({ swept, at: nowIso() });
  });

  app.post('/api/clocks/timers/:id/resolve', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const { outcome, note } = req.body as { outcome: 'met' | 'missed' | 'paused' | 'waived'; note?: string };
    if (outcome === 'waived') await requireRole(req, ['admin', 'lead']);
    // A waiver without a written exception is just a deleted violation.
    if (outcome === 'waived' && !note?.trim()) {
      throw badRequest('A waiver requires a written exception note — an unexplained waiver erases the breach.');
    }
    const resolved = await resolveTimer(db(), timerId, outcome, note);
    await db().run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      await actor(req as never), 'clock.resolve', 'timer', timerId, JSON.stringify({ outcome, note: note ?? '' }),
    ]);
    return ok(resolved);
  });

  /**
   * Acknowledge a missed clock. The miss is not erased — the timer keeps its
   * `missed` outcome and the acknowledgement sits beside it, naming the person
   * who owns the miss and why. This is what turns an alert into accountability.
   */
  app.post('/api/clocks/timers/:id/acknowledge', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    const body = req.body as { reason?: string; escalatedTo?: string };
    if (!body.reason?.trim() || body.reason.trim().length < 12) {
      throw badRequest('An acknowledgement needs a substantive reason (at least 12 characters).');
    }
    const timer = await db().get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
    if (!timer) throw notFound('Timer not found');
    if (timer.outcome !== 'missed') {
      throw badRequest(`Only a missed clock can be acknowledged (this timer is ${timer.outcome}).`);
    }
    const existing = await db().get<{ id: string }>('SELECT id FROM clock_acknowledgements WHERE timer_id = ?', [timerId]);
    if (existing) throw badRequest('This clock miss has already been acknowledged.');
    await db().run(
      'INSERT INTO clock_acknowledgements (id, timer_id, acknowledged_by, reason, escalated_to) VALUES (?,?,?,?,?)',
      [id('ack'), timerId, identity.userId, body.reason.trim(), body.escalatedTo ?? null],
    );
    await db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      timer.entity_type, timer.entity_id, identity.userId, 'clock_acknowledged', `acknowledged miss on ${timer.clock_key}`,
    ]);
    return ok(await db().get('SELECT * FROM clock_acknowledgements WHERE timer_id = ?', [timerId]));
  });

  /* ------------------------------------------------------------ projects -- */
  app.get('/api/projects', async (req) => {
    const identity = await currentIdentity(req);
    const rows = await db().all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_count,
              (SELECT COALESCE(SUM(logged_hours),0) FROM tasks t WHERE t.project_id = p.id) AS logged_hours
       FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.status != 'archived' ORDER BY p.name`,
    );
    return ok(rows.map(mapProject));
  });

  app.get('/api/projects/:id', async (req) => {
    const { id: projectId } = req.params as { id: string };
    // Access is checked before the row is read, so a denial cannot be
    // distinguished from a non-existent project (no enumeration oracle).
    await requireProjectAccess(db(), await currentIdentity(req), projectId, 'read');
    const project = await db().get<Record<string, any>>(
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

    const phases = await db().all<Record<string, any>>(
      `SELECT pp.*, ph.name, ph.key AS phase_key, ph.color, ph.description, ph.sla_days, ph.turnover_policy,
              u.full_name AS signoff_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_phase_id = pp.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_phase_id = pp.id AND t.status='done') AS done_count
       FROM project_phases pp JOIN phases ph ON ph.id = pp.phase_id
       LEFT JOIN users u ON u.id = pp.signoff_by
       WHERE pp.project_id = ? ORDER BY pp.position`, [project.id],
    );
    const phaseGates = await db().all<Record<string, any>>('SELECT * FROM turnover_gates WHERE scope = ?', ['phase']);
    const phaseChecks = await db().all<Record<string, any>>('SELECT * FROM turnover_checks WHERE project_phase_id IS NOT NULL');
    const checkByPhase = new Map<string, Record<string, any>[]>();
    for (const c of phaseChecks) {
      const list = checkByPhase.get(c.project_phase_id) ?? [];
      list.push(c);
      checkByPhase.set(c.project_phase_id, list);
    }

    const edgeStats = await db().all<Record<string, any>>(
      'SELECT status, COUNT(*) AS c FROM edge_cases WHERE project_id = ? GROUP BY status', [project.id]);
    const edgeByCategory = await db().all<Record<string, any>>(
      'SELECT category, COUNT(*) AS c FROM edge_cases WHERE project_id = ? GROUP BY category ORDER BY c DESC', [project.id]);
    const releases = await db().all<Record<string, any>>('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
    const handoffs = await db().all<Record<string, any>>('SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
    const qa = await db().all<Record<string, any>>(
      `SELECT q.*, u.full_name AS reporter FROM qa_reports q LEFT JOIN users u ON u.id = q.reporter_id
       WHERE q.project_id = ? ORDER BY q.created_at DESC LIMIT 20`, [project.id]);
    const docs = await db().all('SELECT id,title,kind,status,updated_at,client_visible FROM docs WHERE project_id = ? ORDER BY updated_at DESC', [project.id]);
    const timers = (await liveTimers(db(), 200)).filter((t) => t.entityId === project.id || t.entityId === project.key);
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
        clientAccepted: ((await db().get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM tasks t JOIN acceptance_records a ON a.task_id = t.id
           WHERE t.project_id = ? AND a.step='client_accepted' AND a.state='passed'`, [project.id]))?.c ?? 0) > 0,
      },
    });
  });

  app.patch('/api/projects/:id/phases/:phaseRowId', async (req) => {
    const identity = await currentIdentity(req);
    await requireProjectAccess(db(), identity, (req.params as { id: string }).id, 'write');
    const { id: projectId, phaseRowId } = req.params as { id: string; phaseRowId: string };
    const actorId = await actor(req as never);
    const body = req.body as { status?: string; progress?: number; turnoverPassed?: boolean };
    const rows = await db().get<Record<string, any>>('SELECT * FROM project_phases WHERE id = ? AND project_id = ?', [phaseRowId, projectId]);
    if (!rows) throw notFound('Phase not found');
    if (body.status) {
      await db().run('UPDATE project_phases SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?', [
        body.status, body.status === 'active' ? nowIso() : null, phaseRowId,
      ]);
      // Phase lifecycle drives three clocks. Starting a phase starts the
      // milestone clock; moving it into client review starts the client-turnover
      // clock (14d ceiling / 7d target); closing it stops both as met. A late
      // sweep may already have marked them missed — that verdict stands.
      if (body.status === 'active') {
        await startTimer(db(), 'milestone-turnover', 'phase', rows.phase_id, `Phase turnover: ${rows.phase_id}`);
      }
      if (body.status === 'blocked') {
        await startTimer(db(), 'client-turnover', 'phase', rows.phase_id, `Client review: ${rows.phase_id}`);
      }
      if (body.status === 'done') {
        await closeTimersFor(db(), 'phase', rows.phase_id, 'met');
      }
    }
    if (body.progress !== undefined) await db().run('UPDATE project_phases SET progress = ? WHERE id = ?', [body.progress, phaseRowId]);
    if (body.turnoverPassed !== undefined) {
      await db().run('UPDATE project_phases SET turnover_passed = ?, signoff_by = ?, signoff_at = ? WHERE id = ?', [
        body.turnoverPassed ? 1 : 0, body.turnoverPassed ? actorId : null, body.turnoverPassed ? nowIso() : null, phaseRowId,
      ]);
    }
    await db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      'phase', phaseRowId, actorId, 'updated', `phase ${phaseRowId} → ${body.status ?? 'updated'}`,
    ]);
    return ok({ ok: true });
  });

  /* ------------------------------------------------------------ pipeline -- */
  app.get('/api/pipeline', async () => {
    const stages = await db().all<Record<string, any>>('SELECT * FROM pipeline_stages ORDER BY position');
    const deals = await db().all<Record<string, any>>(
      `SELECT d.*, c.name AS client_name, c.accent_color AS client_color, s.key AS stage_key, s.name AS stage_name,
              s.phase AS stage_phase, s.color AS stage_color, s.default_sla_days, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color
       FROM deals d JOIN clients c ON c.id = d.client_id JOIN pipeline_stages s ON s.id = d.stage_id
       LEFT JOIN users u ON u.id = d.owner_id ORDER BY d.value_cents DESC`,
    );
    const dealsMapped = deals.map(mapDeal);

    const phaseRuns = await db().all<Record<string, any>>(
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
    const actorId = await actor(req as never);
    const body = req.body as { stageId?: string; stageKey?: string; status?: string; nextStep?: string; probability?: number; ownerId?: string };
    const deal = await db().get<Record<string, any>>('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) throw notFound('Deal not found');
    if (body.stageId || body.stageKey) {
      const stage = body.stageId
        ? await db().get<Record<string, any>>('SELECT * FROM pipeline_stages WHERE id = ?', [body.stageId])
        : await db().get<Record<string, any>>('SELECT * FROM pipeline_stages WHERE key = ?', [body.stageKey!]);
      if (!stage) throw badRequest('Unknown stage');
      await db().run('UPDATE deals SET stage_id = ?, probability = ?, updated_at = ? WHERE id = ?', [
        stage.id, body.probability ?? Math.min(100, Math.round(stage.position / 1.2)), nowIso(), dealId,
      ]);
      await db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
        'deal', dealId, actorId, 'stage_changed', `${deal.title} → ${stage.name}`,
      ]);
      // Every deal-stage transition that has a clock policy starts it. The map
      // is data, not a chain of ifs, so a stage added later cannot silently
      // leave its clock unwired.
      const STAGE_CLOCKS: Record<string, string> = {
        inbound: 'lead-triage',
        tech_consult: 'consult-to-plan',
        proposal: 'plan-revision',
      };
      const clockKey = STAGE_CLOCKS[stage.key];
      if (clockKey) await startTimer(db(), clockKey, 'deal', dealId, `${deal.title} — ${stage.name}`);
    }
    if (body.status) {
      await db().run('UPDATE deals SET status = ?, won_at = ?, lost_at = ?, updated_at = ? WHERE id = ?', [
        body.status, body.status === 'won' ? nowIso() : deal.won_at, body.status === 'lost' ? nowIso() : deal.lost_at, nowIso(), dealId,
      ]);
    }
    if (body.nextStep !== undefined) await db().run('UPDATE deals SET next_step = ? WHERE id = ?', [body.nextStep, dealId]);
    if (body.probability !== undefined) await db().run('UPDATE deals SET probability = ? WHERE id = ?', [body.probability, dealId]);
    if (body.ownerId !== undefined) await db().run('UPDATE deals SET owner_id = ? WHERE id = ?', [body.ownerId, dealId]);
    return ok(await db().get('SELECT * FROM deals WHERE id = ?', [dealId]));
  });

  app.post('/api/deals', async (req, reply) => {
    const body = req.body as Record<string, any>;
    if (!body.clientId || !body.title) throw badRequest('clientId and title are required');
    const dealId = id('dl');
    const stage = await db().get<{ id: string }>('SELECT id FROM pipeline_stages WHERE key = ?', [body.stageKey ?? 'inbound']);
    if (!stage) throw badRequest('Unknown stage');
    await db().run(
      `INSERT INTO deals (id,client_id,title,value_cents,status,stage_id,owner_id,probability,next_step)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealId, body.clientId, body.title, body.valueCents ?? 0, 'open', stage.id, body.ownerId ?? await actor(req as never), body.probability ?? 20, body.nextStep ?? ''],
    );
    reply.code(201);
    return ok({ id: dealId });
  });

  /* ------------------------------------------------------------- clients -- */
  app.get('/api/clients', async () => {
    const clients = (await db().all<Record<string, any>>('SELECT * FROM clients ORDER BY name')).map(mapClient);
    const deals = await db().all<Record<string, any>>('SELECT client_id, value_cents, status FROM deals');
    const projects = await db().all<Record<string, any>>('SELECT client_id, status FROM projects');
    return ok(clients.map((c) => ({
      ...c,
      openValueCents: deals.filter((d) => d.client_id === c.id && d.status === 'open').reduce((a, d) => a + d.value_cents, 0),
      wonValueCents: deals.filter((d) => d.client_id === c.id && d.status === 'won').reduce((a, d) => a + d.value_cents, 0),
      projectCount: projects.filter((p) => p.client_id === c.id && p.status !== 'archived').length,
    })));
  });

  app.get('/api/partners', async () => {
    const partners = await db().all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color FROM partners p JOIN clients c ON c.id = p.client_id ORDER BY p.name`,
    );
    const iam = await db().all<Record<string, any>>('SELECT partner_id, role, mfa_enabled, status FROM partner_iam_users');
    const devices = await db().all<Record<string, any>>('SELECT partner_id, status FROM device_licenses');
    const usage = await db().all<Record<string, any>>('SELECT partner_id, day, api_calls, active_users, storage_mb, uptime_pct FROM usage_metrics ORDER BY day');
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
    const rows = await db().all<Record<string, any>>(
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
    const actorId = await actor(req as never);
    const b = req.body as Record<string, any>;
    if (!b.projectId || !b.title) throw badRequest('projectId and title are required');
    const reportId = id('qa');
    const due = new Date(Date.now() + 12 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    await db().run(
      `INSERT INTO qa_reports (id,project_id,kind,severity,title,body,status,reproduction,evidence_url,reporter_id,assignee_id,due_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [reportId, b.projectId, b.kind ?? 'bug', b.severity ?? 'p2', b.title, b.body ?? '', 'open',
        b.reproduction ?? '', b.evidenceUrl ?? '', actorId, b.assigneeId ?? null, due],
    );
    await startTimer(db(), 'qa-report', 'qa', reportId, `QA report: ${b.title}`);
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
      await closeTimersFor(db(), 'qa', reportId, 'met');
    }
    if (!sets.length) throw badRequest('Nothing to update');
    await db().run(`UPDATE qa_reports SET ${sets.join(', ')} WHERE id = ?`, [...params, reportId]);
    return ok(await db().get('SELECT * FROM qa_reports WHERE id = ?', [reportId]));
  });

  /* ------------------------------------------------------------ releases -- */
  /**
   * Ship readiness is computed, never asserted. This endpoint is the same code
   * path that guards the ship transition, so the UI cannot show a green gate
   * that the server would refuse.
   */
  app.get('/api/releases/:id/gate', async (req) => {
    const { id: releaseId } = req.params as { id: string };
    const release = await db().get<Record<string, any>>('SELECT * FROM releases WHERE id = ?', [releaseId]);
    if (!release) throw notFound('Release not found');
    await requireProjectAccess(db(), await currentIdentity(req), release.project_id, 'read');
    return ok(await evaluateShipGate(db(), releaseId));
  });

  /**
   * Release lifecycle. Only forward transitions are allowed, demo approval and
   * shipping require a lead, and `shipped` is unreachable while any requirement
   * is outstanding — the refusal names every outstanding check.
   */
  app.patch('/api/releases/:id', async (req) => {
    const { id: releaseId } = req.params as { id: string };
    const actorId = await actor(req as never);
    const body = req.body as {
      status?: string; demoAt?: string; execSummaryUrl?: string; execSummaryAt?: string;
      shipPlannedAt?: string; rollbackPlan?: string;
    };
    const release = await db().get<Record<string, any>>('SELECT * FROM releases WHERE id = ?', [releaseId]);
    if (!release) throw notFound('Release not found');
    await requireProjectAccess(db(), await currentIdentity(req), release.project_id, 'write');

    if (body.execSummaryUrl !== undefined) {
      await db().run('UPDATE releases SET exec_summary_url = ? WHERE id = ?', [body.execSummaryUrl, releaseId]);
      // Prepared-at is what the 48h rule compares. It is recorded explicitly so
      // a link added minutes before the ship window cannot claim a 2-day lead.
      if (body.execSummaryAt !== undefined) {
        await db().run('UPDATE releases SET exec_summary_at = ? WHERE id = ?', [body.execSummaryAt, releaseId]);
      }
    }
    if (body.demoAt !== undefined) await db().run('UPDATE releases SET demo_at = ? WHERE id = ?', [body.demoAt, releaseId]);
    if (body.shipPlannedAt !== undefined) await db().run('UPDATE releases SET ship_planned_at = ? WHERE id = ?', [body.shipPlannedAt, releaseId]);
    if (body.rollbackPlan !== undefined) await db().run('UPDATE releases SET rollback_plan = ? WHERE id = ?', [body.rollbackPlan, releaseId]);

    if (body.status) {
      const ORDER = ['planning', 'in_qa', 'demo_ready', 'demo_done', 'approved', 'shipped', 'rolled_back'];
      const current = ORDER.indexOf(release.status);
      const next = ORDER.indexOf(body.status);
      if (next < 0) throw badRequest(`Unknown release status: ${body.status}`);
      if (body.status !== 'rolled_back' && next <= current) {
        throw badRequest(`Release ${release.version} is already ${release.status}; the lifecycle only moves forward.`);
      }
      if (body.status === 'demo_done' || body.status === 'approved' || body.status === 'shipped') {
        await requireRole(req, ['admin', 'lead']);
      }
      if (body.status === 'demo_done' && !release.demo_at) {
        throw badRequest('A demo must be scheduled before it can be marked as done.');
      }
      if (body.status === 'shipped') {
        const result = await markShipped(db(), releaseId, actorId);
        await db().run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
          actorId, 'release.ship', 'release', releaseId,
          JSON.stringify({ version: release.version, gate: result.gate.checks.map((c) => [c.key, c.passed]) }),
        ]);
        return ok({ release: result.release, gate: result.gate });
      }
      if (body.status === 'demo_done') {
        await db().run("UPDATE releases SET status = 'demo_done', demo_approved_at = COALESCE(demo_approved_at, ?) WHERE id = ?", [nowIso(), releaseId]);
        // Approval locks the 5-day ship clock: the promise is measured from here.
        await startTimer(db(), 'ship-after-approval', 'release', releaseId, `Ship ${release.version}`);
        await startTimer(db(), 'exec-summary', 'release', releaseId, `Exec summary ${release.version}`);
      } else {
        await db().run('UPDATE releases SET status = ? WHERE id = ?', [body.status, releaseId]);
        if (body.status === 'demo_ready') {
          await startTimer(db(), 'exec-summary', 'release', releaseId, `Exec summary ${release.version}`);
        }
      }
      await db().run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
        'release', releaseId, actorId, 'status_changed', `${release.version} → ${body.status}`,
      ]);
    }
    return ok(await db().get('SELECT * FROM releases WHERE id = ?', [releaseId]));
  });

  /**
   * Post-ship acknowledgements. A ship cannot claim success without a
   * deployment acknowledgement and a post-ship verification — both recorded
   * here with a source and a timestamp, never inferred.
   */
  app.post('/api/releases/:id/acknowledgements', async (req) => {
    const { id: releaseId } = req.params as { id: string };
    const actorId = await actor(req as never);
    const body = req.body as { signal?: string; state?: string; source?: string; detail?: string };
    const valid = ['device_ack', 'deployment_ack', 'post_ship_verification'];
    if (!body.signal || !valid.includes(body.signal)) throw badRequest(`signal must be one of ${valid.join(', ')}`);
    if (!body.state || !['pending', 'received', 'failed', 'waived'].includes(body.state)) throw badRequest('Invalid acknowledgement state');
    if (body.state === 'received' && !body.source?.trim()) {
      throw badRequest('A received acknowledgement needs a source (pipeline URL, device id or verification report).');
    }
    const release = await db().get<Record<string, any>>('SELECT * FROM releases WHERE id = ?', [releaseId]);
    if (!release) throw notFound('Release not found');
    await requireProjectAccess(db(), await currentIdentity(req), release.project_id, 'write');
    const existing = await db().get<{ id: string }>('SELECT id FROM ship_acknowledgements WHERE release_id = ? AND signal = ?', [releaseId, body.signal]);
    const receivedAt = body.state === 'received' ? nowIso() : null;
    if (existing) {
      await db().run('UPDATE ship_acknowledgements SET state = ?, source = ?, detail = ?, received_at = ?, recorded_by = ? WHERE id = ?', [
        body.state, body.source ?? '', body.detail ?? '', receivedAt, actorId, existing.id,
      ]);
    } else {
      await db().run(
        `INSERT INTO ship_acknowledgements (id, release_id, signal, state, source, detail, received_at, recorded_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id('ack'), releaseId, body.signal, body.state, body.source ?? '', body.detail ?? '', receivedAt, actorId],
      );
    }
    await db().run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'release.acknowledgement', 'release', releaseId, JSON.stringify({ signal: body.signal, state: body.state, source: body.source ?? '' }),
    ]);
    const acks = await db().all('SELECT * FROM ship_acknowledgements WHERE release_id = ? ORDER BY signal', [releaseId]);
    return ok({ releaseId, acknowledgements: acks });
  });

  app.get('/api/releases', async () => {
    const rows = await db().all<Record<string, any>>(
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
    const actorId = await actor(req as never);
    const now = Date.now();
    const tasks = await db().all<Record<string, any>>(
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

    const clients = await db().all<Record<string, any>>('SELECT * FROM clients');
    const projects = (await db().all<Record<string, any>>(
      `SELECT p.id,p.key,p.name,p.status,p.health,c.name AS client_name,c.accent_color,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) AS total,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='done') AS done
       FROM projects p JOIN clients c ON c.id=p.client_id WHERE p.status!='archived'`,
    ));
    const deals = await db().all<Record<string, any>>(
      `SELECT d.*, s.name AS stage_name, s.phase FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.status='open'`,
    );
    const workload = await db().all<Record<string, any>>(
      `SELECT u.id,u.full_name,u.initials,u.avatar_color,u.capacity_hours_week,
              COALESCE(SUM(CASE WHEN t.status NOT IN ('done','cancelled') THEN t.estimate_hours - CASE WHEN t.logged_hours < t.estimate_hours*0.8 THEN t.logged_hours ELSE t.estimate_hours*0.8 END ELSE 0 END),0) AS open_hours,
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
        billableHoursWeek: Math.round(((await db().get<{ m: number }>(
          'SELECT COALESCE(SUM(minutes),0) AS m FROM time_entries WHERE worked_on >= ?', [new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)]))?.m ?? 0) / 60),
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
      clocks: await clockHealth(db()),
      timers: await liveTimers(db(), 12),
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
    const rows = await db().all<Record<string, any>>(
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
    const rows = await db().all<Record<string, any>>(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [await actor(req as never)],
    );
    return ok(rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, readAt: n.read_at, createdAt: n.created_at })));
  });

  app.post('/api/notifications/:id/read', async (req) => {
    const { id: notifId } = req.params as { id: string };
    await db().run('UPDATE notifications SET read_at = ? WHERE id = ?', [nowIso(), notifId]);
    return ok({ id: notifId });
  });

  /* -------------------------------------------------------- intelligence -- */
  app.get('/api/insights', async () => {
    const tasks = await db().all<Record<string, any>>(`${TASK_SELECT} WHERE t.status NOT IN ('cancelled','done')`);
    const now = Date.now();
    const insights: Array<Record<string, unknown>> = [];

    // 1. Critical path / dependency bottlenecks.
    const deps = await db().all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies');
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
    const reviewers = await db().all<Record<string, any>>(
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
    const failedGates = await db().all<Record<string, any>>(
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
    await requireRole(req, ['admin', 'lead']);
    const limit = Math.min(queryInt(req, 'limit', 50), 200);
    const rows = await db().all<Record<string, any>>(
      `SELECT a.*, u.full_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.id DESC LIMIT ?`, [limit],
    );
    return ok(rows);
  });

  /* ------------------------------------------------------------- search --- */
  /**
   * Permission-scoped search.
   *
   * Every entity is filtered by the resolved read scope *inside the query*, so
   * an unauthorised row is never loaded, never counted and never paginated
   * over. The shapes below are derived from the scope predicates, which are
   * also what `requireProjectAccess` and the list endpoints use — search cannot
   * drift from them without breaking those tests too.
   *
   * What a leak would look like, and why it cannot happen here:
   *  - a result set: the predicate is in the WHERE clause
   *  - a total or facet: the same predicate produces the count
   *  - a suggestion: same query, fewer columns
   *  - an empty query: returns nothing rather than everything
   *  - archived/hidden rows: excluded by `hidden_at`/`deleted_at`
   */
  app.get('/api/search', async (req) => {
    const q = (queryStr(req, 'q') ?? '').trim();
    const scope = await resolveReadScope(db(), await currentIdentity(req));
    const empty = { tasks: [], projects: [], clients: [], deals: [], docs: [], comments: [], meetings: [], counts: {} };
    if (q.length < 2) return ok(empty);
    const like = `%${q}%`;

    const tw = tasksWhere(scope, 't');
    const pw = projectsWhere(scope, 'p');
    const dw = docsWhere(scope, 'd');
    const cw = clientsWhere(scope, 'c');
    const dlw = dealsWhere(scope, 'd');

    const tasks = await db().all<Record<string, any>>(
      `${TASK_SELECT} WHERE (${tw.sql}) AND t.hidden_at IS NULL AND (t.title LIKE ? OR t.key LIKE ?)
       ORDER BY t.updated_at DESC LIMIT 8`,
      [...tw.params, like, like],
    );
    const projects = await db().all<Record<string, any>>(
      `SELECT p.id, p.key, p.name FROM projects p
        WHERE (${pw.sql}) AND p.hidden_at IS NULL AND (p.name LIKE ? OR p.key LIKE ?)
        ORDER BY p.name LIMIT 5`,
      [...pw.params, like, like],
    );
    const clients = await db().all<Record<string, any>>(
      `SELECT c.id, c.name, c.initials, c.accent_color FROM clients c
        WHERE (${cw.sql}) AND c.name LIKE ? ORDER BY c.name LIMIT 5`,
      [...cw.params, like],
    );
    const deals = await db().all<Record<string, any>>(
      `SELECT d.id, d.title, d.value_cents FROM deals d
        WHERE (${dlw.sql}) AND d.title LIKE ? ORDER BY d.value_cents DESC LIMIT 5`,
      [...dlw.params, like],
    );
    const docs = await db().all<Record<string, any>>(
      `SELECT d.id, d.title, d.kind FROM docs d
        WHERE (${dw.sql}) AND d.status != 'archived' AND d.title LIKE ?
        ORDER BY d.updated_at DESC LIMIT 5`,
      [...dw.params, like],
    );

    // Comments inherit their task's authorisation: a comment is exactly as
    // visible as the work it is attached to.
    const comments = await db().all<Record<string, any>>(
      `SELECT k.id, k.body, k.task_id, k.created_at, t.key AS task_key, t.title AS task_title
         FROM task_comments k JOIN tasks t ON t.id = k.task_id
        WHERE (${tw.sql}) AND t.hidden_at IS NULL AND k.deleted_at IS NULL AND k.body LIKE ?
        ORDER BY k.created_at DESC LIMIT 5`,
      [...tw.params, like],
    );

    // Meeting notes are external-visible only when the note is marked shared.
    const meetings = await db().all<Record<string, any>>(
      `SELECT m.id, m.title, m.occurred_at, m.project_id FROM meeting_notes m
        WHERE ${scope.unrestricted
          ? '1 = 1'
          : scope.externalOnly
            ? `m.client_visible = 1 AND m.project_id IN (${scope.projectIds.length ? scope.projectIds.map(() => '?').join(',') : 'NULL'})`
            : scope.projectIds.length
              ? `m.project_id IN (${scope.projectIds.map(() => '?').join(',')})`
              : '1 = 0'}
          AND m.title LIKE ? ORDER BY m.occurred_at DESC LIMIT 5`,
      [...(scope.unrestricted ? [] : scope.externalOnly || scope.projectIds.length ? scope.projectIds : []), like],
    );

    return ok({
      tasks: tasks.map(mapTask),
      projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name })),
      clients,
      deals,
      docs,
      comments: comments.map((c) => ({
        id: c.id, body: c.body.slice(0, 180), taskId: c.task_id, taskKey: c.task_key, taskTitle: c.task_title, createdAt: c.created_at,
      })),
      meetings: meetings.map((m) => ({ id: m.id, title: m.title, occurredAt: m.occurred_at, projectId: m.project_id })),
      counts: {
        tasks: tasks.length, projects: projects.length, clients: clients.length,
        deals: deals.length, docs: docs.length, comments: comments.length, meetings: meetings.length,
      },
    });
  });

  /** Typeahead. Same scope, same predicates, fewer columns, smaller limit. */
  app.get('/api/search/suggest', async (req) => {
    const q = (queryStr(req, 'q') ?? '').trim();
    const scope = await resolveReadScope(db(), await currentIdentity(req));
    if (q.length < 2) return ok({ suggestions: [] });
    const like = `%${q}%`;
    const tw = tasksWhere(scope, 't');
    const pw = projectsWhere(scope, 'p');
    const rows = await db().all<Record<string, any>>(
      `SELECT t.key AS label, 'task' AS kind, t.id AS id FROM tasks t
        WHERE (${tw.sql}) AND t.hidden_at IS NULL AND t.title LIKE ?
        UNION ALL
       SELECT p.name AS label, 'project' AS kind, p.id AS id FROM projects p
        WHERE (${pw.sql}) AND p.hidden_at IS NULL AND p.name LIKE ?
        LIMIT 8`,
      [...tw.params, like, ...pw.params, like],
    );
    return ok({ suggestions: rows });
  });

  /* ---------------------------------------------------- client lifecycle -- */
  /**
   * The 18-stage lifecycle. Reading is scoped like everything else; writing is
   * enforced by the transition service, not by these handlers — the handlers
   * only translate HTTP into a service call so the rules cannot be bypassed by
   * a second caller.
   */
  app.get('/api/clients/:id/lifecycle', async (req) => {
    const { id: clientId } = req.params as { id: string };
    const scope = await resolveReadScope(db(), await currentIdentity(req));
    const client = await db().get<{ id: string }>('SELECT id FROM clients WHERE id = ?', [clientId]);
    if (!client) throw notFound('Client not found');
    const cw = clientsWhere(scope, 'c');
    const visible = await db().get<{ c: number }>(`SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [clientId, ...cw.params]);
    if (!(visible?.c ?? 0)) throw notFound('Client not found');
    return ok(await lifecycleView(db(), clientId));
  });

  app.post('/api/clients/:id/lifecycle/:stageKey/transitions', async (req) => {
    const { id: clientId, stageKey } = req.params as { id: string; stageKey: string };
    const identity = await currentIdentity(req);
    const body = req.body as { to?: string; reason?: string; note?: string; exception?: boolean };
    if (!body.to) throw badRequest('A transition needs a target state');
    // Only staff may drive the lifecycle; a client identity may only ever
    // decide a client-approval stage (the service enforces which).
    if (identity.role === 'client' && body.to !== 'approved') {
      throw forbidden('A client identity may only record an approval decision.');
    }
    const result = await transition(db(), {
      clientId, stageKey, to: body.to,
      actorId: identity.userId, actorRole: identity.role,
      reason: body.reason, note: body.note, exception: body.exception,
    });
    return ok({
      replay: result.replay,
      stage: result.stage.key,
      state: result.instance.state,
      lifecycle: await lifecycleView(db(), clientId),
    });
  });

  app.post('/api/clients/:id/lifecycle/:stageKey/evidence', async (req) => {
    const { id: clientId, stageKey } = req.params as { id: string; stageKey: string };
    const identity = await currentIdentity(req);
    const body = req.body as { kind?: string; label?: string; url?: string; body?: string };
    if (!body.kind || !body.label) throw badRequest('Evidence needs a kind and a label');
    const row = await addEvidence(db(), {
      clientId, stageKey, kind: body.kind, label: body.label,
      url: body.url, body: body.body, actorId: identity.userId,
    });
    return ok({ evidence: row, lifecycle: await lifecycleView(db(), clientId) });
  });

  /** Lifecycle dashboard: every client's position, for the delivery board. */
  app.get('/api/lifecycle', async (req) => {
    const scope = await resolveReadScope(db(), await currentIdentity(req));
    const cw = clientsWhere(scope, 'c');
    const clients = await db().all<Record<string, any>>(
      `SELECT c.id, c.name, c.initials, c.accent_color FROM clients c WHERE (${cw.sql}) ORDER BY c.name`,
      cw.params,
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const c of clients) {
      const view = await lifecycleView(db(), c.id);
      const currentStage = view.stages.find((s) => s.key === view.current);
      rows.push({
        clientId: c.id,
        clientName: c.name,
        initials: c.initials,
        color: c.accent_color,
        progress: view.progress,
        current: currentStage ? { key: currentStage.key, name: currentStage.name, state: currentStage.state, overdue: currentStage.overdue } : null,
        overdueCount: view.stages.filter((s) => s.overdue).length,
        waitingOnClient: view.stages.filter((s) => s.waitingOnClientSince).length,
      });
    }
    return ok({ clients: rows, stages: await getStages(db()) });
  });

  /** Clock history for one timer — every pause, resume and verdict. */
  app.get('/api/clocks/timers/:id/history', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const timer = await db().get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
    if (!timer) throw notFound('Timer not found');
    return ok({ timer, events: await clockHistory(db(), timerId) });
  });

  /** Pause a clock while waiting on a client (authorised, categorised, logged). */
  app.post('/api/clocks/timers/:id/pause', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    const body = req.body as { reason?: string; category?: 'client' | 'internal' | 'vendor' };
    if (!body.reason?.trim()) throw badRequest('A pause needs a reason — it is excluded from the elapsed measurement.');
    const timer = await db().get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
    if (!timer) throw notFound('Timer not found');
    if (timer.outcome !== 'running') throw badRequest(`Only a running clock can be paused (this one is ${timer.outcome}).`);
    const category = body.category ?? 'client';
    const paused = await pauseTimerFor(db(), timer.entity_type, timer.entity_id, body.reason.trim(), {
      category, actorId: identity.userId,
    });
    return ok({ timer: paused, events: await clockHistory(db(), timerId) });
  });

  app.post('/api/clocks/timers/:id/resume', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    const timer = await db().get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
    if (!timer) throw notFound('Timer not found');
    if (!timer.paused_at) throw badRequest('This clock is not paused.');
    const resumed = await resumeTimerFor(db(), timer.entity_type, timer.entity_id, { actorId: identity.userId });
    return ok({ timer: resumed, events: await clockHistory(db(), timerId) });
  });

  /* ----------------------------------------------------------- documents -- */
  app.get('/api/docs', async (req) => {
    const projectId = queryStr(req, 'projectId');
    const scope = await resolveReadScope(db(), await currentIdentity(req));
    if (projectId) await assertProjectInScope(scope, projectId);
    const dw = docsWhere(scope, 'd');
    const rows = projectId
      ? await db().all<Record<string, any>>(
          `SELECT d.*, p.name AS project_name FROM docs d LEFT JOIN projects p ON p.id = d.project_id
            WHERE d.project_id = ? AND (${dw.sql}) ORDER BY d.updated_at DESC`,
          [projectId, ...dw.params],
        )
      : await db().all<Record<string, any>>(
          `SELECT d.*, p.name AS project_name FROM docs d LEFT JOIN projects p ON p.id = d.project_id
            WHERE (${dw.sql}) ORDER BY d.updated_at DESC`,
          dw.params,
        );
    return ok(rows.map((d) => ({
      id: d.id, title: d.title, kind: d.kind, body: d.body, status: d.status,
      projectName: d.project_name, clientVisible: !!d.client_visible, updatedAt: d.updated_at,
    })));
  });
}

