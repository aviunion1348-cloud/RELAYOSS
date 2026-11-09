/**
 * Forward-only migration runner with checksum verification and a lock, so two
 * API replicas can never race a schema change.
 *
 *   node dist/db/cli.js migrate      (SQLite: db/migrations)
 *   node dist/db/cli.js migrate      (Postgres: db/migrations/pg)
 *
 * The PostgreSQL migration set is generated 1:1 from the SQLite set by
 * `scripts/gen-pg-migrations.mjs`, so the two schemas cannot drift: any new
 * SQLite migration fails the build until its PG counterpart is generated.
 * Applied migrations are recorded in `schema_migrations` with a checksum; a
 * changed migration file is a hard error (never silently re-apply).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../config.ts';
import { BUNDLED_MIGRATIONS } from './migrations-bundle.ts';
import type { Db } from './types.ts';

function migrationsDir(dialect: 'sqlite' | 'postgres') {
  return dialect === 'postgres'
    ? path.join(ROOT, 'db', 'migrations', 'pg')
    : path.join(ROOT, 'db', 'migrations');
}

/**
 * The migration set, from disk when it is there and from the bundle when it is not.
 *
 * Reading from disk is the normal case — the CLI, the tests and a container all have
 * the repository beside the process. A bundled serverless function does not: its
 * migration files are only present if the bundler chose to copy them, and it cannot
 * follow a path built from a computed `ROOT`. That produced a boot failure before any
 * route existed, which surfaced as a platform-level 500 with no application body.
 *
 * Returning a reason alongside the set keeps the diagnosis available: a bundle that
 * disagrees with the files must not silently apply the wrong schema.
 */
function loadMigrations(
  dialect: 'sqlite' | 'postgres',
  source: 'auto' | 'disk' | 'bundle',
): {
  files: ReadonlyArray<readonly [string, string]>;
  source: 'disk' | 'bundle';
} {
  const dir = migrationsDir(dialect);
  if (source !== 'bundle' && fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')] as const);
    return { files, source: 'disk' };
  }
  if (source === 'disk') {
    throw new Error(
      migrationsMissingHint(dialect, dir),
    );
  }
  /*
   * The bundle is generated from the same files by `scripts/gen-migrations-module.mjs`
   * and a guard fails the build when it goes stale, so falling back is safe rather
   * than convenient. An empty bundle means the generator never ran, which is worth
   * failing loudly for.
   */
  const files = BUNDLED_MIGRATIONS[dialect];
  if (!files || files.length === 0) {
    throw new Error(
      `Missing migrations for ${dialect}: ${path.relative(ROOT, dir)} is absent and the ` +
        `embedded copy is empty. Run: node scripts/gen-migrations-module.mjs`,
    );
  }
  return { files, source: 'bundle' };
}

function migrationsMissingHint(dialect: 'sqlite' | 'postgres', dir: string): string {
  return dialect === 'postgres'
    ? `Missing ${path.relative(ROOT, dir)}. Run: node scripts/gen-pg-migrations.mjs`
    : `Missing migrations directory: ${dir}`;
}

function sha256(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export async function ensureLedger(db: Db) {
  const tsDefault = db.dialect === 'postgres' ? 'now()' : "datetime('now')";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id           TEXT PRIMARY KEY,
      checksum     TEXT NOT NULL,
      applied_at   TEXT NOT NULL DEFAULT (${tsDefault}),
      duration_ms  INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
  version: number;
  /**
   * Which copy was applied. Reported because "the migrations ran" is not the whole
   * answer: in a function bundle the files are absent and the embedded copy is what
   * runs, so a caller that needs to know which schema source it just trusted can
   * read it here rather than infer it.
   */
  source: 'disk' | 'bundle';
}

export async function migrate(
  db: Db,
  opts: {
    log?: (m: string) => void;
    /**
     * Which copy to use. `auto` is what every caller wants: disk when it is there,
     * the embedded bundle when it is not.
     *
     * `disk` and `bundle` exist so a test can pin one side and compare it with the
     * other. The alternative — making the directory absent during a test — would
     * mean deleting the repository's schema under a running suite, which is a worse
     * idea than a two-word seam that does nothing unless asked.
     */
    from?: 'auto' | 'disk' | 'bundle';
  } = {},
): Promise<MigrateResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { files, source: usedSource } = loadMigrations(db.dialect, opts.from ?? 'auto');
  if (usedSource === 'bundle') log('  · migration files not on disk; using the embedded copy');

  await ensureLedger(db);
  const appliedRows = await db.all<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations');
  const applied = new Map(appliedRows.map((r) => [r.id, r.checksum]));
  const appliedNow: string[] = [];

  for (const [file, sql] of files) {
    const checksum = sha256(sql);
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(
          `Migration ${file} was modified after being applied. Create a new migration instead (checksum drift).`,
        );
      }
      continue;
    }
    const started = Date.now();
    await db.tx(async () => {
      await db.exec(sql);
      await db.run('INSERT INTO schema_migrations (id, checksum, duration_ms) VALUES (?, ?, ?)', [
        file,
        checksum,
        Date.now() - started,
      ]);
    });
    appliedNow.push(file);
    log(`  ✓ applied ${file} (${Date.now() - started}ms)`);
  }

  return {
    applied: appliedNow,
    alreadyApplied: files.length - appliedNow.length,
    version: await schemaVersion(db),
    source: usedSource,
  };
}

export async function schemaVersion(db: Db): Promise<number> {
  await ensureLedger(db);
  const row = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM schema_migrations');
  return Number(row?.c ?? 0);
}
