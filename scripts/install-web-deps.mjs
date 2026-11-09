#!/usr/bin/env node
/**
 * Install the web app's dependencies, because `npm install` at the root does not.
 *
 * `apps/web` is deliberately **not** an npm workspace: it has its own lockfile and its
 * own toolchain (Vite, React, Tailwind), and the deployment installs it separately with
 * `npm ci --prefix apps/web`. The consequence was not deliberate at all: a fresh clone
 * followed by `npm install` produced a repository where `npm run dev` died with
 *
 *     [web] 'vite' is not recognized as an internal or external command
 *
 * because nothing had ever installed `vite`. The build path installed the web
 * dependencies (`install:web`, called from `build:service`); the developer path did
 * not. That is a repository defect, not a user error — the documented first two
 * commands must produce a running app.
 *
 * So this runs from `postinstall`: it installs the web app's dependencies as part of the
 * root install, which is what everyone already expects `npm install` to do.
 *
 * It is a no-op when the dependencies are already there, so it costs nothing on repeat
 * installs, in CI, or on the deployment where `build:service` installs them again.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'apps', 'web');

/**
 * Is the toolchain present?
 *
 * `vite` is the probe rather than the whole `node_modules` directory: it is the package
 * whose absence produced the observed failure, and it is a devDependency, so its
 * presence also proves the install included dev dependencies.
 */
function alreadyInstalled() {
  return existsSync(path.join(web, 'node_modules', 'vite', 'package.json'));
}

if (!existsSync(path.join(web, 'package.json'))) {
  process.exit(0);
}

if (alreadyInstalled()) {
  process.exit(0);
}

const hasLockfile = existsSync(path.join(web, 'package-lock.json'));
const args = hasLockfile
  ? ['ci', '--prefix', 'apps/web', '--include=dev', '--no-audit', '--no-fund']
  : ['install', '--prefix', 'apps/web', '--include=dev', '--no-audit', '--no-fund'];

/*
 * `shell: true` because Windows resolves `npm` to `npm.cmd`, which cannot be spawned
 * directly. This script exists for the Windows path in the first place.
 */
const result = spawnSync('npm', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`web dependency install could not run: ${result.error.message}`);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  console.error(
    `web dependency install failed with exit code ${result.status}. ` +
      '`npm run dev` needs these packages; run it again with network access.',
  );
  process.exit(result.status ?? 1);
}
