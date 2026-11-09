#!/usr/bin/env node
/**
 * Fail the build when the embedded migration copy drifts from the SQL files.
 *
 * `apps/api/src/db/migrations-bundle.ts` exists because a bundled serverless function
 * cannot read `db/migrations` from disk — the file tracer cannot follow a path built
 * from a computed root. The copy is only safe while it is *identical* to the files it
 * mirrors, so this check compares them and refuses to pass on any difference:
 *
 *   · a migration added without regenerating  → the deployed schema is incomplete
 *   · a migration edited without regenerating → the deployed schema is different
 *   · a migration deleted without regenerating → a phantom migration reapplies
 *
 * Any of those would make a deployment run a schema nobody reviewed, which is far
 * worse than a build failure. The remedy is always the same one command.
 *
 * Usage:  node scripts/check-migrations-bundle.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE = path.join(ROOT, 'db', 'migrations');
const POSTGRES = path.join(SQLITE, 'pg');
const BUNDLE = path.join(ROOT, 'apps', 'api', 'src', 'db', 'migrations-bundle.ts');

function read(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
}

if (!fs.existsSync(BUNDLE)) {
  console.error('✗ apps/api/src/db/migrations-bundle.ts is missing. Run: node scripts/gen-migrations-module.mjs');
  process.exit(1);
}

const source = fs.readFileSync(BUNDLE, 'utf8');
const problems = [];

/*
 * Compare against the *generator's* output rather than scanning the bundle for
 * strings: a substring test would pass for a file whose content was appended to
 * (the original still appears) and would miss reordering. Regenerating in memory and
 * comparing whole representations is the only check that cannot be fooled.
 */
const { execFileSync } = await import('node:child_process');
try {
  execFileSync(process.execPath, ['scripts/gen-migrations-module.mjs', '--check'], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
} catch (err) {
  problems.push(String(err?.stderr || err?.message || err).trim());
}

for (const [label, dir] of [['SQLite', SQLITE], ['PostgreSQL', POSTGRES]]) {
  const files = read(dir);
  for (const [file, sql] of files) {
    if (!source.includes(JSON.stringify(file))) {
      problems.push(`${label} migration ${file} is absent from the bundle`);
    }
    /*
     * The embedded value is a JSON string literal, so the file's own text does not
     * appear verbatim. Compare through the same encoding the generator uses.
     */
    if (!source.includes(JSON.stringify(sql))) {
      problems.push(`${label} migration ${file} content differs from the bundle`);
    }
  }
  // And nothing may be embedded that no longer exists on disk.
  const onDisk = new Set(files.map(([f]) => f));
  for (const m of source.matchAll(/"(\d{4}_[A-Za-z0-9_]+\.sql)":/g)) {
    if (!onDisk.has(m[1])) {
      problems.push(`the bundle embeds ${m[1]}, which no longer exists on disk`);
    }
  }
}

if (problems.length > 0) {
  console.error('✗ The embedded migration bundle is stale:');
  for (const p of [...new Set(problems)].slice(0, 20)) console.error(`    ${p}`);
  console.error('\n  Regenerate it with: node scripts/gen-migrations-module.mjs');
  process.exit(1);
}

console.log('✓ Embedded migrations match db/migrations exactly');
