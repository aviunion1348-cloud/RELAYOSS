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
 * One service, one origin.
 *
 * This deployment used to be two Vercel services — a Fastify API routed under
 * `/api/(.*)` and a static Vite build routed under `/(.*)` — with the browser
 * crossing between them on every request. That split was the source of the
 * failures it was supposed to prevent: `/api` answered with the SPA document
 * because a rewrite was ordered or targeted wrongly; the API function was absent
 * from the deployment entirely because the project preset was not "Services"; and
 * a framework prefix that is a dashboard setting could not be asserted from here at
 * all.
 *
 * The application does not need the split. The Fastify process already serves the
 * built SPA, with a deep-link fallback and an extension guard, and every piece of
 * data on every screen is computed by that process. So it is now **one service on
 * one origin**: the same process answers `/api/*` and every browser route, and
 * there is no route between them to misconfigure.
 *
 * What this guard therefore has to defend is different, and narrower:
 *
 *   1. exactly one service, and it is the application itself;
 *   2. one catch-all rewrite to it — a rule that sends `/api` somewhere else, or a
 *      catch-all before a more specific rule, is the bug this shape removes;
 *   3. a single build command that produces *both* artefacts. The API is useless
 *      without `apps/web/dist`, and a build that compiles only one workspace is how
 *      a deploy serves an empty shell;
 *   4. `api/index.js` still delegating to the one serverless handler;
 *   5. no service bindings and no hardcoded loopback URLs, because with one service
 *      there is nothing private to call.
 */
let cfg;
try {
  cfg = JSON.parse(read('vercel.json'));
} catch (err) {
  fail(`vercel.json is missing or not valid JSON: ${err.message}`);
}

if (cfg) {
  const pkg = JSON.parse(read('package.json'));

  /**
   * Top-level build and runtime keys are invalid in services mode, where they
   * belong to a service. A config that keeps them at the top level is ignored or
   * rejected, and both present as a confusing build error rather than a config one.
   */
  for (const key of ['buildCommand', 'installCommand', 'outputDirectory', 'framework', 'functions', 'devCommand', 'ignoreCommand']) {
    if (cfg[key] !== undefined) {
      fail(
        `vercel.json sets "${key}" at the top level, which is not valid in services mode — ` +
          'move it into the service it belongs to',
      );
    }
  }

  const services = cfg.services && typeof cfg.services === 'object' ? cfg.services : null;
  if (!services) {
    fail('vercel.json has no "services" object');
  } else {
    const names = Object.keys(services);
    if (names.length !== 1) {
      fail(
        `vercel.json declares ${names.length} services (${names.join(', ')}); this deployment is one ` +
          'process serving the SPA and the API from one origin. A second service reintroduces the ' +
          'rewrite boundary every previous outage came from',
      );
    }

    const [name, svc] = Object.entries(services)[0] ?? ['(none)', {}];
    for (const key of Object.keys(svc)) {
      const known = [
        'root', 'framework', 'runtime', 'entrypoint', 'command', 'installCommand', 'buildCommand',
        'devCommand', 'ignoreCommand', 'outputDirectory', 'bindings', 'functions', 'headers',
        'redirects', 'rewrites', 'routes', 'cleanUrls', 'trailingSlash',
        'includeFiles', 'excludeFiles',
      ];
      if (!known.includes(key)) fail(`service "${name}" has an unknown key "${key}"`);
    }

    if (svc.root && !exists(String(svc.root).replace(/^\.\/?/, '').replace(/\/$/, '') || '.')) {
      fail(`service "${name}" root "${svc.root}" does not exist`);
    }
    if (svc.runtime === 'container') {
      fail(
        `service "${name}" uses runtime "container". A container binding a port is a different ` +
          'deployment model from the function this repository ships, and mixing the two is how the ' +
          'earlier three-service revision became untestable',
      );
    }

    /* ------------------------------------------------------- the entrypoint -- */
    /*
     * The entrypoint is declared explicitly rather than left to the Fastify preset's
     * filename scraping, so the file that production runs is the file CI can name.
     * What it must *do* is bind a port — see the check below, which previously
     * asserted the opposite and caused the deployment to serve nothing at all.
     */
    const entry = String(svc.entrypoint ?? '');
    if (!entry) {
      fail(
        `service "${name}" declares no entrypoint. The Fastify preset would scrape the service root ` +
          'for a filename, and the file it picks is not necessarily the one CI verifies',
      );
    } else if (!exists(entry.replace(/^\.\//, ''))) {
      fail(`service "${name}" entrypoint "${entry}" does not exist`);
    } else {
      /*
       * What the platform actually requires of a services entrypoint, from the launcher's
       * own source (`@vercel/node`, `compileUserCode`):
       *
       *   it stubs `http.Server.prototype.listen`, imports the module, peels nested
       *   `.default` values, then uses a **function** export per request, or a captured
       *   server, or throws `Can't detect way to handle request`.
       *
       * Both failures this deployment has had came from that contract, in opposite
       * directions, and both were green here first:
       *
       *   - an entrypoint with no default export and no listen     → the throw above;
       *   - `await new Promise(r => server.listen(p, () => r()))`  → the stub swallows the
       *     callback, the module import never resolves, the invocation times out.
       *
       * So the entrypoint must export a handler and must not bind: the launcher binds,
       * and only after the module has finished importing.
       */
      const src = stripComments(read(entry.replace(/^\.\//, '')));
      if (!/export\s+default\s+(async\s+)?function|export\s+default\s+\w+\s*;?\s*$|export\s+\{[^}]*\bas\s+default\b/.test(src)) {
        fail(
          `service "${name}" entrypoint "${entry}" has no default export. The platform's launcher ` +
            'peels `.default` and uses it as the request handler; with none it finds neither a ' +
            'function nor a server and throws "Can\'t detect way to handle request", which surfaces ' +
            'as 500 FUNCTION_INVOCATION_FAILED on every path',
        );
      }
      if (/(?:^|\n)\s*(?:await\s+)?new\s+Promise\s*\([^)]*\.listen\s*\(|\.listen\s*\(/.test(src)) {
        fail(
          `service "${name}" entrypoint "${entry}" calls .listen(). The launcher stubs ` +
            'http.Server.prototype.listen while importing the module and never invokes the ' +
            'callback, so awaiting a listen here hangs the import and times out the invocation. ' +
            'Export the handler and let the platform bind; apps/api/src/index.ts is the process ' +
            'that listens for npm start and Docker',
        );
      }
    }
    /*
     * The SPA has to travel with the function.
     *
     * The platform's bundler follows `import` and `require`, and nothing else. The API
     * serves the built SPA with `@fastify/static`, which reads the directory at runtime,
     * so a plain fs read is invisible to tracing: the bundle deployed without
     * `apps/web/dist`, found no document, and answered `/` with a JSON 404 while `/api`
     * worked. `includeFiles` is the declaration that puts them in the bundle, and it is
     * glob-based, so it has to be stated rather than inferred.
     */
    if (svc.framework === 'fastify' || svc.runtime !== 'container') {
      const include = Array.isArray(svc.includeFiles) ? svc.includeFiles.map(String) : [];
      const coversSpa = include.some((glob) => /apps\/web\/dist/.test(glob));
      if (!coversSpa) {
        fail(
          `service "${name}" does not include "apps/web/dist/**" in includeFiles. This service ` +
            'serves the SPA itself, and the platform tracer only follows module imports — the ' +
            'built document and assets would be left out of the deployment, so every browser ' +
            'path would answer a JSON 404',
        );
      } else {
        note('the built SPA travels with the function (includeFiles → apps/web/dist/**)');
      }
    }

    if (svc.framework !== 'fastify') {
      note(`the service framework is "${svc.framework ?? '(auto)'}" rather than "fastify"`);
    }

    /* ------------------------------------------------------------- the build -- */
    const install = String(svc.installCommand ?? '');
    if (!install) {
      fail(
        'the service declares no installCommand. Vercel installs in production mode by default, so ' +
          'devDependencies — and therefore tsc and vite — are missing when the build runs',
      );
    } else if (!install.includes('--include=dev')) {
      fail(`installCommand ("${install}") omits devDependencies; add --include=dev`);
    }

    const build = String(svc.buildCommand ?? '');
    if (!build) {
      fail('the service declares no buildCommand');
    } else {
      /*
       * Both artefacts, in one command.
       *
       * The build script is the contract the whole shape rests on: the API serves
       * `apps/web/dist`, so a build that produces only `apps/api/dist` deploys a
       * working API in front of a 404 for every page. Rather than trusting the
       * script name, this resolves it from package.json and asserts that it names
       * both workspaces.
       */
      const scriptName = build.match(/npm run ([\w:-]+)/)?.[1] ?? '';
      const script = String(pkg.scripts?.[scriptName] ?? '');
      if (!script) {
        fail(`buildCommand "${build}" does not resolve to a script in package.json (looked for "${scriptName}")`);
      } else {
        const buildsApi = /-w @relay\/api|--workspace @relay\/api/.test(script);
        const buildsWeb = /--prefix apps\/web|-w @relay\/web|install:web/.test(script);
        if (!buildsApi || !buildsWeb) {
          fail(
            `the build script "${scriptName}" does not produce both artefacts: ` +
              `api=${buildsApi ? 'yes' : 'NO'} web=${buildsWeb ? 'yes' : 'NO'}. ` +
              'The API serves apps/web/dist, so a build that skips the web workspace deploys a ' +
              'working API behind a page that 404s',
          );
        }
      }
    }

    /* ---------------------------------------------------------- the rewrites -- */
    const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
    if (rewrites.length === 0) {
      fail('vercel.json has no rewrites, so no public path reaches the service');
    }
    const targetOf = (rule) =>
      rule?.destination && typeof rule.destination === 'object' ? rule.destination.service : null;

    for (const rule of rewrites) {
      const target = targetOf(rule);
      if (!target) {
        fail(
          `rewrite "${rule?.source}" has destination ${JSON.stringify(rule?.destination)}; in services ` +
            'mode the destination must be an object of the form { "service": "<name>" }',
        );
      } else if (!names.includes(target)) {
        fail(`rewrite "${rule.source}" targets service "${target}", which is not declared (known: ${names.join(', ')})`);
      }
    }

    /*
     * Every public path must land in the same service. A rule that carves `/api`
     * out to a different service is the exact split this shape deletes, and it is
     * also how `/api` came to be answered with an HTML document and a 200.
     */
    const specific = rewrites.filter((r) => String(r.source ?? '') !== '/(.*)');
    if (specific.length > 0) {
      fail(
        `vercel.json has ${specific.length} rewrite(s) narrower than the catch-all ` +
          `(${specific.map((r) => r.source).join(', ')}). With one service there is nothing to carve out, ` +
          'and a narrower rule that wins first is how /api stopped reaching the API',
      );
    }
    const catchAll = rewrites.find((r) => String(r.source ?? '') === '/(.*)');
    if (!catchAll) {
      fail('vercel.json has no catch-all rewrite "/(.*)", so browser routes never reach the application');
    } else if (String(targetOf(catchAll)) !== name) {
      fail(`the catch-all rewrite targets "${targetOf(catchAll)}" rather than the application service "${name}"`);
    }

    /* ------------------------------------------------------- the static shell -- */
    /*
     * Deep links and assets are now the *server's* job, not a rewrite table's. The
     * application answers an unknown browser route with `index.html` and an unknown
     * `/api` route with JSON, and it must refuse to answer a missing asset with the
     * document — that would return 200 for a stale hashed filename and leave the
     * page blank with a MIME-type error instead of a clean 404.
     */
    const appSource = read('apps/api/src/app.ts');
    if (!/setNotFoundHandler/.test(appSource)) {
      fail('apps/api/src/app.ts has no not-found handler, so a deep-link refresh would 404 instead of loading the app');
    }
    if (!/startsWith\('\/api'\)/.test(appSource)) {
      fail(
        'the not-found handler does not separate /api from browser routes: an unknown API path would ' +
          'be answered with the SPA document',
      );
    }
    if (!/index\.html/.test(appSource)) {
      fail('the not-found handler does not serve index.html, so browser routes would not resolve');
    }
    if (!/fastifyStatic|@fastify\/static/.test(appSource)) {
      fail('the API does not serve the built assets, so the SPA cannot load in this single-service shape');
    }

    /* ------------------------------------------------------------ the wrapper -- */
    /*
     * `api/index.js` is what Vercel actually executes, and it must delegate to the
     * compiled serverless handler. A mismatch is a 500 from every route while the
     * build log reports success.
     */
    if (!exists('api/index.js')) {
      fail('api/index.js is missing; the platform would have no function to invoke');
    } else {
      const wrapper = stripComments(read('api/index.js'));
      const artefact = wrapper.match(/apps\/api\/dist\/[\w/.]+\.js/)?.[0];
      if (!artefact) {
        fail('api/index.js does not delegate to a compiled apps/api/dist artefact');
      } else if (!/entrypoints\/vercel\.js$/.test(artefact)) {
        fail(
          `api/index.js delegates to "${artefact}"; the serverless handler is ` +
            'apps/api/dist/entrypoints/vercel.js',
        );
      }
      if (/\bapp\.listen\s*\(/.test(wrapper)) {
        fail('api/index.js calls app.listen(): a function is invoked per request');
      }
    }

    /*
     * No bindings, and no loopback URLs.
     *
     * A binding injects another service's internal URL. With one service there is
     * nothing to bind to, and a hardcoded `localhost` in server code resolves to the
     * caller itself in production — a call that can only ever fail.
     */
    if (services[name]?.bindings) {
      fail(
        `service "${name}" declares bindings. This deployment has one service: the browser reaches it ` +
          'on the same origin and its only egress is PostgreSQL',
      );
    }
    const URL_LITERAL = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/;
    for (const dir of ['apps/api/src', 'deploy']) {
      if (!exists(dir)) continue;
      const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
          const child = path.join(rel, entry.name);
          if (entry.isDirectory()) { walk(child); continue; }
          if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
          if (/\.test\.mjs$/.test(entry.name)) continue;
          const src = stripComments(fs.readFileSync(path.join(ROOT, child), 'utf8'));
          if (URL_LITERAL.test(src)) {
            fail(
              `${child} contains a hardcoded loopback URL. In a deployment there is no loopback service ` +
                'to call — localhost resolves to the caller itself',
            );
          }
        }
      };
      walk(dir);
    }

    /* -------------------------------------------------------------------- cron -- */
    for (const cron of Array.isArray(cfg.crons) ? cfg.crons : []) {
      if (!String(cron.path ?? '').startsWith('/api/')) {
        fail(`cron "${cron.path}" is not under /api`);
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
        note(`cron "${cron.schedule}" may exceed the Hobby plan's one-run-per-day limit`);
      }
    }
  }

  /*
   * `.npmrc` carries `include=dev`.
   *
   * The service installCommand is the primary fix for the build-tool starvation, but
   * the failing deployment ran the *root* build, not a service build — so the install
   * that starved it did not come from a service installCommand. This makes every
   * install include the toolchain regardless of which command drives it.
   */
  if (!exists('.npmrc')) {
    fail('.npmrc is missing; it carries `include=dev`, the fallback that keeps a production install from omitting the build toolchain');
  } else {
    const npmrc = read('.npmrc').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    if (!/^\s*include\s*=\s*dev\s*$/m.test(npmrc)) {
      fail('.npmrc must set `include=dev`; without it a production install omits vite and tsc');
    }
    if (/^\s*ignore-scripts\s*=/m.test(npmrc)) {
      fail('.npmrc sets `ignore-scripts`, which disables every dependency lifecycle script');
    }
    if (/^\s*cache-dir\s*=/m.test(npmrc)) {
      fail('.npmrc sets `cache-dir`, which npm no longer recognises; use `cache`');
    }
  }

  /*
   * `apps/web` must keep its own lockfile and must not be a workspace member.
   *
   * This used to prevent one service's install from wiping another's `node_modules`.
   * It still matters for a different reason: `build:service` installs the web app
   * separately (`install:web`), and an `npm ci` from a workspace member walks up and
   * replaces the repo-root tree — deleting `fastify` out from under the API that was
   * just compiled against it.
   */
  {
    const rootPkg = JSON.parse(read('package.json'));
    const members = (rootPkg.workspaces ?? []).map((w) => String(w).replace(/\/+$/, ''));
    if (members.some((w) => /^apps\/web$|^apps\/web\//.test(w))) {
      fail(
        'apps/web is an npm workspace member. Its install then resolves the workspace root and ' +
          'deletes the root node_modules, removing the API dependencies the build just compiled against',
      );
    }
    if (JSON.parse(read('apps/web/package.json')).workspaces) {
      fail('apps/web/package.json declares "workspaces"; the web app must install as a standalone project');
    }
    if (!exists('apps/web/package-lock.json')) {
      fail('apps/web has no package-lock.json, so npm would resolve the repo-root lockfile and wipe the shared tree');
    }
  }

  /*
   * The obsolete shapes must stay obsolete.
   *
   * Each of these existed and was removed for a specific failure. Leaving one behind
   * as dead configuration is how it gets resurrected: a stale `deploy/web-server.mjs`
   * looks like the way to serve the SPA, and `Dockerfile.vercel` looks like a
   * deployment path.
   */
  for (const stale of ['Dockerfile.vercel', 'deploy/web-server.mjs', 'scripts/verify-service-builds.mjs']) {
    if (exists(stale)) {
      fail(`${stale} belongs to the retired multi-service deployment and must not be left behind as dead configuration`);
    }
  }

  /*
   * PostgreSQL is the only deployment database.
   *
   * The removed fallback wrote a SQLite file to `/tmp` on a serverless runtime, where
   * it was per-instance and discarded: the API accepted writes, served them back, and
   * lost every one on the next cold start. So the code must refuse to boot a serving
   * runtime without `DATABASE_URL`, and must not contain a temporary-directory
   * database path at all.
   */
  {
    /*
     * Text checks only. Whether a serving runtime actually refuses is *behaviour*, and a
     * scan for the identifier `isServingRuntime` passes against `if (false)` — verified,
     * it did. That assertion lives in apps/api/test/vercel.test.mjs, which calls
     * `buildApp()` in a production Vercel environment with no DATABASE_URL and asserts
     * the refusal. What is checkable here is that the explanation exists at all, so the
     * failure a person sees names the variable instead of surfacing as a blank 500.
     */
    const dbSource = read('apps/api/src/db/index.ts');
    if (!/DATABASE_URL is not set/.test(dbSource)) {
      fail('apps/api/src/db/index.ts does not explain what is missing when DATABASE_URL is absent, so the refusal would be opaque');
    }
    if (!/per-instance|discarded/i.test(dbSource)) {
      fail('apps/api/src/db/index.ts does not explain why a local file is not an alternative to DATABASE_URL');
    }
    const configSource = read('apps/api/src/config.ts');
    if (/os\.tmpdir\(\)/.test(stripComments(configSource))) {
      fail(
        'apps/api/src/config.ts still resolves a database path into the temporary directory. On a ' +
          'serverless runtime that is per-instance storage, so writes are accepted and then lost',
      );
    }
  }

  const engines = String(pkg.engines?.node ?? '');
  if (!engines) fail('package.json declares no engines.node, so Vercel cannot pin the runtime');
  else if (!/<\d+|\s/.test(engines) || !/^[><=~^]*\s*\d+/.test(engines)) {
    fail(`engines.node "${engines}" is not a usable range`);
  } else if (!/\s<|\|\||\^22\.\d+\.\d+$/.test(engines)) {
    /*
     * An open-ended lower bound is not a pin. `>=22.5.0` is satisfied by every future
     * major too, so when a new Node major ships Vercel upgrades the build image and the
     * runtime changes without anyone deciding to. The deploy log warned about exactly
     * this. A bounded range keeps the project on the line it was verified against.
     */
    fail(
      `engines.node "${engines}" has no upper bound; Vercel will auto-upgrade to a future ` +
        'major Node version. Pin the supported LTS line, e.g. ">=22.5.0 <23"',
    );
  } else {
    /*
     * The deployed entrypoint is TypeScript, and its imports name `.ts` files. Running
     * it requires Node's type stripping, enabled by default from 22.18.0. Below that the
     * module graph fails to resolve before any application code runs, which the platform
     * reports as the same opaque `500 FUNCTION_INVOCATION_FAILED` this deployment has
     * already been bitten by once. The floor is therefore a correctness bound, not a
     * preference: a lower one is a range that cannot execute the file it selects.
     */
    const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(engines);
    const minMinor = floor ? Number(floor[1]) * 1000 + Number(floor[2]) : 0;
    if (minMinor < 22_018) {
      fail(
        `engines.node "${engines}" allows a Node without default type stripping. ` +
          'The service entrypoint is TypeScript importing `.ts` specifiers, so it needs ' +
          '">=22.18.0 <23"; below that the entry fails to load and production answers ' +
          '500 FUNCTION_INVOCATION_FAILED',
      );
    } else {
      note(`engines.node ${engines} (bounded, type stripping available, Node 24 permitted for local work)`);
    }
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

/**
 * The install-script allowlist.
 *
 * npm 12 stopped running dependency lifecycle scripts by default; they run only when
 * `package.json` approves them in `allowScripts`. Vercel's log flagged
 * `argon2@0.41.1 (install: node-gyp-build)` as not approved, which is the one script
 * this deployment genuinely needs.
 *
 * The failure mode this check exists for is a *silent* one: approval is pinned to an
 * exact version, so bumping argon2 without updating the pin means the script stops
 * running and the native binding arrives missing — at runtime, not at build time.
 *
 * The allowlist must stay narrow. Approving broadly to make a warning disappear is
 * the blanket trust the mechanism exists to remove.
 */
{
  const rootPkg = JSON.parse(read('package.json'));
  const approved = rootPkg.allowScripts ?? {};
  const names = Object.keys(approved);

  if (!names.length) {
    fail('package.json has no "allowScripts"; npm 12+ would skip every dependency install script');
  }
  for (const [name, ok] of Object.entries(approved)) {
    if (ok !== true) continue; // explicit `false` is a deliberate denial, not a problem
    if (!name.includes('@')) {
      fail(
        `allowScripts entry "${name}" is not version-pinned. A bare name approves every future ` +
          'version without review — pin it as "<name>@<version>"',
      );
    }
  }

  /*
   * argon2 must be approved at exactly the version that will be installed. Resolved
   * from the lockfile rather than node_modules so the guard runs on a bare checkout
   * (CI calls it before and after installing; a guard that needs an install to run
   * is a guard that gets skipped).
   */
  const lock = JSON.parse(read('package-lock.json'));
  const installed =
    lock.packages?.['node_modules/argon2']?.version ??
    lock.packages?.['apps/api/node_modules/argon2']?.version;
  if (!installed) fail('package-lock.json does not contain argon2 — the lockfile is out of sync');
  if (!approved[`argon2@${installed}`]) {
    const pinned = names.filter((n) => n.startsWith('argon2@'));
    fail(
      `allowScripts does not approve argon2@${installed}` +
        (pinned.length ? ` (it pins ${pinned.join(', ')})` : '') +
        ' — the native binding would be skipped and password verification would fail at runtime',
    );
  } else {
    notes.push(`argon2@${installed} install script approved (node-gyp-build; prebuilt, no compile)`);
  }

  // Build/bundler scripts are not needed: they ship working binaries, and nothing in
  // this repo rebuilds them. Approving them would widen the allowlist for no reason.
  for (const name of names) {
    if (/^esbuild@|^@embedded-postgres\//.test(name) && approved[name] === true) {
      fail(
        `allowScripts approves "${name}", which this deployment does not need. ` +
          'Keep the allowlist to the scripts the build actually requires',
      );
    }
  }
}

/**
 * The Services framework preset is a dashboard setting, so it cannot be asserted from
 * here — but the *documentation* of it can be, and that is the deliverable the requester
 * follows. A guide that stops saying "set the preset to Services" leaves the next person
 * with a silent fallback and no stated cause.
 */
if (exists(DEPLOY_DOC)) {
  const doc = read(DEPLOY_DOC);
  const presetRow = /\|\s*\*\*Framework Preset\*\*\s*\|\s*\*\*`Services`\*\*/i.test(doc);
  if (!presetRow) {
    fail(
      'docs/DEPLOYMENT.md no longer instructs the reader to set the Framework Preset to ' +
        'Services — without that preset Vercel silently ignores the services block',
    );
  } else {
    notes.push('deployment guide states the Services framework preset requirement');
  }
  if (/\|\s*Framework preset\s*\|\s*Leave to `vercel\.json`/i.test(doc)) {
    fail(
      'docs/DEPLOYMENT.md claims the framework preset can be left to vercel.json; it is a ' +
        'project-level setting and Services mode is required',
    );
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
