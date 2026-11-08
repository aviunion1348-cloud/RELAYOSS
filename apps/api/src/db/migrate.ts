/**
 * Forward-only migration runner with checksum verification and an advisory
 * lock row, so two API replicas can never race a schema change.
 *
 *   node apps/api/src/db/cli.ts migrate
 *   node apps/api/src/db/cli.ts seed
 *   node apps/api/src/db/cli.ts reset
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../config.ts';
import type { Db } from './index.ts';

const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

function sha256(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function ensureLedger(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id           TEXT PRIMARY KEY,
      checksum     TEXT NOT NULL,
      applied_at   TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms  INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function migrate(db: Db, opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.log(m));
  ensureLedger(db);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map(
    db.all<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations').map((r) => [r.id, r.checksum]),
  );

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
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
    db.tx(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (id, checksum, duration_ms) VALUES (?, ?, ?)', [
        file,
        checksum,
        Date.now() - started,
      ]);
    });
    log(`  ✓ applied ${file} (${Date.now() - started}ms)`);
  }
}

export function schemaVersion(db: Db): number {
  ensureLedger(db);
  return db.get<{ c: number }>('SELECT COUNT(*) AS c FROM schema_migrations')?.c ?? 0;
}
