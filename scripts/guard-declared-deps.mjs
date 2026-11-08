#!/usr/bin/env node
/**
 * Guard: every bare import must be a declared dependency.
 *
 * This exists because of a real production failure. `apps/api/src/db/postgres.ts`
 * imported `pg`, but `pg` was never declared — it resolved only because
 * `embedded-postgres` (a dev-only tool used for local clusters) happened to
 * depend on it. Everything passed locally and in CI, then the container builds
 * with `npm ci --omit=dev`, `pg` is not installed, and the image crashes on
 * startup with ERR_MODULE_NOT_FOUND.
 *
 * A dependency that exists only by accident is a time bomb. This guard makes
 * the mistake fail at the point it is made instead of in production.
 *
 * Checks:
 *   - every bare (non-relative, non-node:) import in each app's src resolves to a
 *     `dependencies` entry of that workspace (or the root), and is importable
 *   - the production install set actually contains those packages
 *
 *   node scripts/guard-declared-deps.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACES = ['apps/api', 'apps/web'];
// `node:sqlite` is a Node 22 builtin that does not always appear in
// `builtinModules`, so the `node:` prefix is treated as authoritative.
const EXTRA_BUILTINS = ['node:sqlite', 'node:test'];
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...EXTRA_BUILTINS,
]);

const problems = [];
const seen = new Map();

function pkgName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'build'].includes(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rootPkg = readJson(path.join(ROOT, 'package.json'));

for (const ws of WORKSPACES) {
  const wsPkg = readJson(path.join(ROOT, ws, 'package.json'));
  const declared = new Set([
    ...Object.keys(wsPkg.dependencies ?? {}),
    ...Object.keys(wsPkg.devDependencies ?? {}),
  ]);
  const prod = new Set(Object.keys(wsPkg.dependencies ?? {}));

  for (const file of walk(path.join(ROOT, ws, 'src'))) {
    const source = stripTemplateLiterals(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(ROOT, file);
    // Static imports, side-effect imports and dynamic import() of a literal.
    const specs = [
      ...[...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      if (BUILTINS.has(spec)) continue;
      const name = pkgName(spec);
      if (BUILTINS.has(name)) continue;
      seen.set(name, rel);
      if (!declared.has(name)) {
        problems.push(`${rel}: imports "${name}" but ${ws}/package.json does not declare it`);
      } else if (prod.has(name) || !isRuntimeOnly(rel)) {
        if (!prod.has(name) && !name.startsWith('@types/')) {
          problems.push(
            `${rel}: imports "${name}" at runtime but it is only a devDependency — ` +
              `it will be missing from a production (--omit=dev) install`,
          );
        }
      }
    }
  }
}

/**
 * Test files and build-time scripts may legitimately use dev dependencies.
 * Application source may not.
 */
/**
 * Remove template-literal contents before scanning for imports.
 *
 * `scripts/smoke-web.mjs` generates a module as a string; its `import`s are
 * code that will be bundled elsewhere, not dependencies of that script. Without
 * this, the guard reports three false positives and gets switched off — which
 * is how real guards die.
 */
function stripTemplateLiterals(src) {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      depth += 1;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '`') {
          depth = Math.max(0, depth - 1);
          i += 1;
          break;
        }
        i += 1;
      }
      out += '``';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isRuntimeOnly(rel) {
  return rel.includes(`${path.sep}test${path.sep}`) || rel.includes('.test.');
}

// Sanity: the import surface must be resolvable on disk right now.
//
// Resolution is per workspace, not per repository. `apps/web` is deliberately not an npm
// workspace member — that is what stops its install from deleting the API's dependencies —
// so it has its own node_modules, and resolving a web import from the repo root would
// look in the wrong tree. The path is anchored with pathToFileURL because a bare specifier
// given to import.meta.resolve is resolved relative to *this guard's* URL; an absolute
// directory only filesystem-resolves if it is a file: URL.
for (const [name, rel] of seen) {
  if (BUILTINS.has(name)) continue;
  const owner = rel.startsWith('apps/web/') ? path.join(ROOT, 'apps/web') : ROOT;
  // Checked on disk rather than with import.meta.resolve: under Node 22 that function
  // ignores the parent argument and resolves relative to this guard's own file, which
  // collapses both workspaces onto the repo root. A missing package directory is exactly
  // the failure this catches — `pg` was absent from a `--omit=dev` install and the image
  // crashed on boot.
  const installed = fs.existsSync(path.join(owner, 'node_modules', name, 'package.json'));
  if (!installed) {
    problems.push(
      `${rel}: "${name}" is declared/imported but not installed in ` +
        `${owner === ROOT ? 'the repo root' : 'apps/web'} ` +
        `(run ${owner === ROOT ? 'npm ci' : 'npm run install:web'})`,
    );
  }
}

// Root-level tooling dependencies used by scripts/ are checked too.
for (const file of walk(path.join(ROOT, 'scripts'))) {
  const source = stripTemplateLiterals(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(ROOT, file);
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    const name = pkgName(spec);
    if (BUILTINS.has(name)) continue;
    const declared = new Set([
      ...Object.keys(rootPkg.dependencies ?? {}),
      ...Object.keys(rootPkg.devDependencies ?? {}),
    ]);
    if (!declared.has(name)) problems.push(`${rel}: imports "${name}" but the root package.json does not declare it`);
  }
}

if (problems.length) {
  console.error('✗ Dependency guard failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ Dependency guard passed — ${seen.size} runtime packages imported, all declared as dependencies.`);
