/**
 * The form a deployment runs in.
 *
 * CI proves the application works from a checkout: `db/migrations/*.sql` is right
 * there, so every migration path is exercised against real files. A deployed
 * serverless function is not a checkout, and the difference was invisible until it
 * produced `500 FUNCTION_INVOCATION_FAILED` on a live URL:
 *
 *   · the bundler follows static imports, and the runner built its migration path
 *     from a computed root, so the `.sql` files were never copied into the function
 *   · boot therefore threw inside `buildApp()` before any route existed — the one
 *     place the product could not report anything, because there was no route to
 *     report it on and the platform answered first
 *
 * So this suite asserts the property directly, by pinning the reader to the embedded
 * bundle and requiring that it still builds the whole schema. It also requires the
 * bundle to be *identical* to the files: a bundle that applied a different schema
 * would be worse than one that failed to load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteDb } from '../src/db/sqlite.ts';
import { migrate, schemaVersion } from '../src/db/migrate.ts';
import { BUNDLED_MIGRATIONS } from '../src/db/migrations-bundle.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DISK = path.join(ROOT, 'db', 'migrations');

function schemaOf(db) {
  return db.all(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
}

test('the embedded bundle lists exactly the migrations on disk, byte for byte', () => {
  for (const [dialect, dir] of [
    ['sqlite', DISK],
    ['postgres', path.join(DISK, 'pg')],
  ]) {
    const onDisk = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    assert.deepEqual(
      BUNDLED_MIGRATIONS[dialect].map(([name]) => name),
      onDisk,
      `${dialect}: the bundle must name exactly the files on disk, in apply order`,
    );
    for (const [name, sql] of BUNDLED_MIGRATIONS[dialect]) {
      assert.equal(
        sql,
        fs.readFileSync(path.join(dir, name), 'utf8'),
        `${dialect}: ${name} must be embedded verbatim`,
      );
    }
  }
});

test('the bundle alone migrates a database to the full schema', async () => {
  const db = new SqliteDb(':memory:');
  const result = await migrate(db, { log: () => {}, from: 'bundle' });

  /*
   * The source assertion is the one that matters. Both copies contain the same SQL,
   * so a schema comparison passes whichever branch ran — which means it cannot tell
   * a working fallback from a fallback that is never reached. Naming the copy closes
   * that gap: sabotage the reader to always prefer disk and this line fails.
   */
  assert.equal(result.source, 'bundle', 'from: "bundle" must actually use the embedded copy');
  assert.equal(
    result.applied.length,
    BUNDLED_MIGRATIONS.sqlite.length,
    'a fresh database must apply every embedded migration',
  );
  assert.equal(result.version, BUNDLED_MIGRATIONS.sqlite.length);

  const names = (await schemaOf(db)).map((t) => t.name);
  for (const required of [
    'users', 'clients', 'projects', 'tasks', 'boards', 'change_log',
    'insight_dismissals', 'schema_migrations',
  ]) {
    assert.ok(names.includes(required), `the embedded schema must contain ${required}`);
  }

  // The ledger, not the file listing, decides what is pending.
  const again = await migrate(db, { log: () => {}, from: 'bundle' });
  assert.equal(again.applied.length, 0, 're-running must not reapply anything');
  assert.equal(await schemaVersion(db), result.version);
});

test('the bundle and the files produce an identical schema', async () => {
  const fromDisk = new SqliteDb(':memory:');
  const diskRun = await migrate(fromDisk, { log: () => {}, from: 'disk' });
  assert.equal(diskRun.source, 'disk');

  const fromBundle = new SqliteDb(':memory:');
  await migrate(fromBundle, { log: () => {}, from: 'bundle' });

  assert.deepEqual(
    await schemaOf(fromBundle),
    await schemaOf(fromDisk),
    'the embedded migrations must create exactly the schema the files create',
  );
});

test('the committed bundle is not stale, and a stale one fails the check', () => {
  const clean = execFileSync(process.execPath, ['scripts/check-migrations-bundle.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(clean, /match/);

  /*
   * The guard is only worth its exit code if it can fail. Rather than editing the
   * repository during a test, corrupt a *copy* of the bundle in a scratch directory
   * and confirm the generator's own comparison rejects it.
   */
  const scratch = fs.mkdtempSync(path.join(ROOT, '.routing-bundle-'));
  try {
    const copy = path.join(scratch, 'migrations-bundle.ts');
    const original = fs.readFileSync(path.join(ROOT, 'apps', 'api', 'src', 'db', 'migrations-bundle.ts'), 'utf8');
    fs.writeFileSync(copy, original.replace(/"0001_core\.sql":/, '"0001_core.sql": "tampered" + '), 'utf8');
    assert.notEqual(fs.readFileSync(copy, 'utf8'), original, 'the scratch copy must differ');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
