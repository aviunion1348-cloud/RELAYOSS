/**
 * Operational CLI (works against either engine):
 *
 *   node dist/db/cli.js migrate   # forward-only schema migrations
 *   node dist/db/cli.js seed      # idempotent demo data
 *   node dist/db/cli.js reset     # recreate + migrate + seed (destructive)
 *   node dist/db/cli.js status    # schema version + row counts
 *
 * With `DATABASE_URL` set it targets PostgreSQL; otherwise the local SQLite
 * file. `reset` refuses to run against a host that is not local unless
 * `ALLOW_REMOTE_RESET=1`, because "drop the production database" should never
 * be one typo away.
 */
import fs from 'node:fs';
import pg from 'pg';
import { config } from '../config.ts';
import { createDb, setDb } from './index.ts';
import { migrate, schemaVersion } from './migrate.ts';
import { seed } from './seed.ts';

const cmd = process.argv[2] ?? 'migrate';

function isRemote(url: string) {
  try {
    const host = new URL(url).hostname;
    return !['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host);
  } catch {
    return true;
  }
}

if (cmd === 'reset') {
  if (config.databaseUrl) {
    if (isRemote(config.databaseUrl) && process.env.ALLOW_REMOTE_RESET !== '1') {
      console.error('✗ refusing to reset a remote database (set ALLOW_REMOTE_RESET=1 to override)');
      process.exit(1);
    }
    const url = new URL(config.databaseUrl);
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const adminUrl = new URL(config.databaseUrl);
    adminUrl.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    console.log(`• recreated database ${dbName}`);
  } else {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = config.dbPath + suffix;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    console.log(`• dropped ${config.dbPath}`);
  }
}

const db = createDb();
setDb(db);

try {
  console.log(`• engine: ${db.dialect}${config.databaseUrl ? '' : ` (${config.dbPath})`}`);

  if (cmd === 'migrate' || cmd === 'reset') {
    console.log('• migrating');
    const result = await migrate(db);
    if (!result.applied.length) console.log(`  ✓ already up to date (version ${result.version})`);
  }
  if (cmd === 'seed' || cmd === 'reset') {
    console.log('• seeding');
    await seed(db);
  }
  if (cmd === 'status') {
    const version = await schemaVersion(db);
    console.log(`schema version: ${version}`);
    const tables = db.dialect === 'postgres'
      ? await db.all<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        )
      : await db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
    for (const t of tables) {
      const c = await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM "${t.name}"`);
      console.log(`  ${t.name.padEnd(24)} ${String(c?.c ?? 0).padStart(6)}`);
    }
  }
  if (!['migrate', 'seed', 'reset', 'status'].includes(cmd)) {
    console.error(`Unknown command: ${cmd}. Use migrate | seed | reset | status`);
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
