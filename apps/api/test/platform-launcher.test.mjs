/**
 * The platform's invocation contract, reproduced.
 *
 * `docs/DEPLOYMENT.md` §1.1.1 recorded a `500 FUNCTION_INVOCATION_FAILED` that no
 * local test could explain. It could not be explained because every local test booted
 * the app the way *we* would, and the platform does not do that. Its Node serverless
 * launcher (`@vercel/node`, `compileUserCode`) does this:
 *
 *   1. Replace `http.Server.prototype.listen` with a stub that records the server and
 *      **returns without binding and without calling the callback**.
 *   2. `await import(entrypoint)` with the stub in place.
 *   3. Peel up to five nested `.default` values.
 *   4. If the result is a function → call it per request.
 *      Else if a server was captured → bind it on a random port and proxy to it.
 *      Else → wait 1s, then throw `Can't detect way to handle request`.
 *
 * Step 1 is the part nobody guesses. An entrypoint that does
 *
 *     await new Promise(resolve => server.listen(port, () => resolve()))
 *
 * never resolves, because the stub it just called swallows the callback. The module
 * import itself hangs, the invocation is killed, and the platform answers with the
 * error page — with no application log line, because the app never got that far.
 *
 * This file is that sequence, executed against the built artefact. It is the only test
 * here that can distinguish "our app works" from "the platform can start our app".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const entry = path.join(repoRoot, 'apps/api/dist/entrypoints/index.js');
const webIndex = path.join(repoRoot, 'apps/web/dist/index.html');
const built = fs.existsSync(entry) && fs.existsSync(webIndex);

/** A fresh SQLite database per run, so nothing depends on a previous test's state. */
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launcher-'));
  return path.join(dir, 'relay.sqlite');
}

/**
 * Import the entrypoint exactly as the platform does: with `listen` stubbed out.
 *
 * Returns what the launcher would see, plus the server the module tried to bind, so a
 * test can assert on either branch.
 */
async function platformImport(entryPath) {
  const originalListen = http.Server.prototype.listen;
  let captured = null;
  let serverFound = () => {};

  http.Server.prototype.listen = function stubbedListen() {
    captured = this;
    http.Server.prototype.listen = originalListen;
    serverFound();
    return this;
  };

  let mod;
  try {
    mod = await import(pathToFileURL(entryPath).href);
  } finally {
    http.Server.prototype.listen = originalListen;
  }

  /* The platform peels nested `.default`s; mirror that before inspecting the shape. */
  let listener = mod;
  for (let i = 0; i < 5; i += 1) {
    if (listener && listener.default) listener = listener.default;
    else break;
  }

  return { mod, listener, captured, waitForServer: (ms) => {
    if (captured) return Promise.resolve(captured);
    return new Promise((resolve) => {
      serverFound = () => resolve(captured);
      setTimeout(() => resolve(captured), ms);
    });
  } };
}

/** Bind whatever the launcher accepted and give back a base URL, or null. */
async function serve(listener, captured) {
  if (typeof listener === 'function') {
    const server = http.createServer((req, res) => {
      void listener(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  }
  if (captured) {
    /*
     * A captured server was never actually bound (the stub ate the call), so bind it
     * here on an ephemeral port — which is what the launcher does with `listen(server,
     * { host: '127.0.0.1', port: 0 })`.
     */
    await new Promise((r) => captured.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${captured.address().port}`, close: () => new Promise((r) => captured.close(r)) };
  }
  return null;
}

test(
  'the entrypoint survives the platform launcher: import with listen stubbed',
  { skip: !built && 'no dist/ build', timeout: 60_000 },
  async () => {
    process.env.DATABASE_URL = '';
    process.env.DB_PATH = tempDb();
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'warn';

    const { listener, captured, waitForServer } = await platformImport(entry);

    /*
     * The launcher's own decision tree. A function is used directly; otherwise it waits
     * up to a second for a server the module bound; otherwise it throws.
     */
    let accepted = listener;
    if (typeof accepted !== 'function') {
      accepted = await waitForServer(1_000);
    }
    assert.ok(
      accepted,
      'the launcher found neither a handler function nor a listening server, so it would ' +
        'throw "Can\'t detect way to handle request" and every path would 500',
    );

    const served = await serve(typeof listener === 'function' ? listener : null, captured);
    assert.ok(served, 'the launcher could not turn the export into a server');

    try {
      const live = await fetch(`${served.url}/api/live`);
      assert.equal(live.status, 200, `GET /api/live via the launcher path should be 200, got ${live.status}`);

      const root = await fetch(`${served.url}/`);
      assert.equal(root.status, 200, `GET / should be 200, got ${root.status}`);
      assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      await served.close();
    }
  },
);

test(
  'importing the entrypoint does not hang when listen is stubbed',
  { skip: !built && 'no dist/ build', timeout: 15_000 },
  async () => {
    /*
     * The specific hang: top-level `await new Promise(r => server.listen(p, r))` never
     * settles under the stub, so `import()` never resolves. A timeout here is the
     * production symptom reproduced in one assertion.
     */
    process.env.DATABASE_URL = '';
    process.env.DB_PATH = tempDb();
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'warn';

    const imported = platformImport(entry);
    const result = await Promise.race([
      imported.then(() => 'imported'),
      new Promise((r) => setTimeout(() => r('hung'), 5_000)),
    ]);
    assert.equal(
      result,
      'imported',
      'the module import did not finish within 5s with `listen` stubbed. On the platform ' +
        'that is an invocation timeout, which surfaces as 500 FUNCTION_INVOCATION_FAILED',
    );
  },
);
