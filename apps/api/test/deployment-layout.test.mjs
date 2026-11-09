/**
 * The deployment as the platform lays it out, not as the repository does.
 *
 * Every "works locally, broken on Vercel" failure in this project's history came from
 * the difference between those two shapes. This test constructs the second one:
 *
 *   /<root>/apps/api/dist/**      the compiled application
 *   /<root>/apps/web/dist/**      the built SPA, placed there by `includeFiles`
 *   /<root>/node_modules          dependencies
 *
 * and runs the server with that directory as its working directory, with no repository
 * around it. The source tree's `import.meta.url`-relative path to `apps/web/dist` is
 * meaningless there — three levels up from a compiled module lands outside the artefact
 * — so this is the test that catches a document the deployment cannot find.
 *
 * The failure it was written for: `/` answered with a JSON 404 and a correct dashboard
 * URL looked like a broken app, while `/api/*` worked perfectly.
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
const apiDist = path.join(repoRoot, 'apps/api/dist');
const webDist = path.join(repoRoot, 'apps/web/dist');
const built = fs.existsSync(path.join(apiDist, 'index.js')) && fs.existsSync(path.join(webDist, 'index.html'));

/**
 * Build the platform layout in a temporary directory.
 *
 * `node_modules` is symlinked rather than copied: the point of the test is file layout,
 * and copying a dependency tree would take longer than the assertion is worth.
 */
function makeDeploymentRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-deploy-'));

  fs.cpSync(apiDist, path.join(root, 'apps/api/dist'), { recursive: true });
  fs.cpSync(webDist, path.join(root, 'apps/web/dist'), { recursive: true });

  const modules = path.join(repoRoot, 'node_modules');
  if (fs.existsSync(modules)) {
    fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir');
  }
  /*
   * `db/migrations` is deliberately not copied.
   *
   * `includeFiles` ships `apps/web/dist/**` and nothing else, so the SQL directory does
   * not exist in the deployment either. Boot has to fall back to the generated
   * `BUNDLED_MIGRATIONS` module — which is the reason that module exists, and this is
   * the only test that proves the fallback under the conditions that need it.
   */
  return root;
}

async function bootInLayout(root) {
  const dbPath = path.join(root, 'data.sqlite');
  const child = spawn(process.execPath, ['--no-warnings', 'apps/api/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0',
      DATABASE_URL: '',
      DB_PATH: dbPath,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      /* Make sure no configuration from the surrounding shell points at the repo tree. */
      WEB_DIST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (c) => logs.push(c.toString()));
  child.stderr.on('data', (c) => logs.push(c.toString()));
  const output = () => logs.join('');

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start within 40s\n${output()}`)), 40_000);
    const check = () => {
      const match = /Server listening at http:\/\/[^\s:]+:(\d+)/.exec(output());
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before serving\n${output()}`));
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
  'in the deployed layout the dashboard is served, not a JSON 404 at /',
  { skip: !built && 'no dist/ build', timeout: 120_000 },
  async () => {
    const root = makeDeploymentRoot();
    const app = await bootInLayout(root);

    try {
      const live = await fetch(`http://127.0.0.1:${app.port}/api/live`);
      assert.equal(live.status, 200, `the API must work in the deployment layout\n${app.output()}`);

      /*
       * The assertion this file exists for. `index.html` lives at
       * `<root>/apps/web/dist/index.html`, and the module that needs it was compiled
       * into `<root>/apps/api/dist/` — so any answer derived from the module's own
       * location points outside the deployment.
       */
      const root200 = await fetch(`http://127.0.0.1:${app.port}/`);
      assert.equal(root200.status, 200, `GET / must return the dashboard, got ${root200.status}\n${app.output()}`);
      assert.match(root200.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await root200.text(), /<!doctype html>/i);

      /*
       * The dashboard's own data, through the deployment layout. A document that loads
       * and an API that does not is a blank screen with a spinner, so both are asserted
       * where the platform runs them.
       */
      for (const endpoint of ['/api/dashboard', '/api/clients', '/api/projects', '/api/health']) {
        const res = await fetch(`http://127.0.0.1:${app.port}${endpoint}`);
        assert.equal(res.status, 200, `${endpoint} must be 200 in the deployment, got ${res.status}\n${app.output()}`);
        assert.match(res.headers.get('content-type') ?? '', /application\/json/);
        const body = await res.json();
        assert.ok(body.data ?? body.ok ?? body, `${endpoint} must carry a payload`);
      }

      const deep = await fetch(`http://127.0.0.1:${app.port}/projects/anything`);
      assert.equal(deep.status, 200, 'a deep link must be the document too');
      assert.match(await deep.text(), /<!doctype html>/i);

      /* Assets come from the same directory and must not be answered with the document. */
      const html = await (await fetch(`http://127.0.0.1:${app.port}/`)).text();
      const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html)?.[1];
      assert.ok(asset, 'the document must reference its built assets');

      const assetRes = await fetch(`http://127.0.0.1:${app.port}${asset}`);
      assert.equal(assetRes.status, 200, `asset ${asset} must be served from the deployment`);
      assert.ok(!/text\/html/.test(assetRes.headers.get('content-type') ?? ''), 'an asset is not a document');
    } finally {
      await app.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'with no built SPA present, the deployment says so instead of pretending',
  { skip: !built && 'no dist/ build', timeout: 120_000 },
  async () => {
    const root = makeDeploymentRoot();
    /* Remove exactly the thing includeFiles is responsible for. */
    fs.rmSync(path.join(root, 'apps/web/dist'), { recursive: true, force: true });

    const app = await bootInLayout(root);
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/`);
      /*
       * Not a 200 with an empty body, and not a document-shaped lie: a JSON 404 that
       * names the path. This is what the API did on every deployment before the SPA was
       * included in the bundle, which is why it is asserted as the *failure* mode rather
       * than accepted as a valid state.
       */
      assert.equal(res.status, 404, `expected a JSON 404 without a build, got ${res.status}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.error?.code, 'not_found');
    } finally {
      await app.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
