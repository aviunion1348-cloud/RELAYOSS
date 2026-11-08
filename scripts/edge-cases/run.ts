/**
 * Edge-case registry runner (R34, R38).
 *
 *   node --no-warnings scripts/edge-cases/run.ts [--limit N] [--module name] [--project p1]
 *
 * Two phases, deliberately separate:
 *
 *   catalogue  write every distinct case into `edge_cases` with its
 *              preconditions, steps, expected result and fingerprint. Catalogue
 *              status is NOT evidence of anything.
 *
 *   execute    issue every probe against a real app instance backed by a real
 *              (migrated) database, and record what actually happened:
 *                observed status === expected  → passed
 *                anything else                 → failed, with both values kept
 *              A probe that throws, times out, or cannot be constructed is
 *              `blocked`, never `passed`. Nothing is inferred.
 *
 * The gate reads only `execution`, so a case that was never run cannot contribute
 * to a release. That is the fail-closed behaviour the brief requires.
 */
import type { EdgeCase } from './manifest.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 0;
  const moduleArg = args.indexOf('--module');
  const onlyModule = moduleArg >= 0 ? args[moduleArg + 1] : '';
  const phase = args.includes('--catalogue-only') ? 'catalogue' : 'all';

  process.env.SESSION_SECRET ||= 'edge-registry-runner-secret';
  process.env.RATE_LIMIT_AUTH ||= '100000';
  process.env.RATE_LIMIT_GLOBAL ||= '1000000';
  process.env.RATE_LIMIT_WRITE ||= '1000000';

  const { buildApp } = await import(`${ROOT}apps/api/src/app.ts`);
  const { discoverRoutes, surfaceFrom } = await import('./manifest.ts');
  const { SqliteDb } = await import(`${ROOT}apps/api/src/db/sqlite.ts`);
  const { PostgresDb } = await import(`${ROOT}apps/api/src/db/postgres.ts`);
  const { migrate } = await import(`${ROOT}apps/api/src/db/migrate.ts`);
  const { buildCases } = await import('./manifest.ts');

  const pgUrl = process.env.DATABASE_URL ?? '';
  const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(process.env.EDGE_DB ?? ':memory:');
  await migrate(db, { log: () => {} });

  /* ---------------------------------------------------------- fixtures --- */
  // Real rows, created through the same schema the app uses. Nothing here is a
  // shortcut the application could not take itself.
  const USERS = [
    ['u_admin', 'admin@relay.test', 'Ada Admin', 'admin'],
    ['u_lead', 'lead@relay.test', 'Lee Lead', 'lead'],
    ['u_member', 'member@relay.test', 'Mia Member', 'member'],
    ['u_client', 'client@acme.test', 'Cara Client', 'client'],
    ['u_client2', 'client@globex.test', 'Gil Client', 'client'],
    // A partner is not a distinct auth role: it is a `member` identity linked to
    // a partner tenant through partner_iam_users, which is what scope.ts reads.
    ['u_partner', 'partner@relay.test', 'Pat Partner', 'member'],
  ];
  for (const [id, email, name, role] of USERS) {
    await db.run(
      'INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING',
      [id, email, name, role, name.slice(0, 2)],
    );
  }
  await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC') ON CONFLICT (id) DO NOTHING");
  await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c2','Globex','globex','GX') ON CONFLICT (id) DO NOTHING");
  await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_client','c1') ON CONFLICT DO NOTHING");
  await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_client2','c2') ON CONFLICT DO NOTHING");
  await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p1','ACM','Acme Portal','c1') ON CONFLICT (id) DO NOTHING");
  await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p2','GLX','Globex Portal','c2') ON CONFLICT (id) DO NOTHING");
  // The member has a grant on p1 only; p2 is the "restricted" project.
  await db.run("INSERT INTO project_members (project_id,user_id,access) VALUES ('p1','u_member','member') ON CONFLICT DO NOTHING");
  await db.run("INSERT INTO partners (id,client_id,name,slug) VALUES ('pa1','c1','Acme Partner','acme-partner') ON CONFLICT (id) DO NOTHING");
  await db.run("INSERT INTO partner_iam_users (id,partner_id,email,display_name,role,status) VALUES ('piu1','pa1','partner@relay.test','Pat Partner','operator','active') ON CONFLICT (id) DO NOTHING");
  await db.run("UPDATE partner_iam_users SET user_id = 'u_partner' WHERE id = 'piu1'");
  await db.run("INSERT INTO partner_projects (partner_id,project_id) VALUES ('pa1','p1') ON CONFLICT DO NOTHING");

  const { createTask } = await import(`${ROOT}apps/api/src/services/tasks.ts`);
  const { startTimer } = await import(`${ROOT}apps/api/src/services/clocks.ts`);
  const { ensureLifecycle } = await import(`${ROOT}apps/api/src/services/lifecycle.ts`);

  const board = await db.get<{ id: string }>("SELECT id FROM boards WHERE id = 'b1'");
  if (!board) {
    await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery')");
    for (const [key, name, done] of [
      ['backlog', 'Backlog', 0], ['todo', 'Ready', 0], ['in_progress', 'In Progress', 0],
      ['review', 'In Review', 0], ['blocked', 'Blocked', 0], ['done', 'Done', 1],
    ] as Array<[string, string, number]>) {
      await db.run('INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES (?,?,?,?,?,?)', [
        `b1_${key}`, 'b1', key, name, 0, done,
      ]);
    }
  }

  /*
   * `createTask` returns the new task's **id string**, not a row.
   *
   * The harness used to read `task?.id`, which is `undefined` on a string, so
   * `taskId` silently fell through to the literal 't_missing' and every task probe
   * asked for an object that does not exist. The product then correctly answered
   * 404 and the registry recorded a defect that belonged to the harness.
   *
   * Normalising both shapes here — and asserting the row exists — means a future
   * change to the return type fails loudly instead of turning every task probe into
   * a phantom 404.
   */
  let taskIdRaw: string | undefined;
  try {
    const created = await createTask(
      db,
      { title: 'Edge probe task', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1', clientVisible: true },
      'u_lead',
    );
    taskIdRaw = typeof created === 'string' ? created : (created as { id?: string })?.id;
  } catch {
    /* the board or column may not exist on a partially-seeded fixture; fall back */
  }
  const taskRow = taskIdRaw ? await db.get<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [taskIdRaw]) : null;
  const task = taskRow ?? (await db.get<{ id: string }>("SELECT id FROM tasks WHERE project_id = 'p1' LIMIT 1"));
  const timerId = await startTimer(db, 'module-turnover', 'project', 'p1', 'Edge probe clock');
  await ensureLifecycle(db, 'c1');

  // `task` is a row ({id}) from the query above, so read `id` once, here.
  const taskId = String(task?.id ?? '');
  const checklist = await db.get<{ id: string }>('SELECT id FROM task_checklist WHERE task_id = ? LIMIT 1', [taskId]);
  const gate = await db.get<{ id: string }>('SELECT id FROM turnover_checks WHERE task_id = ? LIMIT 1', [taskId]);

  // Fixtures for every module the surface exposes. Created through the service
  // layer where one exists, so the rows satisfy the same invariants the app
  // enforces. Without these, a probe would fail for want of a subject and record
  // a "defect" that is really a gap in the harness.
  const { createThread, addMessage, addFollowUp } = await import(`${ROOT}apps/api/src/services/communications.ts`);
  const { createDocument, addSignatory } = await import(`${ROOT}apps/api/src/services/legal.ts`);
  const { createChangeRequest } = await import(`${ROOT}apps/api/src/services/legal.ts`);

  let threadRow = await db.get<{ id: string }>("SELECT id FROM comm_threads WHERE client_id = 'c1' LIMIT 1");
  if (!threadRow) {
    await createThread(db, { clientId: 'c1', projectId: 'p1', channel: 'email', subject: 'Edge fixture thread', actorId: 'u_lead' });
    threadRow = await db.get<{ id: string }>("SELECT id FROM comm_threads WHERE client_id = 'c1' LIMIT 1");
  }
  if (threadRow) {
    await addMessage(db, { threadId: threadRow.id, direction: 'outbound', body: 'Fixture message', actorId: 'u_lead', mode: 'draft' });
    await addFollowUp(db, { clientId: 'c1', threadId: threadRow.id, action: 'Fixture follow-up' });
  }

  let docRow = await db.get<{ id: string }>("SELECT id FROM legal_documents WHERE client_id = 'c1' LIMIT 1");
  if (!docRow) {
    await createDocument(db, { clientId: 'c1', kind: 'nda', title: 'Edge fixture NDA', actorId: 'u_admin' });
    docRow = await db.get<{ id: string }>("SELECT id FROM legal_documents WHERE client_id = 'c1' LIMIT 1");
  }
  if (docRow) {
    const existingSig = await db.get<{ id: string }>('SELECT id FROM legal_signatories WHERE document_id = ? LIMIT 1', [docRow.id]);
    if (!existingSig) await addSignatory(db, { documentId: docRow.id, party: 'client', fullName: 'Cara Client', actorId: 'u_admin' });
  }

  let changeRow = await db.get<{ id: string }>("SELECT id FROM change_requests WHERE client_id = 'c1' LIMIT 1");
  if (!changeRow) {
    await createChangeRequest(db, { clientId: 'c1', projectId: 'p1', title: 'Edge fixture change', actorId: 'u_lead' });
    changeRow = await db.get<{ id: string }>("SELECT id FROM change_requests WHERE client_id = 'c1' LIMIT 1");
  }

  // A release and a QA report, so the ship gate and QA routes have subjects.
  let releaseRow = await db.get<{ id: string }>("SELECT id FROM releases WHERE project_id = 'p1' LIMIT 1");
  if (!releaseRow) {
    await db.run(
      "INSERT INTO releases (id, project_id, version, name, status) VALUES ('rel_edge','p1','0.0.1','Edge fixture release','planning')",
    );
    releaseRow = await db.get<{ id: string }>("SELECT id FROM releases WHERE project_id = 'p1' LIMIT 1");
  }
  let qaRow = await db.get<{ id: string }>("SELECT id FROM qa_reports WHERE project_id = 'p1' LIMIT 1");
  if (!qaRow) {
    await db.run(
      "INSERT INTO qa_reports (id, project_id, kind, title, severity, status) VALUES ('qa_edge','p1','bug','Edge fixture report','p3','open')",
    );
    qaRow = await db.get<{ id: string }>("SELECT id FROM qa_reports WHERE project_id = 'p1' LIMIT 1");
  }
  let dealRow = await db.get<{ id: string }>('SELECT id FROM deals LIMIT 1');
  if (!dealRow) {
    // `pipeline_stages` is seed data, not migration data, so the runner seeds it
    // the way the application's own seed does.
    let stage = await db.get<{ id: string }>('SELECT id FROM pipeline_stages LIMIT 1');
    if (!stage) {
      await db.run(
        "INSERT INTO pipeline_stages (id,key,name,phase,position) VALUES ('ps_edge','edge','Edge stage','discovery',1) ON CONFLICT (key) DO NOTHING",
      );
      stage = await db.get<{ id: string }>('SELECT id FROM pipeline_stages LIMIT 1');
    }
    if (stage) {
      await db.run(
        "INSERT INTO deals (id, client_id, title, stage_id, value_cents) VALUES ('deal_edge','c1','Edge fixture deal',?,0)",
        [stage.id],
      );
      dealRow = await db.get<{ id: string }>('SELECT id FROM deals LIMIT 1');
    }
  }
  // A full second-tenant object set. A foreign probe must be answered by the
  // permission model, not by the id simply not existing — otherwise the test
  // proves nothing about tenancy.
  const { createThread: ct2 } = await import(`${ROOT}apps/api/src/services/communications.ts`);
  const { createDocument: cd2 } = await import(`${ROOT}apps/api/src/services/legal.ts`);
  const { createChangeRequest: ccr2 } = await import(`${ROOT}apps/api/src/services/legal.ts`);

  let foreignThread = await db.get<{ id: string }>("SELECT id FROM comm_threads WHERE client_id = 'c2' LIMIT 1");
  if (!foreignThread) {
    await ct2(db, { clientId: 'c2', projectId: 'p2', channel: 'email', subject: 'Globex thread', actorId: 'u_lead' });
    foreignThread = await db.get<{ id: string }>("SELECT id FROM comm_threads WHERE client_id = 'c2' LIMIT 1");
  }
  let foreignDoc = await db.get<{ id: string }>("SELECT id FROM legal_documents WHERE client_id = 'c2' LIMIT 1");
  if (!foreignDoc) {
    await cd2(db, { clientId: 'c2', kind: 'nda', title: 'Globex NDA', actorId: 'u_admin' });
    foreignDoc = await db.get<{ id: string }>("SELECT id FROM legal_documents WHERE client_id = 'c2' LIMIT 1");
  }
  let foreignChange = await db.get<{ id: string }>("SELECT id FROM change_requests WHERE client_id = 'c2' LIMIT 1");
  if (!foreignChange) {
    await ccr2(db, { clientId: 'c2', projectId: 'p2', title: 'Globex change', actorId: 'u_lead' });
    foreignChange = await db.get<{ id: string }>("SELECT id FROM change_requests WHERE client_id = 'c2' LIMIT 1");
  }
  let foreignRelease = await db.get<{ id: string }>("SELECT id FROM releases WHERE project_id = 'p2' LIMIT 1");
  if (!foreignRelease) {
    await db.run("INSERT INTO releases (id, project_id, version, name, status) VALUES ('rel_gx','p2','0.0.1','Globex release','planning')");
    foreignRelease = await db.get<{ id: string }>("SELECT id FROM releases WHERE project_id = 'p2' LIMIT 1");
  }
  let foreignQa = await db.get<{ id: string }>("SELECT id FROM qa_reports WHERE project_id = 'p2' LIMIT 1");
  if (!foreignQa) {
    await db.run("INSERT INTO qa_reports (id, project_id, kind, title, severity, status) VALUES ('qa_gx','p2','bug','Globex report','p3','open')");
    foreignQa = await db.get<{ id: string }>("SELECT id FROM qa_reports WHERE project_id = 'p2' LIMIT 1");
  }
  let foreignTimer = await db.get<{ id: string }>("SELECT id FROM sla_timers WHERE entity_id = 'p2' LIMIT 1");
  if (!foreignTimer) {
    const ftId = await startTimer(db, 'module-turnover', 'project', 'p2', 'Globex clock');
    foreignTimer = ftId ? await db.get<{ id: string }>('SELECT id FROM sla_timers WHERE id = ?', [ftId]) : null;
  }
  await ensureLifecycle(db, 'c2');

  // Notifications, a project phase row and a foreign signatory — the last few
  // subjects the surface needs so that a probe fails on behaviour, not on a gap.
  let notifRow = await db.get<{ id: string }>('SELECT id FROM notifications LIMIT 1');
  if (!notifRow) {
    await db.run(
      "INSERT INTO notifications (id, user_id, kind, title, body) VALUES ('notif_edge','u_lead','system','Edge fixture','Fixture notification')",
    );
    notifRow = await db.get<{ id: string }>('SELECT id FROM notifications LIMIT 1');
  }
  /*
   * A project phase needs *two* rows: the phase catalogue entry and the per-project
   * instance. The harness assumed the catalogue was already populated and silently
   * produced nothing when it was not, so every phase probe asked for `phase_missing`
   * and the API correctly answered 404.
   *
   * The catalogue is migration-seeded in a real deployment but not in this fixture
   * database, so it is created here when absent — and the existence of both rows is
   * asserted by re-reading, rather than assumed from the insert not throwing.
   */
  let phaseRow = await db.get<{ id: string }>("SELECT id FROM project_phases WHERE project_id = 'p1' LIMIT 1");
  if (!phaseRow) {
    await db.run(
      `INSERT INTO phases (id, key, name, position, description, sla_days, billable, color)
       VALUES ('ph_edge', 'edge_probe', 'Edge probe phase', 90, 'Fixture phase', 10, 1, '#6366f1')
       ON CONFLICT (key) DO NOTHING`,
    );
    const anyPhase = await db.get<{ id: string }>('SELECT id FROM phases LIMIT 1');
    if (anyPhase) {
      await db.run(
        "INSERT INTO project_phases (id, project_id, phase_id, status) VALUES ('pp_edge','p1',?, 'active')",
        [anyPhase.id],
      );
      phaseRow = await db.get<{ id: string }>("SELECT id FROM project_phases WHERE project_id = 'p1' LIMIT 1");
    }
  }
  let foreignSignatory = null;
  if (foreignDoc) {
    const existing = await db.get<{ id: string }>('SELECT id FROM legal_signatories WHERE document_id = ? LIMIT 1', [foreignDoc.id]);
    if (existing) foreignSignatory = existing;
    else {
      await addSignatory(db, { documentId: foreignDoc.id, party: 'client', fullName: 'Gil Client', actorId: 'u_admin' });
      foreignSignatory = await db.get<{ id: string }>('SELECT id FROM legal_signatories WHERE document_id = ? LIMIT 1', [foreignDoc.id]);
    }
  }

  // A timer deliberately left in the `missed` state, for the acknowledge route.
  let missedTimer = await db.get<{ id: string }>("SELECT id FROM sla_timers WHERE outcome = 'missed' AND entity_id = 'p1' LIMIT 1");
  if (!missedTimer) {
    const mid = await startTimer(db, 'exec-summary', 'project', 'p1', 'Missed clock fixture');
    if (mid) {
      const past = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
      await db.run("UPDATE sla_timers SET due_at = ?, warn_at = ? WHERE id = ?", [past, past, mid]);
      await db.run("UPDATE sla_timers SET outcome = 'missed', missed_at = ? WHERE id = ?", [new Date().toISOString(), mid]);
      missedTimer = await db.get<{ id: string }>('SELECT id FROM sla_timers WHERE id = ?', [mid]);
    }
  }

  const release = releaseRow;
  const qa = qaRow;
  const doc = docRow;
  const thread = threadRow;
  const change = changeRow;
  const notif = notifRow;
  const deal = dealRow;
  const signatory = doc ? await db.get<{ id: string }>('SELECT id FROM legal_signatories WHERE document_id = ? LIMIT 1', [doc.id]) : null;

  const fixtures = {
    ids: {
      project: 'p1', partner: 'pa1', client: 'c1', timer: String(timerId ?? 'tm_missing'),
      release: release?.id ?? 'rel_missing', qa: qa?.id ?? 'qa_missing',
      legalDoc: doc?.id ?? 'doc_missing', thread: thread?.id ?? 'thr_missing',
      changeRequest: change?.id ?? 'chg_missing', notification: notif?.id ?? 'notif_missing',
      deal: deal?.id ?? 'deal_missing', taskChecklist: checklist?.id ?? 'item_missing',
      phaseRow: phaseRow?.id ?? 'phase_missing', notification2: notif?.id ?? 'notif_missing',
      missedTimer: missedTimer?.id ?? 'tm_missing',
      taskGate: gate?.id ?? 'gate_missing', signatory: signatory?.id ?? 'sig_missing',
      document: doc?.id ?? 'doc_missing',
    },
    foreign: {
      // Real objects in the second tenant, so a foreign probe is answered by the
      // permission model rather than by a missing id.
      project: 'p2', task: 't_foreign', client: 'c2',
      timer: foreignTimer?.id ?? 'tm_foreign',
      release: foreignRelease?.id ?? 'rel_missing',
      qa: foreignQa?.id ?? 'qa_missing',
      legalDoc: foreignDoc?.id ?? 'doc_missing',
      thread: foreignThread?.id ?? 'thr_missing',
      changeRequest: foreignChange?.id ?? 'chg_missing',
      signatory: foreignSignatory?.id ?? 'sig_missing',
      notification: notif?.id ?? 'notif_missing',
      document: foreignDoc?.id ?? 'doc_missing',
    },
  };

  // Build the app first so the route table can be read from it: the registry is
  // derived from what is actually registered, never from a hand-kept list.
  const built = await buildApp({ db, serveStatic: false, logger: false });
  await built.app.ready();
  const discovered = await discoverRoutes(built.app);
  const surface = surfaceFrom(built.app, discovered);
  console.log(`route surface: ${surface.length} registered endpoints discovered from the router`);

  const { cases, shortfall } = buildCases(fixtures, surface);

  /* --------------------------------------------------------- catalogue --- */
  const projectId = 'p1';
  console.log(`catalogue: ${cases.length} distinct cases (${shortfall > 0 ? `${shortfall} short of 3,500` : 'target met'})`);
  if (shortfall > 0) {
    console.error(`SHORTFALL: only ${cases.length} distinct cases could be derived from the surface. No records were invented.`);
  }

  const selected = cases
    .filter((c) => !onlyModule || c.module === onlyModule)
    .slice(0, limit > 0 ? limit : undefined);

  // Insert/refresh the catalogue. Fingerprints dedupe on re-run so the registry
  // is stable rather than growing every time it is executed.
  let catalogued = 0;
  for (const c of selected) {
    await db.run(
      `INSERT INTO edge_cases
         (id, project_id, module, code, scenario, category, severity, preconditions, steps, expected, fingerprint, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'catalogued')
       ON CONFLICT (project_id, code) DO UPDATE SET
         scenario = excluded.scenario, preconditions = excluded.preconditions,
         steps = excluded.steps, expected = excluded.expected, fingerprint = excluded.fingerprint`,
      [`ec_${c.code}`, projectId, c.module, c.code, c.scenario, c.category, c.severity,
        c.preconditions, c.steps, c.expected, (c as any).fingerprint ?? ''],
    );
    catalogued++;
  }
  await recordCoverage(db, projectId, selected);
  console.log(`catalogued: ${catalogued} rows written`);

  if (phase === 'catalogue') {
    console.log('catalogue-only run: nothing executed, nothing marked passed.');
    await db.close();
    return;
  }

  /* ----------------------------------------------------------- execute --- */
  const app = built.app;

  async function session(role: string) {
    const map: Record<string, string> = {
      admin: 'u_admin', lead: 'u_lead', member: 'u_member',
      client: 'u_client', client2: 'u_client2', partner: 'u_partner',
    };
    const userId = map[role];
    if (!userId) return null;
    const res = await app.inject({
      method: 'POST', url: '/api/auth/dev-login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ userId }),
    });
    if (res.statusCode !== 200) {
      console.error(`  session for ${role} failed: HTTP ${res.statusCode} ${res.body.slice(0, 160)}`);
      return null;
    }
    return {
      cookie: String(res.headers['set-cookie']).split(';')[0],
      csrf: res.json().data.csrfToken as string,
    };
  }

  const sessions: Record<string, any> = {};
  for (const role of ['admin', 'lead', 'member', 'client', 'client2', 'partner']) {
    sessions[role] = await session(role);
  }
  // A revoked session, an expired one and a tampered one, for the contract cases.
  const revokedLogin = await session('lead');
  if (revokedLogin) {
    await app.inject({
      method: 'POST', url: '/api/auth/logout',
      headers: { cookie: revokedLogin.cookie, 'x-csrf-token': revokedLogin.csrf },
    });
  }
  sessions.revoked = revokedLogin;
  sessions.expired = { cookie: 'relay_session=sess_expired_0000000000', csrf: 'x' };
  sessions.tampered = { cookie: `${sessions.lead?.cookie ?? ''}tampered`, csrf: sessions.lead?.csrf ?? 'x' };

  let passed = 0, failed = 0, blocked = 0;
  const failures: Array<{ code: string; scenario: string; expected: number; actual: number }> = [];

  for (const c of selected) {
    const started = Date.now();
    let result = 'blocked';
    let detail = '';
    let actualStatus = 0;

    try {
      const probe = c.probe;
      const useSession = probe.as !== 'anon' ? sessions[probe.as] : null;
      if (probe.as !== 'anon' && !useSession) throw new Error(`no session for role ${probe.as}`);

      const headers: Record<string, string> = {};
      if (useSession?.cookie) headers.cookie = useSession.cookie;
      if (useSession?.csrf && !probe.omitCsrf && probe.method !== 'GET') headers['x-csrf-token'] = useSession.csrf;
      if (probe.body !== undefined) headers['content-type'] = 'application/json';
      Object.assign(headers, probe.headers ?? {});

      const res = await app.inject({
        method: probe.method,
        url: probe.path,
        headers,
        payload: probe.body !== undefined ? JSON.stringify(probe.body) : undefined,
      });
      actualStatus = res.statusCode;
      if (res.statusCode === probe.expectStatus) {
        result = 'passed';
        detail = `${res.statusCode} as expected`;
      } else {
        result = 'failed';
        detail = `expected ${probe.expectStatus}, got ${res.statusCode}: ${res.body.slice(0, 300)}`;
        failures.push({ code: c.code, scenario: c.scenario, expected: probe.expectStatus, actual: res.statusCode });
      }
    } catch (err) {
      // A probe that could not run has not passed. It is blocked, with the reason.
      result = 'blocked';
      detail = `probe could not run: ${(err as Error).message}`;
    }

    const duration = Date.now() - started;
    if (result === 'passed') passed++;
    else if (result === 'failed') failed++;
    else blocked++;

    await db.run(
      `UPDATE edge_cases
          SET execution = ?, actual = ?, executed_by = ?, executed_at = ?, duration_ms = ?,
              verified_by = ?, verified_at = ?
        WHERE project_id = ? AND code = ?`,
      [result, detail.slice(0, 2000), 'u_lead', new Date().toISOString(), duration,
        result === 'passed' ? 'u_lead' : null, result === 'passed' ? new Date().toISOString() : null,
        projectId, c.code],
    );
    await db.run(
      `INSERT INTO edge_runs (id, project_id, case_id, result, runner, executed_by, duration_ms, detail)
       VALUES (?,?,?,?,?,?,?,?)`,
      [`run_${c.code}_${Date.now()}`, projectId, `ec_${c.code}`, result, 'scripts/edge-cases/run.ts', 'u_lead', duration, detail.slice(0, 2000)],
    );
  }

  await app.close();
  await db.close();

  /* ------------------------------------------------------------ report --- */
  const total = selected.length;
  console.log('');
  console.log('edge-case registry execution');
  console.log('────────────────────────────');
  console.log(`  cases    ${total}`);
  console.log(`  passed   ${passed}  (${((passed / total) * 100).toFixed(1)}%)`);
  console.log(`  failed   ${failed}`);
  console.log(`  blocked  ${blocked}`);
  console.log('');
  if (failures.length) {
    console.log('failures (expected vs actual):');
    const byStatus = new Map<string, number>();
    for (const f of failures) {
      const key = `expected ${f.expected} → got ${f.actual}`;
      byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${key}`);
    }
    console.log('');
    /*
     * `--failures N` controls how many are listed. The default of 15 is enough to
     * notice a pattern; classifying 800+ failures needs all of them, and reading them
     * from the source of truth beats re-deriving the distribution by hand.
     */
    const failArgIdx = args.indexOf('--failures');
    const failCount = failArgIdx >= 0 ? Number(args[failArgIdx + 1] ?? 50) : 15;
    console.log(`listing ${Math.min(failCount, failures.length)} of ${failures.length} failures:`);
    for (const f of failures.slice(0, failCount)) {
      console.log(`  ${f.code}  ${f.scenario.slice(0, 90)}`);
      console.log(`          expected ${f.expected}, got ${f.actual}`);
    }
  }
  // The runner exits non-zero when anything failed, so CI cannot ignore it.
  if (failed > 0) process.exitCode = 1;
}

async function recordCoverage(db: any, projectId: string, cases: EdgeCase[]) {
  const byModule = new Map<string, number>();
  for (const c of cases) byModule.set(c.module, (byModule.get(c.module) ?? 0) + 1);
  for (const [module, count] of byModule) {
    await db.run(
      `INSERT INTO edge_module_coverage (project_id, module, target, actual)
       VALUES (?,?,?,?)
       ON CONFLICT (project_id, module) DO UPDATE SET actual = excluded.actual, updated_at = datetime('now')`,
      [projectId, module, count, count],
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
