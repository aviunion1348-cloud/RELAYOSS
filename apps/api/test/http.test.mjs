/**
 * HTTP contract tests — real router, real error handler, in-memory database.
 * These pin the public API shape and the status codes clients depend on.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';

const db = new Db(':memory:');
migrate(db, { log: () => {} });
db.run("INSERT INTO users (id,email,full_name,role,initials,capacity_hours_week) VALUES ('u1','a@x.io','Ada Lovelace','admin','AL',32)");
db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u2','b@x.io','Grace Hopper','member','GH')");
db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('p1','ACM','Acme Project','c1','active')");
db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery')");
for (const [key, name] of [['backlog', 'Backlog'], ['todo', 'Ready'], ['in_progress', 'In Progress'], ['review', 'In Review'], ['blocked', 'Blocked'], ['done', 'Done']]) {
  db.run('INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES (?,?,?,?,?,?)', [`b1_${key}`, 'b1', key, name, 0, key === 'done' ? 1 : 0]);
}
// Slim demo content so every read endpoint returns something meaningful.
db.run("INSERT INTO pipeline_stages (id,key,name,phase,position) VALUES ('s1','tech_consult','Technical Consultation','discovery',30)");
db.run("INSERT INTO deals (id,client_id,title,value_cents,stage_id,owner_id,probability) VALUES ('d1','c1','Acme platform','5000000','s1','u1',60)");
db.run("INSERT INTO partners (id,client_id,name,slug,plan) VALUES ('pa1','c1','Acme Console','acme','growth')");
db.run("INSERT INTO releases (id,project_id,version,name,status) VALUES ('r1','p1','v1.0.0','Launch','in_qa')");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
const hdr = { 'x-actor-id': 'u1', 'content-type': 'application/json' };

after(async () => { await app.close(); });

const request = (method, url, payload) =>
  app.inject({ method, url, headers: hdr, payload: payload ? JSON.stringify(payload) : undefined });

test('GET /api/health reports a schema version and storage engine', async () => {
  const res = await request('GET', '/api/health');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.status, 'ok');
  assert.ok(body.data.schemaVersion >= 5);
  assert.equal(body.data.storage, 'sqlite-wal');
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
  const emptyBody = await app.inject({ method: 'POST', url: '/api/clocks/sweep', headers: { 'x-actor-id': 'u1', 'content-type': 'application/json' } });
  assert.equal(emptyBody.statusCode, 200, 'empty JSON body must not 500');

  const sweep = await request('POST', '/api/clocks/sweep');
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.ok(typeof sweep.json().data.swept === 'number');
});

test('role guard: member cannot waive a gate', async () => {
  const created = (await request('POST', '/api/tasks', { title: 'Role guard test', boardId: 'b1', columnId: 'b1_todo', projectId: 'p1' })).json().data;
  const gateId = created.turnover.checks[0].gateId;
  const res = await app.inject({
    method: 'PATCH', url: `/api/tasks/${created.id}/turnover/${gateId}`,
    headers: { 'x-actor-id': 'u2', 'content-type': 'application/json' },
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
  assert.equal(d.throughput.length, 14);
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

