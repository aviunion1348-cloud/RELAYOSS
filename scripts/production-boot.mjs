#!/usr/bin/env node
/**
 * Does the production build actually boot, serve, and authenticate nothing?
 *
 * This began as a CI step that started the server with `NODE_ENV=production` and
 * curled it. It passed locally and failed twice in CI, for two different reasons that
 * a shell step could not express:
 *
 *   1. The serving runtime now refuses to start without DATABASE_URL — deliberately,
 *      because the old local-file fallback accepted every write and discarded it on
 *      the next cold start. A production boot therefore needs a *real* database.
 *   2. It borrowed that database from an earlier CI step, which is a hidden
 *      dependency: the embedded cluster is stopped by the step that started it, so
 *      the boot failed with a connection error that looked like an application bug
 *      and was really an environment one.
 *
 * So the check owns its environment end to end. It starts PostgreSQL 16 itself,
 * migrates and seeds a scratch database, builds nothing (the caller builds), boots
 * the production server against it with **no authentication environment at all**, and
 * asserts three things a reintroduced auth gate would break:
 *
 *   · /api/live answers  and reports live
 *   · /api/health reports authMode "none"
 *   · the retired login endpoint answers 410 — not 200, not 404
 *
 * Supplying DATABASE_URL does not weaken the claim: the claim is about authentication,
 * and no authentication variable is set. Supplying a database is what makes the boot
 * representative of production at all.
 *
 *   node scripts/production-boot.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.BOOT_PORT ?? 4310);
const PG_PORT = Number(process.env.BOOT_PG_PORT ?? 55433);
const DB = 'relay_boot_check';
const PG_URL = `postgres://relay:relay_local_dev@127.0.0.1:${PG_PORT}/${DB}`;
const BASE = `http://127.0.0.1:${PORT}`;

let pgProc = null;
let server = null;
const failures = [];

function pass(msg) { console.log(`  \u2713 ${msg}`); }
function fail(msg) { failures.push(msg); console.log(`  \u2717 ${msg}`); }

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status) return res;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function startPostgres() {
  console.log(`  \u00b7 starting PostgreSQL 16 on :${PG_PORT}`);
  const dataDir = path.join(ROOT, '.pgdata-boot');
  pgProc = spawn(process.execPath, ['--no-warnings', 'scripts/pg-dev.mjs', 'start'], {
    cwd: ROOT,
    env: { ...process.env, PG_PORT: String(PG_PORT), PG_DB: DB, PG_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  pgProc.stdout.on('data', (d) => { log += String(d); });
  pgProc.stderr.on('data', (d) => { log += String(d); });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (/PostgreSQL 16 running/.test(log)) return;
    if (pgProc.exitCode !== null) throw new Error(`pg-dev exited early:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`PostgreSQL did not start in time:\n${log}`);
}

function cli(...args) {
  const res = spawnSync(process.execPath, ['--no-warnings', 'apps/api/src/db/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: PG_URL },
  });
  if (res.status !== 0) {
    throw new Error(`db cli ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

async function main() {
  const dist = path.join(ROOT, 'apps', 'api', 'dist', 'index.js');
  if (!fs.existsSync(dist)) {
    throw new Error(`${dist} is missing — run: npm run build -w @relay/api`);
  }

  await startPostgres();
  cli('reset');
  cli('seed');

  /*
   * `AUTH_MODE` is explicitly emptied rather than merely omitted: the point of the
   * check is that no authentication environment is present, and an inherited value
   * from the caller's shell would silently change what is being tested.
   */
  const bootLog = path.join(ROOT, '.pgdata-boot', 'boot.log');
  const out = fs.openSync(bootLog, 'w');
  server = spawn(process.execPath, [dist], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: PG_URL,
      AUTH_MODE: '',
      SESSION_SECRET: '',
      OIDC_ISSUER: '',
      OIDC_AUDIENCE: '',
      OIDC_JWKS_URI: '',
    },
    stdio: ['ignore', out, out],
  });

  const live = await waitFor(`${BASE}/api/live`);
  if (!live) {
    fail(`the production build did not serve /api/live on ${BASE}`);
    console.log(`  --- boot log ---\n${fs.readFileSync(bootLog, 'utf8').slice(-2500)}`);
    return;
  }
  /*
   * Responses are wrapped in the product's `ok()` envelope, so the payload is under
   * `data`. Reading the bare body would pass against a stub and fail against the real
   * server, which is the wrong way round for a check whose job is to describe reality.
   */
  const liveBody = await live.json().catch(() => ({}));
  if (live.ok && liveBody?.data?.live === true) pass('/api/live reports live');
  else fail(`/api/live answered ${live.status} with ${JSON.stringify(liveBody).slice(0, 200)}`);

  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  const healthBody = health ? await health.json().catch(() => ({})) : {};
  const authMode = healthBody?.data?.authMode;
  if (authMode === 'none') pass('/api/health reports authMode "none"');
  else fail(`authMode is ${JSON.stringify(authMode)} — a gate was reintroduced`);
  if (healthBody?.data?.storage === 'postgres') pass('/api/health reports storage "postgres"');
  else fail(`storage is ${JSON.stringify(healthBody?.data?.storage)}, expected "postgres"`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x', password: 'y' }),
  }).catch(() => null);
  if (login && login.status === 410) pass('the retired login endpoint answers 410');
  else fail(`/api/auth/login answered ${login ? login.status : 'nothing'}, expected 410`);
}

try {
  await main();
} catch (err) {
  fail(String(err?.message ?? err));
} finally {
  if (server) server.kill('SIGTERM');
  if (pgProc) pgProc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(path.join(ROOT, '.pgdata-boot'), { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} production-boot check(s) failed`);
  process.exit(1);
}
console.log('\n\u2713 production boot serves and authenticates nothing, against a real database');
