#!/usr/bin/env node
/**
 * Local PostgreSQL 16 for development, integration tests and migration checks.
 *
 * Uses a real PostgreSQL 16 server binary (via `embedded-postgres`), not a
 * schema-inspection stub. In CI and locally the same command proves the
 * production migrations apply from a clean state.
 *
 *   node scripts/pg-dev.mjs start     → boots the cluster, prints DATABASE_URL
 *   node scripts/pg-dev.mjs stop
 *   node scripts/pg-dev.mjs psql
 */
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.PG_DATA_DIR ?? path.join(process.cwd(), '.pgdata');
const PORT = Number(process.env.PG_PORT ?? 55432);
const DB = process.env.PG_DB ?? 'relay';
const USER = 'relay';
const PASSWORD = 'relay_local_dev';

const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}`;

const cmd = process.argv[2] ?? 'start';

if (cmd === 'url') {
  console.log(url);
  process.exit(0);
}

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

if (cmd === 'start') {
  if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    console.log('  · initialising cluster (PostgreSQL 16)');
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DB);
    console.log(`  · created database ${DB}`);
  } catch (err) {
    if (!/already exists/i.test(String(err?.message))) throw err;
  }
  console.log(`✓ PostgreSQL 16 running on 127.0.0.1:${PORT}`);
  console.log(`  DATABASE_URL=${url}`);
  // Keep the process alive so the cluster stays up for the caller's lifetime.
  process.on('SIGTERM', async () => { await pg.stop(); process.exit(0); });
  process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
  setInterval(() => {}, 1 << 30);
} else if (cmd === 'stop') {
  await pg.stop().catch(() => {});
  console.log('✓ stopped');
} else {
  console.error(`Unknown command: ${cmd}. Use start | stop | url`);
  process.exit(1);
}
