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
  /**
   * Provision the shared login credential.
   *
   * Separate from `seed` on purpose: seeding makes demo data, this makes a real
   * credential. Running them together would mean a production seed silently
   * provisions a login, and a password reset would require re-seeding the
   * database.
   *
   * Reads RELAY_LOGIN_USERNAME and RELAY_ADMIN_PASSWORD_HASH from the environment
   * so the hash never appears in a command line (and therefore never in a process
   * listing or a shell history).
   */
  if (cmd === 'assign-login') {
    const username = process.env.RELAY_LOGIN_USERNAME ?? 'lear roadmap 289';
    const hash = process.env.RELAY_ADMIN_PASSWORD_HASH ?? '';
    const userId = process.env.RELAY_LOGIN_USER_ID ?? 'usr_owner';

    if (!hash) {
      console.error(
        'RELAY_ADMIN_PASSWORD_HASH is not set.\n' +
          'Generate one with `node scripts/set-password.mjs`, then run this command with both\n' +
          'RELAY_LOGIN_USERNAME and RELAY_ADMIN_PASSWORD_HASH in the environment.',
      );
      process.exitCode = 1;
    } else if (!hash.startsWith('$argon2id$')) {
      // Fail loudly on the wrong format rather than storing something that can
      // never verify — a credential that silently cannot work is worse than none.
      console.error('RELAY_ADMIN_PASSWORD_HASH must be an Argon2id hash beginning `$argon2id$`.');
      process.exitCode = 1;
    } else {
      // The identity must exist. It is created here if absent, with the admin role
      // the shared login is granted — and nothing else about it is invented.
      const existing = await db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [userId]);
      if (!existing) {
        await db.run(
          'INSERT INTO users (id, email, full_name, role, initials) VALUES (?,?,?,?,?)',
          [userId, process.env.RELAY_LOGIN_EMAIL ?? 'owner@relay.local', 'Relay Owner', 'admin', 'RO'],
        );
        console.log(`  ✓ created user ${userId} (admin)`);
      }

      const row = await db.get<{ id: string; version: number }>(
        'SELECT id, version FROM local_credentials WHERE username = ?',
        [username],
      );
      if (row) {
        // Rotation: bump the version so every existing session stops working.
        await db.run(
          'UPDATE local_credentials SET password_hash = ?, version = version + 1, updated_at = ?, disabled_at = NULL, user_id = ? WHERE id = ?',
          [hash, new Date().toISOString().slice(0, 19).replace('T', ' '), userId, row.id],
        );
        console.log(`  ✓ rotated credential for "${username}" (now version ${row.version + 1}; prior sessions invalidated)`);
      } else {
        await db.run(
          'INSERT INTO local_credentials (id, user_id, username, password_hash) VALUES (?,?,?,?)',
          [`cred_${Date.now().toString(36)}`, userId, username, hash],
        );
        console.log(`  ✓ provisioned credential for "${username}" → user ${userId}`);
      }
      // Confirm the row is readable and the hash is the one supplied. This is the
      // difference between "the command succeeded" and "the login will work".
      const check = await db.get<{ username: string; version: number; disabled_at: string | null }>(
        'SELECT username, version, disabled_at FROM local_credentials WHERE username = ?',
        [username],
      );
      console.log(
        check
          ? `  ✓ verified: username "${check.username}", version ${check.version}, ${check.disabled_at ? 'DISABLED' : 'enabled'}`
          : '  ✗ the credential could not be read back — do not deploy',
      );
      if (!check) process.exitCode = 1;
    }
  }

  if (!['migrate', 'seed', 'reset', 'status', 'assign-login'].includes(cmd)) {
    console.error(`Unknown command: ${cmd}. Use migrate | seed | reset | status | assign-login`);
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
