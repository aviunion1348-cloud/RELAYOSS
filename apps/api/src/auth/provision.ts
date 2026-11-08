/**
 * Provisioning the shared login from the environment.
 *
 * The credential normally lives in the database, written once by
 * `npm run db:assign-login`. That works when the database persists. It does not
 * work when the store is ephemeral — a serverless instance whose SQLite file is
 * recreated on every cold start — because the row written by the CLI is gone by
 * the time the request arrives, so `AUTH_MODE=auto` finds no credential, resolves
 * to `dev`, and a production deployment refuses to boot. The symptom is a
 * deployment that can never be signed into, however correctly it was configured.
 *
 * So the same two values can also arrive as configuration:
 * `RELAY_LOGIN_USERNAME` + `RELAY_ADMIN_PASSWORD_HASH`. On boot, if a hash is
 * present and the database has no enabled credential for that username, the row is
 * written. This is the *same* credential the CLI writes — an Argon2id hash, never
 * a plaintext password — and it is validated by the same rule, so a malformed
 * value fails loudly at boot rather than silently never verifying.
 *
 * Rotation semantics match the CLI: an existing row for that username has its hash
 * replaced and its `version` bumped, which invalidates sessions minted with the old
 * one.
 */
import type { Db } from '../db/index.ts';

export interface ProvisionResult {
  action: 'created' | 'rotated' | 'unchanged' | 'absent';
  username?: string;
  userId?: string;
}

/** How many attempts to find a free credentials row id before giving up. */
const MAX_ID_ATTEMPTS = 5;

function credentialId(): string {
  return `cred_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Ensure the credential described by the environment exists.
 *
 * Returns `absent` when no hash is supplied — that is not an error, it means this
 * deployment is not using the shared login.
 */
export async function provisionLoginFromEnv(
  db: Db,
  opts: { log?: (message: string) => void } = {},
): Promise<ProvisionResult> {
  const log = opts.log ?? (() => {});
  const hash = process.env.RELAY_ADMIN_PASSWORD_HASH ?? '';
  if (!hash) return { action: 'absent' };

  const username = process.env.RELAY_LOGIN_USERNAME ?? 'lear roadmap 289';
  const userId = process.env.RELAY_LOGIN_USER_ID ?? 'usr_owner';

  // The boot guard already refuses a malformed hash before this runs; repeating the
  // check keeps the function safe to call from anywhere without relying on order.
  if (!hash.startsWith('$argon2id$')) {
    throw new Error('RELAY_ADMIN_PASSWORD_HASH must be an Argon2id hash beginning `$argon2id$`');
  }

  const existing = await db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [userId]);
  if (!existing) {
    await db.run(
      'INSERT INTO users (id, email, full_name, role, initials) VALUES (?,?,?,?,?)',
      [userId, process.env.RELAY_LOGIN_EMAIL ?? 'owner@relay.local', 'Relay Owner', 'admin', 'RO'],
    );
    log(`created user ${userId} (admin)`);
  }

  const row = await db.get<{ id: string; version: number }>(
    'SELECT id, version FROM local_credentials WHERE username = ?',
    [username],
  );

  if (row) {
    // Only rewrite when the hash actually differs, so a restart does not
    // invalidate every session for no reason.
    const current = await db.get<{ password_hash: string }>(
      'SELECT password_hash FROM local_credentials WHERE id = ?',
      [row.id],
    );
    if (current?.password_hash === hash) {
      return { action: 'unchanged', username, userId };
    }
    await db.run(
      'UPDATE local_credentials SET password_hash = ?, version = version + 1, updated_at = ?, disabled_at = NULL, user_id = ? WHERE id = ?',
      [hash, new Date().toISOString().slice(0, 19).replace('T', ' '), userId, row.id],
    );
    log(`rotated credential for "${username}" (prior sessions invalidated)`);
    return { action: 'rotated', username, userId };
  }

  /**
   * Insert with a fresh id, retrying on a collision.
   *
   * The id is derived from randomness rather than a sequence because the same rows
   * may be created concurrently by two cold-starting instances; a duplicate key is
   * then a benign race to absorb, not a boot failure.
   */
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    try {
      await db.run(
        'INSERT INTO local_credentials (id, user_id, username, password_hash) VALUES (?,?,?,?)',
        [credentialId(), userId, username, hash],
      );
      log(`provisioned credential for "${username}" → user ${userId}`);
      return { action: 'created', username, userId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A concurrent instance may have won the race for this username; that is the
      // outcome we wanted, so treat it as done rather than as a failure.
      if (/UNIQUE|duplicate key/i.test(message)) {
        if (attempt === MAX_ID_ATTEMPTS - 1) {
          return { action: 'unchanged', username, userId };
        }
        continue;
      }
      throw err;
    }
  }

  return { action: 'unchanged', username, userId };
}
