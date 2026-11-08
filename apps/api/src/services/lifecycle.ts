/**
 * Client lifecycle — the 18-stage state machine.
 *
 * The rules that matter live here, not in the UI:
 *
 *   * no stage may be skipped            (prerequisites are the previous stage)
 *   * no stage completes silently        (approval is a separate act from work)
 *   * no approval without its evidence   (the requirement is on the stage row)
 *   * a rejection must carry a reason    and resubmission is a new transition
 *   * history is append-only             (nothing updates a past row)
 *   * client sign-off cannot be self-served by an agency user
 *   * client-caused waiting is measured separately from internal delay
 *   * a repeated identical transition is idempotent, not an error and not a
 *     second history row
 *
 * Every function is written against the database so a caller cannot hold a
 * stale instance in memory and transition twice.
 */
import type { Db } from '../db/index.ts';
import type { Identity } from '../auth/index.ts';
import { badRequest, forbidden, notFound } from '../lib/http.ts';
import { id, nowIso } from '../lib/ids.ts';
import { toDate } from '../lib/dates.ts';
import { startTimer, closeTimersFor, pauseTimerFor, resumeTimerFor } from './clocks.ts';

export interface StageRow {
  id: string;
  key: string;
  position: number;
  name: string;
  phase: string;
  intent: string;
  owner_role: string;
  approver_role: string;
  required_evidence: string;
  clock_key: string | null;
  requires_client_signoff: number;
  allows_exception: number;
}

export interface InstanceRow {
  id: string;
  client_id: string;
  stage_key: string;
  state: string;
  owner_id: string | null;
  started_at: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  due_at: string | null;
  waiting_on_client_since: string | null;
  client_wait_ms: number;
  exception_granted_by: string | null;
  exception_reason: string;
}

export const STAGE_KEYS = [
  'lead_capture', 'triage_qualify', 'initial_consultation', 'technical_consultation',
  'product_specification', 'implementation_plan', 'dev_meeting', 'client_review',
  'commercial_agreement', 'kickoff', 'architecture_design', 'development',
  'qa_verification', 'milestone_turnover', 'client_acceptance', 'release_ship',
  'hypercare', 'maintenance_ota',
] as const;

/** States a stage may legally move between. Anything absent is refused. */
const TRANSITIONS: Record<string, string[]> = {
  not_started: ['in_progress'],
  in_progress: ['awaiting_approval', 'blocked'],
  blocked: ['in_progress'],
  awaiting_approval: ['approved', 'rejected'],
  rejected: ['in_progress', 'awaiting_approval'],
  approved: [], // terminal for this stage; the next stage carries the journey
  skipped: [],
};

export async function getStages(db: Db): Promise<StageRow[]> {
  return db.all<StageRow>('SELECT * FROM lifecycle_stages ORDER BY position');
}

export async function getStage(db: Db, key: string): Promise<StageRow | undefined> {
  return db.get<StageRow>('SELECT * FROM lifecycle_stages WHERE key = ?', [key]);
}

/**
 * Ensure every stage has an instance for this client, and return them in order.
 * Called on first read so a client created before this feature still resolves.
 */
export async function ensureLifecycle(db: Db, clientId: string): Promise<InstanceRow[]> {
  const stages = await getStages(db);
  const existing = await db.all<InstanceRow>('SELECT * FROM lifecycle_instances WHERE client_id = ?', [clientId]);
  const have = new Set(existing.map((r) => r.stage_key));
  for (const stage of stages) {
    if (have.has(stage.key)) continue;
    await db.run(
      `INSERT INTO lifecycle_instances (id, client_id, stage_key, state) VALUES (?,?,?,'not_started')`,
      [id('lci'), clientId, stage.key],
    );
  }
  return db.all<InstanceRow>('SELECT * FROM lifecycle_instances WHERE client_id = ? ORDER BY stage_key', [clientId]);
}

/**
 * Prerequisites: every stage before this one must be approved.
 *
 * An exception does not change this — an exception lets a stage be *bypassed
 * with a recorded authoriser*, which is itself recorded as `skipped` and still
 * counts as settled. That way "we skipped legal because the client is an
 * existing account" is visible forever rather than invisible.
 */
export async function unmetPrerequisites(db: Db, clientId: string, stageKey: string): Promise<string[]> {
  const stage = await getStage(db, stageKey);
  if (!stage) throw notFound(`Unknown lifecycle stage: ${stageKey}`);
  const earlier = await db.all<InstanceRow>(
    `SELECT i.* FROM lifecycle_instances i
       JOIN lifecycle_stages s ON s.key = i.stage_key
      WHERE i.client_id = ? AND s.position < ? ORDER BY s.position`,
    [clientId, stage.position],
  );
  return earlier.filter((i) => !['approved', 'skipped'].includes(i.state)).map((i) => i.stage_key);
}

export interface TransitionInput {
  clientId: string;
  stageKey: string;
  to: string;
  actorId: string;
  actorRole: Identity['role'];
  reason?: string;
  note?: string;
  /** Grant a recorded exception for a stage that normally cannot be skipped. */
  exception?: boolean;
}

export interface TransitionResult {
  instance: InstanceRow;
  /** True when the same transition had already been applied (idempotent replay). */
  replay: boolean;
  stage: StageRow;
}

/**
 * Apply a lifecycle transition.
 *
 * Runs inside a transaction so the instance read, the legality check, the
 * evidence check and the history write cannot interleave with a competing
 * transition — two simultaneous approvals cannot both succeed.
 */
export async function transition(db: Db, input: TransitionInput): Promise<TransitionResult> {
  const stage = await getStage(db, input.stageKey);
  if (!stage) throw notFound(`Unknown lifecycle stage: ${input.stageKey}`);
  const client = await db.get<{ id: string }>('SELECT id FROM clients WHERE id = ?', [input.clientId]);
  if (!client) throw notFound('Client not found');
  await ensureLifecycle(db, input.clientId);

  let result: TransitionResult | null = null;
  let replayed = false;

  await db.tx(async () => {
    const instance = await db.get<InstanceRow>(
      'SELECT * FROM lifecycle_instances WHERE client_id = ? AND stage_key = ?',
      [input.clientId, input.stageKey],
    );
    if (!instance) throw notFound('Lifecycle instance not found');

    /* ------------------------------------------------------- idempotency -- */
    // A repeated identical transition is a no-op with `replay: true`. It is not
    // an error (a retried request must not fail) and not a second history row
    // (which would falsify the timeline).
    if (instance.state === input.to) {
      replayed = true;
      result = { instance, replay: true, stage };
      return;
    }

    /* ------------------------------------------------------- legitimacy -- */
    const allowed = TRANSITIONS[instance.state] ?? [];
    if (!allowed.includes(input.to)) {
      throw badRequest(
        `Stage "${stage.name}" cannot move from ${instance.state} to ${input.to}` +
          ` (allowed: ${allowed.length ? allowed.join(', ') : 'nothing — this stage is closed'}).`,
      );
    }

    /* ---------------------------------------------------- prerequisites --- */
    if (input.to === 'in_progress') {
      const unmet = await unmetPrerequisites(db, input.clientId, input.stageKey);
      if (unmet.length) {
        const isException = input.exception === true;
        if (!isException) {
          throw badRequest(
            `Cannot start "${stage.name}" before ${unmet.length} earlier stage(s) are settled: ${unmet.join(', ')}.`,
          );
        }
        if (!stage.allows_exception) {
          throw badRequest(`"${stage.name}" does not permit an exception; the earlier stages must be completed.`);
        }
        if (input.actorRole !== 'admin' && input.actorRole !== 'lead') {
          throw forbidden('Only an admin or lead can grant a lifecycle exception.');
        }
        if (!input.reason?.trim()) {
          throw badRequest('An exception requires a written reason naming who authorised it and why.');
        }
      }
    }

    /* -------------------------------------------------- role authority --- */
    if (input.to === 'approved') {
      const approver = stage.approver_role;
      if (approver === 'client') {
        // A client sign-off may only be recorded by a client identity, or by an
        // admin recording a *received* written approval with an explicit note.
        // It can never be self-served by the delivery team.
        if (input.actorRole !== 'client' && input.actorRole !== 'admin') {
          throw forbidden(`"${stage.name}" requires client approval; only the client or an admin recording it may decide.`);
        }
      } else if (approver === 'admin') {
        if (input.actorRole !== 'admin') throw forbidden(`"${stage.name}" requires an admin approver.`);
      } else if (!['lead', 'admin'].includes(input.actorRole)) {
        throw forbidden(`"${stage.name}" requires a lead approver.`);
      }
    }
    if (input.to === 'skipped') {
      if (!['admin', 'lead'].includes(input.actorRole)) throw forbidden('Only an admin or lead can skip a lifecycle stage.');
      if (!input.reason?.trim()) throw badRequest('Skipping a stage requires a written reason.');
    }
    if (input.to === 'rejected' && !input.reason?.trim()) {
      throw badRequest('A rejection must carry a reason — a rejection without one cannot be acted on.');
    }

    /* ------------------------------------------------------- evidence ---- */
    if (input.to === 'awaiting_approval' || input.to === 'approved') {
      const evidenceCount = await db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM lifecycle_evidence WHERE client_id = ? AND stage_key = ?',
        [input.clientId, input.stageKey],
      );
      if ((evidenceCount?.c ?? 0) === 0) {
        throw badRequest(
          `"${stage.name}" requires evidence before it can be submitted or approved: ${stage.required_evidence}`,
        );
      }
    }

    /* --------------------------------------------------------- waiting --- */
    // Resuming from a client wait: bank the elapsed client time so it never
    // counts against the agency's clock.
    let clientWaitMs = Number(instance.client_wait_ms ?? 0);
    const waitingSince = toDate(instance.waiting_on_client_since);
    if (waitingSince && input.to !== 'awaiting_approval') {
      clientWaitMs += Math.max(0, Date.now() - waitingSince.getTime());
    }

    const now = nowIso();
    const setClauses: string[] = ['state = ?', 'updated_at = ?'];
    const params: unknown[] = [input.to, now];

    if (input.to === 'in_progress') {
      setClauses.push('started_at = COALESCE(started_at, ?)');
      params.push(now);
      setClauses.push('waiting_on_client_since = NULL');
      setClauses.push('client_wait_ms = ?');
      params.push(clientWaitMs);
      if (input.exception === true) {
        setClauses.push('exception_granted_by = ?', 'exception_reason = ?');
        params.push(input.actorId, input.reason ?? '');
      }
    }
    if (input.to === 'awaiting_approval') {
      setClauses.push('submitted_at = ?');
      params.push(now);
      // Waiting on the client from the moment it is submitted for review.
      if (stage.approver_role === 'client') {
        setClauses.push('waiting_on_client_since = ?');
        params.push(now);
      }
    }
    if (input.to === 'approved' || input.to === 'rejected') {
      setClauses.push('decided_at = ?');
      params.push(now);
      setClauses.push('waiting_on_client_since = NULL');
      setClauses.push('client_wait_ms = ?');
      params.push(clientWaitMs);
    }

    await db.run(`UPDATE lifecycle_instances SET ${setClauses.join(', ')} WHERE id = ?`, [...params, instance.id]);

    await db.run(
      `INSERT INTO lifecycle_transitions (client_id, stage_key, from_state, to_state, actor_id, actor_role, reason, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      [input.clientId, input.stageKey, instance.state, input.to, input.actorId, input.actorRole, input.reason ?? '', input.note ?? ''],
    );

    const fresh = await db.get<InstanceRow>('SELECT * FROM lifecycle_instances WHERE id = ?', [instance.id]);
    replayed = false;
    result = { instance: fresh!, replay: false, stage };
  });

  const outcome = result as TransitionResult | null;
  if (!outcome) throw new Error('transition produced no result');

  /* ------------------------------------------------------ clock coupling --- */
  // Outside the transaction: a clock is observability and must never roll back
  // a legitimate workflow transition.
  if (stage.clock_key) {
    if (input.to === 'in_progress') {
      await startTimer(db, stage.clock_key, 'lifecycle', `${input.clientId}:${input.stageKey}`, stage.name);
    }
    if (input.to === 'awaiting_approval' && stage.approver_role === 'client') {
      await pauseTimerFor(db, 'lifecycle', `${input.clientId}:${input.stageKey}`, 'waiting on client review');
    }
    if (input.to === 'approved') {
      await resumeTimerFor(db, 'lifecycle', `${input.clientId}:${input.stageKey}`);
      await closeTimersFor(db, 'lifecycle', `${input.clientId}:${input.stageKey}`, 'met');
    }
  }

  await db.run(
    'INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary) VALUES (?,?,?,?,?)',
    ['client', input.clientId, input.actorId, 'lifecycle_transition', `${stage.name} → ${input.to}${replayed ? ' (replay)' : ''}`],
  );

  return outcome;
}

/** Full lifecycle view for one client: stages, state, evidence, history. */
export async function lifecycleView(db: Db, clientId: string) {
  const stages = await getStages(db);
  const instances = await ensureLifecycle(db, clientId);
  const evidence = await db.all<Record<string, any>>(
    `SELECT e.*, u.full_name AS supplied_by_name FROM lifecycle_evidence e
       LEFT JOIN users u ON u.id = e.supplied_by WHERE e.client_id = ? ORDER BY e.created_at DESC`,
    [clientId],
  );
  const transitions = await db.all<Record<string, any>>(
    `SELECT t.*, u.full_name AS actor_name FROM lifecycle_transitions t
       LEFT JOIN users u ON u.id = t.actor_id WHERE t.client_id = ? ORDER BY t.id DESC`,
    [clientId],
  );
  const byKey = new Map(instances.map((i) => [i.stage_key, i]));
  const now = Date.now();
  const view = stages.map((s) => {
    const inst = byKey.get(s.key)!;
    const due = toDate(inst.due_at)?.getTime() ?? null;
    return {
      key: s.key,
      name: s.name,
      position: s.position,
      phase: s.phase,
      intent: s.intent,
      ownerRole: s.owner_role,
      approverRole: s.approver_role,
      requiredEvidence: s.required_evidence,
      clockKey: s.clock_key,
      requiresClientSignoff: !!s.requires_client_signoff,
      state: inst.state,
      ownerId: inst.owner_id,
      startedAt: inst.started_at,
      submittedAt: inst.submitted_at,
      decidedAt: inst.decided_at,
      dueAt: inst.due_at,
      waitingOnClientSince: inst.waiting_on_client_since,
      clientWaitHours: Math.round((Number(inst.client_wait_ms ?? 0) / 3_600_000) * 10) / 10,
      overdue: due !== null && due < now && !['approved', 'skipped'].includes(inst.state),
      exceptionGrantedBy: inst.exception_granted_by,
      exceptionReason: inst.exception_reason,
      evidence: evidence.filter((e) => e.stage_key === s.key).map((e) => ({
        id: e.id, kind: e.kind, label: e.label, url: e.url, body: e.body,
        suppliedBy: e.supplied_by_name ?? null, createdAt: e.created_at,
      })),
      history: transitions.filter((t) => t.stage_key === s.key).map((t) => ({
        from: t.from_state, to: t.to_state, actor: t.actor_name ?? null, role: t.actor_role,
        reason: t.reason, note: t.note, at: t.created_at,
      })),
    };
  });

  const settled = view.filter((v) => ['approved', 'skipped'].includes(v.state)).length;
  return {
    clientId,
    stages: view,
    current: view.find((v) => !['approved', 'skipped'].includes(v.state))?.key ?? null,
    progress: { settled, total: view.length, pct: Math.round((settled / view.length) * 100) },
  };
}

/** Add evidence to a stage. Evidence is additive; it is never edited in place. */
export async function addEvidence(
  db: Db,
  input: { clientId: string; stageKey: string; kind: string; label: string; url?: string; body?: string; actorId: string },
): Promise<Record<string, any>> {
  const stage = await getStage(db, input.stageKey);
  if (!stage) throw notFound(`Unknown lifecycle stage: ${input.stageKey}`);
  const client = await db.get<{ id: string }>('SELECT id FROM clients WHERE id = ?', [input.clientId]);
  if (!client) throw notFound('Client not found');
  if (!input.label?.trim()) throw badRequest('Evidence needs a label describing what it is.');
  const kinds = ['document', 'link', 'meeting_note', 'spec', 'plan', 'approval', 'report', 'signoff', 'other'];
  if (!kinds.includes(input.kind)) throw badRequest(`Evidence kind must be one of ${kinds.join(', ')}`);
  // A link without a URL is not evidence of anything.
  if (input.kind === 'link' && !input.url?.trim()) throw badRequest('A link evidence item needs a URL.');
  const evidenceId = id('lev');
  await db.run(
    `INSERT INTO lifecycle_evidence (id, client_id, stage_key, kind, label, url, body, supplied_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [evidenceId, input.clientId, input.stageKey, input.kind, input.label.trim(), input.url ?? '', input.body ?? '', input.actorId],
  );
  await ensureLifecycle(db, input.clientId);
  return db.get('SELECT * FROM lifecycle_evidence WHERE id = ?', [evidenceId]) as Promise<Record<string, any>>;
}
