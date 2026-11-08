#!/usr/bin/env node
/**
 * CI guard: the product must never regress to a JSON file posing as a database.
 *
 * Fails if:
 *  - a `db.json` / `database.json` / `data.json` style store exists anywhere
 *  - application code writes state to fs (readFileSync of .json used as a store)
 *  - a package.json declares lowdb/node-json-db/json-server/jsonfile-db
 *
 * Run in CI and as a pre-commit hook:  node scripts/guard-no-json-store.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.smoke', 'data']);
const BAD_FILENAMES = [/^(db|database|datastore|mock-db|server-db)\.json$/i, /^(db|database)\.json$/i];
const BAD_PACKAGES = ['lowdb', 'node-json-db', 'json-server', 'file-system-db', 'jsonfile-db', 'simple-json-db'];
const BAD_CODE = [
  /\bwriteFileSync\s*\([^)]*\.json/,
  /\brequire\(['"](?:lowdb|node-json-db)['"]\)/,
  /\bfrom\s+['"](?:lowdb|node-json-db)['"]/,
];

const problems = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (BAD_FILENAMES.some((re) => re.test(entry.name))) {
      problems.push(`${rel}: JSON file masquerading as a database`);
      continue;
    }
    if (entry.name === 'package.json') {
      const pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const bad of BAD_PACKAGES) {
        if (deps[bad]) problems.push(`${rel}: depends on "${bad}" — use the relational store instead`);
      }
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
    const src = fs.readFileSync(full, 'utf8');
    for (const re of BAD_CODE) {
      if (re.test(src)) problems.push(`${rel}: JSON file used as application state (${re})`);
    }
  }
}

walk(ROOT);

if (problems.length) {
  console.error('✗ Architecture guard failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('✓ Architecture guard passed — no JSON-file data store, no JSON-db dependencies.');
