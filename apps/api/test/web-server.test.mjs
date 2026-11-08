/**
 * The `app` service static server, under test.
 *
 * This server is the public entry point for every non-`/api` request in the
 * multi-service deployment, which makes it the one place where a mistake is both
 * easy to make and invisible: a bad rewrite returns HTML with status 200 for a
 * missing bundle, and the browser reports a syntax error pointing at the wrong
 * thing.
 *
 * The cases below are the ones that have bitten real static-file servers:
 *
 *   - a deep link must return the document (SPA routing)
 *   - a missing *asset* must 404, not return the document (a stale index.html
 *     referencing a purged chunk would otherwise "work" and then fail oddly)
 *   - a traversal attempt must not escape the root
 *   - `/api` must never be served here, because answering it with the document
 *     turns a routing misconfiguration into a client-side parse error
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Build a throwaway web root so the test does not depend on a real build. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-web-root-'));
fs.writeFileSync(path.join(ROOT, 'index.html'), '<!doctype html><title>Relay</title><div id="root"></div>');
fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets', 'index-abc123.js'), 'console.log("real chunk");');
/** A file outside the root, which no request may reach. */
const SECRET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-outside-'));
fs.writeFileSync(path.join(SECRET_DIR, 'secret.txt'), 'TOP-SECRET-DO-NOT-SERVE');

process.env.WEB_ROOT = ROOT;
const server = (await import('../../../deploy/web-server.mjs')).default;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const get = (p) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });

test.after(() => server.close());

test('web server: a deep link returns the SPA document', async () => {
  const res = await get('/projects/pr_northwind');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.ok(res.body.includes('id="root"'), 'the document must be the built index.html');
  // The document must never be cached: a deploy that reuses a cached index.html
  // pins browsers to asset filenames that no longer exist.
  assert.match(String(res.headers['cache-control']), /no-store/);
});

test('web server: a real asset is served and cached immutably', async () => {
  const res = await get('/assets/index-abc123.js');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.equal(res.body, 'console.log("real chunk");');
  assert.match(String(res.headers['cache-control']), /immutable/);
});

test('web server: a missing asset is a 404, not the document', async () => {
  // The failure mode this prevents: returning index.html for a purged chunk makes
  // the browser throw "Unexpected token <" at the bundle URL, which reads as a
  // code bug rather than a stale deployment.
  const res = await get('/assets/index-purged.js');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('id="root"'), 'a missing asset was answered with the SPA document');
});

test('web server: path traversal cannot escape the web root', async () => {
  const attempts = [
    '/../secret.txt',
    '/../../secret.txt',
    `/${'../'.repeat(8)}etc/passwd`,
    '/%2e%2e/secret.txt',
    '/assets/../../secret.txt',
  ];
  for (const attempt of attempts) {
    const res = await get(attempt);
    assert.ok(!res.body.includes('TOP-SECRET'), `traversal escaped the root via ${attempt}`);
    assert.ok(!res.body.includes('root:x:'), `traversal reached /etc/passwd via ${attempt}`);
  }
});

test('web server: /api is refused here rather than answered with the document', async () => {
  // Vercel routes /api to the api service before this container sees it. A request
  // arriving here means the routing config is wrong, and that must be visible as a
  // JSON 404 rather than silently rendering the app shell.
  for (const p of ['/api/projects', '/api', '/api/auth/me']) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} was not refused`);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.ok(!res.body.includes('id="root"'));
  }
});

test('web server: a malformed percent-encoding does not crash the server', async () => {
  /*
   * `decodeURIComponent('/%E0%A4%A')` throws URIError. Called unguarded inside the
   * request handler that exception escapes `createServer`'s callback and terminates
   * the process — one malformed URL from anyone on the internet, and the service is
   * down for every user until the platform restarts the container. This test failed
   * against the first version of the server, which is why it exists.
   */
  for (const bad of ['/%E0%A4%A', '/%', '/%zz', '/assets/%E0%A4%A']) {
    const res = await get(bad);
    assert.ok(res.status >= 200 && res.status < 600, `unexpected status ${res.status} for ${bad}`);
  }
  // The decisive assertion: the process is still serving afterwards.
  const after = await get('/');
  assert.equal(after.status, 200, 'the server stopped responding after a malformed URL');
  assert.ok(after.body.includes('id="root"'));
});
