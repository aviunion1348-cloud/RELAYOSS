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
 *   node scripts/smoke-web.mjs            (expects the API on :4000)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.SMOKE_API ?? 'http://127.0.0.1:4000/api';
const WORK = path.join(ROOT, '.smoke');
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

const login = await fetch(BASE + '/auth/dev-login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: 'usr_maya' }),
});
if (!login.ok) { console.error('login failed', login.status); process.exit(2); }
COOKIE = String(login.headers.get('set-cookie') ?? '').split(';')[0];
CSRF = (await login.json())?.data?.csrfToken ?? '';
const session = { user: { id: 'usr_maya', name: 'Maya Iyer', email: 'maya@relayoss.studio', role: 'admin' }, method: 'dev', authMode: 'dev', expiresAt: '', csrfToken: CSRF, permissions: {} };

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

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'entry.mjs'), entry.replace(/\.tsx?/g, ''), 'utf8');

// esbuild resolves the .tsx imports from the source tree.
fs.writeFileSync(path.join(WORK, 'entry.mtsx'), entry, 'utf8');
execFileSync(
  'npx',
  [
    'esbuild', path.join(WORK, 'entry.mtsx'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${OUT}`,
    '--loader:.mtsx=tsx', '--jsx=automatic', '--log-level=error',
    '--external:react', '--external:react-dom', '--external:react-dom/server',
    '--external:react-router-dom', '--external:@tanstack/react-query',
    '--external:lucide-react', '--external:recharts',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

execFileSync(process.execPath, ['--no-warnings', OUT], { cwd: ROOT, stdio: 'inherit' });
console.log('\n✓ all screens render with real API data');
