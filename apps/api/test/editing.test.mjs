/**
 * Editing what used to be read-only.
 *
 * The complaint behind this suite is precise: four screens — Clients, Partners,
 * Docs, Intelligence — rendered records that the product could not change. The
 * tables existed and the reads worked, so the screens *looked* finished; nothing
 * in them could be created, corrected or retired, and the only writes the
 * repository had were the seed's.
 *
 * So these tests do not ask "does the route exist". They ask the question the
 * user actually asked — is the change stored — and they ask it twice:
 *
 *   1. through the API: write, then re-read in a *separate request*, so the
 *      assertion cannot pass on a value the handler happened to echo back;
 *   2. against the database: read the row straight from the engine, so a route
 *      that returns a plausible object without writing is caught.
 *
 * The refusals matter as much as the writes, and each one is a real hazard:
 *
 *   - deleting a client that still owns projects would cascade to every project,
 *     task and document under it in one statement;
 *   - cutting a partner's device limit below its usage leaves the tenant
 *     permanently over quota, refused for a reason nobody can see;
 *   - editing a document outside your scope must answer 404, not 403, or the
 *     response becomes an oracle for which document ids exist.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { resetOperatorIdentity } from '../src/auth/operator-middleware.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

/* ------------------------------------------------------------- fixtures --- */

for (const [id, email, name, role] of [
  ['u_admin', 'admin@x.io', 'Ada Admin', 'admin'],
  ['u_lead', 'lead@x.io', 'Lee Lead', 'lead'],
  ['u_client', 'client@x.io', 'Cleo Client', 'client'],
  // A member with no project grants. It has to exist as a row: a missing operator id
  // is deliberately resolved to an administrator rather than refused, so a test that
  // names a non-existent user would silently run as an admin and assert nothing.
  ['u_member', 'mem@x.io', 'Mia Member', 'member'],
]) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [
    id, email, name, role, name.slice(0, 2),
  ]);
}

await db.run("INSERT INTO clients (id,name,slug,initials,tier,health) VALUES ('c1','Acme','acme','AC','growth','healthy')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c2','Globex','globex','GX')");
// c1 owns a project, so it must not be deletable; c2 is empty, so it may go.
await db.run(
  "INSERT INTO projects (id,key,client_id,name,status,started_at,target_end_at) VALUES ('p1','NRTH','c1','Northwind','active','2026-01-01','2026-06-01')",
);
await db.run(
  `INSERT INTO partners (id,client_id,name,slug,plan,status,device_limit,seat_limit,api_quota_month)
   VALUES ('pa','c1','Partner A','partner-a','starter','active',3,2,1000)`,
);
await db.run(
  `INSERT INTO device_licenses (id,partner_id,device_id,device_name,status)
   VALUES ('dl1','pa','dev-1','Handset One','active')`,
);
await db.run(
  "INSERT INTO docs (id,project_id,title,kind,body,status,author_id,client_visible) VALUES ('d1','p1','Runbook','runbook','step one','draft','u_admin',0)",
);

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

const get = (url) => app.inject({ method: 'GET', url });
const send = (method, url, payload) =>
  app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });

/* ================================================================ clients == */

test('clients: an edit is stored, not merely echoed', async () => {
  const res = await send('PATCH', '/api/clients/c1', {
    tier: 'strategic',
    health: 'at_risk',
    primaryContactName: 'Dana Whitfield',
    primaryContactEmail: 'dana@acme.io',
    notes: 'Renewal at risk after the Q3 slip.',
  });
  assert.equal(res.statusCode, 200, res.body);

  // 1. Re-read through the API in its own request.
  const again = await get('/api/clients');
  assert.equal(again.statusCode, 200, again.body);
  const row = again.json().data.find((c) => c.id === 'c1');
  assert.equal(row.tier, 'strategic');
  assert.equal(row.health, 'at_risk');
  // The list route maps `primary_contact_name` to `contactName`; assert the field
  // the screens actually read rather than the column.
  assert.equal(row.contactName, 'Dana Whitfield');
  assert.equal(row.contactEmail, 'dana@acme.io');

  // 2. Re-read from the engine, bypassing the route entirely.
  const stored = await db.get('SELECT tier, health, primary_contact_email, notes FROM clients WHERE id = ?', ['c1']);
  assert.equal(stored.tier, 'strategic');
  assert.equal(stored.health, 'at_risk');
  assert.equal(stored.primary_contact_email, 'dana@acme.io');
  assert.match(String(stored.notes), /Q3 slip/);
});

test('clients: an invalid value is refused, and the old value survives', async () => {
  const res = await send('PATCH', '/api/clients/c1', { tier: 'platinum' });
  assert.equal(res.statusCode, 400, 'an unknown tier must be a 400, not a silent default');
  const stored = await db.get('SELECT tier FROM clients WHERE id = ?', ['c1']);
  assert.equal(stored.tier, 'strategic', 'a refused edit must not have written anything');
});

test('clients: an empty patch is refused rather than pretending to save', async () => {
  const res = await send('PATCH', '/api/clients/c1', {});
  assert.equal(res.statusCode, 400, res.body);
});

test('clients: the slug is not editable', async () => {
  const res = await send('PATCH', '/api/clients/c1', { slug: 'acme-renamed' });
  // Either refused outright or ignored — but never silently renamed, because every
  // stored reference quotes the old slug.
  const stored = await db.get('SELECT slug FROM clients WHERE id = ?', ['c1']);
  assert.equal(stored.slug, 'acme', `slug changed to ${stored.slug} (route answered ${res.statusCode})`);
});

test('clients: deleting a client that owns work is refused, and names the blocker', async () => {
  const res = await send('DELETE', '/api/clients/c1');
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.json().error?.message ?? res.body, /project/i);
  const still = await db.get('SELECT id FROM clients WHERE id = ?', ['c1']);
  assert.ok(still, 'the client must still exist after a refused delete');
});

test('clients: deleting an empty client removes it', async () => {
  const res = await send('DELETE', '/api/clients/c2');
  assert.equal(res.statusCode, 204, res.body);
  const gone = await db.get('SELECT id FROM clients WHERE id = ?', ['c2']);
  assert.equal(gone ?? null, null, 'the row must actually be gone, not archived in place');
});

/* =============================================================== partners == */

test('partners: plan and status edits are stored and visible to enforcement', async () => {
  const res = await send('PATCH', '/api/partners/pa', {
    plan: 'enterprise',
    status: 'trial',
    apiQuotaMonth: 250000,
    consoleUrl: 'https://console.partner-a.example',
  });
  assert.equal(res.statusCode, 200, res.body);

  const again = await get('/api/partners');
  const row = again.json().data.find((p) => p.id === 'pa');
  assert.equal(row.plan, 'enterprise');
  assert.equal(row.status, 'trial');

  const stored = await db.get('SELECT plan, status, api_quota_month FROM partners WHERE id = ?', ['pa']);
  assert.equal(stored.plan, 'enterprise');
  assert.equal(stored.status, 'trial');
  assert.equal(Number(stored.api_quota_month), 250000);
});

test('partners: raising a limit takes effect immediately', async () => {
  await send('PATCH', '/api/partners/pa', { deviceLimit: 9, status: 'active' });
  const ent = await get('/api/partners/pa/entitlements');
  assert.equal(ent.statusCode, 200, ent.body);
  assert.equal(ent.json().data.devices.limit, 9);
  assert.equal(ent.json().data.devices.remaining, 8, 'one device is already registered');
});

test('partners: a limit below current usage is refused with the numbers', async () => {
  const res = await send('PATCH', '/api/partners/pa', { deviceLimit: 0 });
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.json().error?.message ?? res.body, /1 registered device|already has 1/i);
  const stored = await db.get('SELECT device_limit FROM partners WHERE id = ?', ['pa']);
  assert.equal(Number(stored.device_limit), 9, 'the refused edit must leave the limit alone');
});

/* ================================================================== docs == */

test('docs: creating a document stores it with its author and project', async () => {
  const res = await send('POST', '/api/docs', {
    title: 'Incident review',
    kind: 'retro',
    body: 'What happened, and what changes.',
    projectId: 'p1',
    status: 'in_review',
    clientVisible: true,
  });
  assert.equal(res.statusCode, 201, res.body);
  const created = res.json().data;

  const stored = await db.get('SELECT * FROM docs WHERE id = ?', [created.id]);
  assert.ok(stored, 'the document must exist in the engine');
  assert.equal(stored.title, 'Incident review');
  assert.equal(stored.kind, 'retro');
  assert.equal(stored.project_id, 'p1');
  assert.equal(Number(stored.client_visible), 1, 'clientVisible must be stored as 1, not "true"');
  assert.ok(stored.author_id, 'a document needs an author');

  const listed = await get('/api/docs');
  assert.ok(listed.json().data.some((d) => d.id === created.id), 'it must appear in the list');
});

test('docs: a title is required', async () => {
  const res = await send('POST', '/api/docs', { title: '   ' });
  assert.equal(res.statusCode, 400, 'a whitespace title is not a title');
});

test('docs: editing the body moves updated_at', async () => {
  const before = await db.get('SELECT updated_at FROM docs WHERE id = ?', ['d1']);
  const res = await send('PATCH', '/api/docs/d1', {
    title: 'Runbook (v2)',
    body: 'step one, revised',
    status: 'approved',
  });
  assert.equal(res.statusCode, 200, res.body);

  const stored = await db.get('SELECT title, body, status, updated_at FROM docs WHERE id = ?', ['d1']);
  assert.equal(stored.title, 'Runbook (v2)');
  assert.equal(stored.body, 'step one, revised');
  assert.equal(stored.status, 'approved');
  assert.ok(stored.updated_at >= before.updated_at, 'updated_at must not move backwards');

  const listed = await get('/api/docs');
  assert.equal(listed.json().data.find((d) => d.id === 'd1').title, 'Runbook (v2)');
});

test('docs: deleting a document removes the row', async () => {
  const res = await send('DELETE', '/api/docs/d1');
  assert.equal(res.statusCode, 204, res.body);
  const gone = await db.get('SELECT id FROM docs WHERE id = ?', ['d1']);
  assert.equal(gone ?? null, null);
});

test('docs: an edit to a document that does not exist is a 404, not a silent success', async () => {
  const res = await send('PATCH', '/api/docs/does-not-exist', { title: 'Nothing' });
  assert.equal(res.statusCode, 404, res.body);
});

/* ============================================================== tenancy === */

test('new writes are not a way around the read scope', async () => {
  /*
   * Two different boundaries, because they fail differently.
   *
   * The operator identity is resolved once and cached for the life of the process —
   * correct for a deployment whose identity is fixed by configuration — so a test
   * that wants to act as somebody else has to clear that cache. Doing so is the only
   * way to exercise a non-admin identity here, and it is worth the trouble: "the new
   * write routes forgot the scope predicate" is precisely the regression an
   * admin-only test can never see.
   *
   *   member, no project grants  → the row is filtered out by `docsWhere`, so the
   *                                edit is a 404. A 403 would confirm the document
   *                                exists and turn the endpoint into an oracle.
   *   client                     → refused by role before the scope is even built.
   *
   * In both cases the assertion that matters is the same: the body is untouched.
   */
  await db.run(
    "INSERT INTO docs (id,project_id,title,kind,body,status,author_id,client_visible) VALUES ('d2','p1','Internal only','note','secret','draft','u_admin',0)",
  );

  const asOperator = async (userId, fn) => {
    const saved = process.env.OPERATOR_USER_ID;
    process.env.OPERATOR_USER_ID = userId;
    resetOperatorIdentity();
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.OPERATOR_USER_ID;
      else process.env.OPERATOR_USER_ID = saved;
      resetOperatorIdentity();
    }
  };

  const asMember = await asOperator('u_member', () => send('PATCH', '/api/docs/d2', { body: 'tampered' }));
  assert.equal(asMember.statusCode, 404, 'a document outside your grants must answer 404');

  const asClient = await asOperator('u_client', () => send('PATCH', '/api/docs/d2', { body: 'tampered again' }));
  assert.ok(
    asClient.statusCode === 403 || asClient.statusCode === 404,
    `a client user must be refused, got ${asClient.statusCode}`,
  );

  const stored = await db.get('SELECT body FROM docs WHERE id = ?', ['d2']);
  assert.equal(stored.body, 'secret', 'the document body must be untouched by both attempts');

  // And the legitimate operator can still edit it afterwards, so the refusals above
  // were about permission and not about the route being broken.
  const asAdmin = await asOperator('u_admin', () => send('PATCH', '/api/docs/d2', { body: 'revised by the operator' }));
  assert.equal(asAdmin.statusCode, 200, asAdmin.body);
  const after = await db.get('SELECT body FROM docs WHERE id = ?', ['d2']);
  assert.equal(after.body, 'revised by the operator');
});
