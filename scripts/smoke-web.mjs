#!/usr/bin/env node
/**
 * Server-render smoke test for every screen.
 *
 * There is no headless browser available in this environment (Playwright's
 * Chromium download is blocked), so verification is done by rendering each page
 * through React's server renderer with a pre-filled query cache. That catches
 * the failures that matter for a screen: a crashing component, a missing
 * permission field, a hook order violation, an undefined access from real API
 * data. It is not a substitute for a browser; docs/REQUIREMENT-TRACEABILITY.md
 * records exactly what remains unproven because of it.
 *
 *   node scripts/smoke-web.mjs            # boots its own API if none is listening
 *   SMOKE_API=http://host:port/api …      # or point at an existing instance
 *
 * Self-booting matters: CI has no server running, and a smoke test that
 * silently depends on someone having started one is a smoke test that fails
 * for the wrong reason (it did exactly that on the first CI run).
 */
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.SMOKE_API ?? 'http://127.0.0.1:4000/api';
// Built inside apps/web, not the repo root: the web project is standalone (its install
// cannot touch the root tree — that is what broke the Vercel deploy), so its node_modules
// is the only place react-dom and friends resolve from.
const WORK = path.join(ROOT, 'apps', 'web', '.smoke');
const OUT = path.join(WORK, 'smoke.mjs');

const PAGES = [
  ['Dashboard', 'Dashboard', '/', ['/dashboard', '/insights', '/activity?limit=14']],
  ['Board', 'Board', '/board', ['/meta', '/tasks?limit=400']],
  ['Pipeline', 'Pipeline', '/pipeline', ['/pipeline']],
  ['Clocks', 'Clocks', '/clocks', ['/clocks']],
  ['Projects', 'Projects', '/projects', ['/projects', '/releases']],
  ['ProjectDetail', 'ProjectDetail', '/projects/pr_northwind', ['/projects/pr_northwind']],
  ['Workload', 'Workload', '/workload', ['/planner?horizon=21']],
  ['QACentre', 'QACentre', '/qa', ['/qa', '/meta']],
  ['Releases', 'Releases', '/releases', ['/releases']],
  ['Clients', 'Clients', '/clients', ['/clients', '/pipeline']],
  ['Partners', 'Partners', '/partners', ['/partners']],
  ['Intelligence', 'Intelligence', '/intel', ['/insights', '/dashboard']],
  ['Docs', 'Docs', '/docs', ['/docs']],
];

const entry = `
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from ${JSON.stringify(path.join(ROOT, 'apps/web/src/components/Shell'))};
${PAGES.map(([name, file]) => `import ${name} from ${JSON.stringify(path.join(ROOT, `apps/web/src/pages/${file}`))};`).join('\n')}

const BASE = ${JSON.stringify(API)};
async function get(p) {
  const r = await fetch(BASE + p);
  const j = await r.json();
  if (!r.ok) throw new Error(p + ' → ' + r.status);
  return j?.data ?? j;
}

/*
 * No sign-in.
 *
 * This used to authenticate the way a real user did — the shared credential when
 * one was provisioned, the demo login otherwise — and carried the cookie and CSRF
 * token through every request. Both endpoints are gone, so the smoke run now does
 * what a browser does on a cold start: it requests the deployment description with
 * no credential, and asserts that it got one.
 *
 * That check is worth keeping rather than deleting. It is the one place in the
 * suite that verifies the *running server* answers the startup probe, and its
 * failure was previously the first sign that a deployment was unprovisioned.
 */
const sessionRes = await fetch(BASE + '/auth/session');
if (!sessionRes.ok) {
  console.error('the deployment description failed:', sessionRes.status, await sessionRes.text());
  process.exit(2);
}
const sessionBody = await sessionRes.json().catch(() => ({}));
const session = sessionBody?.data;
if (!session?.user?.id) {
  console.error('the deployment description carried no operator identity:', JSON.stringify(sessionBody).slice(0, 200));
  process.exit(2);
}
if (session.authMode !== 'none') {
  console.error('expected authMode "none", got', session.authMode);
  process.exit(2);
}

const pages = ${JSON.stringify(PAGES)};
let failed = 0;
for (const [name, , route, endpoints] of pages) {
  const Page = { Dashboard, Board, Pipeline, Clocks, Projects, ProjectDetail, Workload, QACentre, Releases, Clients, Partners, Intelligence, Docs }[name];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
  const prefills = [[['meta'], get('/meta')], [['session'], Promise.resolve(session)]];
  for (const ep of endpoints) {
    const [p, q] = ep.split('?');
    if (p === '/tasks') prefills.push([['tasks', '', { priority: [], mine: false, labelId: '', q: '', risk: 'all' }], get(ep)]);
    else if (p === '/planner') prefills.push([['planner', 21], get(ep)]);
    else if (p === '/activity') prefills.push([['activity'], get(ep)]);
    else prefills.push([[p.replace('/', '').split('?')[0]], get(ep)]);
  }
  try {
    for (const [key, promise] of prefills) qc.setQueryData(key, await promise);
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <Shell session={session}><Page /></Shell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const ok = html.length > 16000;
    if (!ok) failed++;
    console.log(\`\${ok ? 'ok  ' : 'THIN'} \${name.padEnd(14)} \${String(html.length).padStart(7)} bytes\`);
  } catch (e) {
    failed++;
    console.log(\`FAIL \${name.padEnd(14)} \${e.message}\`);
  }
}

process.exit(failed ? 1 : 0);
`;


/* --------------------------------------------------------- API lifecycle -- */
const PORT = Number(new URL(API).port || 4000);
const needsBoot = !process.env.SMOKE_API;

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForApi(deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await portOpen(PORT)) {
      try {
        const res = await fetch(`${API}/live`);
        if (res.ok) return true;
      } catch { /* not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let api = null;
if (await portOpen(PORT)) {
  console.log(`· using the API already listening on :${PORT}`);
} else if (needsBoot) {
  // A clean checkout has no database: migrate + seed so every screen has real
  // content to render, rather than a wall of empty states that would pass while
  // proving nothing.
  /*
   * A dedicated throwaway database, not the developer's working one.
   *
   * This used to default to `data/relay.sqlite` — the same file the documented
   * login-setup step writes a real credential into (`assign-login`). Once anyone
   * followed the deployment guide locally, the shared credential was provisioned,
   * `AUTH_MODE=dev` was correctly refused, the dev-login the smoke run depends on
   * returned 403, and `npm run verify` failed permanently with `login failed 401`.
   * A smoke test that breaks when the developer configures the application it is
   * testing is worse than useless: it trains people to ignore it.
   *
   * The smoke run builds its own fixture each time instead, so it is impervious to
   * whatever else the checkout has been used for.
   */
  const dbFile = process.env.SMOKE_DB_PATH ?? path.join(WORK, 'smoke.sqlite');
  if (process.env.SMOKE_DB_PATH && !fs.existsSync(dbFile)) {
    console.error(`✗ SMOKE_DB_PATH is set but ${dbFile} does not exist`);
    process.exit(1);
  }
  if (!fs.existsSync(dbFile)) {
    console.log('· no smoke database — migrating and seeding a fresh one');
    execFileSync(process.execPath, ['--no-warnings', 'apps/api/src/db/cli.ts', 'migrate'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, DB_PATH: dbFile },
    });
    execFileSync(process.execPath, ['--no-warnings', 'apps/api/src/db/cli.ts', 'seed'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, DB_PATH: dbFile },
    });
  }
  console.log(`· booting the API on :${PORT}`);
  api = spawn(process.execPath, ['--no-warnings', 'apps/api/src/index.ts'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '0.0.0.0',
      DB_PATH: dbFile,
      AUTH_MODE: 'dev',
      SESSION_SECRET: process.env.SESSION_SECRET ?? 'smoke-run-secret-not-a-deployment',
      SKIP_MIGRATE: '1',
    },
  });
  if (!(await waitForApi(45_000))) {
    api.kill('SIGTERM');
    console.error(`✗ the API did not become ready on :${PORT}`);
    process.exit(1);
  }
} else {
  console.error(`✗ SMOKE_API is set but nothing is listening on :${PORT}`);
  process.exit(1);
}

const stopApi = () => {
  if (api && !api.killed) api.kill('SIGTERM');
};
process.on('exit', stopApi);
process.on('SIGINT', () => {
  stopApi();
  process.exit(130);
});

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'entry.mjs'), entry.replace(/\.tsx?/g, ''), 'utf8');

// esbuild resolves the .tsx imports from the source tree.
fs.writeFileSync(path.join(WORK, 'entry.mtsx'), entry, 'utf8');
const ESBUILD = path.join(ROOT, 'apps', 'web', 'node_modules', '.bin', 'esbuild');
execFileSync(
  fs.existsSync(ESBUILD) ? ESBUILD : 'esbuild',
  [
    path.join(WORK, 'entry.mtsx'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${OUT}`,
    '--loader:.mtsx=tsx', '--jsx=automatic', '--log-level=error',
    '--external:react', '--external:react-dom', '--external:react-dom/server',
    '--external:react-router-dom', '--external:@tanstack/react-query',
    '--external:lucide-react', '--external:recharts',
  ],
  { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' },
);

execFileSync(process.execPath, ['--no-warnings', OUT], { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' });

/**
 * A failure must be described accurately, wherever it surfaces.
 *
 * There is no sign-in screen any more, so this check moved to `ApiFailure` — the
 * component every page now renders in place of its content when a request fails.
 * That move matters: previously a broken API produced a sign-in screen that
 * explained the problem, and the dashboard was never reached. Now a broken API
 * produces the dashboard shell with an inline explanation, so *this* is the text a
 * person actually reads when a deployment is wrong.
 *
 * The three distinguishable cases are unchanged, and so is why they matter. The
 * original bug reported "Is the API running on :4000?" for a 503, which is false on
 * every deployed host and sent the reader after a server that was running fine.
 *
 * It is a render assertion, not a browser test — see
 * docs/REQUIREMENT-TRACEABILITY.md for what that leaves unproven.
 */
const failureCheck = `
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiFailure } from ${JSON.stringify(path.join(ROOT, 'apps/web/src/components/ApiFailure'))};
import { ApiError } from ${JSON.stringify(path.join(ROOT, 'apps/web/src/lib/api'))};

function render(error) {
  return renderToStaticMarkup(<ApiFailure error={error} what="the dashboard" />);
}

const misconfigured = new ApiError(503, 'misconfigured', 'The database is not configured', {
  code: 'misconfigured',
  stage: 'database',
  summary: 'No DATABASE_URL is set and SQLite is unavailable in this runtime',
  missing: ['DATABASE_URL'],
  invalid: [],
  optional: [],
  remedy: ['Set DATABASE_URL to a PostgreSQL connection string'],
});

const cases = [
  ['misconfigured', misconfigured, [
    (h) => /not configured yet/i.test(h), 'names the real problem',
    (h) => h.includes('DATABASE_URL'), 'names the missing variable',
    (h) => !/running on\\s*:?4000/i.test(h), 'does not blame a missing local server',
  ]],
  ['unreachable', new TypeError('Failed to fetch'), [
    (h) => /could not reach the api/i.test(h), 'says the request never completed',
    (h) => !/not configured/i.test(h), 'does not claim a configuration problem',
  ]],
  ['rejected', new ApiError(429, 'rate_limited', 'Too many requests'), [
    (h) => /429/.test(h) && /rate_limited/.test(h), 'reports the status and code',
  ]],
];

let bad = 0;
for (const [label, err, checks] of cases) {
  const html = render(err);
  // The check list is flat pairs: [predicate, explanation, predicate, ...].
  for (let i = 0; i < checks.length; i += 2) {
    const fn = checks[i];
    const why = checks[i + 1];
    const verified = fn(html);
    if (!verified) bad++;
    console.log((verified ? 'ok  ' : 'FAIL') + ' failure/' + label.padEnd(13) + ' ' + why);
  }
}
if (bad) { console.error('\\n' + bad + ' failure-message assertion(s) failed'); process.exit(1); }
`;

fs.writeFileSync(path.join(WORK, 'failure.mtsx'), failureCheck, 'utf8');
const FAILURE_OUT = path.join(WORK, 'failure.mjs');
execFileSync(
  fs.existsSync(ESBUILD) ? ESBUILD : 'esbuild',
  [
    path.join(WORK, 'failure.mtsx'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${FAILURE_OUT}`,
    '--loader:.mtsx=tsx', '--jsx=automatic', '--log-level=error',
    '--external:react', '--external:react-dom', '--external:react-dom/server',
    '--external:react-router-dom', '--external:@tanstack/react-query',
    '--external:lucide-react', '--external:recharts',
  ],
  { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' },
);
execFileSync(process.execPath, ['--no-warnings', FAILURE_OUT], { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' });


/**
 * The failure pass: what a screen shows when its data does not arrive.
 *
 * This exists because of a real defect that every other check in this repository
 * passed straight through. Each screen rendered its content only when a query had
 * data, and rendered a loading skeleton otherwise:
 *
 *     if (isLoading || !data) return <Skeleton />;
 *
 * A *failed* query has no data, so the skeleton never went away. The application
 * opened on the dashboard, the sidebar worked, every page was reachable — and
 * every panel buffered forever with no error and no timeout. The API-level tests
 * could not see it (they assert status codes), and the happy-path render above
 * could not see it (it seeds the cache with successful responses first).
 *
 * So this pass does the opposite of the happy path: it renders each screen with
 * its queries in an error state and asserts the reader is told, can retry, and is
 * not shown a loading placeholder. It is a render assertion, not a browser test;
 * it cannot prove a spinner is *animated* away, only that the markup a failed
 * screen produces is an error rather than a skeleton.
 */
const failStateCheck = `
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from ${JSON.stringify(path.join(ROOT, 'apps/web/src/components/Shell'))};
import { ApiError, NetworkError, requestWithDeadline } from ${JSON.stringify(path.join(ROOT, 'apps/web/src/lib/api'))};
${PAGES.map(([name, file]) => `import ${name} from ${JSON.stringify(path.join(ROOT, `apps/web/src/pages/${file}`))};`).join('\n')}

const SCREENS = ${JSON.stringify(PAGES)};
const COMPONENTS = { Dashboard, Board, Pipeline, Clocks, Projects, ProjectDetail, Workload, QACentre, Releases, Clients, Partners, Intelligence, Docs };

/*
 * The error a real deployment produces when it has no data: a 503 whose body
 * carries the remedy. Rendered through the actual ApiFailure component, so the
 * text being asserted is the text a person would read.
 */
const dbError = new ApiError(503, 'misconfigured', 'The database is not configured', {
  code: 'misconfigured',
  stage: 'database',
  summary: 'No DATABASE_URL is set',
  missing: ['DATABASE_URL'],
  invalid: [],
  optional: [],
  remedy: ['Set DATABASE_URL to a PostgreSQL connection string'],
});

let bad = 0;
function check(label, ok, detail) {
  if (!ok) bad++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' fail-state/' + label.padEnd(15) + ' ' + (detail ?? ''));
}

for (const [name, , route, endpoints] of SCREENS) {
  const Page = COMPONENTS[name];
  const qc = new QueryClient({
    /*
     * Hold the failure still. With a short staleTime the observer refetches on
     * mount, which flips the entry back to 'pending' and the screen legitimately
     * renders its skeleton again — the check would then be asserting nothing. In
     * a browser the same refetch happens, and its *result* is what a real user
     * sees; here the question is only what a failed query renders.
     */
    defaultOptions: {
      /* Client-level refetchOnMount:false is the one that matters: it survives a
         screen that passes its own enabled, which a per-query default does not. */
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });

  /*
   * Put every query this screen issues into the failed state, under the key the
   * screen actually uses. 'setQueryData(key, undefined)' first creates the entry;
   * the state override then makes it indistinguishable from a rejection React
   * Query produced itself.
   */
  const keys = [[['meta']], [['session']]];
  for (const ep of endpoints) {
    const p = ep.split('?')[0];
    if (p === '/tasks') {
      keys.push([['tasks', '', { priority: [], mine: false, labelId: '', q: '', risk: 'all' }]]);
      keys.push([['tasks']]);
    } else if (p === '/planner') keys.push([['planner', 21]]);
    else if (p === '/activity') keys.push([['activity']]);
    /*
     * A detail screen keys its query by the route parameter, not by the resource
     * name: '/projects/pr_northwind' is ['project', 'pr_northwind']. Registering
     * only ['project'] left that screen pending and it failed this check for a
     * reason that had nothing to do with the code under test.
     */
    else if (p.startsWith('/projects/')) keys.push([['project', p.slice('/projects/'.length)]]);
    else keys.push([[p.replace('/', '').split('?')[0]]]);
  }
  for (const [key] of keys) {
    /*
     * Two details decide whether this check tests anything at all:
     *
     *  - build the entry, never setQueryData(undefined) — that DELETES the query,
     *    and the screen then renders in its pending state for the wrong reason;
     *  - disable the query. React Query treats "no data" as always stale
     *    (isStaleByTime returns true when data is undefined), so a mounted
     *    observer starts a fetch on mount and the screen reads as pending while
     *    that fetch is in flight — which is exactly the state this check is not
     *    about. Disabling it holds the failed result still so the render sees it.
     */
    /*
     * refetchOnMount: false as a default, plus an observer-level override below:
     * a screen is free to pass its own enabled (one does), and the observer
     * re-resolves the mount refetch against its own options, so the default alone
     * is not enough to hold the failed state still.
     */
    qc.setQueryDefaults(key, { enabled: false, refetchOnMount: false, staleTime: Infinity });
    const entry = qc.getQueryCache().build(qc, { queryKey: key });
    entry.setState({
      status: 'error', data: undefined, error: dbError,
      errorUpdateCount: 1, errorUpdatedAt: Date.now(), fetchStatus: 'idle',
    });
  }

  let html = '';
  let threw = null;
  try {
    /*
     * Rendered through a real Route, not as a bare element: a detail screen reads
     * its identifier from useParams, and without a matching Route that param is
     * undefined, so the screen keys its query differently and this check would
     * fail for a reason that has nothing to do with how it behaves.
     */
    html = renderToString(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route
              path={route.startsWith('/projects/') ? '/projects/:id' : route}
              element={<Shell session={undefined}><Page /></Shell>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  } catch (e) {
    threw = e;
  }

  const told = /could not load|did not answer|could not reach|rejected the request|not configured yet/i.test(html);
  const retry = /retry/i.test(html);
  const furniture = html.length > 4000;
  const noSkeleton = !/shimmer/.test(html);

  const detail = [
    threw ? 'threw ' + threw.message : null,
    !told ? 'no message explaining the failure' : null,
    !retry ? 'no retry offered' : null,
    !furniture ? 'rendered almost nothing (' + html.length + ' bytes)' : null,
    !noSkeleton ? 'rendered a loading skeleton for a failed query' : null,
  ].filter(Boolean).join('; ');

  check(name, !threw && told && retry && furniture && noSkeleton, detail || 'error shown, retry offered, no skeleton');
}

/*
 * A request that never answers must not become an endless wait.
 *
 * The deadline in 'request()' is the only thing standing between a stuck request
 * and the symptom this pass exists to catch, and a deadline that is never
 * exercised is a deadline that silently stops working. TEST-NET-1 (192.0.2.0/24)
 * is reserved and never answers, so the call can only end by the deadline.
 */
{
  const started = Date.now();
  let code = null;
  try {
    await requestWithDeadline('/nothing', { deadlineMs: 150, base: 'http://192.0.2.1:9' });
  } catch (e) {
    code = e && e.code;
  }
  const settled = Date.now() - started;
  const ok = (code === 'timeout' || code === 'network') && settled < 5000;
  check('deadline', ok, ok
    ? 'abandoned after ' + settled + 'ms (' + code + '), so the screen cannot wait forever'
    : 'did not give up: ' + code + ' after ' + settled + 'ms');
}

/*
 * A 200 that is not JSON must be a failure, not data.
 *
 * This is the other buffering path, and on a real deployment the likeliest one:
 * when /api is routed to the web service instead of the API service, the
 * platform answers every API call with the index.html of the SPA and a 200. The
 * status check passed, the body parsed to null, and the component received
 * undefined as its data — which its data-presence check read as still loading, so
 * the screen buffered with no error to show. Here the client is pointed at a stub
 * server that returns exactly that, and must report a routing fault.
 */
{
  const http = await import('node:http');
  const stub = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><div id="root"></div></body></html>');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  let code = null;
  let message = '';
  try {
    await requestWithDeadline('/api/dashboard', { base: 'http://127.0.0.1:' + port });
  } catch (e) {
    code = e && e.code;
    message = (e && e.message) || '';
  }
  stub.close();
  const ok = code === 'network' && /routing fault|HTML page/i.test(message);
  check('html-200', ok, ok
    ? 'an HTML page served at /api is reported as a routing fault, not accepted as data'
    : 'a non-JSON 200 was not rejected: ' + code + ' ' + message);
}

/*
 * An older browser must still be able to make a request.
 *
 * AbortSignal.timeout is Safari 16+ / Chrome 103+ and AbortSignal.any is newer.
 * The client used both unconditionally, outside its try/catch — so on an older
 * browser calling them threw a TypeError before the fetch was even attempted, and
 * every panel in the product failed at once with "the request never reached the
 * server". Deleting the two statics here reproduces that browser exactly: a server
 * is listening and reachable, so a working client must get its response.
 */
{
  const http = await import('node:http');
  const stub = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { ok: true } }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + stub.address().port;

  const savedTimeout = AbortSignal.timeout;
  const savedAny = AbortSignal.any;
  // A browser from before these existed: the properties are simply absent.
  delete AbortSignal.timeout;
  delete AbortSignal.any;
  let result = null;
  let failure = null;
  try {
    result = await requestWithDeadline('/api/meta', { base, deadlineMs: 5000 });
  } catch (e) {
    failure = e;
  } finally {
    AbortSignal.timeout = savedTimeout;
    AbortSignal.any = savedAny;
    stub.close();
  }
  const ok = !failure && result && result.ok === true;
  check('no-abortsignal', Boolean(ok), ok
    ? 'a browser without AbortSignal.timeout/any can still load data'
    : 'a browser without AbortSignal.timeout/any cannot make a request: ' +
      (failure ? failure.name + ': ' + failure.message : 'no data returned'));
}

/*
 * The timeout must render as a timeout, not as a generic network fault: the two
 * have different remedies, and conflating them is the mistake ApiFailure was
 * written to stop.
 */
{
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } } });
  qc.setQueryDefaults(['dashboard'], { enabled: false });
  const dashEntry = qc.getQueryCache().build(qc, { queryKey: ['dashboard'] });
  dashEntry.setState({
    status: 'error', data: undefined, error: new NetworkError('timeout', 'No response from the server within 20s.'),
    errorUpdateCount: 1, errorUpdatedAt: Date.now(), fetchStatus: 'idle',
  });
  const html = renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Shell session={undefined}><Dashboard /></Shell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const saysTimeout = /did not answer in time/i.test(html);
  check('timeout-text', saysTimeout, saysTimeout ? 'reports that the server did not answer, not that the network failed' : 'timeout was described as a network fault');
}

if (bad) {
  console.error('\\n' + bad + ' failure-state check(s) failed — a broken screen can still look like a loading one');
  process.exit(1);
}
`;

fs.writeFileSync(path.join(WORK, 'failstate.mtsx'), failStateCheck, 'utf8');
const FAILSTATE_OUT = path.join(WORK, 'failstate.mjs');
execFileSync(
  fs.existsSync(ESBUILD) ? ESBUILD : 'esbuild',
  [
    path.join(WORK, 'failstate.mtsx'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${FAILSTATE_OUT}`,
    '--loader:.mtsx=tsx', '--jsx=automatic', '--log-level=error',
    '--external:react', '--external:react-dom', '--external:react-dom/server',
    '--external:react-router-dom', '--external:@tanstack/react-query',
    '--external:lucide-react', '--external:recharts',
  ],
  { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' },
);
execFileSync(process.execPath, ['--no-warnings', FAILSTATE_OUT], { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' });

console.log('\n✓ all screens render with real API data');
console.log('✓ API failures are described accurately in the dashboard');
console.log('✓ every screen shows an error and a retry when its data fails to load');
stopApi();
