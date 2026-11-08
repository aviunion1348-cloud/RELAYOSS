#!/usr/bin/env node
/**
 * Does "saved" mean saved?
 *
 * Every other test in this repository proves that a write is *accepted*. That is a
 * weaker claim than it sounds. A route can return 201 for a row it then throws away,
 * a SQLite file in a temporary directory can hold a write that disappears with the
 * process, and an in-memory cache can serve a re-read that was never in the database.
 * All three pass an "POST then GET" test in one process.
 *
 * So this asks the only question that settles it:
 *
 *   1. boot the API against a real PostgreSQL database, over HTTP, on a port;
 *   2. write and edit records — and record a decision about a finding;
 *   3. SIGTERM the server and wait for the process to be gone;
 *   4. boot a *new* server process against the same database;
 *   5. read everything back and assert the changes are still there.
 *
 * A fresh process cannot carry anything in memory, so a pass means the data is in
 * PostgreSQL and the schema survives a restart. It also exercises the real boot path —
 * environment loading, migrations, the operator identity, the HTTP contract — rather
 * than an injected Fastify instance.
 *
 *   node scripts/persistence-restart.mjs
 *
 * It starts its own embedded PostgreSQL unless DATABASE_URL is set.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const step = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail(label + (detail ? ': ' + detail : ''));
};

/* --------------------------------------------------------------- postgres -- */

/*
 * The cluster is started in-process rather than by shelling out to `pg-dev.mjs`: that
 * script is a blocking `start` (it exists to keep a development server in the
 * foreground) and a child process of it never returns. `embedded-postgres` is already
 * a dependency of the Postgres conformance run, so this reuses the same mechanism and
 * shuts the cluster down on the way out.
 *
 * An existing cluster is reused when one is reachable, and the database is
 * deliberately *not* reset: the whole point is that rows outlive the process that
 * wrote them. That also means a second run meets the first run's rows, so the seed is
 * skipped when users already exist instead of being forced.
 */
const PG_PORT = Number(process.env.PG_PORT ?? 55432);
const PG_DB = 'relay_persistence';
let databaseUrl = process.env.DATABASE_URL ?? '';
let cluster = null;

async function canConnect(url) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  await client.connect();
  await client.end();
  return true;
}

async function ensurePostgres() {
  if (databaseUrl) {
    notes.push('using the DATABASE_URL from the environment');
    return;
  }
  const candidate = `postgres://relay:relay_local_dev@127.0.0.1:${PG_PORT}/${PG_DB}`;
  if (await canConnect(candidate).catch(() => false)) {
    databaseUrl = candidate;
    notes.push('reused the running PostgreSQL cluster');
    return;
  }

  console.log(`· starting an embedded PostgreSQL 16 on :${PG_PORT}…`);
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  cluster = new EmbeddedPostgres({
    databaseDir: path.join(ROOT, '.pgdata'),
    user: 'relay',
    password: 'relay_local_dev',
    port: PG_PORT,
    persistent: true,
  });
  if (!fs.existsSync(path.join(ROOT, '.pgdata', 'PG_VERSION'))) await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase(PG_DB).catch(() => {});
  databaseUrl = candidate;
}

async function stopPostgres() {
  if (!cluster) return;
  try { await cluster.stop(); } catch { /* already stopped */ }
}

/* ----------------------------------------------------------------- server -- */

/** Build the API once, so a boot failure is a build failure and not a mystery. */
function buildApi() {
  execFileSync('npm', ['run', 'build', '-w', '@relay/api'], {
    cwd: ROOT, stdio: 'ignore', timeout: 300_000,
  });
}

/**
 * Migrate, then seed only if the database is empty.
 *
 * A write that needs an author — which is every edit, because attribution is part of
 * the record — fails on a database with no `users` row, and it fails *correctly*:
 * there is nobody to attribute the change to. Creates without an actor succeed, which
 * is why an unseeded run looks like "create works, edit is broken" rather than "the
 * database is empty".
 */
async function prepareDatabase() {
  execFileSync(process.execPath, ['apps/api/dist/db/cli.js', 'migrate'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: 'error' },
    stdio: 'ignore',
    timeout: 300_000,
  });

  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let users = 0;
  try {
    const res = await client.query('SELECT COUNT(*)::int AS n FROM users');
    users = Number(res.rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
  if (users > 0) {
    notes.push(`database already has ${users} user(s); skipped seeding`);
    return;
  }

  execFileSync(process.execPath, ['apps/api/dist/db/cli.js', 'seed'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: 'error' },
    stdio: 'ignore',
    timeout: 300_000,
  });
}

/**
 * Boot `apps/api/dist/index.js` on a given port and wait for `/api/health`.
 *
 * Waiting on the endpoint rather than sleeping: a slow boot must not be mistaken for a
 * broken one, and a fast one should not waste a minute.
 */
async function boot(port) {
  const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      SWEEP_INTERVAL_MS: '600000',
      OPERATOR_USER_ID: process.env.OPERATOR_USER_ID ?? 'usr_maya',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', () => {});

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the API exited during boot (code ${child.exitCode})\n${stderr.slice(-1200)}`);
    }
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { child, base };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`the API did not answer /api/health within 90s\n${stderr.slice(-1200)}`);
}

/** Stop a server and *prove* it is gone before the next one starts. */
async function stop(server) {
  const { child } = server;
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
}

async function call(base, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is a finding */ }
  return { status: res.status, json, text };
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  await ensurePostgres();
  notes.push('database: PostgreSQL (no SQLite fallback in this path)');

  buildApi();
  await prepareDatabase();

  const stamp = Date.now().toString(36);
  const newClientName = `Persistence ${stamp}`;
  const docTitle = `Restart proof ${stamp}`;
  const ids = {};

  /* ------------------------------------------------------------- phase 1 -- */
  {
    const server = await boot(47101);
    try {
      console.log('· phase 1: writing through the API…');

      const created = await call(server.base, 'POST', '/api/clients', {
        name: newClientName,
        industry: 'Verification',
        tier: 'growth',
        health: 'healthy',
        primaryContactName: 'Restart Tester',
        primaryContactEmail: 'restart@example.com',
      });
      step('a client can be created', created.status === 201, `status ${created.status}`);
      ids.clientId = created.json?.data?.id;
      if (!ids.clientId) throw new Error('no client id returned: ' + created.text.slice(0, 200));

      const edited = await call(server.base, 'PATCH', `/api/clients/${ids.clientId}`, {
        tier: 'strategic',
        health: 'watch',
        notes: 'written before the restart',
        mrrCents: 4_500_000,
      });
      step('the client can be edited', edited.status === 200, `status ${edited.status}`);

      const doc = await call(server.base, 'POST', '/api/docs', {
        title: docTitle,
        kind: 'runbook',
        body: 'written before the restart',
        status: 'draft',
        clientVisible: false,
      });
      step('a document can be created', doc.status === 201, `status ${doc.status}`);
      ids.docId = doc.json?.data?.id;

      const docEdit = await call(server.base, 'PATCH', `/api/docs/${ids.docId}`, {
        body: 'edited before the restart',
        status: 'approved',
      });
      step('the document can be edited', docEdit.status === 200, `status ${docEdit.status}`);

      /*
       * The intelligence dismissal is the other kind of write this product makes: not
       * a record, but a decision about one. It has to survive for the same reason — a
       * decision that evaporates brings the warning back, and the person who
       * acknowledged it cannot tell that anything was lost.
       */
      const insights = await call(server.base, 'GET', '/api/insights');
      const finding = insights.json?.data?.insights?.[0];
      if (finding) {
        ids.insightKey = finding.key;
        const ack = await call(
          server.base, 'POST', `/api/insights/${encodeURIComponent(finding.key)}/dismiss`,
          { reason: 'acknowledged before the restart' },
        );
        step('a finding can be acknowledged', ack.status === 201 || ack.status === 200, `status ${ack.status}`);
      } else {
        notes.push('no findings in this database, so the acknowledgement path is not exercised');
      }

      const partners = await call(server.base, 'GET', '/api/partners');
      const partner = partners.json?.data?.[0];
      if (partner) {
        ids.partnerId = partner.id;
        const partnerEdit = await call(server.base, 'PATCH', `/api/partners/${partner.id}`, {
          plan: 'enterprise',
          status: 'trial',
        });
        step('a partner can be edited', partnerEdit.status === 200, `status ${partnerEdit.status}`);
      } else {
        notes.push('no partners in this database, so the partner edit is not exercised');
      }
    } finally {
      await stop(server);
      console.log('· server stopped');
    }
  }

  /* ------------------------------------------------------------- phase 2 -- */
  {
    const server = await boot(47102);
    try {
      console.log('· phase 2: reading from a brand-new process…');

      const clients = await call(server.base, 'GET', '/api/clients');
      const client = (clients.json?.data ?? []).find((c) => c.id === ids.clientId);
      step('the client survived the restart', Boolean(client), client ? client.name : 'not found');
      if (client) {
        step('the client edit survived', client.tier === 'strategic' && client.health === 'watch',
          `tier=${client.tier} health=${client.health}`);
        step('the MRR change survived', Number(client.mrrCents) === 4_500_000, `mrrCents=${client.mrrCents}`);
        step('the notes survived', /before the restart/.test(String(client.notes ?? '')), 'notes present');
      }

      const docs = await call(server.base, 'GET', '/api/docs');
      const doc = (docs.json?.data ?? []).find((d) => d.id === ids.docId);
      step('the document survived the restart', Boolean(doc), doc ? doc.title : 'not found');
      if (doc) {
        step('the document edit survived',
          /edited before the restart/.test(doc.body) && doc.status === 'approved',
          `status=${doc.status} body=${String(doc.body).slice(0, 32)}`);
      }

      if (ids.insightKey) {
        const insights = await call(server.base, 'GET', '/api/insights');
        const dismissed = (insights.json?.data?.dismissed ?? []).find((d) => d.key === ids.insightKey);
        step('the acknowledgement survived the restart', Boolean(dismissed), dismissed ? 'present' : 'not found');
        if (dismissed) {
          step('the acknowledgement reason survived',
            /before the restart/.test(String(dismissed.reason)),
            `reason=${String(dismissed.reason).slice(0, 40)}`);
          step('the acknowledged finding is not in the open list',
            !(insights.json?.data?.insights ?? []).some((i) => i.key === ids.insightKey));
        }
      }

      if (ids.partnerId) {
        const partners = await call(server.base, 'GET', '/api/partners');
        const partner = (partners.json?.data ?? []).find((p) => p.id === ids.partnerId);
        step('the partner edit survived', partner?.plan === 'enterprise' && partner?.status === 'trial',
          partner ? `plan=${partner.plan} status=${partner.status}` : 'not found');
      }

      /*
       * The health endpoint must report the engine, not a guess. A deployment that
       * quietly fell back to a file would show `sqlite-wal` here — which is exactly
       * what this whole test exists to rule out.
       */
      const health = await call(server.base, 'GET', '/api/health');
      const engine = health.json?.storage ?? health.json?.data?.storage ?? '';
      step('the API reports PostgreSQL as its storage', engine === 'postgres', `storage=${engine || '(absent)'}`);

      /* A delete must persist too, or the cleanup is a lie. */
      const del = await call(server.base, 'DELETE', `/api/docs/${ids.docId}`);
      step('the document can be retired', del.status === 204, `status ${del.status}`);
      const after = await call(server.base, 'GET', '/api/docs');
      step('the retired document is gone from the list',
        !(after.json?.data ?? []).some((d) => d.id === ids.docId));
    } finally {
      await stop(server);
    }
  }

  /*
   * No artifact is written. An earlier draft dumped the ids to a JSON file as
   * evidence, and the architecture guard correctly refused it: a JSON file holding run
   * state is the pattern this repository bans, and "it is only a test" is how those
   * files get adopted. The assertions above are the evidence.
   */
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await stopPostgres();
}

for (const n of notes) console.log(`· ${n}`);
if (failures.length) {
  console.error(`\n✗ Persistence across a restart failed (${failures.length}):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
console.log('\n✓ Every change written through the API was read back by a new process from PostgreSQL.');
