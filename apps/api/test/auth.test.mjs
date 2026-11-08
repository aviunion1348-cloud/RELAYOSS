/**
 * The unauthenticated deployment.
 *
 * RelayOS runs here as an internal application with no sign-in. This suite exists
 * to prove the *replacement* behaviour, not to re-test a session system that has
 * been removed:
 *
 *   - every business route answers an anonymous caller with real data
 *   - no request can be refused for want of a credential, cookie or token
 *   - mutations are attributed to the operator, so `created_by` stays populated
 *     and the foreign keys that reference `users` still hold
 *   - the login endpoints answer `410 Gone` rather than pretending to work
 *   - unrelated guarantees are *not* collateral damage: validation still rejects
 *     bad input, unknown ids still 404, and the database still enforces its
 *     constraints
 *
 * The last group is the point of the file. Removing authentication must not become
 * a licence to remove input validation or error handling, and those are the things
 * most easily lost when a middleware is deleted.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { resetOperatorIdentity } from '../src/auth/operator-middleware.ts';

/**
 * No SESSION_SECRET and no AUTH_MODE.
 *
 * Deleting them is the test: the deployment must work without the variables that
 * the removed authentication system used to require. If a stale reference
 * reintroduces the dependency, these tests fail by refusing to boot.
 */
delete process.env.SESSION_SECRET;
delete process.env.AUTH_MODE;
delete process.env.RELAY_ADMIN_PASSWORD_HASH;
delete process.env.ALLOW_DEV_AUTH_IN_PRODUCTION;

const pgUrl = process.env.TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL_ALT ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');

await migrate(db, { log: () => {} });
await resetPostgres(db);

/* ---------------------------------------------------------------- fixtures -- */
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('usr_maya','maya@relayoss.studio','Maya Iyer','admin','MI')");
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('usr_lead','lead@relayoss.studio','Lee Lead','lead','LL')");
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('usr_member','mem@relayoss.studio','Mia Member','member','MM')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('cl_a','Client A','client-a','CA')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('cl_b','Client B','client-b','CB')");
await db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('pr_a','PRA','A Project','cl_a','active')");
await db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('pr_b','PRB','B Project','cl_b','active')");
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('bd_a','pr_a','A Board')");
/**
 * The column id follows the schema's `${boardId}_${status}` convention, which is
 * what `createTask` derives when a caller omits `columnId`. Using an arbitrary id
 * here makes the fixture — not the route — fail on a foreign key.
 */
await db.run("INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES ('bd_a_backlog','bd_a','backlog','Backlog',1,0)");
await db.run("INSERT INTO tasks (id,key,project_id,board_id,column_id,title,type,priority,status) VALUES ('t_a','PRA-1','pr_a','bd_a','bd_a_backlog','A task','feature','medium','todo')");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  await app.close();
  await db.close();
});

/* ------------------------------------------------------- no gate anywhere -- */
test('noauth: every business route answers an anonymous caller', async () => {
  /**
   * No cookie, no CSRF token, no Authorization header — deliberately.
   *
   * These are the reads every screen performs on load. Under the removed session
   * system each of them answered `401` to exactly this request.
   */
  const reads = [
    '/api/health',
    '/api/live',
    '/api/ready',
    '/api/meta',
    '/api/dashboard',
    '/api/projects',
    '/api/projects/pr_a',
    '/api/clients',
    '/api/pipeline',
    '/api/tasks',
    '/api/qa',
    '/api/releases',
    '/api/clocks',
    '/api/partners',
    '/api/users',
    '/api/docs',
    '/api/planner',
  ];
  for (const url of reads) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} answered ${res.statusCode} to an anonymous caller`);
    assert.match(String(res.headers['content-type']), /application\/json/i, `${url} was not JSON`);
  }
});

test('noauth: the session probe reports an unauthenticated deployment instead of 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.equal(res.statusCode, 200, 'a 401 here is what used to trigger the sign-in screen');
  const body = JSON.parse(res.body).data;
  assert.equal(body.authMode, 'none', 'the deployment must state plainly that nothing authenticates');
  assert.equal(body.authenticated, true);
  assert.equal(body.user.id, 'usr_maya', 'the operator identity must be reported');
  assert.equal(body.user.role, 'admin');
  assert.equal(body.csrfToken, null, 'no token exists, so none may be advertised');
});

test('noauth: writes succeed with no cookie and no CSRF token', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ projectId: 'pr_a', boardId: 'bd_a', title: 'Written without a credential', type: 'feature', priority: 'high' }),
  });
  assert.equal(created.statusCode, 201, 'a mutation must not need a session');
  const task = JSON.parse(created.body).data;
  assert.ok(task.id);
  assert.equal(task.project.key, 'PRA');

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/tasks/${task.id}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ title: 'Updated without a credential' }),
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(JSON.parse(patched.body).data.title, 'Updated without a credential');
});

test('noauth: mutations are attributed to the operator, not left null', async () => {
  /**
   * The foreign keys from tasks and activity to `users` are still enforced, so an
   * unattributed write would fail. This asserts the operator id is recorded, which
   * is what keeps the activity feed meaningful on an unauthenticated deployment.
   */
  const created = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ projectId: 'pr_a', boardId: 'bd_a', title: 'Attribute me', type: 'feature' }),
  });
  const id = JSON.parse(created.body).data.id;
  const row = await db.get('SELECT reporter_id FROM tasks WHERE id = ?', [id]);
  const actor = String(row.reporter_id ?? '');
  assert.ok(actor.length > 0, 'the write must carry an actor');
  const user = await db.get('SELECT id FROM users WHERE id = ?', [actor]);
  assert.ok(user, 'the actor must be a real user row, because the schema has a foreign key to it');
});

test('noauth: the login endpoints are gone, and say so', async () => {
  for (const url of ['/api/auth/login', '/api/auth/dev-login', '/api/auth/logout']) {
    const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' });
    assert.equal(res.statusCode, 410, `${url} must be Gone, not a working login`);
    assert.equal(JSON.parse(res.body).error.code, 'auth_removed');
  }
});

/* ---------------------------------- nothing that mattered was collateral -- */
test('noauth: input validation still rejects bad payloads', async () => {
  const noName = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ projectId: 'pr_a', boardId: 'bd_a', title: 'x' }),
  });
  assert.equal(noName.statusCode, 400, 'a too-short title must still be rejected');

  const badType = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ projectId: 'pr_a', boardId: 'bd_a', title: 'Valid title', type: 'not-a-real-type' }),
  });
  assert.equal(badType.statusCode, 500, 'the database CHECK constraint must still fire on an invalid enum');
});

test('noauth: unknown ids still 404 and unknown routes still 404', async () => {
  const missing = await app.inject({ method: 'GET', url: '/api/tasks/does-not-exist' });
  assert.equal(missing.statusCode, 404, 'authorisation being gone must not turn a missing row into a 200');

  const noRoute = await app.inject({ method: 'GET', url: '/api/there-is-no-such-endpoint' });
  assert.equal(noRoute.statusCode, 404);
  assert.match(String(noRoute.headers['content-type']), /application\/json/i);

  /**
   * A browser route reaching the API is still a routing bug and must not be
   * answered with a document, exactly as before.
   */
  const spa = await app.inject({ method: 'GET', url: '/projects/pr_a' });
  assert.equal(spa.statusCode, 404, 'the API function must not serve the SPA');
});

test('noauth: client and project creation work, with the schema enforcing itself', async () => {
  const client = await app.inject({
    method: 'POST',
    url: '/api/clients',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Vertex Robotics', tier: 'strategic' }),
  });
  assert.equal(client.statusCode, 201, 'client creation must work — it did not exist before this change');
  const made = JSON.parse(client.body).data;
  assert.equal(made.slug, 'vertex-robotics', 'a slug must be derived from the name');

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/clients',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Vertex Robotics' }),
  });
  assert.equal(duplicate.statusCode, 409, 'the UNIQUE constraint must surface as a conflict, not a 500');

  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Vertex Fleet Console', clientId: made.id, key: 'VTX' }),
  });
  assert.equal(project.statusCode, 201, 'project creation must work — it did not exist before this change');
  assert.equal(JSON.parse(project.body).data.key, 'VTX');

  // The foreign key still governs: a project cannot belong to a client that is absent.
  const orphan = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Orphan', clientId: 'cl_does_not_exist' }),
  });
  assert.equal(orphan.statusCode, 400, 'an unknown client must be refused');
});

test('noauth: operational probes stay anonymous and expose no user data', async () => {
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  const body = JSON.parse(health.body).data;
  assert.ok(!/@/.test(health.body), 'the health payload must not contain an email address');
  assert.equal(body.authMode, 'none', 'the health probe must report that nothing authenticates');
});

test('noauth: the operator identity is resolved once and reused', async () => {
  resetOperatorIdentity();
  const first = await app.inject({ method: 'GET', url: '/api/auth/session' });
  const second = await app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.equal(JSON.parse(first.body).data.user.id, JSON.parse(second.body).data.user.id);
});
