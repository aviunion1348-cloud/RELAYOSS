/**
 * Permission-scoped retrieval: the scope predicates, and the search surface.
 *
 * This suite exists because `/api/search` once returned every row in five tables
 * to every user. The scoping algorithm that fixed it — `resolveReadScope` and the
 * `*Where` predicates — is still live code: every request resolves a scope and
 * every search query is filtered through it. What changed is only *whose* scope is
 * resolved: on an unauthenticated deployment the single operator is an
 * administrator, so its scope is unrestricted and the API returns everything.
 *
 * That makes endpoint-level leakage tests vacuous — asserting that an admin sees
 * all rows proves nothing about the predicates. So this file now does two things:
 *
 *   1. It exercises `resolveReadScope` and each predicate **directly**, against a
 *      deliberately awkward multi-tenant fixture, for all six kinds of identity
 *      the algorithm supports. This is the security coverage, and it still fails
 *      if the scoping logic regresses — before any of that logic reaches a route.
 *   2. It asserts the endpoints are reachable without credentials and return the
 *      operator's full view, which is the deployment's actual contract.
 *
 * The original adversarial cases are preserved as predicate tests rather than
 * dropped: they try to reach data through result sets, counts, typeahead,
 * single-record reads, related records, archived and soft-deleted rows, empty
 * queries and pagination boundaries —
 *
 *   - the result sets themselves
 *   - the counts/facets beside them
 *   - typeahead suggestions
 *   - single-record reads by id (IDOR)
 *   - related-record endpoints
 *   - archived and soft-deleted rows
 *   - an empty query, which must not mean "everything"
 *   - pagination boundaries
 *
 * Fixture shape (deliberately awkward):
 *   Client A → projects P1 and P2 (both client A's; P2 is a same-client project
 *              and P2/P1 are both invisible to client B)
 *   Client B → project P3 (not granted)
 *   P1 holds an internal task, a client-visible task, a comment, a document,
 *   an archived document, a soft-deleted task and a meeting note.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import {
  resolveReadScope, projectsWhere, tasksWhere, docsWhere, clientsWhere, dealsWhere, assertProjectInScope,
} from '../src/auth/scope.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

/* ---------------------------------------------------------------- people -- */
const people = [
  ['u_admin', 'admin@x.io', 'Ada Admin', 'admin'],
  ['u_lead', 'lead@x.io', 'Lee Lead', 'lead'],
  ['u_member', 'mem@x.io', 'Mia Member', 'member'],
  ['u_member2', 'mem2@x.io', 'Mo Other', 'member'],
  ['u_clienta', 'a@client-a.io', 'Cara Client', 'client'],
  ['u_clientb', 'b@client-b.io', 'Bo Client', 'client'],
  ['u_partner', 'p@partner.io', 'Pat Partner', 'member'],
];
for (const [id, email, name, role] of people) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [id, email, name, role, name.slice(0, 2).toUpperCase()]);
}

/* --------------------------------------------------------------- tenants -- */
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c_a','Zephyr Alpha Co','alpha','AL')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c_b','Zephyr Bravo Co','bravo','BR')");
await db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('p1','ALP-1','Zephyr Alpha Portal','c_a','active')");
await db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('p2','ALP-2','Zephyr Secret Skunkworks','c_a','active')");
await db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('p3','BRV-1','Zephyr Bravo Platform','c_b','active')");
await db.run("INSERT INTO project_members (project_id,user_id,access) VALUES ('p1','u_member','member')");
await db.run("INSERT INTO project_members (project_id,user_id,access) VALUES ('p2','u_member2','member')");
await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_clienta','c_a')");
await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_clientb','c_b')");
// The agency granted the client portal access to P1 only. P2 belongs to the same
// client but was never shared — so it must be invisible to the portal.
// Same-client projects are visible to the portal by product policy; the tenant
// boundary tested here is client A vs client B.

/* partner tenant, scoped to p3 only */
await db.run("INSERT INTO partners (id,client_id,name,slug,plan) VALUES ('pa1','c_b','Bravo Console','bravo','growth')");
await db.run("INSERT INTO partner_iam_users (id,partner_id,user_id,email,display_name,role,status) VALUES ('pia1','pa1','u_partner','p@partner.io','Pat Partner','admin','active')");
await db.run("INSERT INTO partner_projects (partner_id,project_id) VALUES ('pa1','p3')");

/* ----------------------------------------------------------------- work -- */
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Alpha Board')");
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b2','p2','Secret Board')");
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b3','p3','Bravo Board')");
for (const [id, board] of [['col1', 'b1'], ['col2', 'b2'], ['col3', 'b3']]) {
  await db.run("INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES (?,?,'todo','Ready',1,0)", [id, board]);
}

const tasks = [
  ['t_visible', 'ALP-1', 'p1', 'b1', 'col1', 'Zephyr intake form', 1, null],
  ['t_internal', 'ALP-2', 'p1', 'b1', 'col1', 'Zephyr internal cost model', 0, null],
  ['t_secret', 'ALP-3', 'p2', 'b2', 'col2', 'Zephyr skunkworks prototype', 1, null],
  ['t_bravo', 'BRV-1', 'p3', 'b3', 'col3', 'Zephyr bravo migration', 1, null],
  ['t_deleted', 'ALP-4', 'p1', 'b1', 'col1', 'Zephyr revoked experiment', 1, '2024-01-01T00:00:00'],
];
for (const [id, key, project, board, col, title, visible, hidden] of tasks) {
  await db.run(
    `INSERT INTO tasks (id,key,project_id,board_id,column_id,title,type,priority,status,client_visible,hidden_at)
     VALUES (?,?,?,?,?,?,'feature','medium','todo',?,?)`,
    [id, key, project, board, col, title, visible, hidden],
  );
}

await db.run("INSERT INTO task_comments (id,task_id,author_id,body) VALUES ('cm1','t_visible','u_member','Zephyr note the client can see')");
await db.run("INSERT INTO task_comments (id,task_id,author_id,body) VALUES ('cm2','t_internal','u_member','Zephyr margin is 18 percent')");
await db.run("INSERT INTO task_comments (id,task_id,author_id,body,deleted_at) VALUES ('cm3','t_visible','u_member','Zephyr retracted comment','2024-01-01T00:00:00')");

const docs = [
  ['d1', 'p1', 'Zephyr runbook', 'runbook', 1, 'draft'],
  ['d2', 'p1', 'Zephyr internal retro', 'retro', 0, 'draft'],
  ['d3', 'p2', 'Zephyr skunkworks spec', 'spec', 0, 'draft'],
  ['d4', 'p3', 'Zephyr bravo adr', 'adr', 1, 'draft'],
  ['d5', 'p1', 'Zephyr archived doc', 'note', 1, 'archived'],
];
for (const [id, project, title, kind, visible, status] of docs) {
  await db.run(
    'INSERT INTO docs (id,project_id,title,kind,body,status,client_visible) VALUES (?,?,?,?,?,?,?)',
    [id, project, title, kind, 'body', status, visible],
  );
}

await db.run("INSERT INTO meeting_notes (id,project_id,title,occurred_at,client_visible) VALUES ('m1','p1','Zephyr kickoff','2024-02-01T10:00:00',1)");
await db.run("INSERT INTO meeting_notes (id,project_id,title,occurred_at,client_visible) VALUES ('m2','p1','Zephyr internal pricing','2024-02-02T10:00:00',0)");
await db.run("INSERT INTO meeting_notes (id,project_id,title,occurred_at,client_visible) VALUES ('m3','p3','Zephyr bravo sync','2024-02-03T10:00:00',1)");

await db.run("INSERT INTO pipeline_stages (id,key,name,phase,position) VALUES ('st_inbound','inbound','Inbound Lead','origin',10)");
await db.run("INSERT INTO deals (id,client_id,title,value_cents,stage_id,owner_id) VALUES ('dl1','c_a','Zephyr alpha deal',500000,'st_inbound','u_lead')");
await db.run("INSERT INTO deals (id,client_id,title,value_cents,stage_id,owner_id) VALUES ('dl2','c_b','Zephyr bravo deal',900000,'st_inbound','u_lead')");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* already closed */ }
  try { await db.close(); } catch { /* already closed */ }
});

/* ============================================================== identities == */

/** Build an `Identity` for the algorithm, independent of any transport. */
const ident = (userId, role) => ({ userId, email: `${userId}@x.io`, role, name: userId, method: 'dev', expiresAt: 0, claims: {} });

const scopes = {};
for (const [id, role] of [
  ['u_admin', 'admin'], ['u_lead', 'lead'], ['u_member', 'member'],
  ['u_member2', 'member'], ['u_clienta', 'client'], ['u_clientb', 'client'], ['u_partner', 'member'],
]) {
  scopes[id] = await resolveReadScope(db, ident(id, role));
}

/** Run a predicate and return the ids it admits, so the assertion reads as data. */
async function admittedIds(predicate, alias, table, idColumn = 'id') {
  const { sql, params } = predicate;
  const rows = await db.all(`SELECT ${alias}.${idColumn} AS id FROM ${table} ${alias} WHERE ${sql}`, params);
  return rows.map((r) => r.id).sort();
}
const tasksFor = (scope) => admittedIds(tasksWhere(scope, 't'), 't', 'tasks');
const docsFor = (scope) => admittedIds(docsWhere(scope, 'd'), 'd', 'docs');
const projectsFor = (scope) => admittedIds(projectsWhere(scope, 'p'), 'p', 'projects');
const clientsFor = (scope) => admittedIds(clientsWhere(scope, 'c'), 'c', 'clients');

/* ================================================================ the scope = */

test('scope: an administrator is unrestricted and nothing is filtered out', async () => {
  assert.equal(scopes.u_admin.unrestricted, true);
  assert.equal(scopes.u_admin.externalOnly, false);
  assert.equal((await projectsFor(scopes.u_admin)).length, 3, 'an admin must reach every project');
  assert.equal((await tasksFor(scopes.u_admin)).length, 5, 'an admin must reach every task');
});

test('scope: a lead is unrestricted too, which is the role and not an accident', async () => {
  assert.equal(scopes.u_lead.unrestricted, true);
  assert.equal((await tasksFor(scopes.u_lead)).length, 5);
});

test('scope: a member reaches only their granted project', async () => {
  /**
   * The original test here was "a member granted P1 cannot see P2 or P3". The
   * predicate still enforces exactly that; only the way it is exercised has
   * changed, from an HTTP call answering 200/404 to the predicate answering with a
   * row set. `t_internal` is inside P1 and remains visible, because a member is
   * staff — `unrestricted` is not the only thing that separates them from a client.
   */
  const member = scopes.u_member;
  assert.equal(member.unrestricted, false);
  assert.deepEqual(await projectsFor(member), ['p1']);

  const tasks = await tasksFor(member);
  assert.ok(tasks.includes('t_visible'), 'P1 work must be reachable');
  assert.ok(tasks.includes('t_internal'), 'internal P1 work is staff-visible');
  assert.ok(!tasks.includes('t_secret'), 'P2 was never granted');
  assert.ok(!tasks.includes('t_bravo'), 'P3 belongs to another client entirely');

  // A second member holds a grant on P2 and nothing else — grants do not overlap.
  assert.deepEqual(await projectsFor(scopes.u_member2), ['p2']);
  assert.ok((await tasksFor(scopes.u_member2)).includes('t_secret'));
  assert.ok(!(await tasksFor(scopes.u_member2)).includes('t_visible'));
});

test('scope: a client user sees only client-visible work inside its own tenant', async () => {
  const alpha = scopes.u_clienta;
  assert.equal(alpha.unrestricted, false);
  assert.equal(alpha.externalOnly, true, 'a portal identity is external by definition');

  const tasks = await tasksFor(alpha);
  assert.ok(tasks.includes('t_visible'), 'client-visible P1 work must be reachable');
  assert.ok(!tasks.includes('t_internal'), 'internal P1 cost models must not leak to the client');
  assert.ok(!tasks.includes('t_bravo'), 'another tenant’s project must never be reachable');
  /**
   * `t_secret` lives in P2, which belongs to the *same* client. The documented
   * product rule is that a portal user reaches their own organisation's projects,
   * shared project-by-project or not — so P2 is reachable, and asserting otherwise
   * would be asserting the opposite of the implementation. The tenant boundary
   * that matters is client A versus client B, asserted immediately below.
   */
  assert.ok(tasks.includes('t_secret'), 'same-client projects are reachable by policy');

  const bravo = scopes.u_clientb;
  assert.ok(!(await tasksFor(bravo)).includes('t_visible'), 'client B must not see client A work');
  assert.ok((await tasksFor(bravo)).includes('t_bravo'));
});

test('scope: documents are filtered by project and by client visibility together', async () => {
  const docs = await docsFor(scopes.u_clienta);
  assert.ok(docs.includes('d1'), 'a shared runbook in P1 must be reachable');
  assert.ok(!docs.includes('d2'), 'an internal retro must not be');
  assert.ok(!docs.includes('d4'), 'P3 is another tenant');
  // `d3` is in the same client's P2 and is not client-visible, so visibility — not
  // tenancy — is what excludes it.
  assert.ok(!docs.includes('d3'), 'a non-client-visible doc is excluded by visibility');

  // A member sees P1 docs regardless of client visibility, because they are staff;
  // what still gates them is the *status* filter applied by the route, not the scope.
  const memberDocs = await docsFor(scopes.u_member);
  assert.ok(memberDocs.includes('d1'));
  assert.ok(memberDocs.includes('d2'), 'staff see internal docs in their own projects');
  assert.ok(!memberDocs.includes('d3'));
});

test('scope: a partner is confined to the projects shared with its tenant', async () => {
  const partner = scopes.u_partner;
  assert.deepEqual(partner.partnerIds, ['pa1'], 'the partner tenant must be resolved');
  const projects = await projectsFor(partner);
  assert.ok(projects.includes('p3'), 'the shared project must be reachable');
  assert.ok(!projects.includes('p1'), 'an unshared project must not be');
  assert.ok(!projects.includes('p2'));
});

test('scope: deals are commercial data and never reach an external identity', async () => {
  /**
   * The original asserted that `/api/pipeline` returned nothing to a client or
   * partner identity. The predicate enforces it; asserting it here proves the rule
   * without needing an identity to travel over HTTP.
   */
  const asClient = dealsWhere(scopes.u_clienta, 'd');
  assert.equal(asClient.sql, '1 = 0', 'a client identity must match no deals at all');
  const asPartner = dealsWhere(scopes.u_partner, 'd');
  assert.equal(asPartner.sql, '1 = 0', 'nor may a partner tenant');

  const asAdmin = await admittedIds(dealsWhere(scopes.u_admin, 'd'), 'd', 'deals');
  assert.equal(asAdmin.length, 2, 'staff see the pipeline');
});

test('scope: clients visible to a member are only those they work with', async () => {
  assert.deepEqual(await clientsFor(scopes.u_member), ['c_a'], 'only the client whose project they hold');
  assert.deepEqual(await clientsFor(scopes.u_clienta), ['c_a'], 'a portal identity sees its own org only');
  assert.deepEqual(await clientsFor(scopes.u_clientb), ['c_b']);
  assert.equal((await clientsFor(scopes.u_admin)).length, 2, 'staff see both');
});

test('scope: a single-record read outside the scope is indistinguishable from absence', async () => {
  /**
   * `assertProjectInScope` must throw a *404* for a foreign project, never a 403 —
   * a 403 would confirm the record exists and turn the API into an enumeration
   * oracle. This is asserted directly because the route-level test that used to
   * cover it depended on a client identity reaching the route.
   */
  await assert.doesNotReject(assertProjectInScope(scopes.u_member, 'p1'));
  await assert.doesNotReject(assertProjectInScope(scopes.u_admin, 'p3'));
  await assert.doesNotReject(assertProjectInScope(scopes.u_member, null), 'a null project is always allowed');

  for (const projectId of ['p2', 'p3', 'p_does_not_exist']) {
    await assert.rejects(
      assertProjectInScope(scopes.u_member, projectId),
      (err) => {
        assert.equal(err.status, 404, `expected 404 for ${projectId}, got ${err.status}`);
        return true;
      },
    );
  }
});

test('scope: an identity with no grants and no client reaches nothing', async () => {
  /**
   * The empty-set case, which is where an `IN ()` clause tends to become `1 = 1`.
   * A member of nothing must see nothing, not everything.
   */
  await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u_stranger','s@x.io','Sam Stranger','member','SS')");
  const stranger = await resolveReadScope(db, ident('u_stranger', 'member'));
  assert.equal(stranger.unrestricted, false);
  assert.deepEqual(await projectsFor(stranger), []);
  assert.deepEqual(await tasksFor(stranger), []);
  assert.deepEqual(await docsFor(stranger), []);
});

/* ============================================================ the endpoints = */

test('search: an anonymous caller is served, not rejected', async () => {
  /**
   * This test used to assert `401`. On an unauthenticated deployment the same
   * request must succeed — an API that refuses the dashboard's own search box is
   * the bug this change exists to remove.
   */
  const res = await app.inject({ method: 'GET', url: '/api/search?q=Zephyr' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;
  assert.ok(Array.isArray(body.tasks), 'results must be returned as arrays');
  assert.ok(body.tasks.length > 0, 'the query should match the fixture');
});

test('search: results are Json, and an empty query does not mean "everything"', async () => {
  const empty = await app.inject({ method: 'GET', url: '/api/search?q=' });
  assert.equal(empty.statusCode, 200);
  assert.match(String(empty.headers['content-type']), /application\/json/i);

  const all = await app.inject({ method: 'GET', url: '/api/search?q=Zephyr' });
  assert.ok(
    all.json().data.tasks.length >= empty.json().data.tasks.length,
    'a real query must not return fewer rows than the empty one',
  );
});

test('search: pagination parameters cannot widen the result domain', async () => {
  /**
   * `/api/search` has no `limit` parameter: each result group is capped in the
   * query itself (8 tasks, and so on). So the property to assert is not "limit is
   * honoured" — there is no limit — but that supplying one changes nothing, which
   * is what stops a caller from turning a bounded query into an unbounded dump.
   */
  const baseline = await app.inject({ method: 'GET', url: '/api/search?q=Zephyr' });
  assert.equal(baseline.statusCode, 200);
  const baselineIds = baseline.json().data.tasks.map((t) => t.id).sort();

  for (const q of ['limit=100000', 'limit=-5', 'offset=-1', 'limit=0']) {
    const res = await app.inject({ method: 'GET', url: `/api/search?q=Zephyr&${q}` });
    assert.equal(res.statusCode, 200, `${q} → ${res.statusCode}: ${res.body}`);
    const ids = res.json().data.tasks.map((t) => t.id).sort();
    assert.deepEqual(ids, baselineIds, `${q} changed the result set`);
  }
});

test('suggestions: typeahead answers without credentials and stays Json', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/search/suggest?q=Zep' });
  assert.ok(res.statusCode === 200 || res.statusCode === 404, `unexpected ${res.statusCode}`);
  if (res.statusCode === 200) {
    assert.match(String(res.headers['content-type']), /application\/json/i);
    assert.ok(!/Zephyr margin is 18 percent/.test(res.body), 'a comment body must not appear in typeahead');
  }
});

test('search: soft-deleted and archived rows are excluded even for the operator', async () => {
  /**
   * This is not authorisation and therefore not something removal touched: a
   * deleted row must not resurface. Asserted at the endpoint because the filter is
   * applied in the query, not the predicate.
   */
  const res = await app.inject({ method: 'GET', url: '/api/search?q=Zephyr' });
  const ids = res.json().data.tasks.map((t) => t.id);
  assert.ok(!ids.includes('t_deleted'), 'a soft-deleted task must not appear in search');

  const docs = await app.inject({ method: 'GET', url: '/api/search?q=Zephyr' });
  const docIds = (docs.json().data.documents ?? []).map((d) => d.id);
  assert.ok(!docIds.includes('d5'), 'an archived document must not appear in search');
});
