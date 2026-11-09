/**
 * Module-format compatibility of the deployed function.
 *
 * The production failure this file exists for:
 *
 *   boot_failed — require() of ES Module
 *   /var/task/node_modules/content-disposition/dist/index.js
 *   from /var/task/node_modules/@fastify/static/index.js is not supported.
 *
 * `@fastify/static` is CommonJS in every 10.1.x release. Up to 10.1.3 it depends on
 * `content-disposition@^2`, which is CommonJS. From 10.1.4 it depends on `^3`, which is
 * `"type": "module"` — so the package's own `require()` throws `ERR_REQUIRE_ESM` on a
 * runtime that cannot require ESM. Because `app.ts` imported it at module scope, the
 * throw happened while the function was *loading*, so every route — `/api/live`
 * included — answered `boot_failed` before any of our code ran.
 *
 * Two things make that class of failure invisible to ordinary tests, and both are
 * addressed here:
 *
 *   1. A modern Node can `require()` ESM (`--experimental-require-module`, default from
 *      22.12), so this reproduces only on an older runtime. The child processes below
 *      run with `--no-experimental-require-module`, which is exactly the capability the
 *      failing Vercel runtime lacked.
 *   2. `tsc` and unit tests never load the real CJS graph. These tests import the
 *      installed package from `node_modules`, not a stub.
 *
 * The assertions are deliberately about the installed tree *and* about booting it: a
 * lockfile can say 10.1.3 while the resolved dependency is 3.x, and a tree can be
 * correct while the application still imports something eagerly that it does not need.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Read a package manifest out of `node_modules`, wherever npm hoisted it.
 *
 * Not `require.resolve(name + '/package.json')`: content-disposition 2.x exports only
 * `./dist/index.js`, so its manifest is not a resolvable subpath — which is itself a
 * detail worth not depending on in a test about module formats.
 */
function installed(name) {
  const roots = [ROOT, path.join(ROOT, 'apps/api'), path.join(ROOT, 'apps/web')];
  for (const root of roots) {
    const manifest = path.join(root, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) return { dir: path.dirname(manifest), json: JSON.parse(fs.readFileSync(manifest, 'utf8')) };
  }
  throw new Error(`${name} is not installed under any of: ${roots.join(', ')}`);
}

test('the installed tree keeps @fastify/static on a CommonJS dependency', () => {
  const staticPkg = installed('@fastify/static');
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/api/package.json'), 'utf8'));
  const declaredSpec = declared.dependencies['@fastify/static'];

  /*
   * An exact pin, not a range. `^10.1.10` is what resolved to a release whose dependency
   * is ESM-only; a caret would let the next `npm install` walk back into the same hole.
   */
  assert.match(
    declaredSpec,
    /^\d+\.\d+\.\d+$/,
    `apps/api must pin @fastify/static exactly, found "${declaredSpec}"`,
  );
  assert.equal(
    staticPkg.json.version,
    declaredSpec,
    `installed @fastify/static is ${staticPkg.json.version} but the manifest pins ${declaredSpec}`,
  );

  /* 10.1.4+ pulls content-disposition@3, which is ESM-only. */
  assert.equal(
    staticPkg.json.dependencies?.['content-disposition'],
    '^2.0.1',
    `@fastify/static@${staticPkg.json.version} must depend on content-disposition ^2 (found ${staticPkg.json.dependencies?.['content-disposition']})`,
  );

  const disposition = installed('content-disposition');
  const major = Number(String(disposition.json.version).split('.')[0]);
  assert.equal(major, 2, `content-disposition must resolve to 2.x, found ${disposition.json.version}`);
  assert.notEqual(
    disposition.json.type,
    'module',
    'content-disposition 2.x must be CommonJS; require() of an ESM build is the production outage',
  );

  /*
   * One copy. A nested @fastify/static from another workspace dependency would keep its
   * own content-disposition and reintroduce the failure for whoever resolves it.
   */
  /* A directory named `static` inside a directory named `@fastify`, under any node_modules. */
  const copies = fs
    .readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name === 'static')
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .filter((p) => p.split(path.sep).slice(-2).join('/') === '@fastify/static')
    .filter((p) => fs.existsSync(path.join(p, 'package.json')));

  assert.equal(copies.length, 1, `expected one copy of @fastify/static, found ${copies.length}:\n${copies.join('\n')}`);
});

test('the CJS graph loads on a runtime without require(esm)', () => {
  /*
   * The precise capability the failing runtime lacked. Node 22.12+ can require ESM by
   * default, which masks this bug entirely; the flag restores the older behaviour so the
   * assertion means the same thing on every machine.
   */
  const script = `
    const { createRequire } = require('node:module');
    const r = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))});
    const statics = r('@fastify/static');
    if (!statics || typeof statics.default !== 'function') {
      console.log('NO_DEFAULT_EXPORT');
      process.exit(3);
    }
    console.log('ok');
  `;

  let out = '';
  try {
    out = execFileSync(process.execPath, ['--no-experimental-require-module', '--no-warnings', '-e', script], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim();
    assert.fail(
      'requiring @fastify/static failed on a runtime without require(esm) — this is the ' +
        `production boot_failed signature (ERR_REQUIRE_ESM):\n${detail}`,
    );
  }
  assert.equal(out.trim(), 'ok');
});

test('the API boots on that runtime, with and without a built SPA on disk', async () => {
  /*
   * Booting is the assertion that matters: the outage was at module load, before any
   * route could answer. Two layouts are covered because they exercise different code
   * paths in `app.ts`:
   *
   *   - no `apps/web/dist`: the deployment bundle. `@fastify/static` must not be loaded
   *     at all here, which is the structural defence against this class of failure.
   *   - a `apps/web/dist` present: the workstation/container case, where the plugin is
   *     loaded and its CJS graph really is executed.
   */
  const child = `
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = '';
    const webDist = process.env.WEB_DIST || null;
    const fsMod = await import('node:fs');
    /*
     * Boot the compiled output when it exists, because that is what the platform ships
     * and its module graph is what the bundle traces. Fall back to the sources with a
     * note so a developer without a build is not misled about what was exercised.
     */
    const dist = ${JSON.stringify(path.join(ROOT, 'apps/api/dist'))};
    const built = fsMod.existsSync(dist + '/app.js');
    const from = built ? dist : ${JSON.stringify(path.join(ROOT, 'apps/api/src'))};
    if (!built) console.log('· apps/api/dist absent — booting sources instead of the shipped build');
    const { buildApp } = await import(from + '/app.js').catch(() => import(from + '/app.ts'));
    const { SqliteDb } = await import(from + '/db/sqlite.js').catch(() => import(from + '/db/sqlite.ts'));
    const { migrate } = await import(from + '/db/migrate.js').catch(() => import(from + '/db/migrate.ts'));

    const db = new SqliteDb(':memory:');
    await migrate(db, { log: () => {} });
    const { app } = await buildApp({ db, logger: false, webDist });
    /*
     * A real listener rather than app.inject().
     *
     * inject() pulls in light-my-request on first use, which requires an ESM-only
     * 'cookie' — that fails on this simulated runtime too, but fastify loads that
     * package lazily for inject() only and never on the request path, so using inject
     * here would test the harness instead of the application. A socket is also what a
     * container deployment actually uses.
     */
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const live = await fetch(base + '/api/live');
    if (live.status !== 200) { console.log('LIVE_FAILED ' + live.status); process.exit(4); }
    if (!/application\\/json/.test(live.headers.get('content-type') || '')) { console.log('LIVE_NOT_JSON'); process.exit(9); }

    /* A missing API route must answer JSON, never HTML: that is how the HTML fallback
       used to hide backend failures. */
    const missing = await fetch(base + '/api/does-not-exist');
    if (!/application\\/json/.test(missing.headers.get('content-type') || '')) { console.log('MISSING_NOT_JSON ' + missing.status); process.exit(10); }

    const root = await fetch(base + '/');
    const rootType = root.headers.get('content-type') || '';

    let asset = null;
    if (webDist) {
      /* A real file from the real build, served by @fastify/static through its CJS graph. */
      const dir = webDist + '/assets';
      const file = fsMod.existsSync(dir) ? fsMod.readdirSync(dir).find((f) => f.endsWith('.js')) : null;
      if (file) {
        const res = await fetch(base + '/assets/' + file);
        asset = res.status;
        if (res.status !== 200) { console.log('ASSET_FAILED ' + res.status); process.exit(7); }
        if (/text\\/html/.test(res.headers.get('content-type') || '')) { console.log('ASSET_IS_HTML'); process.exit(8); }
      }
    }
    await app.close();
    console.log('ok asset=' + asset + ' root=' + root.status + ' rootType=' + rootType.split(';')[0]);
  `;

  const run = (env) => execFileSync(process.execPath, ['--no-experimental-require-module', '--no-warnings', '--input-type=module', '-e', child], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });

  /* The boot log is JSON on stdout; the result line is the last one. */
  const resultLine = (out) => out.trim().split('\n').pop() ?? '';

  // 1. The deployed shape: no web build on disk.
  try {
    const line = resultLine(run({ WEB_DIST: '' }));
    assert.match(line, /^ok asset=null root=/, `unexpected output: ${line}`);
    /*
     * Without a web build and without embedded assets there is genuinely no SPA to
     * serve, and `app.ts` says so with a JSON 404 rather than an HTML page. Both are
     * reported honestly; what is asserted is that the two cases are distinguishable and
     * that neither is a crash.
     */
    assert.match(
      line,
      /root=(200 rootType=text\/html|404 rootType=application\/json)$/,
      `expected either a served SPA or a JSON 404 for /, got: ${line}`,
    );
  } catch (err) {
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim().split('\n').slice(-6).join('\n');
    assert.fail(`the API did not boot without a web build (the deployment layout):\n${detail}`);
  }

  // 2. The workstation/container shape: a real build directory, so the plugin loads.
  const webDist = path.join(ROOT, 'apps/web/dist');
  if (!fs.existsSync(path.join(webDist, 'index.html'))) {
    /*
     * Not a silent skip: the suite must not pass by never exercising the static plugin.
     * `npm run verify` runs this after a build; a developer who has not built gets a
     * clear instruction instead of a false green.
     */
    console.log('· apps/web/dist absent — run `npm run build:web` to cover the static-file path');
    return;
  }
  try {
    const line = resultLine(run({ WEB_DIST: webDist }));
    assert.equal(line, 'ok asset=200 root=200 rootType=text/html', `static serving failed: ${line}`);
  } catch (err) {
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim().split('\n').slice(-6).join('\n');
    assert.fail(`the API did not boot/serve with a build directory present:\n${detail}`);
  }
});

test('a future dependency refresh cannot silently reintroduce it', () => {
  /*
   * The version pin is the fix; this is the tripwire on the *lockfile*, which is what a
   * deployment actually installs. It reads the committed lock rather than node_modules,
   * so it also catches a dependency bump that has not been installed yet.
   */
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages ?? {}).filter(([key]) => key.endsWith('@fastify/static'));
  assert.ok(entries.length > 0, 'the lockfile must contain @fastify/static');

  for (const [key, entry] of entries) {
    assert.equal(entry.version, '10.1.3', `${key} is locked to ${entry.version}; 10.1.4+ requires content-disposition 3, which is ESM-only`);
  }

  const dispositions = Object.entries(lock.packages ?? {}).filter(([key]) => key.endsWith('content-disposition'));
  assert.ok(dispositions.length > 0, 'the lockfile must contain content-disposition');
  for (const [key, entry] of dispositions) {
    assert.match(String(entry.version), /^2\./, `${key} is locked to ${entry.version}; 3.x is ESM-only and breaks the CJS require in @fastify/static`);
  }
});
