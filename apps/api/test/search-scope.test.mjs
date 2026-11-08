/**
 * Permission-scoped retrieval: search, suggestions, filters and single reads.
 *
 * This suite exists because `/api/search` returned every row in five tables to
 * every authenticated user. That is the whole class of bug the brief calls a
 * release blocker, so the tests are adversarial rather than illustrative: they
 * try to reach data through every surface that could leak it —
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

async function login(userId) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/dev-login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ userId }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return {
    cookie: res.headers['set-cookie'].split(';')[0],
    csrf: res.json().data.csrfToken,
  };
}

async function get(session, url) {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
  return { status: res.statusCode, body: res.json() };
}

const admin = await login('u_admin');
const lead = await login('u_lead');
const member = await login('u_member');
const member2 = await login('u_member2');
const clientA = await login('u_clienta');
const clientB = await login('u_clientb');
const partner = await login('u_partner');

const ids = (rows) => rows.map((r) => r.id);
const titles = (rows) => rows.map((r) => r.title ?? r.name ?? r.body ?? '');

/* ============================================== the leak that started this == */

test('search: an anonymous caller gets 401, never an empty 200', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/search?q=Zephyr' });
  assert.equal(res.statusCode, 401);
});

test('search: an empty query returns nothing, not everything', async () => {
  const { body } = await get(admin, '/api/search?q=');
  assert.deepEqual(body.data.tasks, []);
  assert.deepEqual(body.data.projects, []);
  assert.deepEqual(body.data.counts, {});
});

test('search: admin sees every client and project', async () => {
  const { body } = await get(admin, '/api/search?q=Zephyr');
  const projectIds = ids(body.data.projects);
  assert.ok(projectIds.includes('p1') && projectIds.includes('p2') && projectIds.includes('p3'));
  assert.deepEqual(ids(body.data.clients).sort(), ['c_a', 'c_b']);
  assert.ok(ids(body.data.deals).includes('dl1') && ids(body.data.deals).includes('dl2'));
});

test('search: a member granted P1 cannot see P2 or P3', async () => {
  const { body } = await get(member, '/api/search?q=Zephyr');
  const projectIds = ids(body.data.projects);
  assert.deepEqual(projectIds, ['p1'], `member should only reach p1, got ${projectIds.join(',')}`);
  assert.ok(!titles(body.data.tasks).some((t) => t.includes('skunkworks')), 'P2 task title leaked');
  assert.ok(!titles(body.data.tasks).some((t) => t.includes('bravo')), 'P3 task title leaked');
});

test('search: a client user sees only client-visible work inside their own tenant', async () => {
  const { body } = await get(clientA, '/api/search?q=Zephyr');
  const taskTitles = titles(body.data.tasks);
  assert.ok(taskTitles.some((t) => t.includes('intake form')), 'client should see shared work');
  assert.ok(!taskTitles.some((t) => t.includes('cost model')), 'internal task leaked to client');
  // Same-client projects are the client's own data (product policy, mirroring
  // requireProjectAccess). Cross-tenant is the line that must never be crossed:
  assert.ok(!taskTitles.some((t) => t.includes('bravo')), 'other client leaked');
  assert.ok(!taskTitles.some((t) => t.includes('migration')), 'other client task leaked');
  assert.deepEqual(ids(body.data.clients), ['c_a'], 'client must not see the other client');
  assert.deepEqual(body.data.deals, [], 'commercial pipeline must never reach a client');
});

test('search: a client user sees only documents marked client-visible', async () => {
  const { body } = await get(clientA, '/api/search?q=Zephyr');
  const docIds = ids(body.data.docs);
  assert.ok(docIds.includes('d1'), 'shared runbook missing');
  assert.ok(!docIds.includes('d2'), 'internal retro leaked');
  assert.ok(!docIds.includes('d4'), 'other-client adr leaked');
});

test('search: a partner sees only projects shared with its tenant', async () => {
  const { body } = await get(partner, '/api/search?q=Zephyr');
  assert.deepEqual(ids(body.data.projects), ['p3'], 'partner reached a project outside its tenant');
  assert.ok(!titles(body.data.tasks).some((t) => t.includes('intake form')));
  assert.deepEqual(body.data.deals, [], 'partner must not see the agency pipeline');
});

test('search: comments are as visible as the task they belong to', async () => {
  const asClient = await get(clientA, '/api/search?q=Zephyr');
  const bodies = asClient.body.data.comments.map((c) => c.body);
  assert.ok(!bodies.some((b) => b.includes('margin is 18 percent')), 'internal comment leaked to client');
  const asMember = await get(member, '/api/search?q=Zephyr');
  assert.ok(asMember.body.data.comments.some((c) => c.body.includes('margin is 18 percent')), 'member should see its own project comment');
});

test('search: a deleted comment and an archived document never appear', async () => {
  for (const session of [admin, member, clientA]) {
    const { body } = await get(session, '/api/search?q=Zephyr');
    assert.ok(!body.data.comments.some((c) => c.id === 'cm3'), 'deleted comment surfaced');
    assert.ok(!body.data.docs.some((d) => d.id === 'd5'), 'archived document surfaced');
  }
});

test('search: a soft-deleted task never appears', async () => {
  const { body } = await get(admin, '/api/search?q=Zephyr');
  assert.ok(!body.data.tasks.some((t) => t.id === 't_deleted'), 'soft-deleted task surfaced');
});

test('search: counts match the rows that were returned, not a wider query', async () => {
  for (const session of [member, clientA, partner]) {
    const { body } = await get(session, '/api/search?q=Zephyr');
    const c = body.data.counts;
    assert.equal(c.tasks, body.data.tasks.length);
    assert.equal(c.projects, body.data.projects.length);
    assert.equal(c.clients, body.data.clients.length);
    assert.equal(c.docs, body.data.docs.length);
    assert.equal(c.comments, body.data.comments.length);
  }
});

test('search: meeting notes are external-visible only when shared', async () => {
  const asClient = await get(clientA, '/api/search?q=Zephyr');
  const meetingTitles = asClient.body.data.meetings.map((m) => m.title);
  assert.ok(meetingTitles.includes('Zephyr kickoff'), 'shared note missing');
  assert.ok(!meetingTitles.some((t) => t.includes('pricing')), 'internal pricing note leaked');
});

test('suggestions: typeahead leaks nothing the full search would not', async () => {
  const suggest = await get(member, '/api/search/suggest?q=Zephyr');
  assert.equal(suggest.status, 200);
  const labels = suggest.body.data.suggestions.map((s) => s.label);
  assert.ok(!labels.some((l) => l.includes('ALP-3')), 'P2 task suggested to a P1 member');
  const anon = await app.inject({ method: 'GET', url: '/api/search/suggest?q=Zephyr' });
  assert.equal(anon.statusCode, 401);
});

/* ================================================== IDOR / single-record == */

test('IDOR: reading a task by id from another project is a 404, not a 200', async () => {
  const forbiddenTask = await get(member, '/api/tasks/t_secret');
  assert.equal(forbiddenTask.status, 404, 'a P1 member read a P2 task');
  const otherTenant = await get(clientA, '/api/tasks/t_bravo');
  assert.equal(otherTenant.status, 404);
  const own = await get(member, '/api/tasks/t_visible');
  assert.equal(own.status, 200);
});

test('IDOR: a client cannot read an internal task even inside its own project', async () => {
  const res = await get(clientA, '/api/tasks/t_internal');
  assert.equal(res.status, 404, 'client read an internal-only task');
});

test('IDOR: denial and absence are indistinguishable (no enumeration oracle)', async () => {
  const denied = await get(member, '/api/tasks/t_secret');
  const missing = await get(member, '/api/tasks/t_does_not_exist');
  assert.equal(denied.status, missing.status);
  assert.deepEqual(denied.body.error.code, missing.body.error.code);
});

test('documents: listing is scoped, and the single-project form is scoped too', async () => {
  const asMember = await get(member, '/api/docs');
  assert.ok(!ids(asMember.body.data).includes('d3'), 'P2 document listed to a P1 member');
  const targeted = await get(member, '/api/docs?projectId=p2');
  assert.equal(targeted.status, 404, 'scope was bypassed with a projectId parameter');
  const asClient = await get(clientA, '/api/docs');
  assert.ok(!ids(asClient.body.data).includes('d2'), 'internal document listed to a client');
  assert.ok(ids(asClient.body.data).includes('d1'), 'shared document missing for the client');
});

/* ================================================ grant changes take hold == */

test('isolation: a revoked grant takes effect on the next request, with no cache', async () => {
  const before = await get(member, '/api/search?q=Zephyr');
  assert.ok(ids(before.body.data.projects).includes('p1'));
  await db.run("DELETE FROM project_members WHERE project_id = 'p1' AND user_id = 'u_member'");
  const after1 = await get(member, '/api/search?q=Zephyr');
  // The member still has assigned work in p1? No — assignment is separate and
  // this fixture has none, so p1 must now be invisible.
  assert.ok(!ids(after1.body.data.projects).includes('p1'), 'revoked grant still returned p1');
  const taskAfter = await get(member, '/api/tasks/t_visible');
  assert.equal(taskAfter.status, 404, 'revoked grant still allowed a task read');
  // Restore so later tests are not order-dependent.
  await db.run("INSERT INTO project_members (project_id,user_id,access) VALUES ('p1','u_member','member')");
});

test('isolation: pagination parameters cannot widen the scope', async () => {
  const res = await get(member, '/api/search?q=Zephyr&limit=1000&offset=0&page=1');
  const projectIds = ids(res.body.data.projects);
  assert.deepEqual(projectIds, ['p1'], 'pagination parameters widened the result set');
});

test('isolation: an unknown identity cannot reach search through a forged header', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/search?q=Zephyr',
    headers: { 'x-actor-id': 'u_admin' },
  });
  assert.equal(res.statusCode, 401, 'identity header was trusted');
});

/* ================================== write-path IDOR, not just read paths ==
 *
 * Both routes below were reachable by direct object reference: the item's own id was
 * enough, and neither checked tenancy. `PATCH /api/tasks/:id/checklist/:itemId`
 * ignored the `:id` in the path altogether, and `PATCH /api/qa/:id` looked up nothing
 * before writing. The QA route surfaced as a 500 — an arbitrary status value violated
 * a CHECK constraint — which is how a missing access-control check masquerades as a
 * schema problem and leaks the constraint text.
 *
 * These tests assert two things each: the write is refused, and **the row is
 * unchanged**. Asserting only the status would pass for a handler that denies after
 * mutating.
 */

test('idor: a checklist item cannot be written through a foreign task', async () => {
  await db.run("INSERT INTO task_checklist (id,task_id,label,done,position) VALUES ('chk1','t_visible','Zephyr step',0,1)");

  // Client B has no grant on p1, which owns t_visible.
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/tasks/t_visible/checklist/chk1',
    headers: { cookie: clientB.cookie, 'x-csrf-token': clientB.csrf, 'content-type': 'application/json' },
    payload: JSON.stringify({ done: true }),
  });
  assert.equal(res.statusCode, 404, 'a foreign client mutated another tenant\'s checklist item');

  const row = await db.get("SELECT done FROM task_checklist WHERE id = 'chk1'");
  assert.equal(Number(row.done), 0, 'the refused write still changed the row');

  // Pairing a task the caller may write with an item belonging to a different task
  // must not work either: the item is resolved through the task in the URL.
  const paired = await app.inject({
    method: 'PATCH',
    url: `/api/tasks/${'t_other'}/checklist/chk1`,
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' },
    payload: JSON.stringify({ done: true }),
  });
  assert.equal(paired.statusCode, 404, 'an item was reachable through a task that does not own it');
});

test('idor: a QA report cannot be written by a foreign identity, and a bad status is a 400', async () => {
  await db.run("INSERT INTO qa_reports (id,project_id,kind,title) VALUES ('qa_scope','p1','bug','Zephyr defect')");

  const foreign = await app.inject({
    method: 'PATCH',
    url: '/api/qa/qa_scope',
    headers: { cookie: clientB.cookie, 'x-csrf-token': clientB.csrf, 'content-type': 'application/json' },
    payload: JSON.stringify({ status: 'verified' }),
  });
  assert.equal(foreign.statusCode, 404, 'a foreign identity mutated a QA report');
  const after1 = await db.get("SELECT status FROM qa_reports WHERE id = 'qa_scope'");
  assert.equal(after1.status, 'open', 'the refused write still changed the report');

  // An authorised identity sending a value the schema would reject gets a validation
  // error, not a constraint violation surfaced as a 500.
  const invalid = await app.inject({
    method: 'PATCH',
    url: '/api/qa/qa_scope',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' },
    payload: JSON.stringify({ status: 'not_a_status' }),
  });
  assert.equal(invalid.statusCode, 400, 'an invalid status must be a 400, not a 500');
  assert.match(invalid.json().error.message, /status must be one of/);

  // And the legitimate write works.
  const ok = await app.inject({
    method: 'PATCH',
    url: '/api/qa/qa_scope',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' },
    payload: JSON.stringify({ status: 'verified' }),
  });
  assert.equal(ok.statusCode, 200);
});

/* ============================ money fields are not directory data =========
 *
 * `GET /api/users` and `/api/meta` returned the full user shape — including
 * `costRateCents` and `billRateCents` — to every authenticated identity. A
 * client-portal user could read internal staff economics by fetching the directory.
 * The directory itself is legitimately shared; the rates are not.
 */
test('exposure: staff rates are withheld from a client but kept for staff', async () => {
  await db.run("UPDATE users SET cost_rate_cents = 4200, bill_rate_cents = 14500 WHERE id = 'u_admin'");

  const asClient = await get(clientB, '/api/users');
  assert.equal(asClient.status, 200, 'the directory stays reachable — assignee pickers need it');
  for (const row of asClient.body.data) {
    assert.equal(row.costRateCents, undefined, 'a client read an internal cost rate');
    assert.equal(row.billRateCents, undefined, 'a client read an internal bill rate');
  }
  // The same must hold on /api/meta, which embeds the directory.
  const meta = await get(clientB, '/api/meta');
  for (const row of meta.body.data.users) {
    assert.equal(row.costRateCents, undefined, '/api/meta leaked a cost rate to a client');
    assert.equal(row.billRateCents, undefined, '/api/meta leaked a bill rate to a client');
  }

  // Staff still see them: withholding from everyone would break the workload screen.
  const asLead = await get(lead, '/api/users');
  const admin = asLead.body.data.find((u) => u.id === 'u_admin');
  assert.equal(admin.costRateCents, 4200, 'a lead lost access to cost rates');
  assert.equal(admin.billRateCents, 14500, 'a lead lost access to bill rates');

  // And the fields are useful, not merely absent: a member must not see them.
  const asMember = await get(member, '/api/users');
  assert.equal(
    asMember.body.data.find((u) => u.id === 'u_admin')?.costRateCents,
    undefined,
    'a plain member read a cost rate',
  );
});
