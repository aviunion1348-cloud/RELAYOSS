/**
 * The container entrypoint — `apps/api/dist/index.js` — executed as a process.
 *
 * This is the `npm start`, Docker and Compose path, and it is a different artefact
 * from the deployed services entrypoint. The difference is deliberate and is the whole
 * reason both are tested:
 *
 *   dist/index.js              binds a port and owns the process. If it cannot boot it
 *                              exits non-zero, because a supervisor (Docker, systemd,
 *                              `npm start` in a terminal) is watching and will say so.
 *
 *   dist/entrypoints/index.js  exports a handler and binds nothing. The platform
 *                              launcher stubs `listen` and proxies requests to the
 *                              handler; exiting is invisible there, so it reports
 *                              failures as JSON instead. Covered by
 *                              `platform-launcher.test.mjs`.
 *
 * Both have failed in production at different times by being the other one, so both
 * get a test that runs them rather than importing them.
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
const entry = path.join(repoRoot, 'apps/api/dist/index.js');
const webIndex = path.join(repoRoot, 'apps/web/dist/index.html');
const built = fs.existsSync(entry) && fs.existsSync(webIndex);

/** A fresh SQLite database per test, so one test's writes cannot explain another's. */
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-container-'));
  return path.join(dir, 'relay.sqlite');
}

/**
 * Spawn the entry and wait until it is serving.
 *
 * Fastify logs `Server listening at http://127.0.0.1:<port>` — the *actual* port — which
 * is what makes `PORT=0` usable here: the test never has to guess a free port or race
 * another process for one.
 */
async function startServing(env, timeoutMs = 30_000) {
  const logs = [];
  const child = spawn(process.execPath, ['--no-warnings', entry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = () => logs.join('');
  const collect = (chunk) => logs.push(chunk.toString());
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`entry did not start serving within ${timeoutMs}ms\n${output()}`));
    }, timeoutMs);

    const check = () => {
      const match = /Server listening at http:\/\/[^\s:]+:(\d+)/.exec(output());
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`entry exited before serving (code=${code} signal=${signal})\n${output()}`));
    });
  });

  const stop = async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 5_000);
      force.unref?.();
    });
  };

  return { port, output, stop };
}

test(
  'the container entry binds a port and serves the API and the SPA',
  { skip: !built && 'no dist/ build', timeout: 90_000 },
  async () => {
    const { port, output, stop } = await startServing({
      DATABASE_URL: '',
      DB_PATH: tempDb(),
      NODE_ENV: 'test',
      /*
       * `info`, not `warn`: the "Server listening at" line this waits for is an info
       * record, and silencing it made this test time out with no output at all.
       */
      LOG_LEVEL: 'info',
    });

    try {
      const live = await fetch(`http://127.0.0.1:${port}/api/live`);
      assert.equal(live.status, 200, `GET /api/live should be 200\n${output()}`);
      assert.equal((await live.json())?.data?.live, true);

      /*
       * The single-process deployment serves the SPA itself. If this fails, `npm start`
       * and the Docker image both hand a browser a JSON 404 at `/`.
       */
      const root = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(root.status, 200, `GET / should be 200\n${output()}`);
      assert.match(root.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await root.text(), /<!doctype html>/i);

      const deepLink = await fetch(`http://127.0.0.1:${port}/clients`);
      assert.equal(deepLink.status, 200, `GET /clients should be 200\n${output()}`);
      assert.match(deepLink.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      await stop();
    }
  },
);

test(
  'the container entry exits non-zero when it cannot boot, rather than serving nothing',
  { skip: !built && 'no dist/ build', timeout: 90_000 },
  async () => {
    /*
     * A supervisor runs this process, so a failure must be an exit it can act on — and
     * its stderr must name the reason, which is what the old opaque 500 never did.
     * Staying up and answering 503 is the *other* entrypoint's job, for a platform where
     * there is no supervisor to read an exit code.
     */
    const logs = [];
    const child = spawn(process.execPath, ['--no-warnings', entry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: '0',
        DATABASE_URL: 'postgres://relay:relay@127.0.0.1:1/relay',
        DB_PATH: tempDb(),
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => logs.push(c.toString()));
    child.stderr.on('data', (c) => logs.push(c.toString()));

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`entry neither served nor exited within 60s\n${logs.join('')}`));
      }, 60_000);
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    assert.notEqual(code, 0, 'an unbootable configuration must not exit 0');
    assert.match(
      logs.join(''),
      /ECONNREFUSED|connect/i,
      'the failure must be reported in the log, not swallowed',
    );
  },
);
