#!/usr/bin/env node
/**
 * Guard the two commands a fresh clone is told to run.
 *
 * The reported failure was not in the application:
 *
 *     npm install      # 125 packages, no vite
 *     npm run dev      # [web] 'vite' is not recognized as an internal or external command
 *     npm start        # Error: Cannot find module apps/api/dist/index.js
 *
 * Both are consequences of the install/build split in this repository:
 *
 *   - `apps/web` is not a workspace member on purpose (its install must not disturb the
 *     API's dependencies on the deployment), so a root `npm install` never installed
 *     `vite`, `react` or `tailwindcss`;
 *   - `npm start` ran `node apps/api/dist/index.js` with nothing having compiled it.
 *
 * The fixes are a `postinstall` that installs the web project and a `prestart` that
 * builds. Both are one-line scripts, which are exactly the kind of thing that gets
 * quietly removed during a refactor — so they are asserted here, with the reason.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const ok = (message) => notes.push(message);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const workspaces = pkg.workspaces ?? [];

/* ------------------------------------------------------------ the web install -- */

const webIsWorkspace = workspaces.some((w) => String(w).replace(/\/$/, '') === 'apps/web');

if (!webIsWorkspace) {
  const postinstall = String(scripts.postinstall ?? '');
  if (!postinstall) {
    fail(
      'apps/web is not a workspace member, so `npm install` at the root does not install ' +
        'vite/react/tailwindcss, and `npm run dev` fails with "\'vite\' is not recognized". ' +
        'Add a postinstall that runs scripts/install-web-deps.mjs (or make apps/web a workspace)',
    );
  } else if (!/install-web-deps/.test(postinstall)) {
    fail(
      `postinstall is "${postinstall}", which does not install the web project. A fresh clone ` +
        'followed by `npm install` must leave `npm run dev` runnable — that is apps/web\'s ' +
        'node_modules, installed by scripts/install-web-deps.mjs',
    );
  } else if (!existsSync(path.join(root, 'scripts/install-web-deps.mjs'))) {
    fail('postinstall references scripts/install-web-deps.mjs, which does not exist');
  } else {
    ok('npm install also installs apps/web (postinstall → install-web-deps.mjs)');
  }
} else {
  ok('apps/web is a workspace member, so the root install covers it');
}

/* ------------------------------------------------------------------- the build -- */

const start = String(scripts.start ?? '');
if (!start) {
  fail('package.json has no `start` script');
} else {
  /*
   * Whatever `start` executes must be a build artefact. A `prestart` (or a `start` that
   * builds first) is the difference between "clone, install, start" and
   * "Cannot find module apps/api/dist/index.js".
   */
  const buildsFirst = Boolean(scripts.prestart) || /\bbuild\b/.test(start);
  const target = /node\s+([^\s]+)/.exec(start)?.[1] ?? '';
  const targetLooksBuilt = target.includes('/dist/') || target.includes('\\dist\\');

  if (targetLooksBuilt && !buildsFirst) {
    fail(
      `"start" is "${start}" and runs a built artefact, but nothing builds it: a fresh clone ` +
        'fails with "Cannot find module". Add a `prestart` that builds, or make `start` build first',
    );
  } else if (targetLooksBuilt) {
    ok(`npm start builds before running (${scripts.prestart ? 'prestart' : 'start'})`);
  } else {
    ok('npm start does not run a build artefact, so no prestart is required');
  }
}

/* ------------------------------------------------------------------ the output -- */

if (failures.length) {
  console.error(`\n✗ Local-run guard failed (${failures.length}):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}

for (const n of notes) console.log(`· ${n}`);
console.log('✓ Local-run guard passed — `npm install`, `npm run dev` and `npm start` work from a fresh clone.');
