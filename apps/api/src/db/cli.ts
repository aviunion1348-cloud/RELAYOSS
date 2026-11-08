/**
 * Operational CLI:
 *   node src/db/cli.ts migrate   # forward-only schema migrations
 *   node src/db/cli.ts seed      # idempotent demo data
 *   node src/db/cli.ts reset     # drop the file, migrate, seed
 *   node src/db/cli.ts status    # schema version + row counts
 */
import fs from 'node:fs';
import { config } from '../config.ts';
import { Db, setDb } from './index.ts';
import { migrate, schemaVersion } from './migrate.ts';
import { seed } from './seed.ts';

const cmd = process.argv[2] ?? 'migrate';

if (cmd === 'reset') {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = config.dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  console.log(`• dropped ${config.dbPath}`);
}

const db = new Db(config.dbPath);
setDb(db);

if (cmd === 'migrate' || cmd === 'reset') {
  console.log('• migrating');
  migrate(db);
}
if (cmd === 'seed' || cmd === 'reset') {
  console.log('• seeding');
  seed(db);
}
if (cmd === 'status') {
  const version = schemaVersion(db);
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  console.log(`schema version: ${version}`);
  for (const t of tables) {
    const c = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM "${t.name}"`);
    console.log(`  ${t.name.padEnd(24)} ${String(c?.c ?? 0).padStart(6)}`);
  }
}
db.close();
