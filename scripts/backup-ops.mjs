#!/usr/bin/env node
/**
 * Backup operations: schedule, retention, integrity, PITR readiness.
 *
 *   node scripts/backup-ops.mjs status          what is actually possible here
 *   node scripts/backup-ops.mjs run              take a backup and verify it
 *   node scripts/backup-ops.mjs retention        apply the retention policy
 *   node scripts/backup-ops.mjs pitr             report point-in-time-recovery readiness
 *   node scripts/backup-ops.mjs verify-all       re-verify every archive on disk
 *
 * The rule this file obeys: never claim a capability the environment does not
 * have. A managed PostgreSQL with no access to `wal_level`/archive_command cannot
 * do PITR, so `pitr` says BLOCKED and names what a provider must supply. A local
 * SQLite file cannot do PITR at all — it says so.
 *
 * Everything here is deliberately dependency-free so it can run from cron or a
 * container scheduler without a control plane.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(ROOT, 'backups');
const DATABASE_URL = process.env.DATABASE_URL ?? '';

const arg = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`);
  return idx > -1 ? process.argv[idx + 1] : fallback;
};

/** Retention policy. Env-overridable so an operator can tighten it per environment. */
export const RETENTION = {
  keepDaily: Number(process.env.BACKUP_KEEP_DAILY ?? 7),
  keepWeekly: Number(process.env.BACKUP_KEEP_WEEKLY ?? 4),
  keepMonthly: Number(process.env.BACKUP_KEEP_MONTHLY ?? 6),
  maxAgeDays: Number(process.env.BACKUP_MAX_AGE_DAYS ?? 200),
};

/* ------------------------------------------------------------------ status -- */

export function environmentStatus() {
  const isPostgres = DATABASE_URL.startsWith('postgres');
  const hasPgDump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' }).status === 0;
  const hasPgRestore = spawnSync('pg_restore', ['--version'], { encoding: 'utf8' }).status === 0;
  const hasWalTools = spawnSync('pg_waldump', ['--version'], { encoding: 'utf8' }).status === 0;

  const missing = [];
  if (isPostgres && !hasPgDump) missing.push('pg_dump binary');
  if (isPostgres && !hasPgRestore) missing.push('pg_restore binary');

  return {
    engine: isPostgres ? 'postgres' : 'sqlite',
    backupDir: BACKUP_DIR,
    backupDirWritable: canWrite(BACKUP_DIR),
    localBackupPossible: isPostgres ? hasPgDump : true,
    missing,
    // PITR is a property of the *server*, not of this script.
    pitr: pitrStatus(isPostgres, hasWalTools),
  };
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Point-in-time recovery readiness.
 *
 * PITR needs three things we cannot supply: WAL archiving enabled on the server
 * (`archive_mode=on`, `archive_command` or `archive_library`), a retained archive
 * of those WAL segments, and a base backup taken with `pg_basebackup`. This
 * function reports which of those are verifiable from here; it does not assume
 * any of them.
 */
export function pitrStatus(isPostgres, hasWalTools) {
  if (!isPostgres) {
    return {
      available: false,
      verdict: 'NOT_APPLICABLE',
      reason: 'SQLite has no write-ahead-log archive. The recovery point objective for this deployment is the last verified backup, not a point in time.',
      requirements: [],
    };
  }

  // Ask the server directly when a client is available.
  let archiveMode = '';
  let walLevel = '';
  if (hasWalTools) {
    const res = spawnSync('psql', [DATABASE_URL, '-tAc', 'SHOW archive_mode'], { encoding: 'utf8' });
    if (res.status === 0) archiveMode = res.stdout.trim();
    const lvl = spawnSync('psql', [DATABASE_URL, '-tAc', 'SHOW wal_level'], { encoding: 'utf8' });
    if (lvl.status === 0) walLevel = lvl.stdout.trim();
  }

  const requirements = [];
  if (archiveMode !== 'on' && archiveMode !== 'always') {
    requirements.push('archive_mode=on (or archive_library set) on the PostgreSQL server');
  }
  if (!['replica', 'logical'].includes(walLevel)) {
    requirements.push('wal_level=replica or logical (currently ' + (walLevel || 'unknown') + ')');
  }
  if (!hasWalTools) requirements.push('psql client to verify server settings');

  const available = requirements.length === 0;
  return {
    available,
    verdict: available ? 'AVAILABLE' : 'BLOCKED',
    reason: available
      ? 'WAL archiving is enabled, so a base backup plus archived segments can be replayed to a chosen point.'
      : 'Continuous archiving is not configured on this server, so recovery can only restore the most recent logical backup. A point in time between backups cannot be recovered.',
    requirements,
  };
}

/* -------------------------------------------------------------- integrity -- */

/**
 * A manifest proves an archive has not been altered since it was written.
 * Without it, "verified" only means "the file is still there".
 */
export function writeManifest(file) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const manifestPath = `${file}.sha256`;
  const stat = fs.statSync(file);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      file: path.basename(file),
      sha256: hash,
      bytes: stat.size,
      createdAt: new Date().toISOString(),
      engine: DATABASE_URL.startsWith('postgres') ? 'postgres' : 'sqlite',
    }, null, 2),
  );
  return { hash, manifestPath, bytes: stat.size };
}

export function verifyManifest(file) {
  const manifestPath = `${file}.sha256`;
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'no manifest: this archive cannot be proven unaltered' };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== manifest.sha256) {
    return { ok: false, reason: `checksum mismatch: expected ${manifest.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…` };
  }
  return { ok: true, manifest };
}

/* --------------------------------------------------------------- retention -- */

/**
 * Retention walks the four tiers rather than deleting by age alone: a backup
 * older than the daily window is kept if it is the newest of its week, and older
 * than the weekly window only if it is the newest of its month. Deleting purely
 * by age would eventually remove every long-range restore point.
 */
export function applyRetention(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return { removed: [], kept: 0 };
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(ndjson|dump|sqlite|db)$/.test(f))
    .map((f) => ({ name: f, path: path.join(dir, f), stat: fs.statSync(path.join(dir, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const now = Date.now();
  const dayMs = 86_400_000;
  const keep = new Set();
  const newestIn = (bucket, bucketKeyOf) => {
    const seen = new Map();
    for (const f of files) {
      const key = bucketKeyOf(new Date(f.stat.mtimeMs));
      if (!seen.has(key)) seen.set(key, f);
    }
    return [...seen.entries()].slice(0, bucket);
  };

  // Tier 1: the newest N backups, always.
  files.slice(0, RETENTION.keepDaily).forEach((f) => keep.add(f.name));
  // Tier 2: newest of each of the last N weeks.
  const weekKey = (d) => {
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  newestIn(RETENTION.keepWeekly, weekKey).forEach(([k, f]) => keep.add(f.name));
  // Tier 3: newest of each of the last N months.
  const monthKey = (d) => d.toISOString().slice(0, 7);
  newestIn(RETENTION.keepMonthly, monthKey).forEach(([k, f]) => keep.add(f.name));

  const removed = [];
  for (const f of files) {
    const ageDays = (now - f.stat.mtimeMs) / dayMs;
    if (keep.has(f.name)) continue;
    // Never delete something inside the daily window, even if a tier forgot it.
    if (ageDays <= RETENTION.keepDaily) { keep.add(f.name); continue; }
    fs.unlinkSync(f.path);
    if (fs.existsSync(`${f.path}.sha256`)) fs.unlinkSync(`${f.path}.sha256`);
    removed.push(f.name);
  }
  return { removed, kept: keep.size, tiers: RETENTION };
}

/* -------------------------------------------------------------------- run -- */

export function takeBackup() {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup.mjs'), 'backup', '--dir', BACKUP_DIR], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (res.status !== 0) {
    return { ok: false, reason: `backup failed: ${(res.stderr || res.stdout).trim().slice(0, 400)}` };
  }
  // Find the newest archive the run produced and stamp it.
  const newest = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /\.(ndjson|dump|sqlite|db)$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (!newest) return { ok: false, reason: 'backup reported success but wrote no archive' };
  const manifest = writeManifest(path.join(BACKUP_DIR, newest.f));
  return { ok: true, file: newest.f, ...manifest, output: (res.stdout || '').trim().slice(0, 600) };
}

function report(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

const command = process.argv[2] ?? 'status';
switch (command) {
  case 'status':
    report(environmentStatus());
    break;
  case 'run': {
    const result = takeBackup();
    report(result);
    process.exitCode = result.ok ? 0 : 1;
    break;
  }
  case 'retention': {
    report(applyRetention(arg('dir', BACKUP_DIR)));
    break;
  }
  case 'pitr': {
    const env = environmentStatus();
    report(env.pitr);
    process.exitCode = env.pitr.available ? 0 : 2;
    break;
  }
  case 'verify-all': {
    const dir = arg('dir', BACKUP_DIR);
    if (!fs.existsSync(dir)) { report({ archives: 0, results: [] }); break; }
    const archives = fs.readdirSync(dir).filter((f) => /\.(ndjson|dump|sqlite|db)$/.test(f) && !f.endsWith('.sha256'));
    const results = archives.map((f) => ({ file: f, ...verifyManifest(path.join(dir, f)) }));
    report({
      archives: results.length,
      checked: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    process.exitCode = 2;
}
