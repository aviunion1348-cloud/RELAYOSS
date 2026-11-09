/**
 * Creating and removing the things the product is made of.
 *
 * These endpoints were the hole in "everything is editable": clients, projects, deals,
 * releases, partners and QA reports could all be *listed*, most could be edited, and
 * several could not be created or removed at all — so a workspace that starts empty (as
 * this one deliberately does) could never be filled, and one that had been filled could
 * never be tidied.
 *
 * The tests drive the HTTP surface, not the services, because the thing being asserted
 * is what a person's browser gets back: a 201 with an id, or a refusal that says why.
 * Every refusal asserted here is a rule, not an accident — a partner with credentials in
 * use, a shipped release, a QA verification without evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { migrate } from '../src/db/migrate.ts';
import { ensureScaffolding } from '../src/db/scaffolding.ts';

/** A migrated, scaffolded database with one operator and no content at all. */
async function emptyApp() {
  const db = new SqliteDb(':memory:');
  await migrate(db, { log: () => {} });
  await db.run(
    `INSERT INTO users (id,email,full_name,role,is_active,initials) VALUES ('usr_owner','o@relay.local','Owner','admin',1,'OW')`,
  );
  await ensureScaffolding(db);
  const { app } = await buildApp({ db, logger: false });
  await app.ready();
  return { app, db };
}

const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });
const del = (app, url) => app.inject({ method: 'DELETE', url });

test('a brand-new installation has a board and a pipeline, so work can be created at all', async () => {
  const { app, db } = await emptyApp();

  const meta = await app.inject({ method: 'GET', url: '/api/meta' });
  assert.equal(meta.statusCode, 200);
  const boards = meta.json().data.boards;
  assert.equal(boards.length, 1, 'one studio board exists before anyone creates one');

  /*
   * The first task: the board's own column, chosen by status key. This used to be a 500
   * because the column id was derived from a seed-only naming convention instead of
   * being looked up, so `tasks.column_id` failed its foreign key.
   */
  const task = await post(app, '/api/tasks', {
    title: 'Wire the onboarding flow', boardId: boards[0].id, status: 'in_progress',
  });
  assert.equal(task.statusCode, 201, `creating the first task must work, got ${task.body}`);
  assert.equal(task.json().data.status, 'in_progress', 'it lands in the column it was asked for');
  const column = await db.get('SELECT key FROM columns WHERE id = (SELECT column_id FROM tasks)');
  assert.equal(column.key, 'in_progress', 'the column is resolved by key, not invented');

  /* The first deal: the twelve gates exist before any deal does. */
  const client = await post(app, '/api/clients', { name: 'Excali Systems' });
  const deal = await post(app, '/api/deals', {
    clientId: client.json().data.id, title: 'Onboarding retainer', valueCents: 50_000_000, stageKey: 'inbound',
  });
  assert.equal(deal.statusCode, 201, `creating the first deal must work, got ${deal.body}`);

  const pipeline = await app.inject({ method: 'GET', url: '/api/pipeline' });
  assert.equal(pipeline.json().data.columns.length, 12, 'the board shows all twelve gates');

  await app.close();
});

test('clients, projects, releases and partners can be created and removed', async () => {
  const { app } = await emptyApp();

  const client = await post(app, '/api/clients', {
    name: 'Excali Systems', industry: 'Fintech', primaryContactName: 'A Rao',
    primaryContactRole: 'CTO', notes: 'intro via referral', mrrCents: 25_000_000,
  });
  assert.equal(client.statusCode, 201);
  const clientId = client.json().data.id;
  assert.equal(client.json().data.mrrCents, 25_000_000, 'MRR is written on create, not only on edit');
  assert.equal(client.json().data.contactRole, 'CTO', 'contact role survives creation');

  const project = await post(app, '/api/projects', { name: 'Excali Onboarding', clientId });
  assert.equal(project.statusCode, 201, project.body);
  const projectId = project.json().data.id;

  const release = await post(app, '/api/releases', { projectId, version: 'v0.1', name: 'First demo' });
  assert.equal(release.statusCode, 201, `a release can be created, got ${release.body}`);
  assert.equal(release.json().data.status, 'planning', 'a new release starts at planning, never shipped');
  const releaseId = release.json().data.id;

  const partner = await post(app, '/api/partners', { name: 'Excali Partner Co', clientId });
  assert.equal(partner.statusCode, 201, `a partner can be created, got ${partner.body}`);
  const partnerId = partner.json().data.id;

  /* Duplicate version within a project is a conflict, not a second row. */
  const dup = await post(app, '/api/releases', { projectId, version: 'v0.1', name: 'Again' });
  assert.equal(dup.statusCode, 409);

  /* Removal, in the order the UI offers it. */
  assert.equal((await del(app, `/api/partners/${partnerId}`)).statusCode, 200, 'a clean partner deletes');
  assert.equal((await del(app, `/api/releases/${releaseId}`)).statusCode, 200, 'a draft release deletes');

  const projectDelete = await del(app, `/api/projects/${projectId}`);
  assert.equal(projectDelete.statusCode, 200);
  assert.equal(projectDelete.json().data.removed.tasks, 0, 'the answer reports what it removed');

  assert.equal((await del(app, `/api/clients/${clientId}`)).statusCode, 204, 'the client can go once its project has');

  await app.close();
});

test('a partner with credentials in use is refused, and the refusal carries the counts', async () => {
  const { app } = await emptyApp();
  const clientId = (await post(app, '/api/clients', { name: 'Kestrel' })).json().data.id;
  const partnerId = (await post(app, '/api/partners', { name: 'Kestrel Partner', clientId })).json().data.id;

  const device = await post(app, `/api/partners/${partnerId}/devices`, {
    deviceId: 'mac-1', deviceName: 'Studio Mac', platform: 'linux',
  });
  assert.equal(device.statusCode, 201, device.body);

  const refused = await del(app, `/api/partners/${partnerId}`);
  assert.equal(refused.statusCode, 409, 'deleting a partner with a live licence must be refused');
  assert.match(refused.json().error.message, /1 device licence/, 'the refusal says how many');
  assert.match(refused.json().error.message, /Revoke those first/);

  await app.close();
});

test('a shipped release resists deletion, because it is the record of what shipped', async () => {
  const { app, db } = await emptyApp();
  const clientId = (await post(app, '/api/clients', { name: 'Halden' })).json().data.id;
  const projectId = (await post(app, '/api/projects', { name: 'Halden Portal', clientId })).json().data.id;
  const releaseId = (await post(app, '/api/releases', { projectId, version: 'v1.0', name: 'Launch' })).json().data.id;

  /* Straight to shipped in the database: the gate itself is covered elsewhere. */
  // sql-portable-ok: a literal ISO timestamp, so the statement is identical on both engines.
  await db.run("UPDATE releases SET status = 'shipped', shipped_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [releaseId]);

  const refused = await del(app, `/api/releases/${releaseId}`);
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error.message, /has shipped/);

  const projectRefused = await del(app, `/api/projects/${projectId}`);
  assert.equal(projectRefused.statusCode, 409, 'a project with shipped releases cannot be deleted either');
  assert.match(projectRefused.json().error.message, /shipped release/);

  await app.close();
});

test('QA verification is a cross-check: fixed first, then evidence, then verified', async () => {
  const { app } = await emptyApp();
  const clientId = (await post(app, '/api/clients', { name: 'Marlow' })).json().data.id;
  const projectId = (await post(app, '/api/projects', { name: 'Marlow App', clientId })).json().data.id;
  const reportId = (await post(app, '/api/qa', {
    projectId, title: 'Onboarding skips KYC step', severity: 'p1', kind: 'bug',
    reproduction: 'Sign up, skip KYC, land on dashboard',
  })).json().data.id;

  /* From `open`: refused, because nobody has fixed it yet. */
  const early = await app.inject({ method: 'PATCH', url: `/api/qa/${reportId}`, payload: { status: 'verified' } });
  assert.equal(early.statusCode, 409);
  assert.match(early.json().error.message, /Only a report in "fixed" can be verified/);

  /* Severity uses p-levels — it used to be validated against an enum this product does not have. */
  const severity = await app.inject({ method: 'PATCH', url: `/api/qa/${reportId}`, payload: { severity: 'p2' } });
  assert.equal(severity.statusCode, 200, severity.body);

  const fixed = await app.inject({ method: 'PATCH', url: `/api/qa/${reportId}`, payload: { status: 'fixed' } });
  assert.equal(fixed.statusCode, 200);

  /* Fixed but unevidenced: still refused, and the refusal says which half is missing. */
  const noEvidence = await app.inject({ method: 'PATCH', url: `/api/qa/${reportId}`, payload: { status: 'verified' } });
  assert.equal(noEvidence.statusCode, 400);
  assert.match(noEvidence.json().error.message, /Verification needs evidence/);

  const evidence = await app.inject({
    method: 'PATCH', url: `/api/qa/${reportId}`,
    payload: { evidenceUrl: 'https://ci.example/runs/42' },
  });
  assert.equal(evidence.statusCode, 200, 'evidence can be attached after the fact');

  const verified = await app.inject({ method: 'PATCH', url: `/api/qa/${reportId}`, payload: { status: 'verified' } });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().data.status, 'verified');

  await app.close();
});

test('a deal that produced a project cannot be deleted out from under it', async () => {
  const { app, db } = await emptyApp();
  const clientId = (await post(app, '/api/clients', { name: 'Ridgeway' })).json().data.id;
  const dealId = (await post(app, '/api/deals', {
    clientId, title: 'Ridgeway rebuild', valueCents: 90_000_000, stageKey: 'inbound',
  })).json().data.id;
  const projectId = (await post(app, '/api/projects', { name: 'Ridgeway Rebuild', clientId })).json().data.id;
  await db.run('UPDATE projects SET deal_id = ? WHERE id = ?', [dealId, projectId]);

  const refused = await del(app, `/api/deals/${dealId}`);
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error.message, /origin of project/);

  await app.close();
});
