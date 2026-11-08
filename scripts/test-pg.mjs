#!/usr/bin/env node
/**
 * PostgreSQL conformance run.
 *
 * Boots (or reuses) a real PostgreSQL 16 server, applies the production
 * migrations from a clean database, then runs the *same* domain and HTTP test
 * suites that run against SQLite. This is the evidence that PostgreSQL parity is
 * real rather than a schema file nobody executed.
 *
 *   npm run test:pg
 *   PG_PORT=55432 TEST_DATABASE_URL=postgres://… npm run test:pg   (external server)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PG_PORT ?? 55432);
const DB = 'relay_test';
const USER = 'relay';
const PASSWORD = 'relay_local_dev';
let external = process.env.TEST_DATABASE_URL ?? '';

let cluster = null;

async function ensureCluster() {
  if (external) return;
  const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}`;
  // Reuse an already-running local cluster when one is present.
  const probe = await canConnect(url).catch(() => false);
  if (probe) {
    external = url;
    return;
  }
  console.log(`  · starting PostgreSQL 16 on :${PORT}`);
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  cluster = new EmbeddedPostgres({
    databaseDir: path.join(ROOT, '.pgdata'),
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  });
  if (!fs.existsSync(path.join(ROOT, '.pgdata', 'PG_VERSION'))) await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase(DB).catch(() => {});
  external = url;
}

async function canConnect(url) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  await client.connect();
  await client.end();
  return true;
}

async function freshDatabase() {
  const pg = (await import('pg')).default;
  const adminUrl = new URL(external);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  await admin.end();
}

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  return res.status ?? 1;
}

let exitCode = 0;
try {
  await ensureCluster();
  console.log(`  · database: ${external.replace(/:[^:@]+@/, ':***@')}`);
  await freshDatabase();

  console.log('\n• migrations from a clean PostgreSQL database');
  exitCode ||= run(process.execPath, ['--no-warnings', 'apps/api/src/db/cli.ts', 'migrate'], { DATABASE_URL: external });

  console.log('\n• seed (production-shaped dataset)');
  exitCode ||= run(process.execPath, ['--no-warnings', 'apps/api/src/db/cli.ts', 'seed'], { DATABASE_URL: external });

  console.log('\n• domain + governance suite on PostgreSQL 16');
  exitCode ||= run(process.execPath, ['--no-warnings', '--test', 'apps/api/test/domain.test.mjs'], { TEST_DATABASE_URL: external });

  console.log('\n• authentication + isolation suite on PostgreSQL 16');
  exitCode ||= run(process.execPath, ['--no-warnings', '--test', 'apps/api/test/auth.test.mjs'], { TEST_DATABASE_URL: external, SESSION_SECRET: 'pg-conformance-secret' });

  console.log('\n• failure and recovery suite on PostgreSQL 16');
  exitCode ||= run(process.execPath, ['--no-warnings', '--test', 'apps/api/test/resilience.test.mjs'], { TEST_DATABASE_URL: external, SESSION_SECRET: 'pg-conformance-secret' });

  console.log('\n• ship gate and clock lifecycle suite on PostgreSQL 16');
  exitCode ||= run(process.execPath, ['--no-warnings', '--test', 'apps/api/test/shipgate.test.mjs'], { TEST_DATABASE_URL: external, SESSION_SECRET: 'pg-conformance-secret' });

  console.log('\n• permission-scoped retrieval suite on PostgreSQL 16');
  exitCode ||= run(process.execPath, ['--no-warnings', '--test', 'apps/api/test/search-scope.test.mjs'], { TEST_DATABASE_URL: external, SESSION_SECRET: 'pg-conformance-secret' });

  console.log('\n• client lifecycle suite on PostgreSQL 16');
  exitCode ||= run(process.execPath, ['--no-warnings', '--test', 'apps/api/test/lifecycle.test.mjs'], { TEST_DATABASE_URL: external, SESSION_SECRET: 'pg-conformance-secret' });

  console.log('\n• HTTP contract suite on PostgreSQL 16');
  exitCode ||= run(process.execPath, ['--no-warnings', '--test', 'apps/api/test/http.test.mjs'], { TEST_DATABASE_URL: external, SESSION_SECRET: 'pg-conformance-secret' });
} catch (err) {
  console.error('\n✗ PostgreSQL conformance run failed:', err.message);
  exitCode = 1;
} finally {
  if (cluster) await cluster.stop().catch(() => {});
}

if (exitCode === 0) console.log('\n✓ PostgreSQL 16 conformance: migrations, seed, governance and HTTP contract all pass.');
process.exit(exitCode);
