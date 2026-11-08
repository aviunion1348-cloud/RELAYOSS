/**
 * Backup, restore and recovery evidence (R63/R64).
 *
 * A backup is a claim, and the claim worth testing is not "a file was written" —
 * it is "this file restores to the same data". So this suite:
 *
 *   - takes a real backup of a real migrated database
 *   - verifies its checksum manifest
 *   - restores it into a fresh database and compares row counts table by table
 *   - proves a corrupted archive is detected rather than silently accepted
 *   - proves retention keeps long-range restore points while dropping noise
 *   - reports PITR honestly: BLOCKED where the server cannot do it, and never
 *     AVAILABLE on the strength of a configuration string alone
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { SqliteDb } = await import(`${ROOT}/apps/api/src/db/sqlite.ts`);
const { migrate } = await import(`${ROOT}/apps/api/src/db/migrate.ts`);
const backupOps = await import(`${ROOT}/scripts/backup-ops.mjs`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-backup-'));
after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* removed */ }
});

/** A populated database, written to disk so a backup can read it. */
async function makeSource(file) {
  const db = new SqliteDb(file);
  await migrate(db, { log: () => {} });
  await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u1','a@x.io','Ada','admin','AD')");
  await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
  await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p1','ACM','Acme','c1')");
  await db.run("INSERT INTO boards (id,project_id,name) VALUES ('b1','p1','Delivery')");
  await db.run("INSERT INTO columns (id,board_id,key,name,position,is_done) VALUES ('b1_todo','b1','todo','Ready',0,0)");
  for (let i = 0; i < 25; i += 1) {
    await db.run(
      "INSERT INTO tasks (id,key,title,board_id,column_id,project_id) VALUES (?,?,?,?,?,?)",
      [`t${i}`, `ACM-${i}`, `Task ${i}`, 'b1', 'b1_todo', 'p1'],
    );
  }
  const counts = await tableCounts(db);
  await db.close();
  return counts;
}

async function tableCounts(db) {
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = {};
  for (const t of tables) {
    const row = await db.get(`SELECT COUNT(*) AS c FROM "${t.name}"`);
    if (Number(row.c) > 0) out[t.name] = Number(row.c);
  }
  return out;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup.mjs'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
}

test('backup: the restore drill proves every table and row comes back', async () => {
  const source = path.join(dir, 'source.sqlite');
  const expected = await makeSource(source);

  // `drill` is the real test: back up, restore into a scratch database, and
  // compare the row count of every table. Comparing table *names* would pass on
  // an archive of empty tables.
  const drilled = run(['drill', '--dir', dir], { DB_PATH: source });
  assert.equal(drilled.status, 0, drilled.stderr || drilled.stdout);
  assert.match(drilled.stdout, /restore drill: \d+ tables and \d+ rows identical/);
  assert.match(drilled.stdout, /integrity ok/);

  // And the numbers it compared are the numbers the fixture wrote.
  const rows = Number(/and (\d+) rows identical/.exec(drilled.stdout)?.[1] ?? 0);
  const expectedRows = Object.values(expected).reduce((a, b) => a + b, 0);
  assert.equal(rows, expectedRows, 'the drill must have compared every row the fixture created');
  assert.ok(expected.tasks === 25);
});

test('backup: a backup archive carries the full schema at the current version', async () => {
  const source = path.join(dir, 'schema.sqlite');
  await makeSource(source);
  const res = run(['backup', '--dir', dir], { DB_PATH: source });
  assert.equal(res.status, 0, res.stderr);
  const archived = fs.readdirSync(dir).filter((f) => /^relay-.*\.sqlite$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f;

  const verified = run(['verify', path.join(dir, archived)]);
  assert.equal(verified.status, 0, verified.stderr);
  // The archive must be at the same migration version as the source, or a restore
  // would silently regress the schema. The expected version is read from the
  // migrations directory rather than hardcoded: pinning the literal made this test
  // fail on every new migration, which trains people to update the number instead
  // of noticing a real drift.
  const expectedVersion = fs
    .readdirSync(path.join(ROOT, 'db', 'migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
  assert.match(
    verified.stdout,
    new RegExp(`schema version ${expectedVersion}\\b`),
    `the archive must be at schema version ${expectedVersion}`,
  );
  assert.match(verified.stdout, /integrity ok/);
});

test('backup: the manifest proves the archive has not been altered', async () => {
  const source = path.join(dir, 'm.sqlite');
  await makeSource(source);
  const taken = run(['backup', '--dir', dir], { DB_PATH: source });
  assert.equal(taken.status, 0, taken.stderr);

  const archive = fs.readdirSync(dir)
    .filter((f) => /^relay-.*\.sqlite$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f;
  const file = path.join(dir, archive);

  const manifest = backupOps.writeManifest(file);
  assert.ok(manifest.hash.length === 64, 'a full SHA-256 must be recorded');

  const clean = backupOps.verifyManifest(file);
  assert.equal(clean.ok, true, 'an untouched archive must verify');

  // Alter one byte and the manifest must catch it.
  const original = fs.readFileSync(file);
  const corrupted = Buffer.from(original);
  corrupted[0] = corrupted[0] ^ 0xff;
  fs.writeFileSync(file, corrupted);
  const broken = backupOps.verifyManifest(file);
  assert.equal(broken.ok, false, 'an altered archive must not verify');
  assert.match(broken.reason, /checksum mismatch/i);
  fs.writeFileSync(file, original);
  assert.equal(backupOps.verifyManifest(file).ok, true, 'restoring the bytes restores the proof');
});

test('backup: an archive with no manifest is not reported as verified', () => {
  const bare = path.join(dir, 'bare.sqlite');
  fs.writeFileSync(bare, Buffer.from('not really a database'));
  const result = backupOps.verifyManifest(bare);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no manifest/i, 'without a manifest there is no proof, and it must say so');
});

test('backup: retention keeps the newest backup and every long-range restore point', () => {
  const retentionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retention-'));
  try {
    // 40 daily backups, one per day, written with descending mtimes.
    const now = Date.now();
    for (let i = 0; i < 40; i += 1) {
      const file = path.join(retentionDir, `relay-${i}.sqlite`);
      fs.writeFileSync(file, `backup ${i}`);
      const when = new Date(now - i * 86_400_000);
      fs.utimesSync(file, when, when);
    }
    const result = backupOps.applyRetention(retentionDir);
    const remaining = fs.readdirSync(retentionDir);

    // The newest N days always survive.
    assert.ok(remaining.includes('relay-0.sqlite'), 'the newest backup is never removed');
    assert.ok(remaining.includes(`relay-${backupOps.RETENTION.keepDaily - 1}.sqlite`), 'the daily window is kept whole');
    // And something from far back survives as a weekly/monthly restore point —
    // the point of tiering rather than deleting by age.
    assert.ok(remaining.length > backupOps.RETENTION.keepDaily, 'long-range restore points must be kept, not just the daily window');
    assert.ok(result.removed.length > 0, 'older noise is removed');
    assert.equal(result.kept, remaining.length);
  } finally {
    fs.rmSync(retentionDir, { recursive: true, force: true });
  }
});

test('recovery: PITR is reported as blocked rather than pretended on this engine', () => {
  // This suite runs against SQLite, where continuous archiving does not exist.
  const pitr = backupOps.pitrStatus(false, false);
  assert.equal(pitr.available, false);
  assert.equal(pitr.verdict, 'NOT_APPLICABLE');
  assert.match(pitr.reason, /recovery point objective/i, 'the limitation must state what it means for RPO');

  // For PostgreSQL the answer depends on the server, and an unverifiable server
  // is BLOCKED with the exact requirements named — never AVAILABLE by default.
  const pg = backupOps.pitrStatus(true, false);
  assert.equal(pg.verdict, 'BLOCKED');
  assert.ok(pg.requirements.some((r) => /archive_mode/i.test(r)), 'the missing server setting must be named');
});

test('recovery: the environment report never claims a capability it lacks', () => {
  const status = backupOps.environmentStatus();
  assert.ok(['sqlite', 'postgres'].includes(status.engine));
  assert.equal(typeof status.localBackupPossible, 'boolean');
  // If a binary is missing, it is listed; if nothing is missing, the list is empty.
  assert.ok(Array.isArray(status.missing));
  assert.equal(status.localBackupPossible, status.missing.length === 0);
  // PITR always carries a verdict and a reason, never a bare boolean.
  assert.ok(status.pitr.verdict);
  assert.ok(status.pitr.reason);
  if (!status.pitr.available) {
    assert.ok(['BLOCKED', 'NOT_APPLICABLE'].includes(status.pitr.verdict));
  }
});
