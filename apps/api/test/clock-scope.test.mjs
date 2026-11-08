/**
 * R83 — a clock you can see is a clock you can resolve.
 *
 * The defect this suite exists for reached a user as "the dashboard opens but
 * nothing works when I click": the Clocks screen listed six kinds of turnover
 * clock, each with Met / Pause / Waive buttons, and three of those kinds answered
 * **404** to every click.
 *
 * The cause was an identifier mismatch inside the tenancy guard, not a missing
 * route. `assertTimerInScope` resolved a timer's `entity_id` by looking the entity
 * up **by row id only**, while `sla_timers.entity_id` stores whatever identifier
 * the clock is *about*:
 *
 *   task      the human key, `NRTH-102` — not `tasks.id`
 *   release   the version the client was promised, `v3.1.0` — not `releases.id`
 *   qa        the report it concerns — and the seeded clock named `QA-2201`,
 *             which is not a report in this schema at all
 *   deal      handled by no branch whatsoever
 *
 * A guard that cannot resolve an entity reports "not found", so the symptom was
 * indistinguishable from a deleted timer. Nothing caught it because the only test
 * that exercised resolve created its timer through the task path, which happened
 * to use the id.
 *
 * The invariant, therefore, is a property of the *list*: every timer the API
 * returns must be resolvable by the same caller through the API. That is stated
 * once, over every timer, for every entity type — including a kind added later.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { startTimer } from '../src/services/clocks.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

/* The smallest fixture in which every entity type can exist. */
await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u1','a@x.io','Ada','admin','AD') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO projects (id,key,name,client_id,status) VALUES ('p1','ACM','Acme Project','c1','active') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery') ON CONFLICT DO NOTHING");
for (const [key, name] of [['backlog', 'Backlog'], ['todo', 'Ready'], ['review', 'In Review'], ['done', 'Done']]) {
  await db.run('INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    [`b1_${key}`, 'b1', key, name, 0, key === 'done' ? 1 : 0]);
}
await db.run("INSERT INTO pipeline_stages (id,key,name,phase,position) VALUES ('st1','tech_consult','Technical Consultation','discovery',30) ON CONFLICT (key) DO UPDATE SET name = excluded.name");
await db.run("INSERT INTO deals (id,client_id,title,value_cents,stage_id,owner_id) VALUES ('dl1','c1','Acme platform',5000000,'st1','u1') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO releases (id,project_id,version,name,status) VALUES ('rel1','p1','v1.0.0','Launch','in_qa') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO qa_reports (id,project_id,kind,severity,title) VALUES ('qa1','p1','bug','p2','Checkout resets') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO tasks (id,key,project_id,board_id,column_id,title,status) VALUES ('t1','ACM-101','p1','b1','b1_review','Turnover the intake module','review') ON CONFLICT DO NOTHING");
await db.run("INSERT INTO task_checklist (id,task_id,label,done,position) VALUES ('chk1','t1','Reviewed',0,1) ON CONFLICT DO NOTHING");
/*
 * A phase clock is keyed by the phase *catalogue* id (`ph_build`), and it is
 * visible when any project carrying that phase is in scope — so the fixture needs
 * the catalogue row and a project phase that references it. Without both, the
 * guard correctly reports the clock as invisible and this suite would be
 * asserting the wrong thing.
 */
await db.run("INSERT INTO phases (id,key,name,position) VALUES ('ph_build','build','Build',4) ON CONFLICT DO NOTHING");
await db.run("INSERT INTO project_phases (id,project_id,phase_id,status,position) VALUES ('pp1','p1','ph_build','active',4) ON CONFLICT DO NOTHING");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => { await app.close(); await db.close(); });

const request = (method, url, payload) =>
  app.inject({
    method,
    url,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });

const HOUR = 3_600_000;

/**
 * One clock per entity type, each keyed the way the product keys it.
 *
 * The identifiers below are the interesting part of this suite: they are
 * deliberately NOT primary keys, because a primary key is not what a clock is
 * filed under in practice — and assuming it was is exactly how the guard broke.
 */
const CLOCKS = [
  ['task', 'ACM-101', 'module-turnover'],
  ['deal', 'dl1', 'consult-to-plan'],
  ['release', 'v1.0.0', 'exec-summary'],
  ['qa', 'qa1', 'qa-report'],
  ['project', 'p1', 'first-demo'],
  ['phase', 'ph_build', 'milestone-turnover'],
];

for (const [entityType, entityId, clockKey] of CLOCKS) {
  // Signature is positional: (db, clockKey, entityType, entityId, label, startedAt).
  await startTimer(db, clockKey, entityType, entityId, `${entityType} clock`, new Date(Date.now() - HOUR));
}

test('every clock the API lists can be resolved through the API', async () => {
  const list = await request('GET', '/api/clocks');
  assert.equal(list.statusCode, 200, list.body);

  const timers = list.json().data.timers.filter((t) => t.outcome === 'running');
  assert.ok(timers.length >= CLOCKS.length, `expected at least ${CLOCKS.length} running clocks, saw ${timers.length}`);

  /*
   * The assertion is over what was listed, not over the fixture: a type that is
   * added to the product without a branch in the guard fails here immediately,
   * which is the failure that took a user report to find.
   */
  const seenTypes = new Set();
  for (const timer of timers) {
    seenTypes.add(timer.entityType);
    const resolved = await request('POST', `/api/clocks/timers/${timer.id}/resolve`, {
      outcome: 'met',
      note: 'resolved by the list-consistency check',
    });
    assert.equal(
      resolved.statusCode,
      200,
      `${timer.entityType} clock ${timer.clock} (entity ${timer.entityId}) is listed but could not be resolved: ${resolved.body}`,
    );
  }
  assert.deepEqual(
    [...seenTypes].sort(),
    CLOCKS.map(([type]) => type).sort(),
    'every seeded entity type must appear in the list',
  );
});

test('a clock resolves when it is filed under a human key, not a row id', async () => {
  /*
   * Pinned separately from the sweep above, because this is the exact shape that
   * regressed: `tasks.id` is `t1`, the clock says `ACM-101`, and only the second is
   * what a person quotes in a standup. If the guard ever goes back to matching on
   * the id alone, this fails with a 404 and names the reason.
   */
  await startTimer(db, 'module-turnover', 'task', 'ACM-101', 'filed by key', new Date(Date.now() - HOUR));
  const list = await request('GET', '/api/clocks');
  const timer = list.json().data.timers.find((t) => t.entityId === 'ACM-101' && t.outcome === 'running');
  assert.ok(timer, 'the clock filed under the human key must be listed');

  const resolved = await request('POST', `/api/clocks/timers/${timer.id}/resolve`, { outcome: 'met', note: 'key resolution' });
  assert.equal(resolved.statusCode, 200, resolved.body);
});

test('a clock for an entity that is genuinely gone still answers 404', async () => {
  /*
   * The other half of the invariant, and the reason the guard resolves entities at
   * all: widening it must not turn it off. A timer pointing at nothing is not
   * visible, and "not found" must stay indistinguishable from a deleted timer so a
   * cross-tenant probe learns nothing.
   */
  await startTimer(db, 'module-turnover', 'task', 'ACM-999', 'orphaned clock', new Date(Date.now() - HOUR));
  const list = await request('GET', '/api/clocks');
  const orphan = list.json().data.timers.find((t) => t.entityId === 'ACM-999' && t.outcome === 'running');
  assert.ok(orphan, 'the orphaned clock is listed (listing does not filter by scope)');

  const resolved = await request('POST', `/api/clocks/timers/${orphan.id}/resolve`, { outcome: 'met', note: 'x' });
  assert.equal(resolved.statusCode, 404, 'an unresolvable entity must not become resolvable');
});
