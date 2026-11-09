/**
 * The service entrypoint, executed the way the platform executes it.
 *
 * This file exists because of a production outage that every other check missed.
 * `vercel.json` deploys one **service** with `framework: "fastify"`: a long-lived
 * process that must bind `PORT`, to which the platform routes the catch-all rewrite.
 * The entrypoint had been written for the opposite model — it built the app, exported
 * a `(req, res)` handler and never listened — and the deployment guard *enforced*
 * that shape. Nothing bound the port, so the platform answered every path, `/`
 * included, with `500 FUNCTION_INVOCATION_FAILED` before any application code ran.
 *
 * Every existing test passed throughout. They all imported the app in-process, so
 * they were testing a server that the platform never reached. The missing assertion
 * was never "does the app work" — it was "does the deployed entrypoint come up".
 *
 * So this test spawns the **built** entrypoint as its own process, with no
 * supertest, no in-process import and no stubbed `req`:
 *
 *   - it must reach a listening socket at all (the exact property that was missing)
 *   - `/api/live` must answer 200 JSON from that socket
 *   - `/` must answer the built SPA document, because the catch-all sends browsers here
 *   - a boot that fails must answer 503 JSON naming the stage, not exit silently
 *
 * The process is spawned with `PORT=0` and the port is read back from its own log
 * line, which also proves the entry reports the socket it actually got.
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
const entry = path.join(repoRoot, 'apps/api/dist/entrypoints/index.js');
const webIndex = path.join(repoRoot, 'apps/web/dist/index.html');

/* The built artefact is the thing under test; without it the test would be a lie. */
const built = fs.existsSync(entry) && fs.existsSync(webIndex);

/**
 * Spawn the entrypoint and wait for its listening line.
 *
 * Rejects on exit before listening, and carries the collected output into the error,
 * because "the process died" without its stderr is the least useful failure message
 * available.
 */
async function start(env, { waitForListen = true } = {}) {
  const logs = [];
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = () => logs.join('');
  const collect = (chunk) => {
    logs.push(chunk.toString());
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const exited = new Promise((_, reject) => {
    child.once('exit', (code, signal) => {
      reject(new Error(`entrypoint exited before listening (code=${code} signal=${signal})\n${output()}`));
    });
  });
  /* Only reject on exit when the caller is waiting for the listener. */
  exited.catch(() => {});

  if (!waitForListen) {
    return { child, port: 0, logs, output };
  }

  const port = await Promise.race([
    exited,
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`entrypoint never listened within 30s\n${output()}`));
      }, 30_000);
      const onData = () => {
        const match = /"msg":"listening on [^"]*:(\d+)"/.exec(output());
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
    }),
  ]);

  return { child, port, logs, output };
}

async function stop(started) {
  if (started.child.exitCode !== null) return;
  await new Promise((resolve) => {
    started.child.once('exit', () => resolve());
    started.child.kill('SIGTERM');
    setTimeout(() => {
      if (started.child.exitCode === null) started.child.kill('SIGKILL');
      resolve();
    }, 5_000).unref?.();
  });
}

/** A fresh SQLite file per test, so a boot failure cannot be blamed on another test. */
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-entry-'));
  return path.join(dir, 'relay.sqlite');
}

test('the built service entrypoint binds a port and serves the app', { skip: !built && 'no dist/ build' }, async () => {
  const started = await start({
    /* SQLite, because this assertion is about wiring, not about Postgres. */
    DATABASE_URL: '',
    DB_PATH: tempDb(),
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
  });

  try {
    assert.ok(started.port > 0, 'the entrypoint must report the port it bound');

    const live = await fetch(`http://127.0.0.1:${started.port}/api/live`);
    assert.equal(live.status, 200, `GET /api/live should be 200, got ${live.status}\n${started.output()}`);
    const body = await live.json();
    assert.equal(body?.data?.live, true, 'liveness must be reported as live');

    /*
     * `/` is the path from the outage report. It must return the SPA document: the
     * catch-all rewrite sends every browser path to this service, so a service that
     * serves only `/api/*` leaves the application unreachable.
     */
    const root = await fetch(`http://127.0.0.1:${started.port}/`);
    assert.equal(root.status, 200, `GET / should be 200, got ${root.status}\n${started.output()}`);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await root.text(), /<!doctype html>/i);
  } finally {
    await stop(started);
  }
});

test(
  'a deep link is answered with the SPA, not a 404 the router never sees',
  { skip: !built && 'no dist/ build' },
  async () => {
    const started = await start({
      DATABASE_URL: '',
      DB_PATH: tempDb(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${started.port}/clients`);
      assert.equal(res.status, 200, `GET /clients should be 200, got ${res.status}\n${started.output()}`);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      await stop(started);
    }
  },
);

test(
  'an unbootable configuration stays up and explains itself instead of exiting',
  { skip: !built && 'no dist/ build' },
  async () => {
    /*
     * A Postgres URL with nothing listening on it. The deployed service must not exit:
     * an exit is invisible on the platform and reads as "the function failed", which
     * is the opaque 500 this whole change is about. It must answer 503 with the stage.
     */
    const started = await start({
      DATABASE_URL: 'postgres://relay:relay@127.0.0.1:1/relay',
      DB_PATH: tempDb(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
    });
    try {
      assert.ok(started.port > 0, 'a failed boot must still bind a port so it can report');

      const res = await fetch(`http://127.0.0.1:${started.port}/api/live`);
      assert.equal(res.status, 503, `expected 503 while misconfigured, got ${res.status}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(res.headers.get('cache-control'), 'no-store, max-age=0');

      const body = await res.json();
      assert.equal(body?.error?.code, 'misconfigured');
      assert.ok(
        typeof body.error.stage === 'string' && body.error.stage.length > 0,
        'the report must name the boot stage that failed',
      );
      assert.ok(
        typeof body.error.summary === 'string' && !/^Failed to start\.?$/.test(body.error.summary),
        'the report must carry the underlying reason, not a placeholder',
      );
    } finally {
      await stop(started);
    }
  },
);
