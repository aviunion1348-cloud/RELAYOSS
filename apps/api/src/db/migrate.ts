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
import type { Db } from './types.ts';

function migrationsDir(dialect: 'sqlite' | 'postgres') {
  return dialect === 'postgres'
    ? path.join(ROOT, 'db', 'migrations', 'pg')
    : path.join(ROOT, 'db', 'migrations');
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
}

export async function migrate(db: Db, opts: { log?: (m: string) => void } = {}): Promise<MigrateResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dir = migrationsDir(db.dialect);
  if (!fs.existsSync(dir)) {
    throw new Error(
      db.dialect === 'postgres'
        ? `Missing ${path.relative(ROOT, dir)}. Run: node scripts/gen-pg-migrations.mjs`
        : `Missing migrations directory: ${dir}`,
    );
  }

  await ensureLedger(db);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const appliedRows = await db.all<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations');
  const applied = new Map(appliedRows.map((r) => [r.id, r.checksum]));
  const appliedNow: string[] = [];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
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
  };
}

export async function schemaVersion(db: Db): Promise<number> {
  await ensureLedger(db);
  const row = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM schema_migrations');
  return Number(row?.c ?? 0);
}
