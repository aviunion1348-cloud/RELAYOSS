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
/**
 * Dockerfiles comment with `#`, not `//`. Stripping with the JS stripper leaves every
 * `# ...` line intact, and these files explain at length what they deliberately do
 * *not* run — so a naive scan matches the documentation and fails a correct image.
 */
const stripDockerComments = (src) =>
  src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

// ---------------------------------------------------------------- vercel.json
/*
 * Services mode, and what actually breaks.
 *
 * The previous guard knew the single-service layout: one top-level buildCommand, one
 * outputDirectory, one `api/index.js` function. Services mode moves build and runtime
 * keys into the service they belong to and makes public routing a top-level table of
 * rewrites to service *names*. That change is exactly the kind that fails silently —
 * a service with no rewrite receives no traffic and looks fine, and a rewrite naming a
 * service that does not exist deploys and then 404s every API call.
 *
 * What this must never do is fail open. In the previous revision a check was silently
 * skipped because a path was built wrongly, and the guard printed its green tick having
 * run nothing. So every structural surprise below is a failure, and anything this guard
 * cannot verify is written to the notes rather than passed over.
 */
let cfg;
try {
  cfg = JSON.parse(read('vercel.json'));
} catch (err) {
  fail(`vercel.json is missing or not valid JSON: ${err.message}`);
}

if (cfg) {
  const pkg = JSON.parse(read('package.json'));
  const services = cfg.services && typeof cfg.services === 'object' ? cfg.services : null;

  /**
   * Top-level build and runtime keys are invalid in services mode. Vercel documents
   * them as belonging to a service, and a config that keeps them at the top level is
   * either ignored or rejected — both of which present as a confusing build error
   * rather than as a config error.
   */
  const MOVED_INTO_SERVICES = [
    'buildCommand', 'installCommand', 'outputDirectory', 'framework', 'functions', 'devCommand', 'ignoreCommand',
  ];
  for (const key of MOVED_INTO_SERVICES) {
    if (cfg[key] !== undefined) {
      fail(
        `vercel.json sets "${key}" at the top level, which is not valid in services mode — ` +
          'move it into the service it belongs to',
      );
    }
  }

  if (!services) {
    fail('vercel.json has no "services" object — this deployment is configured for services mode');
  } else {
    const names = Object.keys(services);
    for (const name of names) {
      const svc = services[name] ?? {};
      if (!svc.root) fail(`service "${name}" has no "root"`);
      if (svc.root && !exists(String(svc.root).replace(/^\.\/?/, '').replace(/\/$/, '') || '.')) {
        fail(`service "${name}" root "${svc.root}" does not exist`);
      }
      // A build/runtime key stranded at the top level is checked above; one belonging
      // to a *different* service is undetectable here, so unknown keys are reported.
      for (const key of Object.keys(svc)) {
        const known = [
          'root', 'framework', 'runtime', 'entrypoint', 'command', 'installCommand', 'buildCommand',
          'devCommand', 'ignoreCommand', 'outputDirectory', 'bindings', 'functions', 'headers',
          'redirects', 'rewrites', 'routes', 'cleanUrls', 'trailingSlash',
        ];
        if (!known.includes(key)) fail(`service "${name}" has an unknown key "${key}"`);
      }
    }

    /**
     * Every service must be reachable or deliberately internal, and that has to be a
     * decision rather than an oversight. A service matched by no rewrite receives no
     * public traffic at all, which is correct for a private backend and a silent
     * outage for a frontend.
     */
    const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
    const publicServices = new Set();
    for (const rule of rewrites) {
      const target = rule?.destination;
      if (target && typeof target === 'object' && target.service) {
        if (!names.includes(target.service)) {
          fail(
            `rewrite "${rule.source}" targets service "${target.service}", which is not in "services" ` +
              `(known: ${names.join(', ')})`,
          );
        } else {
          publicServices.add(target.service);
        }
      } else {
        fail(
          `rewrite "${rule.source}" has destination ${JSON.stringify(target)}; in services mode the ` +
            'destination must be an object of the form { "service": "<name>" }',
        );
      }
    }

    /**
     * Rewrite order. Vercel routes to the first match, so a catch-all before a
     * specific rule silently swallows it: if `/(.*)` preceded `/api/(.*)`, every API
     * call would be answered by the frontend service with an HTML document and a 200.
     */
    const catchAll = rewrites.findIndex((r) => String(r.source ?? '') === '/(.*)');
    const specific = rewrites.findIndex((r) => String(r.source ?? '') !== '/(.*)');
    if (catchAll !== -1 && specific > catchAll) {
      fail(
        'the catch-all rewrite "/(.*)" is listed before a more specific rule; Vercel routes to the ' +
          'first match, so the specific rule would never run',
      );
    }
    if (!rewrites.some((r) => String(r.source ?? '').startsWith('/api'))) {
      fail('no rewrite sends /api to a service — API calls would fall through to the frontend');
    }

    /* ---------------------------------------------------------- api service -- */
    const api = services.api;
    if (!api) {
      fail('no "api" service — the Fastify application would not be deployed');
    } else {
      /**
       * The Fastify preset discovers its entrypoint from a fixed list of filenames, and
       * that list includes `src/index.ts` — the long-lived container entry, which calls
       * `app.listen()` and starts a `setInterval`. Landing on it in a function is a
       * deployment that looks healthy and never sweeps a deadline. The declared
       * entrypoint must therefore be the serverless one.
       */
      const entry = String(api.entrypoint ?? '');
      if (!entry) {
        fail(
          'the api service declares no entrypoint. The Fastify preset would scrape the service root and ' +
            'may resolve apps/api/src/index.ts, which calls app.listen() and starts a setInterval — ' +
            'neither works in a function invocation',
        );
      } else {
        const entryPath = entry.replace(/^\.\//, '');
        if (!exists(entryPath)) {
          fail(`the api service entrypoint "${entry}" does not exist`);
        } else {
          const src = stripComments(read(entryPath));
          if (/\bapp\.listen\s*\(/.test(src)) {
            fail(`the api service entrypoint "${entry}" calls app.listen(): a function is invoked per request`);
          }
          if (/setInterval\s*\(/.test(src) && !/re-export/i.test(read(entryPath))) {
            fail(`the api service entrypoint "${entry}" starts a background timer, which will not survive`);
          }
        }
        // The wrapper Vercel actually runs must point at the same artefact.
        if (exists('api/index.js')) {
          const wrapper = stripComments(read('api/index.js'));
          const artefact = wrapper.match(/apps\/api\/dist\/[\w/.]+\.js/)?.[0];
          if (!artefact) {
            fail('api/index.js does not delegate to a compiled apps/api/dist artefact');
          } else if (!/entrypoints\/vercel\.js$/.test(artefact)) {
            fail(
              `api/index.js delegates to "${artefact}"; the serverless handler is ` +
                'apps/api/dist/entrypoints/vercel.js, and a mismatch means a 500 from every API route',
            );
          }
        }
      }
      if (api.framework !== 'fastify') {
        note(`the api service framework is "${api.framework ?? '(auto)'}" rather than "fastify"`);
      }
    }

    /* ---------------------------------------------------------- app service -- */
    const app = services.app;
    if (app && app.runtime === 'container') {
      /**
       * `app` is a container service. The image is built from the Dockerfile named in
       * `entrypoint`, and that Dockerfile must not be the long-lived production one:
       * `Dockerfile` runs `node apps/api/dist/index.js`, which calls `app.listen()` and
       * starts an interval — both wrong behind Vercel's router, where nothing routes to
       * a port the container opens for itself.
       *
       * The `app` service exists to serve the SPA. In the single-process layout the API
       * served it (`serveStatic`), and in services mode `entrypoints/vercel.ts` turns
       * that off; the two must not both do it, or neither.
       */
      const dockerfile = String(app.entrypoint ?? 'Dockerfile');
      if (!exists(dockerfile)) {
        fail(`the app service builds from "${dockerfile}", which does not exist`);
      } else {
        const df = stripDockerComments(read(dockerfile));
        if (/dist\/index\.js/.test(df)) {
          fail(
            `the app service Dockerfile ("${dockerfile}") runs apps/api/dist/index.js — a long-lived ` +
              'server that calls app.listen() and starts a setInterval. Use the static web image.',
          );
        }
        if (dockerfile === 'Dockerfile') {
          fail(
            'the app service must not build from "Dockerfile": that image is the long-lived ' +
              'single-process deployment and remains the documented non-Vercel path',
          );
        }
        if (!/deploy\/web-server\.mjs/.test(df)) {
          fail(`the app service Dockerfile ("${dockerfile}") does not run deploy/web-server.mjs`);
        }
      }
      const server = exists('deploy/web-server.mjs') ? stripComments(read('deploy/web-server.mjs')) : '';
      if (!server) {
        fail('deploy/web-server.mjs is missing — the app service has no document to serve');
      } else {
        if (!/decodeURIComponent/.test(server) || !/catch\s*\{[\s\S]{0,200}return null/.test(server)) {
          fail(
            'deploy/web-server.mjs decodes a URL without guarding the throw: a malformed ' +
              'percent-encoding escapes the request handler and kills the process',
          );
        }
        if (!/startsWith\(ROOT \+ path\.sep\)/.test(server)) {
          fail('deploy/web-server.mjs has no path-traversal check against the web root');
        }
      }
    }

    /* -------------------------------------------------------- web service ---- */
    const web = services.web;
    if (!web) {
      fail('no "web" service — the SPA would not be built or served');
    } else {
      const outRel = String(web.outputDirectory ?? 'dist');
      const webRoot = String(web.root ?? '.').replace(/\/$/, '');
      const outPath = `${webRoot}/${outRel}`.replace(/^\.\//, '');
      if (outPath !== 'apps/web/dist') {
        fail(
          `the web service builds to "${outPath}"; Vite writes apps/web/dist and the app image copies ` +
            'apps/web/dist, so the two would disagree',
        );
      }
      if (web.framework !== 'vite') {
        note(`the web service framework is "${web.framework ?? '(auto)'}" rather than "vite"`);
      }
    }

    /* -------------------------------------------------------------- bindings -- */
    /**
     * A binding is a caller-side grant: it injects the target's internal URL into an
     * environment variable. Three things make it fail quietly.
     *
     *   - A binding naming a service that does not exist deploys and never resolves.
     *   - A binding whose `env` the application never reads is dead configuration: the
     *     code keeps using whatever it used before, and the topology looks correct.
     *   - The inverse is the dangerous one — code reading a bound URL that no service
     *     grants. `process.env.X_URL` is `undefined`, and `fetch(undefined)` throws at
     *     runtime in production while passing every test that mocks the variable.
     */
    const boundTargets = [];
    for (const name of names) {
      const bindings = services[name]?.bindings;
      if (!bindings) continue;
      if (!Array.isArray(bindings)) {
        fail(`service "${name}" bindings must be an array`);
        continue;
      }
      for (const b of bindings) {
        const label = `service "${name}" binding to "${b?.service ?? '(unset)'}"`;
        if (b?.type !== 'service') fail(`${label}: type must be "service"`);
        if (b?.format !== 'url') fail(`${label}: format must be "url"`);
        if (!b?.env) fail(`${label}: env is required — it names the injected variable`);
        if (b?.service && !names.includes(b.service)) {
          fail(`${label}: "${b.service}" is not a service in this deployment`);
        }
        if (b?.service === name) fail(`${label}: a service cannot bind to itself`);
        boundTargets.push(b?.service);
        // The variable is injected by the platform; setting it yourself silently wins
        // in local runs and is undefined in production.
        if (b?.env && exists('.env.example')) {
          const example = read('.env.example');
          if (new RegExp(`^${b.env}=`, 'm').test(example)) {
            fail(`${b.env} is injected by the binding and must not be set in .env.example`);
          }
        }
      }
    }

    /*
     * The application must not invent a service URL. Any hardcoded hostname or port in
     * server-side code is either a binding that should exist or a dead path.
     */
    const RUNTIME_DIRS = ['apps/api/src', 'deploy'];
    const URL_LITERAL = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/;
    for (const dir of RUNTIME_DIRS) {
      if (!exists(dir)) continue;
      const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
          const child = path.join(rel, entry.name);
          if (entry.isDirectory()) {
            walk(child);
            continue;
          }
          if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
          if (/\.test\.mjs$/.test(entry.name)) continue;
          const src = stripComments(fs.readFileSync(path.join(ROOT, child), 'utf8'));
          if (URL_LITERAL.test(src)) {
            fail(
              `${child} contains a hardcoded loopback URL. In services mode a service reaches another ` +
                'over a binding, and localhost resolves to the caller itself',
            );
          }
        }
      };
      walk(dir);
    }

    if (boundTargets.length === 0) {
      note(
        'no service bindings declared. The api service makes no outbound call to another service: ' +
          'the browser reaches it through the public /api rewrite, and its only egress is the identity ' +
          'provider. If a future service calls another, declare the binding on the caller.',
      );
    }

    /* ------------------------------------------------------------------ cron -- */
    /*
     * Crons are public routing, so they stay at the top level in services mode. The
     * path must still reach the api service and still be authenticated.
     */
    for (const cron of Array.isArray(cfg.crons) ? cfg.crons : []) {
      if (!String(cron.path ?? '').startsWith('/api/')) {
        fail(`cron "${cron.path}" is not under /api, so it would be routed to the frontend service`);
      }
      if (cron.path === '/api/cron/sweep') {
        const routes = read('apps/api/src/routes/index.ts');
        if (!routes.includes('/api/cron/sweep')) fail('vercel.json schedules /api/cron/sweep but the route is not registered');
        if (!routes.includes('timingSafeEqual')) fail('the cron endpoint must compare its secret in constant time');
        if (!/CRON_SECRET/.test(routes)) fail('the cron endpoint must read CRON_SECRET and refuse when it is unset');
      } else {
        note(`cron path ${cron.path} has no corresponding guard-checked route`);
      }
      const fields = String(cron.schedule ?? '').trim().split(/\s+/);
      if (fields.length === 5 && fields[0] !== '0' && !fields[0].startsWith('*')) {
        note(
          `cron "${cron.schedule}" may exceed the Hobby plan's one-run-per-day limit; ` +
            'docs/DEPLOYMENT.md §1.5 explains the trade-off',
        );
      }
    }
  }

  const engines = String(pkg.engines?.node ?? '');
  if (!engines) fail('package.json declares no engines.node, so Vercel cannot pin the runtime');
  else note(`engines.node ${engines}`);
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

/* ------------------------------------------------------------------------
 * The deployment guide must not drift from the code it describes.
 *
 * Both claims checked below were true when written and silently falsified later:
 * the guide said "migrations applied: 14" after migration 0015 was added, and the
 * node-version line is the kind of value that gets updated in package.json and
 * forgotten in prose. A reader following Step 1 sees a count that does not match
 * and reasonably concludes the migration failed. Neither number is a judgement
 * call, so both can be derived rather than trusted.
 * --------------------------------------------------------------------- */
/*
 * `exists()` joins ROOT onto its argument, so this must be a *relative* path.
 * Passing the absolute one made `exists()` false, and the whole check was skipped
 * without a word — a guard that fails open on its own path bug is worse than no
 * guard, because the green tick is indistinguishable from a pass. Absence of the
 * guide is therefore a failure, not a skip.
 */
const DEPLOY_DOC = 'docs/DEPLOYMENT.md';
if (!exists(DEPLOY_DOC)) {
  fail(`${DEPLOY_DOC} is missing — the deployment guide is a deliverable, not an optional extra`);
} else {
  const doc = fs.readFileSync(path.join(ROOT, DEPLOY_DOC), 'utf8');
  const migrationCount = fs
    .readdirSync(path.join(ROOT, 'db', 'migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
  const claimed = doc.match(/migrations applied: (\d+)/);
  if (claimed && Number(claimed[1]) !== migrationCount) {
    fail(
      `docs/DEPLOYMENT.md claims "migrations applied: ${claimed[1]}" but db/migrations holds ${migrationCount} — ` +
        'a reader following Step 1 would think the migration failed',
    );
  } else if (claimed) {
    notes.push(`deployment guide migration count matches db/migrations (${migrationCount})`);
  } else {
    fail('docs/DEPLOYMENT.md no longer states the expected migration count — Step 1 needs a verifiable expectation');
  }
}

// ------------------------------------------------------------------- report
for (const n of notes) console.log(`· ${n}`);
if (failures.length) {
  console.error(`\n✗ Deployment-config guard failed (${failures.length}):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
console.log('✓ Deployment-config guard passed — vercel.json, api/index.js, build script, cron auth and secret hygiene agree.');
