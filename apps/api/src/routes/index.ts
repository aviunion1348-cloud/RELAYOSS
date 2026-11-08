/**
 * HTTP surface. Every route is thin: validate → service → serialise.
 * Grouped by bounded context so the OpenAPI/REST contract stays legible.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, type Db } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, notFound, ok, page, queryInt, queryList, queryStr, forbidden, unauthorized, optionalString, optionalNumber } from '../lib/http.ts';
import { authMode, type Identity } from '../auth/index.ts';
import { requireProjectAccess } from '../auth/middleware.ts';
import {
  resolveReadScope,
  tasksWhere,
  projectsWhere,
  docsWhere,
  clientsWhere,
  dealsWhere,
  assertProjectInScope,
} from '../auth/scope.ts';
import { id, nowIso } from '../lib/ids.ts';
import { toDate } from '../lib/dates.ts';
import { TASK_SELECT, mapTask, mapUser, mapClient, mapProject, mapDeal } from '../repositories/query.ts';
import { SLA_HOURS, scoreRisk, slaState } from '../domain/risk.ts';
import { plan } from '../domain/planner.ts';
import { createTask, updateTask, taskDetail, recordAcceptance, ensureTaskChecks, ACCEPTANCE_LADDER } from '../services/tasks.ts';
import { clockHealth, liveTimers, resolveTimer, startTimer, sweepTimers, closeTimersFor, pauseTimerFor, resumeTimerFor, clockHistory } from '../services/clocks.ts';
import { transition, lifecycleView, addEvidence, getStages } from '../services/lifecycle.ts';
import {
  commsOverview, createThread, threadDetail, addMessage, addFollowUp,
  addMeetingNote, providerStatuses,
} from '../services/communications.ts';
import {
  listDocuments, documentDetail, createDocument, addSignatory, recordSignatoryDecision,
  setDocumentStatus, uploadSignedCopy, createChangeRequest, decideChangeRequest,
  expiringDocuments, esignStatus,
} from '../services/legal.ts';
import {
  entitlementState, registerDevice, activateDevice, revokeDevice, recordApiUsage,
} from '../services/partners.ts';
import { setGauge, renderMetrics, sweeperStats } from '../lib/metrics.ts';
import { evaluateShipGate, markShipped } from '../services/shipgate.ts';

/**
 * The database handle, as a promise.
 *
 * `getDb()` is async because the SQLite driver is loaded on demand. Call sites
 * write `await (await db()).all(...)`: the inner await obtains the handle, the
 * outer one runs the query.
 */
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
  const user = await (await db()).get<{ id: string; email: string; role: Identity['role']; full_name: string }>(
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
    const engine = (await db()).dialect;
    let dbOk = true;
    let version = 0;
    try {
      dbOk = (await db()).ping ? await (await db()).ping!() : true;
      version = (await (await db()).get<{ c: number }>('SELECT COUNT(*) AS c FROM schema_migrations'))?.c ?? 0;
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
      authMode: authMode(),
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
      ready = (await db()).ping ? await (await db()).ping!() : true;
    } catch {
      ready = false;
    }
    if (!ready) return reply.code(503).send({ error: { code: 'unavailable', message: 'Database unreachable' } });
    return ok({ ready: true, engine: (await db()).dialect });
  });

  /**
   * Scheduled work, for Vercel Cron.
   *
   * Why this shape:
   *
   *   - **Authenticated.** Vercel sends `Authorization: Bearer $CRON_SECRET` when
   *     that variable is set. Without a secret configured the endpoint refuses
   *     everything rather than running unauthenticated — an open endpoint that
   *     mutates SLA state would be worse than no endpoint.
   *   - **Idempotent.** The sweep only transitions timers whose deadline has passed
   *     and whose outcome is still `running`, so a retry or an overlapping
   *     invocation finds nothing new. Vercel can and does retry.
   *   - **Not the only path.** Deadline processing also happens lazily on real
   *     requests, because Vercel's Hobby plan allows only one cron run per day.
   *     Correctness therefore does not depend on the schedule.
   *
   * Returns what it did, so a failed run is visible in the cron log rather than
   * being reported as success.
   */
  app.get('/api/cron/sweep', async (req, reply) => {
    const secret = process.env.CRON_SECRET ?? '';
    if (!secret) {
      return reply.code(503).send({
        error: {
          code: 'unavailable',
          message: 'CRON_SECRET is not configured, so scheduled work is disabled. Set it in the deployment environment.',
        },
      });
    }
    const header = String(req.headers.authorization ?? '');
    const supplied = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    // Constant-time comparison: a timing difference on a bearer secret is a
    // practical way to recover it one byte at a time.
    const crypto = await import('node:crypto');
    const a = Buffer.from(supplied.padEnd(64, '\0'));
    const b = Buffer.from(secret.padEnd(64, '\0'));
    const authorised = supplied.length === secret.length && crypto.timingSafeEqual(a, b);
    if (!authorised) {
      req.log.warn({ url: req.url, ip: req.ip }, 'cron_unauthorised');
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Cron secret required' } });
    }

    const started = Date.now();
    const swept = await sweepTimers((await db()));
    const elapsed = Date.now() - started;
    if (swept) req.log.warn({ swept }, 'cron swept overdue clocks');
    return ok({ swept, elapsedMs: elapsed, at: nowIso() });
  });

  /**
   * Prometheus text exposition. Business gauges are computed on scrape so the
   * delivery numbers cannot drift from the database they describe.
   */
  app.get('/api/metrics', async (req, reply) => {
    const wantsJson = String((req.headers.accept ?? '')).includes('application/json');
    const taskRows = await (await db()).all<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status');
    for (const row of taskRows) setGauge(`relay_tasks_${row.status}`, Number(row.c), `Tasks in status ${row.status}`);

    const overdue = await (await db()).get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sla_timers WHERE outcome = 'running' AND due_at < ?",
      [new Date().toISOString().slice(0, 19).replace('T', ' ')],
    );
    setGauge('relay_clocks_overdue', Number(overdue?.c ?? 0), 'Running clocks past their deadline');

    const missed = await (await db()).all<{ clock_key: string; c: number }>(
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
  /**
   * Money fields are not directory data.
   *
   * `GET /api/users` and `/api/meta` both returned the full `mapUser` shape to every
   * authenticated identity — including `costRateCents` and `billRateCents`, which are
   * internal staff economics. A client-portal user could read the margin on their own
   * project by fetching the directory. The directory itself is legitimately shared
   * (assignee pickers, avatars, workload); the rates are not.
   *
   * Rather than hide the field per role in each call site — which is how one of the
   * two routes ends up forgetting — the shape is chosen once by `directoryUser`, and
   * both routes go through it. Rates are returned only to an admin or a lead, matching
   * the capability that already governs the workload and cost surfaces.
   */
  const directoryUser = (row: Record<string, any>, identity: Identity) => {
    const user = mapUser(row);
    if (identity.role === 'admin' || identity.role === 'lead') return user;
    const { costRateCents, billRateCents, ...rest } = user;
    void costRateCents;
    void billRateCents;
    return rest;
  };

  app.get('/api/meta', async (req) => {
    const viewer = await currentIdentity(req);
    const users = (await (await db()).all('SELECT * FROM users WHERE is_active = 1 ORDER BY full_name')).map(
      (row) => directoryUser(row, viewer),
    );
    const labels = await (await db()).all('SELECT id,name,color,description FROM labels ORDER BY name');
    const clients = (await (await db()).all('SELECT * FROM clients ORDER BY name')).map(mapClient);
    const projects = (await (await db()).all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color
       FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.status != 'archived' ORDER BY p.name`,
    )).map(mapProject);
    const boards = await (await db()).all<Record<string, any>>(
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
      currentUser: users.find((u) => u.id === viewer.userId) ?? users[0],
      priorities: ['urgent', 'high', 'medium', 'low'],
      types: ['feature', 'bug', 'research', 'design', 'ops', 'meeting', 'content'],
      acceptanceLadder: ACCEPTANCE_LADDER,
      slaHours: SLA_HOURS,
    });
  });

  /**
   * The user directory. Reachable by any authenticated identity because assignee
   * pickers and avatars need it; money fields are withheld below admin/lead.
   */
  app.get('/api/users', async (req) => {
    const viewer = await currentIdentity(req);
    const rows = await (await db()).all<Record<string, any>>('SELECT * FROM users ORDER BY full_name');
    return ok(rows.map((row) => directoryUser(row, viewer)));
  });

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
    const rows = await (await db()).all<Record<string, any>>(sql, [...params, limit, offset]);
    const total = (await (await db()).get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params))?.c ?? 0;

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
      const labelRows = await (await db()).all<{ id: string; name: string; color: string }>(
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
    const owner = await (await db()).get<{ project_id: string; client_visible: number }>(
      'SELECT project_id, client_visible FROM tasks WHERE id = ?', [taskId],
    );
    if (!owner) throw notFound('Task not found');
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    await assertProjectInScope(scope, owner.project_id);
    if (scope.externalOnly && !owner.client_visible) throw notFound('Task not found');
    return ok(await taskDetail((await db()), taskId));
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
    const taskId = await createTask((await db()), parsed.data as Record<string, any>, await actor(req as never));
    reply.code(201);
    return ok(await taskDetail((await db()), taskId));
  });

  app.patch('/api/tasks/:id', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const row = await (await db()).get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM tasks WHERE id = ? OR key = ?',
      [taskId, taskId],
    );
    if (!row) throw notFound('Task not found');
    // Scope before the update: a task id or key from another tenant must not be writable.
    await assertProjectInScope(await resolveReadScope((await db()), await currentIdentity(req)), row.project_id);
    await requireProjectAccess((await db()), await currentIdentity(req), row.project_id, 'write');
    await updateTask((await db()), row.id, req.body as Record<string, any>, await actor(req as never));
    return ok(await taskDetail((await db()), row.id));
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const actorId = await requireRole(req, ['admin', 'lead']);
    const { id: taskId } = req.params as { id: string };
    /*
     * The role check is not a scope check: a lead of one project could cancel a task in
     * another tenant. Tenancy is asserted separately, and 404 rather than 403 keeps the
     * denial indistinguishable from absence.
     */
    const doomed = await (await db()).get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM tasks WHERE id = ?',
      [taskId],
    );
    await assertProjectInScope(await resolveReadScope((await db()), await currentIdentity(req)), doomed?.project_id ?? null);
    if (!doomed) throw notFound('Task not found');
    await requireProjectAccess((await db()), await currentIdentity(req), doomed.project_id, 'write');
    await (await db()).run("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?", [nowIso(), taskId]);
    await (await db()).run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id) VALUES (?,?,?,?)', [actorId, 'task.cancelled', 'task', taskId]);
    reply.code(204);
    return null;
  });

  app.post('/api/tasks/:id/comments', async (req, reply) => {
    const { id: taskId } = req.params as { id: string };
    const body = (req.body as { body?: string })?.body?.trim();
    if (!body) throw badRequest('Comment body is required');

    /*
     * Resolve the task and assert scope before writing.
     *
     * This route had no tenancy check: a client or partner identity could attach a
     * comment to any task id it knew. With an id that did not exist the insert failed
     * on the foreign key and surfaced as a 500 — a constraint violation standing in
     * for an authorisation decision, which is both a worse API and a small schema
     * disclosure. 404 for a foreign or absent task, matching every other denial.
     */
    const task = await (await db()).get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM tasks WHERE id = ?',
      [taskId],
    );
    await assertProjectInScope(await resolveReadScope((await db()), await currentIdentity(req)), task?.project_id ?? null);
    if (!task) throw notFound('Task not found');
    await requireProjectAccess((await db()), await currentIdentity(req), task.project_id, 'write');

    const commentId = id('cmt');
    await (await db()).run('INSERT INTO task_comments (id,task_id,author_id,body) VALUES (?,?,?,?)', [commentId, taskId, await actor(req as never), body]);
    await (await db()).run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      'task', taskId, await actor(req as never), 'commented', body.slice(0, 120),
    ]);
    reply.code(201);
    return ok({ id: commentId });
  });

  app.post('/api/tasks/:id/checklist', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const { label } = req.body as { label: string };
    if (!label || !String(label).trim()) throw badRequest('Checklist item label is required');

    // Same shape as the comment route: resolve, assert tenancy, then capability.
    const task = await (await db()).get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM tasks WHERE id = ?',
      [taskId],
    );
    await assertProjectInScope(await resolveReadScope((await db()), await currentIdentity(req)), task?.project_id ?? null);
    if (!task) throw notFound('Task not found');
    await requireProjectAccess((await db()), await currentIdentity(req), task.project_id, 'write');

    const itemId = id('chk');
    const pos = ((await (await db()).get<{ m: number | null }>('SELECT MAX(position) AS m FROM task_checklist WHERE task_id = ?', [taskId]))?.m ?? 0) + 1;
    await (await db()).run('INSERT INTO task_checklist (id,task_id,label,done,position) VALUES (?,?,?,0,?)', [itemId, taskId, label, pos]);
    return ok({ id: itemId });
  });

  app.patch('/api/tasks/:id/checklist/:itemId', async (req) => {
    const { id: taskId, itemId } = req.params as { id: string; itemId: string };
    const { done } = req.body as { done: boolean };

    /*
     * Resolve the item *through* the task in the URL, then check scope on that task.
     *
     * Two defects lived here. The `:id` parameter was ignored entirely, so the item id
     * in the path was enough to mutate it — a direct-object-reference hole that any
     * authenticated identity could use, including a client of another tenant. And no
     * tenancy check ran at all.
     *
     * Joining on both ids closes the first: an item that does not belong to the named
     * task is simply not found, so a correct task id cannot be paired with a foreign
     * item id. Returning 404 for the mismatch matches the rest of the API, where
     * absence and denial are deliberately indistinguishable.
     */
    const item = await (await db()).get<{ id: string; project_id: string | null }>(
      `SELECT c.id, t.project_id
         FROM task_checklist c
         JOIN tasks t ON t.id = c.task_id
        WHERE c.id = ? AND c.task_id = ?`,
      [itemId, taskId],
    );
    if (!item) throw notFound('Checklist item not found');
    await assertProjectInScope(await resolveReadScope((await db()), await currentIdentity(req)), item.project_id);
    await requireProjectAccess((await db()), await currentIdentity(req), item.project_id, 'write');

    await (await db()).run('UPDATE task_checklist SET done = ? WHERE id = ? AND task_id = ?', [
      done ? 1 : 0,
      itemId,
      taskId,
    ]);
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

    /*
     * Approving a turnover gate is a governance act, so it needs the same tenancy
     * check as any other write. Without it, `ensureTaskChecks` inserted gate rows for
     * a task the caller cannot see and the update then failed on the foreign key — a
     * 500 where a 404 belongs.
     */
    const gateTask = await (await db()).get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM tasks WHERE id = ?',
      [taskId],
    );
    await assertProjectInScope(await resolveReadScope((await db()), await currentIdentity(req)), gateTask?.project_id ?? null);
    if (!gateTask) throw notFound('Task not found');
    await requireProjectAccess((await db()), await currentIdentity(req), gateTask.project_id, 'write');

    await ensureTaskChecks((await db()), taskId);
    await (await db()).run(
      `UPDATE turnover_checks SET status = ?, evidence = ?, checked_by = ?, checked_at = ?
       WHERE task_id = ? AND gate_id = ?`,
      [status, evidence ?? '', status === 'pending' ? null : actorId, status === 'pending' ? null : nowIso(), taskId, gateId],
    );
    const remaining = (await (await db()).get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM turnover_checks c JOIN turnover_gates g ON g.id = c.gate_id
       WHERE c.task_id = ? AND g.required = 1 AND c.status NOT IN ('pass','waived')`, [taskId],
    ))?.c ?? 0;
    const task = await (await db()).get<{ turnover_state: string }>('SELECT turnover_state FROM tasks WHERE id = ?', [taskId]);
    const nextState = status === 'fail' ? 'failed' : remaining === 0 ? 'passed' : 'in_review';
    await (await db()).run('UPDATE tasks SET turnover_state = ?, updated_at = ? WHERE id = ?', [nextState, nowIso(), taskId]);
    await (await db()).run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'turnover.check', 'task', taskId, JSON.stringify({ gateId, status, remaining }),
    ]);
    return ok(await taskDetail((await db()), taskId));
  });

  app.post('/api/tasks/:id/acceptance', async (req) => {
    const { id: taskId } = req.params as { id: string };
    const { step, state, evidence, notes } = req.body as { step: string; state: 'passed' | 'rejected' | 'skipped'; evidence?: string; notes?: string };
    if (!ACCEPTANCE_LADDER.includes(step as never)) throw badRequest(`step must be one of ${ACCEPTANCE_LADDER.join(', ')}`);
    if (step === 'client_accepted') await requireRole(req, ['admin', 'lead']);
    const records = await recordAcceptance((await db()), taskId, step as never, state, await actor(req as never), evidence, notes);
    return ok({ acceptance: records, task: await taskDetail((await db()), taskId) });
  });

  /* ----------------------------------------------------------- planning --- */
  app.get('/api/planner', async (req) => {
    const horizonDays = queryInt(req, 'horizon', 21);
    /*
     * The planner is a read, so it obeys the same scope as every other read.
     *
     * It used to select every non-cancelled task in the database and hand the lot
     * to the scheduler, which returned titles, assignees, due dates and blocking
     * reasons. `plan()` is cross-project by nature — a resource-levelling view
     * has to see the whole portfolio — but "whole portfolio" means the caller's,
     * not the installation's. A client-portal identity saw every other client's
     * work in the schedule.
     */
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    const tw = tasksWhere(scope, 't');
    const tasks = await (await db()).all<Record<string, any>>(
      `SELECT t.*, a.capacity_hours_week FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.status NOT IN ('cancelled') AND (${tw.sql})`,
      tw.params,
    );
    const visibleIds = new Set(tasks.map((t) => String(t.id)));
    const deps = (
      await (await db()).all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies')
    ).filter((d) => visibleIds.has(String(d.task_id)) && visibleIds.has(String(d.depends_on_id)));
    const depMap = new Map<string, string[]>();
    for (const d of deps) depMap.set(d.task_id, [...(depMap.get(d.task_id) ?? []), d.depends_on_id]);

    const people = (await (await db()).all<Record<string, any>>("SELECT * FROM users WHERE role != 'bot' AND is_active = 1")).map((u) => ({
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

    const projectRows = await (await db()).all<{ id: string; key: string; name: string }>('SELECT id,key,name FROM projects');
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
    // Persisting a schedule run is a staff action: it writes an audit row that
    // claims a plan was computed. A client-portal identity could create one.
    const actorId = await requireRole(req, ['admin', 'lead']);
    const horizonDays = Number((req.body as { horizonDays?: number })?.horizonDays ?? 21);
    const runId = id('run');
    await (await db()).run('INSERT INTO schedule_runs (id,created_by,algorithm,horizon_days) VALUES (?,?,?,?)', [runId, actorId, 'cpm+wspt', horizonDays]);
    return ok({ id: runId, horizonDays, createdAt: nowIso(), note: 'Plan persisted for audit; recompute via GET /api/planner.' });
  });

  /* ------------------------------------------------------------- clocks --- */
  app.get('/api/clocks', async () => ok({ clocks: await clockHealth((await db())), timers: await liveTimers((await db()), 40) }));

  /**
   * Force a clock sweep.
   *
   * This route previously had no authorisation check at all: any authenticated
   * identity, including a client portal user, could trigger it. That is not a data
   * leak — the sweeper only transitions timers whose deadline has already passed,
   * and it is idempotent — but it is a global, side-effecting operation being
   * exposed to every tenant, and it lets an external party drive load and
   * notification volume at will. The background sweeper runs on its own interval,
   * so nobody needs this route to keep clocks honest; it exists for operators.
   */
  app.post('/api/clocks/sweep', async (req) => {
    await requireRole(req, ['admin', 'lead']);
    const swept = await sweepTimers((await db()));
    return ok({ swept, at: nowIso() });
  });

  /**
   * Tenancy check for a clock timer.
   *
   * A timer is only reachable if the entity it is attached to is inside the
   * caller's scope. Without this, a client identity for one tenant could pause,
   * resume or resolve another tenant's clock — and a paused clock is excluded
   * from the elapsed measurement, so that is a way to erase a breach.
   *
   * Returns the timer and its scope, or a 404 identical to a missing timer.
   */
  async function assertTimerInScope(database: Db, identity: Identity, timerId: string) {
    const timer = await database.get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
    if (!timer) throw notFound('Timer not found');
    const scope = await resolveReadScope(database, identity);
    // A clock hangs off a project, a phase, a task, a release or a client. Each
    // resolves through the same primitives the read endpoints use.
    let visible = false;
    if (timer.entity_type === 'project') {
      const pw = projectsWhere(scope, 'p');
      const row = await database.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM projects p WHERE p.id = ? AND (${pw.sql})`, [timer.entity_id, ...pw.params]);
      visible = Number(row?.c ?? 0) > 0;
    } else if (timer.entity_type === 'client' || timer.entity_type === 'lifecycle') {
      const cw = clientsWhere(scope, 'c');
      const row = await database.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [timer.entity_id, ...cw.params]);
      visible = Number(row?.c ?? 0) > 0;
    } else if (timer.entity_type === 'task') {
      const tw = tasksWhere(scope, 't');
      const row = await database.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM tasks t WHERE t.id = ? AND (${tw.sql})`, [timer.entity_id, ...tw.params]);
      visible = Number(row?.c ?? 0) > 0;
    } else if (timer.entity_type === 'phase') {
      // A phase clock is keyed by the phase catalogue id (`ph_build`), which may
      // appear on many projects. It is visible if *any* project carrying that
      // phase is in scope, which is the same rule the phase read endpoint uses.
      const rows = await database.all<{ project_id: string }>(
        'SELECT project_id FROM project_phases WHERE phase_id = ?', [timer.entity_id],
      );
      const pw = projectsWhere(scope, 'p');
      for (const row of rows) {
        const hit = await database.get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM projects p WHERE p.id = ? AND (${pw.sql})`, [row.project_id, ...pw.params]);
        if (Number(hit?.c ?? 0) > 0) { visible = true; break; }
      }
    } else if (timer.entity_type === 'release') {
      const row = await database.get<{ project_id: string }>('SELECT project_id FROM releases WHERE id = ?', [timer.entity_id]);
      if (row?.project_id) {
        const pw = projectsWhere(scope, 'p');
        const hit = await database.get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM projects p WHERE p.id = ? AND (${pw.sql})`, [row.project_id, ...pw.params]);
        visible = Number(hit?.c ?? 0) > 0;
      }
    } else if (timer.entity_type === 'qa') {
      const row = await database.get<{ project_id: string }>('SELECT project_id FROM qa_reports WHERE id = ?', [timer.entity_id]);
      if (row?.project_id) {
        const pw = projectsWhere(scope, 'p');
        const hit = await database.get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM projects p WHERE p.id = ? AND (${pw.sql})`, [row.project_id, ...pw.params]);
        visible = Number(hit?.c ?? 0) > 0;
      }
    }
    if (!visible) throw notFound('Timer not found');
    return timer;
  }

  app.post('/api/clocks/timers/:id/resolve', async (req) => {
    const { id: timerId } = req.params as { id: string };
    await assertTimerInScope((await db()), await currentIdentity(req), timerId);
    const { outcome, note } = req.body as { outcome: 'met' | 'missed' | 'paused' | 'waived'; note?: string };
    /*
     * `outcome` reaches a CHECK-constrained column and a state machine, and a bad
     * value previously raised a constraint error — a 500 for a caller mistake. The
     * legal set is small and closed, so it is cheaper to state it here than to
     * discover it in an error handler.
     */
    if (!['met', 'missed', 'paused', 'waived'].includes(String(outcome))) {
      throw badRequest('outcome must be one of: met, missed, paused, waived');
    }
    if (note !== undefined && typeof note !== 'string') throw badRequest('note must be a string');
    if (outcome === 'waived') await requireRole(req, ['admin', 'lead']);
    // A waiver without a written exception is just a deleted violation.
    if (outcome === 'waived' && !note?.trim()) {
      throw badRequest('A waiver requires a written exception note — an unexplained waiver erases the breach.');
    }
    const resolved = await resolveTimer((await db()), timerId, outcome, note);
    await (await db()).run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
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
    await assertTimerInScope((await db()), identity, timerId);
    if (!body.reason?.trim() || body.reason.trim().length < 12) {
      throw badRequest('An acknowledgement needs a substantive reason (at least 12 characters).');
    }
    const timer = await (await db()).get<Record<string, any>>('SELECT * FROM sla_timers WHERE id = ?', [timerId]);
    if (!timer) throw notFound('Timer not found');
    if (timer.outcome !== 'missed') {
      throw badRequest(`Only a missed clock can be acknowledged (this timer is ${timer.outcome}).`);
    }
    const existing = await (await db()).get<{ id: string }>('SELECT id FROM clock_acknowledgements WHERE timer_id = ?', [timerId]);
    if (existing) throw badRequest('This clock miss has already been acknowledged.');
    await (await db()).run(
      'INSERT INTO clock_acknowledgements (id, timer_id, acknowledged_by, reason, escalated_to) VALUES (?,?,?,?,?)',
      [id('ack'), timerId, identity.userId, body.reason.trim(), body.escalatedTo ?? null],
    );
    await (await db()).run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      timer.entity_type, timer.entity_id, identity.userId, 'clock_acknowledged', `acknowledged miss on ${timer.clock_key}`,
    ]);
    return ok(await (await db()).get('SELECT * FROM clock_acknowledgements WHERE timer_id = ?', [timerId]));
  });

  /* ------------------------------------------------------------ projects -- */
  app.get('/api/projects', async (req) => {
    const identity = await currentIdentity(req);
    const rows = await (await db()).all<Record<string, any>>(
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
    await requireProjectAccess((await db()), await currentIdentity(req), projectId, 'read');
    const project = await (await db()).get<Record<string, any>>(
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

    const phases = await (await db()).all<Record<string, any>>(
      `SELECT pp.*, ph.name, ph.key AS phase_key, ph.color, ph.description, ph.sla_days, ph.turnover_policy,
              u.full_name AS signoff_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_phase_id = pp.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_phase_id = pp.id AND t.status='done') AS done_count
       FROM project_phases pp JOIN phases ph ON ph.id = pp.phase_id
       LEFT JOIN users u ON u.id = pp.signoff_by
       WHERE pp.project_id = ? ORDER BY pp.position`, [project.id],
    );
    const phaseGates = await (await db()).all<Record<string, any>>('SELECT * FROM turnover_gates WHERE scope = ?', ['phase']);
    const phaseChecks = await (await db()).all<Record<string, any>>('SELECT * FROM turnover_checks WHERE project_phase_id IS NOT NULL');
    const checkByPhase = new Map<string, Record<string, any>[]>();
    for (const c of phaseChecks) {
      const list = checkByPhase.get(c.project_phase_id) ?? [];
      list.push(c);
      checkByPhase.set(c.project_phase_id, list);
    }

    const edgeStats = await (await db()).all<Record<string, any>>(
      'SELECT status, COUNT(*) AS c FROM edge_cases WHERE project_id = ? GROUP BY status', [project.id]);
    const edgeByCategory = await (await db()).all<Record<string, any>>(
      'SELECT category, COUNT(*) AS c FROM edge_cases WHERE project_id = ? GROUP BY category ORDER BY c DESC', [project.id]);
    const releases = await (await db()).all<Record<string, any>>('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
    const handoffs = await (await db()).all<Record<string, any>>('SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
    const qa = await (await db()).all<Record<string, any>>(
      `SELECT q.*, u.full_name AS reporter FROM qa_reports q LEFT JOIN users u ON u.id = q.reporter_id
       WHERE q.project_id = ? ORDER BY q.created_at DESC LIMIT 20`, [project.id]);
    const docs = await (await db()).all('SELECT id,title,kind,status,updated_at,client_visible FROM docs WHERE project_id = ? ORDER BY updated_at DESC', [project.id]);
    const timers = (await liveTimers((await db()), 200)).filter((t) => t.entityId === project.id || t.entityId === project.key);
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
        clientAccepted: ((await (await db()).get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM tasks t JOIN acceptance_records a ON a.task_id = t.id
           WHERE t.project_id = ? AND a.step='client_accepted' AND a.state='passed'`, [project.id]))?.c ?? 0) > 0,
      },
    });
  });

  app.patch('/api/projects/:id/phases/:phaseRowId', async (req) => {
    const identity = await currentIdentity(req);
    await requireProjectAccess((await db()), identity, (req.params as { id: string }).id, 'write');
    const { id: projectId, phaseRowId } = req.params as { id: string; phaseRowId: string };
    const actorId = await actor(req as never);
    const body = req.body as { status?: string; progress?: number; turnoverPassed?: boolean };
    // `project_phases.status` is CHECK-constrained (`locked|active|blocked|done`);
    // an unknown value used to reach the database and return 500.
    if (body.status !== undefined && !['locked', 'active', 'blocked', 'done'].includes(String(body.status))) {
      throw badRequest('status must be one of: locked, active, blocked, done');
    }
    if (body.progress !== undefined) {
      const p = body.progress;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
        throw badRequest('progress must be a number between 0 and 100');
      }
    }
    if (body.turnoverPassed !== undefined && typeof body.turnoverPassed !== 'boolean') {
      throw badRequest('turnoverPassed must be a boolean');
    }
    const rows = await (await db()).get<Record<string, any>>('SELECT * FROM project_phases WHERE id = ? AND project_id = ?', [phaseRowId, projectId]);
    if (!rows) throw notFound('Phase not found');
    if (body.status) {
      await (await db()).run('UPDATE project_phases SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?', [
        body.status, body.status === 'active' ? nowIso() : null, phaseRowId,
      ]);
      // Phase lifecycle drives three clocks. Starting a phase starts the
      // milestone clock; moving it into client review starts the client-turnover
      // clock (14d ceiling / 7d target); closing it stops both as met. A late
      // sweep may already have marked them missed — that verdict stands.
      if (body.status === 'active') {
        await startTimer((await db()), 'milestone-turnover', 'phase', rows.phase_id, `Phase turnover: ${rows.phase_id}`);
      }
      if (body.status === 'blocked') {
        await startTimer((await db()), 'client-turnover', 'phase', rows.phase_id, `Client review: ${rows.phase_id}`);
      }
      if (body.status === 'done') {
        await closeTimersFor((await db()), 'phase', rows.phase_id, 'met');
      }
    }
    if (body.progress !== undefined) await (await db()).run('UPDATE project_phases SET progress = ? WHERE id = ?', [body.progress, phaseRowId]);
    if (body.turnoverPassed !== undefined) {
      await (await db()).run('UPDATE project_phases SET turnover_passed = ?, signoff_by = ?, signoff_at = ? WHERE id = ?', [
        body.turnoverPassed ? 1 : 0, body.turnoverPassed ? actorId : null, body.turnoverPassed ? nowIso() : null, phaseRowId,
      ]);
    }
    await (await db()).run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
      'phase', phaseRowId, actorId, 'updated', `phase ${phaseRowId} → ${body.status ?? 'updated'}`,
    ]);
    return ok({ ok: true });
  });

  /* ------------------------------------------------------------ pipeline -- */
  app.get('/api/pipeline', async () => {
    const stages = await (await db()).all<Record<string, any>>('SELECT * FROM pipeline_stages ORDER BY position');
    const deals = await (await db()).all<Record<string, any>>(
      `SELECT d.*, c.name AS client_name, c.accent_color AS client_color, s.key AS stage_key, s.name AS stage_name,
              s.phase AS stage_phase, s.color AS stage_color, s.default_sla_days, u.full_name AS owner_name,
              u.initials AS owner_initials, u.avatar_color AS owner_color
       FROM deals d JOIN clients c ON c.id = d.client_id JOIN pipeline_stages s ON s.id = d.stage_id
       LEFT JOIN users u ON u.id = d.owner_id ORDER BY d.value_cents DESC`,
    );
    const dealsMapped = deals.map(mapDeal);

    const phaseRuns = await (await db()).all<Record<string, any>>(
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
    const body = req.body as { title?: string; stageId?: string; stageKey?: string; status?: string; nextStep?: string; probability?: number; ownerId?: string };
    const deal = await (await db()).get<Record<string, any>>('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) throw notFound('Deal not found');
    /*
     * A deal belongs to a client, and changing its stage starts a clock and rewrites
     * the pipeline — both of which belong to that client's relationship. Without this
     * check any authenticated identity could move another tenant's deal.
     */
    const dealIdentity = await currentIdentity(req);
    await assertClientInScope((await db()), dealIdentity, deal.client_id);
    // Changing a deal's stage starts a clock and rewrites the pipeline: staff only.
    if (!['admin', 'lead'].includes(dealIdentity.role)) {
      throw forbidden('Only an admin or lead may change a deal');
    }
    /*
     * Validate before writing, because a CHECK constraint is not validation.
     *
     * `deals.status` and `deals.probability` both have CHECKs, so an out-of-range
     * value did not corrupt anything — it raised a constraint error, which
     * surfaced as a 500 from a client-supplied body. A 500 is a server fault
     * report for a client mistake, and on PostgreSQL it also leaves the request
     * with a different error shape than SQLite gives. Everything the caller can
     * get wrong is rejected here, in one place, as a 400.
     */
    /*
     * A PATCH that names no field this route updates is a client mistake, not a
     * successful write. Returning 200 told the caller the deal had been changed
     * when nothing had, including for the `{ title }` body the route's own probe
     * has always sent — see below.
     */
    const UPDATABLE = ['title', 'stageId', 'stageKey', 'status', 'nextStep', 'probability', 'ownerId'];
    if (!UPDATABLE.some((k) => (body as Record<string, unknown>)[k] !== undefined)) {
      throw badRequest(`Nothing to update. Supply at least one of: ${UPDATABLE.join(', ')}`);
    }
    /*
     * `title` was accepted and discarded.
     *
     * The route's own probe body has always been `{ title }`, and the handler had
     * no branch for it, so renaming a deal returned 200 with the old name intact.
     * A field the API documents and silently drops is worse than one it rejects:
     * the caller believes the write happened.
     */
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest('title must be a non-empty string');
      if (body.title.length > 300) throw badRequest('title must be 300 characters or fewer');
    }
    if (body.status !== undefined && !['open', 'won', 'lost', 'paused'].includes(String(body.status))) {
      throw badRequest('status must be one of: open, won, lost, paused');
    }
    if (body.probability !== undefined) {
      const p = body.probability;
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100) {
        throw badRequest('probability must be an integer between 0 and 100');
      }
    }
    if (body.nextStep !== undefined && typeof body.nextStep !== 'string') {
      throw badRequest('nextStep must be a string');
    }
    if (body.nextStep !== undefined && body.nextStep.length > 2000) {
      throw badRequest('nextStep must be 2000 characters or fewer');
    }
    if (body.ownerId !== undefined) {
      if (typeof body.ownerId !== 'string' || !body.ownerId) throw badRequest('ownerId must be a non-empty string');
      const owner = await (await db()).get('SELECT 1 AS ok FROM users WHERE id = ?', [body.ownerId]);
      if (!owner) throw badRequest(`No such user: ${body.ownerId}`);
    }
    if (body.stageId !== undefined && typeof body.stageId !== 'string') throw badRequest('stageId must be a string');
    if (body.stageKey !== undefined && typeof body.stageKey !== 'string') throw badRequest('stageKey must be a string');
    if (body.stageId || body.stageKey) {
      const stage = body.stageId
        ? await (await db()).get<Record<string, any>>('SELECT * FROM pipeline_stages WHERE id = ?', [body.stageId])
        : await (await db()).get<Record<string, any>>('SELECT * FROM pipeline_stages WHERE key = ?', [body.stageKey!]);
      if (!stage) throw badRequest('Unknown stage');
      await (await db()).run('UPDATE deals SET stage_id = ?, probability = ?, updated_at = ? WHERE id = ?', [
        stage.id, body.probability ?? Math.min(100, Math.round(stage.position / 1.2)), nowIso(), dealId,
      ]);
      await (await db()).run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
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
      if (clockKey) await startTimer((await db()), clockKey, 'deal', dealId, `${deal.title} — ${stage.name}`);
    }
    if (body.status) {
      await (await db()).run('UPDATE deals SET status = ?, won_at = ?, lost_at = ?, updated_at = ? WHERE id = ?', [
        body.status, body.status === 'won' ? nowIso() : deal.won_at, body.status === 'lost' ? nowIso() : deal.lost_at, nowIso(), dealId,
      ]);
    }
    if (body.title !== undefined) await (await db()).run('UPDATE deals SET title = ?, updated_at = ? WHERE id = ?', [body.title.trim(), nowIso(), dealId]);
    if (body.nextStep !== undefined) await (await db()).run('UPDATE deals SET next_step = ? WHERE id = ?', [body.nextStep, dealId]);
    if (body.probability !== undefined) await (await db()).run('UPDATE deals SET probability = ? WHERE id = ?', [body.probability, dealId]);
    if (body.ownerId !== undefined) await (await db()).run('UPDATE deals SET owner_id = ? WHERE id = ?', [body.ownerId, dealId]);
    return ok(await (await db()).get('SELECT * FROM deals WHERE id = ?', [dealId]));
  });

  app.post('/api/deals', async (req, reply) => {
    const body = req.body as Record<string, any>;
    if (!body.clientId || !body.title) throw badRequest('clientId and title are required');
    const dealId = id('dl');
    const stage = await (await db()).get<{ id: string }>('SELECT id FROM pipeline_stages WHERE key = ?', [body.stageKey ?? 'inbound']);
    if (!stage) throw badRequest('Unknown stage');
    await (await db()).run(
      `INSERT INTO deals (id,client_id,title,value_cents,status,stage_id,owner_id,probability,next_step)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealId, body.clientId, body.title, body.valueCents ?? 0, 'open', stage.id, body.ownerId ?? await actor(req as never), body.probability ?? 20, body.nextStep ?? ''],
    );
    reply.code(201);
    return ok({ id: dealId });
  });

  /* ------------------------------------------------------------- clients -- */
  app.get('/api/clients', async () => {
    const clients = (await (await db()).all<Record<string, any>>('SELECT * FROM clients ORDER BY name')).map(mapClient);
    const deals = await (await db()).all<Record<string, any>>('SELECT client_id, value_cents, status FROM deals');
    const projects = await (await db()).all<Record<string, any>>('SELECT client_id, status FROM projects');
    return ok(clients.map((c) => ({
      ...c,
      openValueCents: deals.filter((d) => d.client_id === c.id && d.status === 'open').reduce((a, d) => a + d.value_cents, 0),
      wonValueCents: deals.filter((d) => d.client_id === c.id && d.status === 'won').reduce((a, d) => a + d.value_cents, 0),
      projectCount: projects.filter((p) => p.client_id === c.id && p.status !== 'archived').length,
    })));
  });

  app.get('/api/partners', async () => {
    const partners = await (await db()).all<Record<string, any>>(
      `SELECT p.*, c.name AS client_name, c.accent_color AS client_color FROM partners p JOIN clients c ON c.id = p.client_id ORDER BY p.name`,
    );
    const iam = await (await db()).all<Record<string, any>>('SELECT partner_id, role, mfa_enabled, status FROM partner_iam_users');
    const devices = await (await db()).all<Record<string, any>>('SELECT partner_id, status FROM device_licenses');
    const usage = await (await db()).all<Record<string, any>>('SELECT partner_id, day, api_calls, active_users, storage_mb, uptime_pct FROM usage_metrics ORDER BY day');
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

  /**
   * Device entitlements. Every route here is partner-scoped: a caller may only
   * act on a partner they belong to, and another partner's identifiers are a 404
   * rather than a 403 so the endpoint cannot be used to enumerate tenants.
   *
   * The limit enforcement lives in `services/partners.ts`, inside the same
   * transaction as the write — a check that runs in a separate round trip can be
   * raced by two concurrent registrations.
   */
  /**
   * Partners are cross-tenant by design — a partner is an external agency that
   * may be engaged on several clients at once — so this is not a client-tenant
   * scope check and staff are legitimately allowed through.
   *
   * Staff bypass previously short-circuited before the partner was looked up, so
   * `GET /api/partners/<anything>/devices` answered `200 []`: an unknown id
   * looked exactly like a partner with no devices. Existence is now checked for
   * every caller; *authorisation* still differs by identity.
   */
  const assertPartner = async (identity: Identity, partnerId: string) => {
    const exists = await (await db()).get('SELECT 1 AS ok FROM partners WHERE id = ?', [partnerId]);
    if (!exists) throw notFound(`Partner "${partnerId}" does not exist.`);
    if (identity.role === 'admin' || identity.role === 'lead') return;
    const row = await (await db()).get(
      "SELECT 1 AS ok FROM partner_iam_users WHERE partner_id = ? AND user_id = ? AND status = 'active'",
      [partnerId, identity.userId],
    );
    if (!row) throw notFound(`Partner "${partnerId}" does not exist.`);
  };

  app.get('/api/partners/:id/entitlements', async (req) => {
    const identity = await currentIdentity(req);
    const partnerId = String((req.params as { id: string }).id);
    await assertPartner(identity, partnerId);
    return ok(await entitlementState((await db()), partnerId));
  });

  app.get('/api/partners/:id/devices', async (req) => {
    const identity = await currentIdentity(req);
    const partnerId = String((req.params as { id: string }).id);
    await assertPartner(identity, partnerId);
    const rows = await (await db()).all<Record<string, any>>(
      `SELECT d.*, u.full_name AS registered_by_name FROM device_licenses d
       LEFT JOIN users u ON u.id = d.assigned_to
       WHERE d.partner_id = ?
       ORDER BY CASE d.status WHEN 'active' THEN 0 WHEN 'unassigned' THEN 1 ELSE 2 END, d.device_name`,
      [partnerId],
    );
    return ok(rows.map((d) => ({
      id: d.id,
      deviceId: d.device_id,
      deviceName: d.device_name,
      platform: d.platform,
      status: d.status,
      activatedAt: d.activated_at,
      assignedTo: d.assigned_to,
    })));
  });

  app.post('/api/partners/:id/devices', async (req, reply) => {
    const identity = await currentIdentity(req);
    const partnerId = String((req.params as { id: string }).id);
    await assertPartner(identity, partnerId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await registerDevice(
      (await db()),
      partnerId,
      {
        deviceId: optionalString(body.deviceId, 'deviceId'),
        deviceName: optionalString(body.deviceName, 'deviceName'),
        platform: optionalString(body.platform, 'platform'),
      },
      identity.userId,
    );
    return reply.code(201).send({ data: result });
  });

  app.post('/api/partners/:id/devices/:deviceId/activate', async (req) => {
    const identity = await currentIdentity(req);
    const partnerId = String((req.params as { id: string }).id);
    await assertPartner(identity, partnerId);
    const deviceRowId = String((req.params as { deviceId: string }).deviceId);
    return ok(await activateDevice((await db()), partnerId, deviceRowId, identity.userId));
  });

  app.post('/api/partners/:id/devices/:deviceId/revoke', async (req) => {
    const identity = await currentIdentity(req);
    const partnerId = String((req.params as { id: string }).id);
    await assertPartner(identity, partnerId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceRowId = String((req.params as { deviceId: string }).deviceId);
    return ok(await revokeDevice((await db()), partnerId, deviceRowId, optionalString(body.reason, 'reason') ?? '', identity.userId));
  });

  app.post('/api/partners/:id/usage', async (req, reply) => {
    const identity = await currentIdentity(req);
    const partnerId = String((req.params as { id: string }).id);
    await assertPartner(identity, partnerId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const calls = optionalNumber(body.calls, 'calls') ?? 0;
    const result = await recordApiUsage((await db()), partnerId, calls);
    // 429 when the quota is breached: the call is recorded, but the caller is told
    // to stop rather than being given a cheerful 200 and an invisible overage.
    return (reply as any).code(result.overQuota ? 429 : 200).send({ data: result });
  });

  /* --------------------------------------------------------------- QA ----- */
  app.get('/api/qa', async (req) => {
    const projectId = queryStr(req, 'projectId');
    const status = queryStr(req, 'status');
    const where: string[] = [];
    const params: unknown[] = [];
    if (projectId) { where.push('q.project_id = ?'); params.push(projectId); }
    if (status) { where.push('q.status = ?'); params.push(status); }
    const rows = await (await db()).all<Record<string, any>>(
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
    /*
     * `kind` and `severity` are CHECK-constrained, so a bad enum was stopped by the
     * database and surfaced as a 500 — see the deal PATCH for the same pattern. The
     * probe that sends `{ ...every field wrong type }` is a request a real client
     * would make by mistake, and the answer to a client mistake is 400.
     */
    if (typeof b.title !== 'string' || !b.title.trim()) throw badRequest('title must be a non-empty string');
    if (typeof b.projectId !== 'string' || !b.projectId) throw badRequest('projectId must be a non-empty string');
    if (b.kind !== undefined && !['bug', 'test', 'regression', 'security', 'a11y', 'perf'].includes(b.kind)) {
      throw badRequest('kind must be one of: bug, test, regression, security, a11y, perf');
    }
    if (b.severity !== undefined && !['p0', 'p1', 'p2', 'p3', 'p4'].includes(b.severity)) {
      throw badRequest('severity must be one of: p0, p1, p2, p3, p4');
    }
    for (const [field, max] of [['title', 300], ['body', 20000], ['reproduction', 20000], ['evidenceUrl', 2000]] as const) {
      if (b[field] !== undefined && typeof b[field] !== 'string') throw badRequest(`${field} must be a string`);
      if (typeof b[field] === 'string' && b[field].length > max) throw badRequest(`${field} must be ${max} characters or fewer`);
    }
    const reportId = id('qa');
    const due = new Date(Date.now() + 12 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    await (await db()).run(
      `INSERT INTO qa_reports (id,project_id,kind,severity,title,body,status,reproduction,evidence_url,reporter_id,assignee_id,due_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [reportId, b.projectId, b.kind ?? 'bug', b.severity ?? 'p2', b.title, b.body ?? '', 'open',
        b.reproduction ?? '', b.evidenceUrl ?? '', actorId, b.assigneeId ?? null, due],
    );
    await startTimer((await db()), 'qa-report', 'qa', reportId, `QA report: ${b.title}`);
    reply.code(201);
    return ok({ id: reportId, dueAt: due });
  });

  app.patch('/api/qa/:id', async (req) => {
    const { id: reportId } = req.params as { id: string };
    const b = req.body as Record<string, any>;

    /*
     * Scope before anything else.
     *
     * This route had no tenancy check at all: any authenticated identity, including a
     * client of a different tenant, could mutate any QA report by id. The response was
     * a 500 because the arbitrary status value then violated a CHECK constraint — which
     * is how the edge registry surfaced it ("expected 404, got 200" on the role probes,
     * and a 500 on a cross-tenant write). A constraint violation is not an access
     * control, and it leaks the schema.
     *
     * 404 rather than 403 for a foreign report, matching every other read and write in
     * this API: a 403 would confirm the id exists.
     */
    const existing = await (await db()).get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM qa_reports WHERE id = ?',
      [reportId],
    );
    if (!existing) throw notFound('QA report not found');
    // Tenancy is a 404 via the shared primitive, not a 403: a 403 would confirm the
    // report exists and merely belongs to someone else.
    await assertProjectInScope(await resolveReadScope((await db()), await currentIdentity(req)), existing.project_id);
    await requireProjectAccess((await db()), await currentIdentity(req), existing.project_id, 'write');

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of [['status', 'status'], ['severity', 'severity'], ['assigneeId', 'assignee_id'], ['title', 'title']] as const) {
      if (b[key] !== undefined) { sets.push(`${col} = ?`); params.push(b[key]); }
    }
    /*
     * Reject values the schema would refuse before touching the database. A CHECK
     * violation reaching the 500 handler reports "something went wrong" and quotes the
     * constraint, which is both a worse API and a small schema disclosure.
     */
    const QA_STATUS = ['open', 'triaged', 'in_progress', 'fixed', 'verified', 'wont_fix', 'duplicate'];
    if (b.status !== undefined && !QA_STATUS.includes(b.status)) {
      throw badRequest(`status must be one of ${QA_STATUS.join(', ')}`);
    }
    if (b.severity !== undefined && !['low', 'medium', 'high', 'critical'].includes(b.severity)) {
      throw badRequest('severity must be one of low, medium, high, critical');
    }
    if (b.status && ['fixed', 'verified', 'wont_fix', 'duplicate'].includes(b.status)) {
      sets.push('resolved_at = ?');
      params.push(nowIso());
      await closeTimersFor((await db()), 'qa', reportId, 'met');
    }
    if (!sets.length) throw badRequest('Nothing to update');
    await (await db()).run(`UPDATE qa_reports SET ${sets.join(', ')} WHERE id = ?`, [...params, reportId]);
    return ok(await (await db()).get('SELECT * FROM qa_reports WHERE id = ?', [reportId]));
  });

  /* ------------------------------------------------------------ releases -- */
  /**
   * Ship readiness is computed, never asserted. This endpoint is the same code
   * path that guards the ship transition, so the UI cannot show a green gate
   * that the server would refuse.
   */
  app.get('/api/releases/:id/gate', async (req) => {
    const { id: releaseId } = req.params as { id: string };
    const release = await (await db()).get<Record<string, any>>('SELECT * FROM releases WHERE id = ?', [releaseId]);
    if (!release) throw notFound('Release not found');
    await requireProjectAccess((await db()), await currentIdentity(req), release.project_id, 'read');
    return ok(await evaluateShipGate((await db()), releaseId));
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
    const release = await (await db()).get<Record<string, any>>('SELECT * FROM releases WHERE id = ?', [releaseId]);
    if (!release) throw notFound('Release not found');
    await requireProjectAccess((await db()), await currentIdentity(req), release.project_id, 'write');

    if (body.execSummaryUrl !== undefined) {
      await (await db()).run('UPDATE releases SET exec_summary_url = ? WHERE id = ?', [body.execSummaryUrl, releaseId]);
      // Prepared-at is what the 48h rule compares. It is recorded explicitly so
      // a link added minutes before the ship window cannot claim a 2-day lead.
      if (body.execSummaryAt !== undefined) {
        await (await db()).run('UPDATE releases SET exec_summary_at = ? WHERE id = ?', [body.execSummaryAt, releaseId]);
      }
    }
    if (body.demoAt !== undefined) await (await db()).run('UPDATE releases SET demo_at = ? WHERE id = ?', [body.demoAt, releaseId]);
    if (body.shipPlannedAt !== undefined) await (await db()).run('UPDATE releases SET ship_planned_at = ? WHERE id = ?', [body.shipPlannedAt, releaseId]);
    if (body.rollbackPlan !== undefined) await (await db()).run('UPDATE releases SET rollback_plan = ? WHERE id = ?', [body.rollbackPlan, releaseId]);

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
        const result = await markShipped((await db()), releaseId, actorId);
        await (await db()).run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
          actorId, 'release.ship', 'release', releaseId,
          JSON.stringify({ version: release.version, gate: result.gate.checks.map((c) => [c.key, c.passed]) }),
        ]);
        return ok({ release: result.release, gate: result.gate });
      }
      if (body.status === 'demo_done') {
        await (await db()).run("UPDATE releases SET status = 'demo_done', demo_approved_at = COALESCE(demo_approved_at, ?) WHERE id = ?", [nowIso(), releaseId]);
        // Approval locks the 5-day ship clock: the promise is measured from here.
        await startTimer((await db()), 'ship-after-approval', 'release', releaseId, `Ship ${release.version}`);
        await startTimer((await db()), 'exec-summary', 'release', releaseId, `Exec summary ${release.version}`);
      } else {
        await (await db()).run('UPDATE releases SET status = ? WHERE id = ?', [body.status, releaseId]);
        if (body.status === 'demo_ready') {
          await startTimer((await db()), 'exec-summary', 'release', releaseId, `Exec summary ${release.version}`);
        }
      }
      await (await db()).run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)', [
        'release', releaseId, actorId, 'status_changed', `${release.version} → ${body.status}`,
      ]);
    }
    return ok(await (await db()).get('SELECT * FROM releases WHERE id = ?', [releaseId]));
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
    const release = await (await db()).get<Record<string, any>>('SELECT * FROM releases WHERE id = ?', [releaseId]);
    if (!release) throw notFound('Release not found');
    await requireProjectAccess((await db()), await currentIdentity(req), release.project_id, 'write');
    const existing = await (await db()).get<{ id: string }>('SELECT id FROM ship_acknowledgements WHERE release_id = ? AND signal = ?', [releaseId, body.signal]);
    const receivedAt = body.state === 'received' ? nowIso() : null;
    if (existing) {
      await (await db()).run('UPDATE ship_acknowledgements SET state = ?, source = ?, detail = ?, received_at = ?, recorded_by = ? WHERE id = ?', [
        body.state, body.source ?? '', body.detail ?? '', receivedAt, actorId, existing.id,
      ]);
    } else {
      await (await db()).run(
        `INSERT INTO ship_acknowledgements (id, release_id, signal, state, source, detail, received_at, recorded_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id('ack'), releaseId, body.signal, body.state, body.source ?? '', body.detail ?? '', receivedAt, actorId],
      );
    }
    await (await db()).run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'release.acknowledgement', 'release', releaseId, JSON.stringify({ signal: body.signal, state: body.state, source: body.source ?? '' }),
    ]);
    const acks = await (await db()).all('SELECT * FROM ship_acknowledgements WHERE release_id = ? ORDER BY signal', [releaseId]);
    return ok({ releaseId, acknowledgements: acks });
  });

  app.get('/api/releases', async () => {
    const rows = await (await db()).all<Record<string, any>>(
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
    const tasks = await (await db()).all<Record<string, any>>(
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

    const clients = await (await db()).all<Record<string, any>>('SELECT * FROM clients');
    const projects = (await (await db()).all<Record<string, any>>(
      `SELECT p.id,p.key,p.name,p.status,p.health,c.name AS client_name,c.accent_color,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) AS total,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='done') AS done
       FROM projects p JOIN clients c ON c.id=p.client_id WHERE p.status!='archived'`,
    ));
    const deals = await (await db()).all<Record<string, any>>(
      `SELECT d.*, s.name AS stage_name, s.phase FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.status='open'`,
    );
    const workload = await (await db()).all<Record<string, any>>(
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
        billableHoursWeek: Math.round(((await (await db()).get<{ m: number }>(
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
      clocks: await clockHealth((await db())),
      timers: await liveTimers((await db()), 12),
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
    const rows = await (await db()).all<Record<string, any>>(
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
    const rows = await (await db()).all<Record<string, any>>(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [await actor(req as never)],
    );
    return ok(rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, readAt: n.read_at, createdAt: n.created_at })));
  });

  app.post('/api/notifications/:id/read', async (req) => {
    const { id: notifId } = req.params as { id: string };
    // An UPDATE that matches nothing is indistinguishable from a successful one
    // unless the row count is checked. Returning 200 for an id that does not
    // exist told the caller a notification had been read when none had.
    /*
     * A notification is addressed to one user, so the update is scoped to the caller.
     * Marking someone else's notification read is not a data breach on its own, but it
     * is a write to another identity's mailbox — and an unscoped `WHERE id = ?` here
     * means the id alone decides. Scoping the statement is both the authorisation check
     * and the update, so they cannot disagree.
     */
    const identity = await currentIdentity(req);
    const result = await (await db()).run(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?',
      [nowIso(), notifId, identity.userId],
    );
    if (!result.changes) throw notFound('Notification not found');
    return ok({ id: notifId });
  });

  /* -------------------------------------------------------- intelligence -- */
  app.get('/api/insights', async () => {
    const tasks = await (await db()).all<Record<string, any>>(`${TASK_SELECT} WHERE t.status NOT IN ('cancelled','done')`);
    const now = Date.now();
    const insights: Array<Record<string, unknown>> = [];

    // 1. Critical path / dependency bottlenecks.
    const deps = await (await db()).all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies');
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
    const reviewers = await (await db()).all<Record<string, any>>(
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
    const failedGates = await (await db()).all<Record<string, any>>(
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
    const rows = await (await db()).all<Record<string, any>>(
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
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    const empty = { tasks: [], projects: [], clients: [], deals: [], docs: [], comments: [], meetings: [], counts: {} };
    if (q.length < 2) return ok(empty);
    const like = `%${q}%`;

    const tw = tasksWhere(scope, 't');
    const pw = projectsWhere(scope, 'p');
    const dw = docsWhere(scope, 'd');
    const cw = clientsWhere(scope, 'c');
    const dlw = dealsWhere(scope, 'd');

    const tasks = await (await db()).all<Record<string, any>>(
      `${TASK_SELECT} WHERE (${tw.sql}) AND t.hidden_at IS NULL AND (t.title LIKE ? OR t.key LIKE ?)
       ORDER BY t.updated_at DESC LIMIT 8`,
      [...tw.params, like, like],
    );
    const projects = await (await db()).all<Record<string, any>>(
      `SELECT p.id, p.key, p.name FROM projects p
        WHERE (${pw.sql}) AND p.hidden_at IS NULL AND (p.name LIKE ? OR p.key LIKE ?)
        ORDER BY p.name LIMIT 5`,
      [...pw.params, like, like],
    );
    const clients = await (await db()).all<Record<string, any>>(
      `SELECT c.id, c.name, c.initials, c.accent_color FROM clients c
        WHERE (${cw.sql}) AND c.name LIKE ? ORDER BY c.name LIMIT 5`,
      [...cw.params, like],
    );
    const deals = await (await db()).all<Record<string, any>>(
      `SELECT d.id, d.title, d.value_cents FROM deals d
        WHERE (${dlw.sql}) AND d.title LIKE ? ORDER BY d.value_cents DESC LIMIT 5`,
      [...dlw.params, like],
    );
    const docs = await (await db()).all<Record<string, any>>(
      `SELECT d.id, d.title, d.kind FROM docs d
        WHERE (${dw.sql}) AND d.status != 'archived' AND d.title LIKE ?
        ORDER BY d.updated_at DESC LIMIT 5`,
      [...dw.params, like],
    );

    // Comments inherit their task's authorisation: a comment is exactly as
    // visible as the work it is attached to.
    const comments = await (await db()).all<Record<string, any>>(
      `SELECT k.id, k.body, k.task_id, k.created_at, t.key AS task_key, t.title AS task_title
         FROM task_comments k JOIN tasks t ON t.id = k.task_id
        WHERE (${tw.sql}) AND t.hidden_at IS NULL AND k.deleted_at IS NULL AND k.body LIKE ?
        ORDER BY k.created_at DESC LIMIT 5`,
      [...tw.params, like],
    );

    // Meeting notes are external-visible only when the note is marked shared.
    const meetings = await (await db()).all<Record<string, any>>(
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
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    if (q.length < 2) return ok({ suggestions: [] });
    const like = `%${q}%`;
    const tw = tasksWhere(scope, 't');
    const pw = projectsWhere(scope, 'p');
    const rows = await (await db()).all<Record<string, any>>(
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
   * Tenancy check for a client-scoped route.
   *
   * Returns 404 — identical to absence — for a client that is not visible in the
   * caller's scope, so the endpoint cannot be used to enumerate clients. Kept in
   * one place because two copies of this check is exactly how the evidence route
   * came to be missing it.
   */
  async function assertClientInScope(database: Db, identity: Identity, clientId: string) {
    const scope = await resolveReadScope(database, identity);
    const cw = clientsWhere(scope, 'c');
    const visible = await database.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`,
      [clientId, ...cw.params],
    );
    if (!(visible?.c ?? 0)) throw notFound('Client not found');
  }


  /**
   * The 18-stage lifecycle. Reading is scoped like everything else; writing is
   * enforced by the transition service, not by these handlers — the handlers
   * only translate HTTP into a service call so the rules cannot be bypassed by
   * a second caller.
   */
  app.get('/api/clients/:id/lifecycle', async (req) => {
    const { id: clientId } = req.params as { id: string };
    await assertClientInScope((await db()), await currentIdentity(req), clientId);
    return ok(await lifecycleView((await db()), clientId));
  });

  app.post('/api/clients/:id/lifecycle/:stageKey/transitions', async (req) => {
    const { id: clientId, stageKey } = req.params as { id: string; stageKey: string };
    const identity = await currentIdentity(req);
    await assertClientInScope((await db()), identity, clientId);
    const body = req.body as { to?: string; reason?: string; note?: string; exception?: boolean };
    if (!body.to || typeof body.to !== 'string') throw badRequest('A transition needs a target state');
    // Only staff may drive the lifecycle; a client identity may only ever
    // decide a client-approval stage (the service enforces which).
    if (identity.role === 'client' && body.to !== 'approved') {
      throw forbidden('A client identity may only record an approval decision.');
    }
    const result = await transition((await db()), {
      clientId, stageKey, to: body.to,
      actorId: identity.userId, actorRole: identity.role,
      reason: body.reason, note: body.note, exception: body.exception,
    });
    return ok({
      replay: result.replay,
      stage: result.stage.key,
      state: result.instance.state,
      lifecycle: await lifecycleView((await db()), clientId),
    });
  });

  app.post('/api/clients/:id/lifecycle/:stageKey/evidence', async (req) => {
    const { id: clientId, stageKey } = req.params as { id: string; stageKey: string };
    const identity = await currentIdentity(req);
    // Evidence is a write, so it needs the same tenancy check as the read route.
    // Without this, a client identity for one tenant could file evidence against
    // another tenant's lifecycle: the row is created on a client nobody in the
    // request is authorised for.
    await assertClientInScope((await db()), identity, clientId);
    const body = req.body as { kind?: unknown; label?: unknown; url?: unknown; body?: unknown };
    if (typeof body.kind !== 'string' || !body.kind.trim() || typeof body.label !== 'string' || !body.label.trim()) {
      throw badRequest('Evidence needs a kind and a label, both non-empty strings');
    }
    if (body.url !== undefined && typeof body.url !== 'string') throw badRequest('Evidence url must be a string');
    if (body.body !== undefined && typeof body.body !== 'string') throw badRequest('Evidence body must be a string');
    const row = await addEvidence((await db()), {
      clientId, stageKey, kind: body.kind, label: body.label,
      url: body.url as string | undefined, body: body.body as string | undefined, actorId: identity.userId,
    });
    return ok({ evidence: row, lifecycle: await lifecycleView((await db()), clientId) });
  });

  /** Lifecycle dashboard: every client's position, for the delivery board. */
  app.get('/api/lifecycle', async (req) => {
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    const cw = clientsWhere(scope, 'c');
    const clients = await (await db()).all<Record<string, any>>(
      `SELECT c.id, c.name, c.initials, c.accent_color FROM clients c WHERE (${cw.sql}) ORDER BY c.name`,
      cw.params,
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const c of clients) {
      const view = await lifecycleView((await db()), c.id);
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
    return ok({ clients: rows, stages: await getStages((await db())) });
  });

  /** Clock history for one timer — every pause, resume and verdict. */
  app.get('/api/clocks/timers/:id/history', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const timer = await assertTimerInScope((await db()), await currentIdentity(req), timerId);
    return ok({ timer, events: await clockHistory((await db()), timerId) });
  });

  /** Pause a clock while waiting on a client (authorised, categorised, logged). */
  app.post('/api/clocks/timers/:id/pause', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    const body = req.body as { reason?: string; category?: 'client' | 'internal' | 'vendor' };
    if (!body.reason?.trim()) throw badRequest('A pause needs a reason — it is excluded from the elapsed measurement.');
    const timer = await assertTimerInScope((await db()), identity, timerId);
    if (timer.outcome !== 'running') throw badRequest(`Only a running clock can be paused (this one is ${timer.outcome}).`);
    const category = body.category ?? 'client';
    const paused = await pauseTimerFor((await db()), timer.entity_type, timer.entity_id, body.reason.trim(), {
      category, actorId: identity.userId,
    });
    return ok({ timer: paused, events: await clockHistory((await db()), timerId) });
  });

  app.post('/api/clocks/timers/:id/resume', async (req) => {
    const { id: timerId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    const timer = await assertTimerInScope((await db()), identity, timerId);
    if (!timer.paused_at) throw badRequest('This clock is not paused.');
    const resumed = await resumeTimerFor((await db()), timer.entity_type, timer.entity_id, { actorId: identity.userId });
    return ok({ timer: resumed, events: await clockHistory((await db()), timerId) });
  });


  /* -------------------------------------------------------- communications -- */
  /**
   * Client communications (R43). Delivery is provider-backed and the provider is
   * not configured in this deployment, so the honest states are draft / recorded
   * / unconfigured. No endpoint here can claim a message was sent.
   */
  app.get('/api/comms/providers', async () => ok({ providers: providerStatuses() }));

  app.get('/api/comms', async (req) => {
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    const clientId = queryStr(req, 'clientId');
    const cw = clientsWhere(scope, 'c');
    if (clientId) {
      const visible = await (await db()).get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [clientId, ...cw.params]);
      if (!(visible?.c ?? 0)) throw notFound('Client not found');
      return ok(await commsOverview((await db()), clientId));
    }
    // Without a client filter, only return threads on visible clients.
    const threads = await (await db()).all<Record<string, any>>(
      `SELECT t.*, c.name AS client_name,
              (SELECT COUNT(*) FROM comm_messages m WHERE m.thread_id = t.id) AS message_count
         FROM comm_threads t JOIN clients c ON c.id = t.client_id
        WHERE (${cw.sql}) ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC LIMIT 100`,
      cw.params,
    );
    return ok({ threads, providers: providerStatuses() });
  });

  app.get('/api/comms/threads/:id', async (req) => {
    const { id: threadId } = req.params as { id: string };
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    const thread = await (await db()).get<{ client_id: string }>('SELECT client_id FROM comm_threads WHERE id = ?', [threadId]);
    if (!thread) throw notFound('Thread not found');
    const cw = clientsWhere(scope, 'c');
    const visible = await (await db()).get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [thread.client_id, ...cw.params]);
    if (!(visible?.c ?? 0)) throw notFound('Thread not found');
    return ok(await threadDetail((await db()), threadId));
  });

  app.post('/api/comms/threads', async (req, reply) => {
    const identity = await currentIdentity(req);
    const scope = await resolveReadScope((await db()), identity);
    const body = req.body as { clientId?: string; projectId?: string; channel?: string; subject?: string };
    if (!body.clientId || !body.channel || !body.subject) throw badRequest('clientId, channel and subject are required');
    const cw = clientsWhere(scope, 'c');
    const visible = await (await db()).get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [body.clientId, ...cw.params]);
    if (!(visible?.c ?? 0)) throw notFound('Client not found');
    if (body.projectId) await assertProjectInScope(scope, body.projectId);
    const thread = await createThread((await db()), {
      clientId: body.clientId, projectId: body.projectId, channel: body.channel,
      subject: body.subject, actorId: identity.userId,
    });
    reply.code(201);
    return ok(thread);
  });

  app.post('/api/comms/threads/:id/messages', async (req, reply) => {
    const { id: threadId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    const scope = await resolveReadScope((await db()), identity);
    const body = req.body as { body?: string; direction?: string; mode?: string; recipient?: string; attachments?: string };
    const thread = await (await db()).get<{ client_id: string }>('SELECT client_id FROM comm_threads WHERE id = ?', [threadId]);
    if (!thread) throw notFound('Thread not found');
    const cw = clientsWhere(scope, 'c');
    const visible = await (await db()).get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [thread.client_id, ...cw.params]);
    if (!(visible?.c ?? 0)) throw notFound('Thread not found');
    if (!body.body) throw badRequest('A message needs a body');
    const mode = (body.mode ?? 'draft') as 'draft' | 'send' | 'record';
    if (!['draft', 'send', 'record'].includes(mode)) throw badRequest('mode must be draft, send or record');
    const result = await addMessage((await db()), {
      threadId, direction: (body.direction ?? 'outbound') as any, body: body.body,
      actorId: identity.userId, authorName: identity.name ?? '', mode,
      recipient: body.recipient, attachments: body.attachments,
    });
    reply.code(201);
    return ok(result);
  });

  app.post('/api/comms/follow-ups', async (req, reply) => {
    const identity = await currentIdentity(req);
    const scope = await resolveReadScope((await db()), identity);
    const body = req.body as { clientId?: string; projectId?: string; threadId?: string; action?: string; ownerId?: string; dueAt?: string };
    if (!body.clientId || !body.action) throw badRequest('clientId and action are required');
    const cw = clientsWhere(scope, 'c');
    const visible = await (await db()).get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [body.clientId, ...cw.params]);
    if (!(visible?.c ?? 0)) throw notFound('Client not found');
    if (body.projectId) await assertProjectInScope(scope, body.projectId);
    const followUp = await addFollowUp((await db()), {
      clientId: body.clientId, projectId: body.projectId, threadId: body.threadId,
      action: body.action, ownerId: body.ownerId, dueAt: body.dueAt,
    });
    reply.code(201);
    return ok(followUp);
  });

  app.post('/api/meetings', async (req, reply) => {
    const identity = await currentIdentity(req);
    const scope = await resolveReadScope((await db()), identity);
    const body = req.body as Record<string, any>;
    if (!body.title || !body.occurredAt) throw badRequest('title and occurredAt are required');
    /*
     * `occurredAt` is a timestamp written straight to a column, and the oversized probe
     * put 50,000 characters there — the driver rejected it and the caller saw a 500.
     * A date that cannot be parsed is a caller mistake; it is checked for shape here,
     * which also stops a bogus date reaching the timeline the calendar reads.
     */
    if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest('title must be a non-empty string');
    if (body.title.length > 300) throw badRequest('title must be 300 characters or fewer');
    if (typeof body.occurredAt !== 'string' || body.occurredAt.length > 40) {
      throw badRequest('occurredAt must be an ISO-8601 timestamp');
    }
    if (Number.isNaN(Date.parse(body.occurredAt))) throw badRequest('occurredAt must be a parseable ISO-8601 timestamp');
    for (const field of ['attendees', 'agenda', 'notes', 'decisions', 'followUps'] as const) {
      const v = body[field];
      if (v !== undefined && typeof v !== 'string') throw badRequest(`${field} must be a string`);
      if (typeof v === 'string' && v.length > 20000) throw badRequest(`${field} must be 20000 characters or fewer`);
    }
    if (body.projectId) await assertProjectInScope(scope, body.projectId);
    const note = await addMeetingNote((await db()), {
      projectId: body.projectId, clientId: body.clientId, title: body.title,
      occurredAt: body.occurredAt, attendees: body.attendees, agenda: body.agenda,
      notes: body.notes, decisions: body.decisions, followUps: body.followUps,
      ownerId: body.ownerId, clientVisible: !!body.clientVisible, actorId: identity.userId,
    });
    reply.code(201);
    return ok(note);
  });

  /* --------------------------------------------------------------- legal -- */
  /**
   * Legal and commercial records (R44). Execution requires evidence of a signed
   * copy; there is no e-signature provider, and the service refuses to pretend.
   */
  app.get('/api/legal/esign', async () => ok({ esign: esignStatus() }));

  app.get('/api/legal', async (req) => {
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    const cw = clientsWhere(scope, 'c');
    const clientId = queryStr(req, 'clientId');
    const kind = queryStr(req, 'kind');
    const params: unknown[] = [...cw.params];
    let sql = `SELECT d.*, c.name AS client_name FROM legal_documents d JOIN clients c ON c.id = d.client_id
                WHERE (${cw.sql})`;
    if (clientId) { sql += ' AND d.client_id = ?'; params.push(clientId); }
    if (kind) { sql += ' AND d.kind = ?'; params.push(kind); }
    sql += ' ORDER BY d.kind, d.version DESC';
    const rows = await (await db()).all<Record<string, any>>(sql, params);
    return ok({ documents: rows, expiring: await expiringDocuments((await db()), 60), esign: esignStatus() });
  });

  app.get('/api/legal/:id', async (req) => {
    const { id: documentId } = req.params as { id: string };
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    const found = await (await db()).get<{ client_id: string }>('SELECT client_id FROM legal_documents WHERE id = ?', [documentId]);
    if (!found) throw notFound('Document not found');
    const cw = clientsWhere(scope, 'c');
    const visible = await (await db()).get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [found.client_id, ...cw.params]);
    if (!(visible?.c ?? 0)) throw notFound('Document not found');
    return ok(await documentDetail((await db()), documentId));
  });

  app.post('/api/legal', async (req, reply) => {
    const identity = await currentIdentity(req);
    if (!['admin', 'lead'].includes(identity.role)) throw forbidden('Only an admin or lead may create a legal document.');
    const scope = await resolveReadScope((await db()), identity);
    const body = req.body as Record<string, any>;
    if (!body.clientId || !body.kind || !body.title) throw badRequest('clientId, kind and title are required');
    const cw = clientsWhere(scope, 'c');
    const visible = await (await db()).get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM clients c WHERE c.id = ? AND (${cw.sql})`, [body.clientId, ...cw.params]);
    if (!(visible?.c ?? 0)) throw notFound('Client not found');
    const detail = await createDocument((await db()), {
      clientId: body.clientId, kind: body.kind, title: body.title, storageUrl: body.storageUrl,
      valueCents: body.valueCents, currency: body.currency, effectiveAt: body.effectiveAt,
      expiresAt: body.expiresAt, renewalNoticeDays: body.renewalNoticeDays,
      supersedesId: body.supersedesId, actorId: identity.userId,
    });
    reply.code(201);
    return ok(detail);
  });

  app.post('/api/legal/:id/signatories', async (req, reply) => {
    const { id: documentId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    if (!['admin', 'lead'].includes(identity.role)) throw forbidden('Only an admin or lead may record signatories.');
    const body = req.body as { party?: 'agency' | 'client'; fullName?: string; email?: string; title?: string };
    if (!body.party || !body.fullName) throw badRequest('party and fullName are required');
    // `party` is CHECK-constrained (`agency|client`); the free-text fields are bounded so
    // an oversized probe is a 400 rather than a driver-level error surfaced as 500.
    if (!['agency', 'client'].includes(String(body.party))) throw badRequest('party must be agency or client');
    if (typeof body.fullName !== 'string' || !body.fullName.trim()) throw badRequest('fullName must be a non-empty string');
    for (const [field, max] of [['fullName', 200], ['email', 320], ['title', 200]] as const) {
      const v = (body as Record<string, unknown>)[field];
      if (v !== undefined && typeof v !== 'string') throw badRequest(`${field} must be a string`);
      if (typeof v === 'string' && v.length > max) throw badRequest(`${field} must be ${max} characters or fewer`);
    }
    const signatory = await addSignatory((await db()), {
      documentId, party: body.party, fullName: body.fullName, email: body.email, title: body.title, actorId: identity.userId,
    });
    reply.code(201);
    return ok(signatory);
  });

  app.post('/api/legal/:id/signatories/:signatoryId/decision', async (req) => {
    const { id: documentId, signatoryId } = req.params as { id: string; signatoryId: string };
    const identity = await currentIdentity(req);
    const body = req.body as { state?: 'approved' | 'declined' | 'signed'; evidenceUrl?: string; reason?: string };
    if (!body.state) throw badRequest('state is required');

    /*
     * A signature decision is the most consequential write in the application, so it
     * needs a tenancy check before anything else. The service verifies that the
     * signatory belongs to the document — that is a consistency check, not an
     * authorisation one — and it was the only check present. Any authenticated identity
     * could therefore approve, decline or sign on another tenant's contract.
     */
    const sigDoc = await (await db()).get<{ client_id: string | null }>(
      'SELECT client_id FROM legal_documents WHERE id = ?',
      [documentId],
    );
    if (!sigDoc) throw notFound('Legal document not found');
    if (sigDoc.client_id) await assertClientInScope((await db()), identity, sigDoc.client_id);

    const detail = await recordSignatoryDecision((await db()), {
      documentId, signatoryId, state: body.state, evidenceUrl: body.evidenceUrl,
      reason: body.reason, actorId: identity.userId,
    });
    return ok(detail);
  });

  app.post('/api/legal/:id/status', async (req) => {
    const { id: documentId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    if (!['admin', 'lead'].includes(identity.role)) throw forbidden('Only an admin or lead may change a legal document status.');
    const body = req.body as { status?: string; reason?: string };
    if (!body.status) throw badRequest('status is required');
    /*
     * Role is not scope. A lead of one client could change another client's contract
     * status — approving, rejecting or expiring a document they have no relationship
     * with. The document's client decides; the scope answers for the caller.
     */
    const doc = await (await db()).get<{ client_id: string | null }>(
      'SELECT client_id FROM legal_documents WHERE id = ?',
      [documentId],
    );
    if (!doc) throw notFound('Legal document not found');
    if (doc.client_id) await assertClientInScope((await db()), identity, doc.client_id);
    return ok(await setDocumentStatus((await db()), { documentId, status: body.status, reason: body.reason, actorId: identity.userId }));
  });

  app.post('/api/legal/:id/upload', async (req) => {
    const { id: documentId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    if (!['admin', 'lead'].includes(identity.role)) throw forbidden('Only an admin or lead may file a signed copy.');
    const body = req.body as { storageUrl?: string; note?: string };
    if (!body.storageUrl) throw badRequest('storageUrl is required — this records where the signed copy lives.');
    return ok(await uploadSignedCopy((await db()), { documentId, storageUrl: body.storageUrl, note: body.note, actorId: identity.userId }));
  });

  app.post('/api/change-requests', async (req, reply) => {
    const identity = await currentIdentity(req);
    const body = req.body as Record<string, any>;
    if (!body.clientId || !body.title) throw badRequest('clientId and title are required');
    const scope = await resolveReadScope((await db()), identity);
    if (body.projectId) await assertProjectInScope(scope, body.projectId);
    reply.code(201);
    return ok(await createChangeRequest((await db()), {
      clientId: body.clientId, projectId: body.projectId, documentId: body.documentId,
      title: body.title, description: body.description, impactValueCents: body.impactValueCents,
      impactDays: body.impactDays, actorId: identity.userId,
    }));
  });

  app.post('/api/change-requests/:id/decision', async (req) => {
    const { id: changeRequestId } = req.params as { id: string };
    const identity = await currentIdentity(req);
    if (!['admin', 'lead'].includes(identity.role)) throw forbidden('Only an admin or lead may decide a change request.');
    // A change request is a commercial commitment on a client, so the id must be
    // reachable in the caller's scope before it is decided.
    const owner = await (await db()).get<{ client_id: string }>('SELECT client_id FROM change_requests WHERE id = ?', [changeRequestId]);
    if (!owner) throw notFound('Change request not found');
    await assertClientInScope((await db()), identity, owner.client_id);
    const body = req.body as { decision?: 'approved' | 'rejected'; reason?: string };
    if (!body.decision) throw badRequest('decision is required');
    return ok(await decideChangeRequest((await db()), {
      changeRequestId, decision: body.decision, reason: body.reason, actorId: identity.userId,
    }));
  });

  /* ----------------------------------------------------------- documents -- */
  app.get('/api/docs', async (req) => {
    const projectId = queryStr(req, 'projectId');
    const scope = await resolveReadScope((await db()), await currentIdentity(req));
    if (projectId) await assertProjectInScope(scope, projectId);
    const dw = docsWhere(scope, 'd');
    const rows = projectId
      ? await (await db()).all<Record<string, any>>(
          `SELECT d.*, p.name AS project_name FROM docs d LEFT JOIN projects p ON p.id = d.project_id
            WHERE d.project_id = ? AND (${dw.sql}) ORDER BY d.updated_at DESC`,
          [projectId, ...dw.params],
        )
      : await (await db()).all<Record<string, any>>(
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

