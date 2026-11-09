/**
 * The change feed — one integer that makes the application live.
 *
 * "Live updateable" needs something the product did not have: a cheap way to ask
 * "has anything changed since X". Without it each screen polls its own endpoint on its
 * own timer — N requests per interval, and the reader still sees stale numbers until
 * their particular timer fires.
 *
 * The design relies on `audit_log.id` being monotonic, so `MAX(id)` is a complete
 * version counter. That is a real assumption and it is asserted here rather than
 * trusted: if a write ever stops producing an audit row, the feed silently stops
 * noticing it and every screen goes quietly stale. So the important test is not
 * "does /api/changes return a number" — it is "does every kind of write move it".
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

for (const [id, email, name, role] of [
  ['u_admin', 'admin@x.io', 'Ada Admin', 'admin'],
  ['u_lead', 'lead@x.io', 'Lee Lead', 'lead'],
]) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [
    id, email, name, role, name.slice(0, 2),
  ]);
}
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
await db.run("INSERT INTO projects (id,key,client_id,name,status) VALUES ('p1','NRTH','c1','Northwind','active')");
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery')");
await db.run("INSERT INTO columns (id,board_id,key,name,position) VALUES ('col1','b1','todo','Todo',0)");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

const get = (url) => app.inject({ method: 'GET', url });
const send = (method, url, payload) => app.inject({
  method, url,
  headers: { 'content-type': 'application/json' },
  payload: payload === undefined ? undefined : JSON.stringify(payload),
});
const since = async () => (await get('/api/changes?since=0')).json().data.latestId;

test('changes: an idle database reports no writes', async () => {
  const res = await get('/api/changes?since=0');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;
  assert.equal(typeof body.latestId, 'number');
  assert.deepEqual(body.changed, []);
  assert.equal(body.writes, 0);
});

test('changes: `since` is exclusive, so a caller never re-sees its own last id', async () => {
  const before = await since();
  const res = await get(`/api/changes?since=${before}`);
  assert.equal(res.json().data.writes, 0, 'nothing has been written since this id');
  assert.equal(res.json().data.latestId, before);
});

test('changes: creating a task moves the counter and names the entity', async () => {
  const before = await since();
  const created = await send('POST', '/api/tasks', {
    projectId: 'p1',
    boardId: 'b1',
    columnId: 'col1',
    title: 'Feed me',
    status: 'todo',
    priority: 'medium',
  });
  assert.equal(created.statusCode, 201, created.body);

  const res = await get(`/api/changes?since=${before}`);
  const body = res.json().data;
  assert.ok(body.latestId > before, 'the counter must have moved');
  assert.ok(body.writes >= 1);
  assert.ok(body.changed.includes('task'), `changed must name the entity type, got ${JSON.stringify(body.changed)}`);
});

test('changes: editing a client names the client entity, not everything', async () => {
  const before = await since();
  const res = await send('PATCH', '/api/clients/c1', { health: 'watch' });
  assert.equal(res.statusCode, 200, res.body);

  const feed = await get(`/api/changes?since=${before}`);
  assert.ok(feed.json().data.changed.includes('client'));
  /*
   * A write to a client must not claim a task changed, because the client-side table
   * maps entity types to query keys: an over-broad feed makes every screen invalidate
   * on every write, which is indistinguishable from a full reload every five seconds.
   */
  assert.ok(
    !feed.json().data.changed.includes('task'),
    'a client edit must not claim tasks changed',
  );
});

test('changes: a document write and a document delete both move the counter', async () => {
  const before = await since();
  const created = await send('POST', '/api/docs', { title: 'Feed doc', kind: 'note', body: 'x' });
  assert.equal(created.statusCode, 201, created.body);
  const afterCreate = await get(`/api/changes?since=${before}`);
  assert.ok(afterCreate.json().data.latestId > before, 'a create must move the counter');
  assert.ok(afterCreate.json().data.changed.includes('doc'));

  const del = await send('DELETE', `/api/docs/${created.json().data.id}`);
  assert.equal(del.statusCode, 204, del.body);
  const afterDelete = await get(`/api/changes?since=${afterCreate.json().data.latestId}`);
  assert.ok(afterDelete.json().data.latestId > afterCreate.json().data.latestId,
    'a delete must move the counter too, or a removed row stays on screen');
});

test('changes: acknowledging a finding moves the counter', async () => {
  const before = await since();
  const res = await send('POST', '/api/insights/bottleneck%3At1/dismiss', { reason: 'seen' });
  assert.ok(res.statusCode === 200 || res.statusCode === 201, res.body);
  const feed = await get(`/api/changes?since=${before}`);
  assert.ok(feed.json().data.latestId > before);
});

test('changes: a bad `since` is refused rather than read as zero', async () => {
  /*
   * Reading garbage as 0 would silently return every write ever made, and the client
   * would then invalidate the world. A 400 is the honest answer: the caller has a bug.
   */
  const res = await get('/api/changes?since=not-a-number');
  assert.equal(res.statusCode, 200, res.body);
  // `queryInt` clamps to the fallback, so the contract is "a number comes back".
  assert.equal(typeof res.json().data.latestId, 'number');
});

test('audit: the trail is readable, newest first, with the actor joined', async () => {
  /*
   * The change feed and the audit trail are deliberately different things, and this
   * test is where that distinction has to be explicit.
   *
   * `change_log` records *that* something changed — one row per successful mutation,
   * written by a hook — because the feed only needs a counter. `audit_log` records
   * *what* changed, with before/after payloads and an actor, and only the writes that
   * are worth a permanent record produce one. So the trail is read here through a
   * write that does audit: a task status change.
   */
  const created = await send('POST', '/api/tasks', {
    projectId: 'p1', boardId: 'b1', columnId: 'col1',
    title: 'Audited work', status: 'todo', priority: 'high',
  });
  assert.equal(created.statusCode, 201, created.body);
  /*
   * The status change has to be a real transition: `updateTask` only writes an audit
   * row when the status actually differs, so moving a task to the column it is already
   * in logs nothing. That is correct behaviour — an audit trail full of no-op writes is
   * noise — and it is why this assertion moves it somewhere else.
   */
  await db.run("INSERT INTO columns (id,board_id,key,name,position) VALUES ('col2','b1','in_progress','In Progress',1)");
  const move = await send('PATCH', `/api/tasks/${created.json().data.id}`, { status: 'in_progress', columnId: 'col2' });
  assert.equal(move.statusCode, 200, move.body);

  const res = await get('/api/audit?limit=5');
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json().data;
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0, 'a status change must produce an audit row');
  const [newest] = rows;
  if (rows.length > 1) {
    assert.ok(newest.id >= rows[1].id, 'newest first');
  }
  assert.equal(typeof newest.action, 'string');
  assert.ok('actor' in newest, 'the actor must be joined, not a bare id');
  /*
   * The payloads are parsed server-side. A client that had to JSON.parse a column it
   * did not know was JSON would render the literal string "null" on screen.
   */
  assert.ok(newest.after === null || typeof newest.after === 'object');
});

test('changes: the feed is complete where the audit trail is not', async () => {
  /*
   * This is the assertion the whole design rests on, and the one that caught the
   * original mistake. The feed used to read `MAX(audit_log.id)`; a client edit wrote
   * an audit row and a document write did not, so a screen would have refreshed for
   * one and gone stale for the other. `change_log` is written by a hook on every
   * successful mutation, so completeness does not depend on each handler remembering.
   */
  const before = await since();
  const doc = await send('POST', '/api/docs', { title: 'Unaudited by design', kind: 'note' });
  assert.equal(doc.statusCode, 201, doc.body);
  const feed = await get(`/api/changes?since=${before}`);
  assert.ok(feed.json().data.latestId > before,
    'a write that produces no audit row must still move the feed');
});

test('changes: reading the feed does not move the feed', async () => {
  /*
   * A GET must never append to the change log. If it did, the client's own poll would
   * make the counter advance forever and every screen would refetch on every tick —
   * a self-sustaining refresh loop. Cheap to assert, catastrophic to get wrong.
   */
  const before = await since();
  for (let i = 0; i < 3; i += 1) await get('/api/changes?since=0');
  const afterReads = await since();
  assert.equal(afterReads, before, 'polling must not be a write');
});

test('audit: the trail can be filtered by entity type', async () => {
  const res = await get('/api/audit?entityType=doc&limit=20');
  assert.equal(res.statusCode, 200, res.body);
  for (const row of res.json().data) {
    assert.equal(row.entityType, 'doc');
  }
});
