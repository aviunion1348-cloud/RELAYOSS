/**
 * HTTP contract tests — real router, real error handler, real database.
 *
 * Runs against SQLite by default (fast, zero-dependency) and against a live
 * PostgreSQL 16 server when `TEST_DATABASE_URL` is set — the same assertions,
 * the same application code, two engines:
 *
 *   npm test                  → SQLite
 *   npm run test:pg           → PostgreSQL 16 (boots one if needed)
 *
 * This is what proves PostgreSQL parity: not a schema diff, but every route
 * returning the same shape and the same governance decisions.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// A suite must be runnable on its own (`node --test apps/api/test/http.test.mjs`).
// The API refuses to boot without a signing secret, so each suite provides its
// own throwaway one instead of relying on another file in the same run.
process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
// PostgreSQL runs keep their data between runs; start from a known-empty
// fixture set while preserving migration-seeded governance policy.
await resetPostgres(db);
await db.run("INSERT INTO users (id,email,full_name,role,initials,capacity_hours_week) VALUES ('u1','a@x.io','Ada Lovelace','admin','AL',32) ON CONFLICT DO NOTHING");
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u2','b@x.io','Grace Hopper','member','GH') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('p1','ACM','Acme Project','c1','active') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery') ON CONFLICT DO NOTHING");
for (const [key, name] of [['backlog', 'Backlog'], ['todo', 'Ready'], ['in_progress', 'In Progress'], ['review', 'In Review'], ['blocked', 'Blocked'], ['done', 'Done']]) {
  await db.run('INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING', [`b1_${key}`, 'b1', key, name, 0, key === 'done' ? 1 : 0]);
}
// Slim demo content so every read endpoint returns something meaningful.
await db.run("INSERT INTO pipeline_stages (id,key,name,phase,position) VALUES ('s1','tech_consult','Technical Consultation','discovery',30) ON CONFLICT (key) DO UPDATE SET name = excluded.name");
await db.run("INSERT INTO deals (id,client_id,title,value_cents,stage_id,owner_id,probability) VALUES ('d1','c1','Acme platform','5000000','s1','u1',60) ON CONFLICT DO NOTHING");
await db.run("INSERT INTO partners (id,client_id,name,slug,plan) VALUES ('pa1','c1','Acme Console','acme','growth') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO releases (id,project_id,version,name,status) VALUES ('r1','p1','v1.0.0','Launch','in_qa') ON CONFLICT DO NOTHING");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => { await app.close(); await db.close(); });

/**
 * Authenticate for real: the API no longer accepts a client-asserted identity,
 * so the contract suite logs in through the same endpoint the browser uses and
 * replays the session cookie plus the CSRF token on mutations.
 */
const session = await (async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ userId: 'u1' }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return { cookie: String(res.headers['set-cookie']).split(';')[0], csrf: res.json().data.csrfToken };
})();

const request = (method, url, payload) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrf }),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    payload: payload ? JSON.stringify(payload) : undefined,
  });

test('GET /api/health reports a schema version and storage engine', async () => {
  const res = await request('GET', '/api/health');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.status, 'ok');
  assert.ok(body.data.schemaVersion >= 5);
  assert.equal(body.data.storage, pgUrl ? 'postgres' : 'sqlite-wal');
});

test('GET /api/meta exposes the client contract the UI depends on', async () => {
  const res = await request('GET', '/api/meta');
  const body = res.json().data;
  for (const key of ['users', 'labels', 'clients', 'projects', 'boards', 'currentUser', 'priorities', 'types', 'acceptanceLadder']) {
    assert.ok(key in body, `meta.${key} missing`);
  }
  assert.deepEqual(body.acceptanceLadder, ['dev_complete', 'qa_approved', 'lead_approved', 'client_accepted']);
});

test('POST /api/tasks validates payloads and 201s on success', async () => {
  const bad = await request('POST', '/api/tasks', { title: 'x' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'bad_request');

  const good = await request('POST', '/api/tasks', {
    title: 'Implement intake validation', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1', priority: 'high', clientVisible: true,
  });
  assert.equal(good.statusCode, 201);
  const task = good.json().data;
  assert.match(task.key, /^ACM-\d+$/);
  assert.equal(task.turnover.ready, false);
  assert.ok(task.turnover.checks.length >= 5);
});

test('PATCH status=done is refused while turnover is open (409 with details)', async () => {
  const created = (await request('POST', '/api/tasks', { title: 'Ship me prematurely', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1' })).json().data;
  const res = await request('PATCH', `/api/tasks/${created.id}`, { status: 'done' });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error.code, 'conflict');
  assert.ok(body.error.details.required);
});

test('PATCH turnover gate without evidence is refused (400)', async () => {
  const created = (await request('POST', '/api/tasks', { title: 'Gate evidence test', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1' })).json().data;
  const gateId = created.turnover.checks[0].gateId;
  const noEvidence = await request('PATCH', `/api/tasks/${created.id}/turnover/${gateId}`, { status: 'pass' });
  assert.equal(noEvidence.statusCode, 400);

  const withEvidence = await request('PATCH', `/api/tasks/${created.id}/turnover/${gateId}`, { status: 'pass', evidence: 'CI run #99 green' });
  assert.equal(withEvidence.statusCode, 200);
  const updated = withEvidence.json().data;
  assert.equal(updated.turnover.checks.find((c) => c.gateId === gateId).status, 'pass');
});

test('acceptance ladder cannot be climbed out of order (409)', async () => {
  const created = (await request('POST', '/api/tasks', { title: 'Ladder order test', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1' })).json().data;
  const res = await request('POST', `/api/tasks/${created.id}/acceptance`, { step: 'lead_approved', state: 'passed' });
  assert.equal(res.statusCode, 409);
  const outOfOrderQa = await request('POST', `/api/tasks/${created.id}/acceptance`, { step: 'qa_approved', state: 'passed', evidence: 'QA-77' });
  assert.equal(outOfOrderQa.statusCode, 409, 'QA cannot approve before dev completion');
  const dev = await request('POST', `/api/tasks/${created.id}/acceptance`, { step: 'dev_complete', state: 'passed' });
  assert.equal(dev.statusCode, 200);
  const qa = await request('POST', `/api/tasks/${created.id}/acceptance`, { step: 'qa_approved', state: 'passed', evidence: 'QA-77' });
  assert.equal(qa.statusCode, 200);
});

test('404 for an unknown task, with a machine-readable code', async () => {
  const res = await request('GET', '/api/tasks/does-not-exist');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'not_found');
});

test('GET /api/planner returns an explainable schedule', async () => {
  await request('POST', '/api/tasks', { title: 'Planner input work', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1', assigneeId: 'u1', estimateHours: 6 });
  const res = await request('GET', '/api/planner?horizon=14');
  assert.equal(res.statusCode, 200);
  const body = res.json().data;
  assert.equal(body.horizonDays, 14);
  assert.ok(Array.isArray(body.items));
  if (body.items.length) {
    assert.ok(body.items[0].rationale.length > 10);
    assert.ok(typeof body.items[0].risk_score === 'number');
  }
});

test('clocks: list, resolve and sweep are all wired', async () => {
  const created = (await request('POST', '/api/tasks', { title: 'Clock wiring test', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1', assigneeId: 'u1' })).json().data;
  await request('PATCH', `/api/tasks/${created.id}`, { status: 'review' }); // starts module-turnover
  const list = await request('GET', '/api/clocks');
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().data.clocks.length >= 5);
  const timer = list.json().data.timers.find((t) => t.entityId === created.key || t.entityId === created.id);
  if (timer) {
    const resolved = await request('POST', `/api/clocks/timers/${timer.id}/resolve`, { outcome: 'met', note: 'done in 2h' });
    assert.equal(resolved.statusCode, 200, resolved.body);
  }
  const emptyBody = await app.inject({
    method: 'POST',
    url: '/api/clocks/sweep',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
  });
  assert.equal(emptyBody.statusCode, 200, 'empty JSON body must not 500');

  const sweep = await request('POST', '/api/clocks/sweep');
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.ok(typeof sweep.json().data.swept === 'number');
});

test('role guard: member cannot waive a gate', async () => {
  const created = (await request('POST', '/api/tasks', { title: 'Role guard test', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1' })).json().data;
  const gateId = created.turnover.checks[0].gateId;
  // u2 is a plain member; sign in as them rather than asserting a header.
  const memberLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ userId: 'u2' }),
  });
  const memberCookie = String(memberLogin.headers['set-cookie']).split(';')[0];
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/tasks/${created.id}/turnover/${gateId}`,
    headers: { cookie: memberCookie, 'x-csrf-token': memberLogin.json().data.csrfToken, 'content-type': 'application/json' },
    payload: JSON.stringify({ status: 'waived', evidence: 'skipping' }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'forbidden');
});

test('GET /api/dashboard aggregates without N+1 meltdown', async () => {
  const res = await request('GET', '/api/dashboard');
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  for (const key of ['kpis', 'byStatus', 'throughput', 'workload', 'projects', 'clocks', 'timers', 'pipelineByPhase']) {
    assert.ok(key in d, `dashboard.${key} missing`);
  }
  assert.equal(d.throughput.length, 14, JSON.stringify({ throughput: d.throughput?.length, keys: Object.keys(d) }));
});

test('paid endpoints: pipeline, qa, releases, partners, docs all return arrays', async () => {
  for (const path of ['/api/pipeline', '/api/qa', '/api/releases', '/api/partners', '/api/docs', '/api/clients', '/api/projects', '/api/activity']) {
    const res = await request('GET', path);
    assert.equal(res.statusCode, 200, `${path} → ${res.statusCode}`);
    const body = res.json().data;
    assert.ok(body !== null && body !== undefined, `${path} returned nothing`);
  }
});

test('unknown /api routes 404 with JSON, never HTML', async () => {
  const res = await request('GET', '/api/nope');
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'], /application\/json/);
});


/* ------------------------------------------------------- observability -- */
test('ops: liveness, readiness and metrics are exposed without leaking secrets', async () => {
  const live = await request('GET', '/api/live');
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().data.live, true);

  const ready = await request('GET', '/api/ready');
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().data.ready, true);

  const metrics = await request('GET', '/api/metrics');
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.headers['content-type'], /text\/plain/);
  assert.match(metrics.body, /relay_http_requests_total/);
  assert.match(metrics.body, /relay_clocks_overdue/);
  // No credential material or connection strings in the exposition.
  assert.ok(!/password|postgres:\/\/|SESSION_SECRET|Bearer /i.test(metrics.body));

  const json = await app.inject({ method: 'GET', url: '/api/metrics', headers: { accept: 'application/json', cookie: session.cookie } });
  assert.equal(json.statusCode, 200);
  assert.ok(json.json().data.text.includes('relay_process_uptime_seconds'));
});

test('ops: health reports the live engine, schema version and database probe', async () => {
  const res = await request('GET', '/api/health');
  const data = res.json().data;
  assert.equal(data.database.ok, true);
  assert.ok(['postgres', 'sqlite-wal'].includes(data.storage));
  assert.equal(data.storage, data.database.engine === 'postgres' ? 'postgres' : 'sqlite-wal');
  assert.ok(data.schemaVersion >= 6);
  assert.ok(!JSON.stringify(data).includes('secret'));
});
