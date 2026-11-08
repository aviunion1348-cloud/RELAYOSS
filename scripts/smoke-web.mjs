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
let COOKIE = '';
let CSRF = '';
async function get(p) {
  const r = await fetch(BASE + p, { headers: { cookie: COOKIE } });
  const j = await r.json();
  if (!r.ok) throw new Error(p + ' → ' + r.status);
  return j?.data ?? j;
}

/*
 * Authenticate the way a real user does.
 *
 * If the shared credential is provisioned, the demo login is refused — correctly —
 * and the smoke run must sign in with it. It is provisioned here from the
 * environment, never hardcoded: the smoke script is committed, and a password in
 * a committed script is a leaked password.
 */
const SHARED_USER = process.env.SMOKE_LOGIN_USERNAME ?? '';
const SHARED_PASS = process.env.SMOKE_LOGIN_PASSWORD ?? '';
let login;
if (SHARED_USER && SHARED_PASS) {
  login = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: SHARED_USER, password: SHARED_PASS }),
  });
} else {
  login = await fetch(BASE + '/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'usr_maya' }),
  });
}
if (!login.ok) { console.error('login failed', login.status); process.exit(2); }
COOKIE = String(login.headers.get('set-cookie') ?? '').split(';')[0];
// Read the body exactly once: a Response body is a stream, and cloning after
// reading throws.
const loginBody = await login.json().catch(() => ({}));
CSRF = loginBody?.data?.csrfToken ?? '';
const sessionUser = loginBody?.data?.user
  ?? { id: 'usr_maya', name: 'Maya Iyer', email: 'maya@relayoss.studio', role: 'admin' };
const session = { user: sessionUser, method: SHARED_USER ? 'password' : 'dev', authMode: SHARED_USER ? 'password' : 'dev', expiresAt: '', csrfToken: CSRF, permissions: {} };

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
 * The sign-in screen must describe a deployment failure accurately.
 *
 * This is checked separately from the screen renders because it is the one screen
 * a broken deployment ever shows, and it was wrong in the most expensive way: a
 * 503 from an unprovisioned API was reported as "Is the API running on :4000?",
 * which is false on every deployed host and points at the wrong problem.
 *
 * The check renders the screen with the three errors it can actually receive and
 * asserts that each is distinguishable. It is a render assertion, not a browser
 * test — see docs/REQUIREMENT-TRACEABILITY.md for what that leaves unproven.
 */
const signInCheck = `
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SignIn } from ${JSON.stringify(path.join(ROOT, 'apps/web/src/pages/SignIn'))};
import { ApiError } from ${JSON.stringify(path.join(ROOT, 'apps/web/src/lib/api'))};

function render(error) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SignIn info={null} probeError={error} onSignedIn={() => {}} />
    </QueryClientProvider>,
  );
}

const misconfigured = new ApiError(503, 'misconfigured', 'SESSION_SECRET is required', {
  code: 'misconfigured',
  stage: 'configuration',
  summary: 'SESSION_SECRET is required (used to sign CSRF tokens and cookie sessions)',
  missing: ['SESSION_SECRET', 'DATABASE_URL'],
  invalid: [],
  remedy: ['Set SESSION_SECRET to 32+ random bytes'],
});

const cases = [
  ['misconfigured', misconfigured, [
    (h) => /not configured yet/i.test(h), 'names the real problem',
    (h) => h.includes('SESSION_SECRET'), 'names the missing variable',
    (h) => h.includes('DATABASE_URL'), 'names every missing variable',
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
  // Paired here rather than nested at each call site.
  for (let i = 0; i < checks.length; i += 2) {
    const fn = checks[i];
    const why = checks[i + 1];
    const verified = fn(html);
    if (!verified) bad++;
    console.log((verified ? 'ok  ' : 'FAIL') + ' sign-in/' + label.padEnd(13) + ' ' + why);
  }
}
if (bad) { console.error('\\n' + bad + ' sign-in failure assertion(s) failed'); process.exit(1); }
`;

fs.writeFileSync(path.join(WORK, 'signin.mtsx'), signInCheck, 'utf8');
const SIGNIN_OUT = path.join(WORK, 'signin.mjs');
execFileSync(
  fs.existsSync(ESBUILD) ? ESBUILD : 'esbuild',
  [
    path.join(WORK, 'signin.mtsx'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${SIGNIN_OUT}`,
    '--loader:.mtsx=tsx', '--jsx=automatic', '--log-level=error',
    '--external:react', '--external:react-dom', '--external:react-dom/server',
    '--external:react-router-dom', '--external:@tanstack/react-query',
    '--external:lucide-react', '--external:recharts',
  ],
  { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' },
);
execFileSync(process.execPath, ['--no-warnings', SIGNIN_OUT], { cwd: path.join(ROOT, 'apps', 'web'), stdio: 'inherit' });

console.log('\n✓ all screens render with real API data');
console.log('✓ the sign-in screen reports deployment failures accurately');
stopApi();
