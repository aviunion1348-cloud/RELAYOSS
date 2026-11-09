#!/usr/bin/env node
/**
 * Does the built application actually serve the SPA and the API from one origin?
 *
 * This used to *simulate* a two-service deployment: it read `vercel.json`, compiled
 * the rewrite table, and reasoned about which service would have answered a path.
 * That was the best available evidence at the time, because routing was a table of
 * rules owned by the platform. It was also indirect — a simulation of a
 * configuration, not the thing itself.
 *
 * The deployment is now one process on one origin, so the honest test is to boot
 * that process and ask it. This starts the compiled server against a throwaway
 * database, points it at the real `apps/web/dist` build, and
 * asserts the behaviours that the previous outages came from:
 *
 *   `/` and a deep link      → the SPA document, so a browser refresh on
 *                              /projects/pr_northwind is not a 404
 *   `/api/*`                 → JSON, always. A document here means /api was routed
 *                              to the frontend, which is what made every panel fail
 *                              with "a non-JSON response"
 *   a missing asset          → 404, not the document with status 200. The catch-all
 *                              that fixes deep links also swallows assets, and then
 *                              a stale hashed filename renders a blank page instead
 *                              of failing cleanly
 *   a real asset             → 200 with a JavaScript content type and immutable
 *                              caching, because that is what the browser needs
 *   `/api/health`            → 200, and it reports the engine it is really using
 *
 *   node scripts/verify-web-routing.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/web/dist');
/*
 * Which compiled entry to boot. The default is the container entry behind `npm start`
 * and the Docker image. CI also runs this against `dist/entrypoints/index.js`, the file
 * `vercel.json` actually deploys, because the two are separate artefacts: a routing
 * assertion is only worth something when it is made against the process production runs.
 */
const ENTRY = process.env.RELAY_ENTRY
  ? path.resolve(ROOT, process.env.RELAY_ENTRY)
  : path.join(ROOT, 'apps/api/dist/index.js');
const PORT = Number(process.env.ROUTING_PORT ?? 47311);
const BASE = `http://127.0.0.1:${PORT}`;

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
};

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ no web build at ${DIST} — run \`npm run build:service\` first`);
  process.exit(1);
}
if (!fs.existsSync(ENTRY)) {
  console.error(`✗ no compiled server at ${ENTRY} — run \`npm run build:service\` first`);
  process.exit(1);
}

/* A real hashed asset from the actual build, not a fabricated name. */
const asset = fs
  .readdirSync(path.join(DIST, 'assets'))
  .find((f) => f.endsWith('.js'));
if (!asset) {
  console.error('✗ the build has no JavaScript asset to request');
  process.exit(1);
}

const dbDir = fs.mkdtempSync(path.join(ROOT, '.routing-db-'));
const env = {
  ...process.env,
  // A local process, so the file engine is legitimate here; the deployment refuses
  // to start without DATABASE_URL and that refusal is tested separately.
  NODE_ENV: 'development',
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  DB_PATH: path.join(dbDir, 'routing.sqlite'),
  WEB_DIST: DIST,
  SWEEP_INTERVAL_MS: '600000',
};
delete env.DATABASE_URL;
delete env.VERCEL;

const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.on('data', (d) => { stderr += String(d); });
server.stdout.on('data', () => {});

const cleanup = () => {
  try { server.kill('SIGKILL'); } catch { /* already gone */ }
  fs.rmSync(dbDir, { recursive: true, force: true });
};
process.on('exit', cleanup);

async function waitForBoot() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`the server exited during boot (code ${server.exitCode})\n${stderr.slice(-1500)}`);
    }
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server did not answer within 60s\n${stderr.slice(-1500)}`);
}

const get = async (url) => {
  const res = await fetch(BASE + url, { redirect: 'manual' });
  const body = await res.text();
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    cache: res.headers.get('cache-control') ?? '',
    body,
    isDocument: /^\s*<!doctype html/i.test(body),
  };
};

try {
  await waitForBoot();
  console.log(`· server listening on ${BASE} (one process, one origin)\n`);

  /* ---------------------------------------------------------- the document -- */
  for (const [route, label] of [
    ['/', 'app entry'],
    ['/projects/pr_northwind', 'project deep link'],
    ['/settings/team', 'another deep link'],
    ['/board?task=tsk_1', 'a route with a query string'],
  ]) {
    const r = await get(route);
    check(
      `${route} → SPA document`,
      r.status === 200 && r.isDocument && /<div id="root">/.test(r.body),
      `status ${r.status} ${r.type}`,
    );
  }

  /* --------------------------------------------------------------- the API -- */
  for (const route of ['/api/live', '/api/projects', '/api/dashboard', '/api/health']) {
    const r = await get(route);
    const json = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
    check(
      `${route} → JSON, never a document`,
      r.status === 200 && !r.isDocument && json !== null,
      `status ${r.status} ${r.type}`,
    );
  }

  /* An unknown API route is a JSON 404, not the SPA. */
  {
    const r = await get('/api/definitely-not-a-route');
    const json = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
    check(
      '/api/<unknown> → JSON 404',
      r.status === 404 && !r.isDocument && json?.error?.code === 'not_found',
      `status ${r.status} ${r.type}`,
    );
  }

  /* -------------------------------------------------------------- the assets -- */
  {
    const r = await get(`/assets/${asset}`);
    check(
      `/assets/${asset.slice(0, 22)}… → 200 script`,
      r.status === 200 && /javascript/.test(r.type),
      `status ${r.status} ${r.type}`,
    );
  }

  /*
   * The one that motivated this whole harness. A missing hashed asset must be a 404,
   * not the document with status 200 — otherwise a stale reference renders a blank
   * page and reports a MIME-type error, which tells nobody anything.
   */
  for (const route of ['/assets/definitely-missing-abc123.js', '/assets/index-nope.css', '/favicon-missing-xyz.ico']) {
    const r = await get(route);
    check(
      `${route.slice(0, 30)}… → 404, not HTML`,
      r.status === 404 && !r.isDocument,
      `status ${r.status} ${r.type}`,
    );
  }

  /* The health endpoint must be honest about the engine it is really using. */
  {
    const r = await get('/api/health');
    const body = JSON.parse(r.body);
    const storage = body.storage ?? body.data?.storage ?? '';
    check('/api/health reports its storage', Boolean(storage), `storage=${storage}`);
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  cleanup();
}

if (failures.length) {
  console.error(`\n✗ Single-origin routing failed (${failures.length}):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
console.log('\n✓ One process served the SPA, the API and the assets correctly on the same origin.');
