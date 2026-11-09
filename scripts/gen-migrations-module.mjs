#!/usr/bin/env node
/**
 * Embed the migration SQL into a module the bundler can see.
 *
 * The migration runner reads `db/migrations/*.sql` from disk at boot. That is fine
 * for a container, where the repository is on disk next to the process, and it is
 * fatal for a bundled serverless function, where it is not:
 *
 *   · Vercel's file tracer follows *static* imports and literal paths. The runner
 *     builds its path from `ROOT` with `path.join(ROOT, 'db', 'migrations', 'pg')`,
 *     which is opaque to that analysis, so the `.sql` files are never included in
 *     the function bundle.
 *   · The failure then happens inside `buildApp()` before any route exists, which
 *     is the one moment the product could not previously report anything — the
 *     platform answered `500 FUNCTION_INVOCATION_FAILED` with no application body
 *     at all.
 *
 * Embedding the SQL as a generated TypeScript module makes the dependency a real
 * import, so it is bundled the same way every other module is. Nothing about
 * *when* migrations run changes: the runner still applies them at boot, still
 * verifies checksums, and still refuses a migrated-then-modified file.
 *
 * Reading from disk stays the default wherever the files are actually present, so
 * the CLI, the tests and a container all keep exercising the real files. The
 * embedded copy is the fallback, and `--check` fails the build when it is stale.
 *
 * Usage:  node scripts/gen-migrations-module.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE = path.join(ROOT, 'db', 'migrations');
const POSTGRES = path.join(SQLITE, 'pg');
const OUT = path.join(ROOT, 'apps', 'api', 'src', 'db', 'migrations-bundle.ts');

function collect(dir, label) {
  if (!fs.existsSync(dir)) {
    throw new Error(`${label} migration directory is missing: ${path.relative(ROOT, dir)}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`${label} migration directory is empty`);
  return files.map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]);
}

function render(sqlite, postgres) {
  const entries = (list) =>
    list
      .map(([file, sql]) => `    ${JSON.stringify(file)}: ${JSON.stringify(sql)},`)
      .join('\n');

  return `/**
 * GENERATED FILE — do not edit. Regenerate with: node scripts/gen-migrations-module.mjs
 *
 * The migration SQL, embedded so a bundled serverless function carries it.
 *
 * The runner normally reads \`db/migrations\` from disk. A bundler cannot follow a
 * path built from a computed root, so in a function bundle those files are absent
 * and the boot fails before any route exists. This module makes the dependency a
 * static import, which is what the bundler can see.
 *
 * It is generated from the same files the disk reader uses, and
 * \`scripts/check-migrations-bundle.mjs\` (run by \`npm run guard\`) fails when the two
 * disagree, so this cannot drift from the schema it claims to be.
 */
export const BUNDLED_MIGRATIONS: Readonly<Record<'sqlite' | 'postgres', ReadonlyArray<readonly [string, string]>>> = {
  sqlite: Object.entries({
${entries(sqlite)}
  }),
  postgres: Object.entries({
${entries(postgres)}
  }),
};
`;
}

const sqlite = collect(SQLITE, 'SQLite');
const postgres = collect(POSTGRES, 'PostgreSQL');
const rendered = render(sqlite, postgres);

const check = process.argv.includes('--check');
const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

if (check) {
  if (existing !== rendered) {
    console.error(
      '✗ apps/api/src/db/migrations-bundle.ts is stale. ' +
        'Run: node scripts/gen-migrations-module.mjs',
    );
    process.exit(1);
  }
  console.log(`✓ migrations bundle in sync (${sqlite.length} SQLite, ${postgres.length} PostgreSQL)`);
} else {
  fs.writeFileSync(OUT, rendered, 'utf8');
  console.log(
    `✓ embedded ${sqlite.length} SQLite and ${postgres.length} PostgreSQL migrations ` +
      `into ${path.relative(ROOT, OUT)}`,
  );
}
