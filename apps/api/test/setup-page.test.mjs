/**
 * What a person sees when the deployment is not configured.
 *
 * A deployment with no reachable database used to answer `/` with a JSON error envelope.
 * That is correct for an API client and useless for a human: the browser shows a wall of
 * `{"error":{...}}`, which gets reported as "the site is broken" even though the site is
 * saying exactly what is wrong.
 *
 * These tests run the built handler in a separate process with a database URL that cannot
 * connect, and assert the split: documents for browser paths, JSON under `/api`. The
 * message must come from the recorded failure — not a generic "something went wrong" —
 * because a setup page that does not say what to fix is only slightly better than a
 * blank one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const handlerPath = path.join(repoRoot, 'apps/api/dist/entrypoints/vercel.js');
const built = fs.existsSync(handlerPath);

/**
 * Boot the handler in a child process against an unreachable database and return the
 * two responses we care about.
 *
 * A child process is required rather than an import: the handler memoises its boot, so a
 * successful boot earlier in this suite would make the failure path unreachable.
 */
async function probeUnbootableDeployment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-'));
  const script = path.join(dir, 'probe.mjs');
  fs.writeFileSync(
    script,
    `
import http from 'node:http';

const { default: handler } = await import(${JSON.stringify(handlerPath)});
const server = http.createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

const out = {};
for (const route of ['/', '/projects/pr_northwind', '/api/health']) {
  const res = await fetch(base + route);
  out[route] = {
    status: res.status,
    type: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    body: await res.text(),
  };
}
server.close();
process.stdout.write(JSON.stringify(out));
`,
  );

  const child = spawn(process.execPath, ['--no-warnings', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // Nothing is listening on port 1, so connection is refused immediately.
      DATABASE_URL: 'postgres://relay:relay@127.0.0.1:1/relay',
      NODE_ENV: 'production',
      VERCEL: '1',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (c) => stdout.push(c.toString()));
  child.stderr.on('data', (c) => stderr.push(c.toString()));

  const code = await new Promise((resolve) => child.once('exit', resolve));
  const raw = stdout.join('');
  assert.equal(code, 0, `probe exited ${code}\n${stderr.join('')}`);
  return JSON.parse(raw);
}

test('an unbootable deployment shows a person a setup page, not a JSON wall', { skip: !built && 'no dist/ build' }, async () => {
  const out = await probeUnbootableDeployment();

  const root = out['/'];
  assert.equal(root.status, 503, 'an unbootable deployment is unavailable, not a 500');
  assert.match(root.type ?? '', /text\/html/, 'a browser path must get a document');
  assert.match(root.body, /<h1>[^<]*<\/h1>/, 'the page must have a heading');
  assert.match(root.body, /ECONNREFUSED|connect/i, 'it must name the failure that was recorded');
  assert.equal(root.cacheControl, 'no-store, max-age=0', 'a fixed deployment must not look broken');

  const deepLink = out['/projects/pr_northwind'];
  assert.match(deepLink.type ?? '', /text\/html/, 'a deep link is a browser path too');
  assert.ok(!/^\s*\{/.test(deepLink.body), 'a deep link must not be answered with raw JSON');

  const api = out['/api/health'];
  assert.equal(api.status, 503);
  assert.match(api.type ?? '', /application\/json/, 'an API path keeps the machine-readable envelope');
  const parsed = JSON.parse(api.body);
  assert.equal(parsed.error.code, 'misconfigured');
  assert.ok(parsed.error.summary, 'the envelope must carry the reason');
});
