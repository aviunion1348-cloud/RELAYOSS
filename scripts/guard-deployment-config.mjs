/**
 * Deployment-configuration guard.
 *
 * The Vercel setup is spread across four files that have to agree with each other:
 * `vercel.json`, `api/index.js`, the build script in `package.json`, and the
 * compiler output path. Nothing enforces that agreement at runtime — a wrong
 * `outputDirectory` or a renamed build script produces a deployment that builds
 * successfully and serves an empty directory or a 500 from every API route.
 *
 * This checks the invariants cheaply, in the same place the other guards run, so a
 * change that would break the deployment fails CI instead of failing in production
 * weeks later.
 *
 * It also enforces the two prohibitions that are easy to violate by accident:
 * committing `.vercel/` (project and team ids are account-specific and must not be
 * shared) and inlining a server secret into a `VITE_` variable (Vite bakes those
 * into the client bundle).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

const fail = (msg) => failures.push(msg);
const note = (msg) => notes.push(msg);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Strip comments before scanning for prohibited calls.
 *
 * These files discuss `app.listen()` and `setInterval()` at length — explaining why
 * they are wrong is the point of the comments. A naive scan matches its own
 * documentation, which is a false positive that trains people to ignore the guard.
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---------------------------------------------------------------- vercel.json
let cfg;
try {
  cfg = JSON.parse(read('vercel.json'));
} catch (err) {
  fail(`vercel.json is missing or not valid JSON: ${err.message}`);
}

if (cfg) {
  const pkg = JSON.parse(read('package.json'));

  /**
   * The build command must exist and must, transitively, compile the API.
   *
   * Transitivity matters: `npm run build` is fine because it chains the API and web
   * builds, while `npm run build -w @relay/web` is not — it looks like a build
   * command, produces a complete static site, and leaves `apps/api/dist/vercel.js`
   * absent so every API request 500s behind a successful-looking deployment
   * (checked: that case passed a naive non-transitive test).
   *
   * So the script body is walked: `npm run X` inside a script counts as running X.
   */
  const buildCmd = String(cfg.buildCommand ?? '');
  // Match the whole invocation, including `-w <workspace>`: `npm run build -w
  // @relay/web` runs the *web* workspace's build, but a bare `([\w:.-]+)` capture
  // reads it as `build` — the root script — and would then validate the wrong thing.
  const invocation = buildCmd.match(/npm run (\S+(?:\s+-w\s+\S+)?)/)?.[1];
  const scriptName = invocation?.startsWith('-') ? null : invocation;
  if (!scriptName) {
    fail(`vercel.json buildCommand "${buildCmd}" does not invoke an npm script`);
  } else if (!pkg.scripts?.[scriptName]) {
    fail(`vercel.json buildCommand runs "${scriptName}", which is not a script in package.json`);
  } else {
    const compilesApi = (name, seen = new Set()) => {
      if (seen.has(name)) return false;
      seen.add(name);
      // A workspace invocation (`build -w @relay/web`) is a distinct script from the
      // root `build`; both are looked up by their full key.
      const body = String(pkg.scripts?.[name] ?? '');
      if (/build -w @relay\/api|build:api|tsc -p apps\/api/.test(body)) return true;
      for (const nested of body.matchAll(/npm run (\S+(?:\s+-w\s+\S+)?)/g)) {
        if (compilesApi(nested[1], seen)) return true;
      }
      return false;
    };
    if (!compilesApi(scriptName)) {
      fail(
        `the Vercel build script "${scriptName}" does not compile the API, directly or through a ` +
          `script it calls. api/index.js imports apps/api/dist/vercel.js, so every API request ` +
          `would 500 while the build still reported success.`,
      );
    }
    /**
     * The SPA must be built too. `npm run build:api` alone compiles a working
     * function but leaves `apps/web/dist` empty, so the deployment serves no UI —
     * a failure that looks like a frontend problem and is a build-command problem.
     */
    const buildsWeb = (name, seen = new Set()) => {
      if (seen.has(name)) return false;
      seen.add(name);
      const body = String(pkg.scripts?.[name] ?? '');
      if (/build -w @relay\/web|vite build/.test(body)) return true;
      for (const nested of body.matchAll(/npm run (\S+(?:\s+-w\s+\S+)?)/g)) {
        if (buildsWeb(nested[1], seen)) return true;
      }
      return false;
    };
    if (!buildsWeb(scriptName)) {
      fail(
        `the Vercel build script "${scriptName}" does not build the web app, so the deployment ` +
          `would serve no user interface. It must run both the API and web builds.`,
      );
    }
  }

  // The output directory must be the one Vite actually writes to.
  const outDir = String(cfg.outputDirectory ?? '');
  if (outDir !== 'apps/web/dist') {
    fail(`vercel.json outputDirectory is "${outDir}"; the web build writes to apps/web/dist`);
  }

  // /api must reach the function, and the rewrite must be present.
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const apiRewrite = rewrites.find((r) => String(r.source ?? '').startsWith('/api'));
  if (!apiRewrite) {
    fail('vercel.json has no rewrite for /api — API calls would fall through to static files');
  } else if (!String(apiRewrite.destination ?? '').includes('api/index')) {
    fail(`the /api rewrite targets "${apiRewrite.destination}", not the api/index.js function`);
  }

  // A cron entry needs an authenticated endpoint behind it.
  const crons = Array.isArray(cfg.crons) ? cfg.crons : [];
  for (const cron of crons) {
    if (cron.path === '/api/cron/sweep') {
      const routes = read('apps/api/src/routes/index.ts');
      if (!routes.includes('/api/cron/sweep')) {
        fail('vercel.json schedules /api/cron/sweep but the route is not registered');
      }
      if (!routes.includes('timingSafeEqual')) {
        fail('the cron endpoint must compare its secret in constant time');
      }
      if (!/CRON_SECRET/.test(routes)) {
        fail('the cron endpoint must read CRON_SECRET and refuse when it is unset');
      }
    } else {
      note(`cron path ${cron.path} has no corresponding guard-checked route`);
    }
  }

  // Hobby allows one run per day. A more frequent schedule is a deploy-time failure
  // on Hobby, so say so rather than letting the requester discover it.
  for (const cron of crons) {
    const fields = String(cron.schedule ?? '').trim().split(/\s+/);
    if (fields.length === 5 && fields[0] !== '0' && !fields[0].startsWith('*')) {
      note(
        `cron "${cron.schedule}" may exceed the Hobby plan's one-run-per-day limit; ` +
          `docs/DEPLOYMENT.md §1.5 explains the trade-off`,
      );
    }
  }

  // Node version must be reachable by the platform.
  const engines = String(pkg.engines?.node ?? '');
  if (!engines) fail('package.json declares no engines.node, so Vercel cannot pin the runtime');
  else note(`engines.node ${engines}`);
}

// ------------------------------------------------------------- api/index.js
if (!exists('api/index.js')) {
  fail('api/index.js is missing — Vercel discovers functions at api/*.js');
} else {
  const wrapper = stripComments(read('api/index.js'));
  if (/\bapp\.listen\s*\(/.test(wrapper)) {
    fail('api/index.js must not call app.listen(): a serverless function is invoked per request');
  }
  if (/setInterval|setTimeout\(\s*\(\)\s*=>\s*\{?\s*setInterval/.test(wrapper)) {
    fail('api/index.js must not start background timers — they do not survive between invocations');
  }
  if (!wrapper.includes("apps/api/dist/vercel.js")) {
    fail('api/index.js must delegate to the compiled apps/api/dist/vercel.js');
  }
}

// The handler source must await ready(), or the first request crashes in Fastify's
// hook pipeline. This is subtle and was a real defect; assert it.
if (!exists('apps/api/src/vercel.ts')) {
  fail('apps/api/src/vercel.ts is missing — the serverless entry point');
} else {
  const handler = stripComments(read('apps/api/src/vercel.ts'));
  if (!/await app\.ready\(\)/.test(handler)) {
    fail('apps/api/src/vercel.ts must await app.ready() before serving; without it requests crash');
  }
  if (/\bapp\.listen\s*\(/.test(handler)) {
    fail('apps/api/src/vercel.ts must not listen');
  }
}

// --------------------------------------------------------- secrets and state
if (exists('.vercel')) {
  fail('.vercel/ must not be committed — it contains account-specific project and team ids');
}
if (exists('.vercel/project.json')) {
  fail('.vercel/project.json must not be committed — it would misdirect the requester\'s import');
}

const gitignore = exists('.gitignore') ? read('.gitignore') : '';
for (const required of ['.vercel/', '.env']) {
  if (!gitignore.includes(required)) fail(`.gitignore must exclude ${required}`);
}

// A VITE_ variable is compiled into the browser bundle. Secrets must never be one.
const envExample = exists('.env.example') ? read('.env.example') : '';
const SECRET_NAMES = ['SESSION_SECRET', 'RELAY_ADMIN_PASSWORD_HASH', 'DATABASE_URL', 'CRON_SECRET'];
for (const name of SECRET_NAMES) {
  if (new RegExp(`^VITE_${name}`, 'm').test(envExample)) {
    fail(`${name} must not be exposed as VITE_* — Vite inlines those into the client bundle`);
  }
}

// No real Argon2id hash may be committed anywhere in source or config. A test
// fixture is fine inside a test file, so only non-test files are scanned.
const ARGON2 = /\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{16,}/;
const scan = ['apps/api/src', 'apps/web/src', 'scripts', 'docs'];
for (const dir of scan) {
  if (!exists(dir)) continue;
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|md|json)$/.test(entry.name)) continue;
      if (/\.test\.mjs$/.test(entry.name)) continue;
      if (ARGON2.test(fs.readFileSync(path.join(ROOT, child), 'utf8'))) {
        fail(`a real Argon2id hash appears in ${child} — only placeholders belong in the repository`);
      }
    }
  };
  walk(dir);
}

// ------------------------------------------------------------------- report
for (const n of notes) console.log(`· ${n}`);
if (failures.length) {
  console.error(`\n✗ Deployment-config guard failed (${failures.length}):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
console.log('✓ Deployment-config guard passed — vercel.json, api/index.js, build script, cron auth and secret hygiene agree.');
