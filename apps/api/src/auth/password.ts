/**
 * Shared-credential authentication (the requested single internal login).
 *
 * The model: one username and one password open the workspace. There is no
 * registration, no guest mode and no alternate demo bypass. A wrong password is
 * denied, and an anonymous request never becomes anybody.
 *
 * How it is stored, and why:
 *
 *   - The password is hashed with **Argon2id** at the OWASP-recommended baseline
 *     (64 MiB, t=3, p=4). The plaintext is never written to the repository, the
 *     database, a log line or an API response. The only artefact is the encoded
 *     hash, which carries its own parameters so a future parameter increase can
 *     verify old hashes and re-hash on next successful login.
 *
 *   - The hash itself is *provisioned*, not committed. `RELAY_ADMIN_PASSWORD_HASH`
 *     holds it in the environment; `scripts/set-password.mjs` generates the hash
 *     locally from a value the operator types. A generated development password
 *     exists only so a fresh clone is usable, and the boot guard refuses that
 *     fallback in production.
 *
 * Verification rules that matter:
 *
 *   - Unknown username and wrong password are **indistinguishable**: same status,
 *     same message, same timing budget (a dummy verification runs when the user
 *     does not exist, so absence is not faster than a wrong password).
 *   - Failures are throttled per client address *and* per claimed username, so one
 *     attacker cannot lock a legitimate operator out from a second address. Both
 *     counters must be exhausted to lock.
 *   - Every attempt is written to `auth_events` — success, failure, throttle and
 *     logout — with the address and user-agent, because a login nobody can audit
 *     is not a control.
 *   - The credential row carries a `version`; live sessions record the version they
 *     were minted with, so rotating the password invalidates every existing session
 *     without needing to enumerate them.
 */
import type { Db } from '../db/index.ts';
import { unauthorized } from '../lib/http.ts';

/**
 * Argon2 is loaded lazily, and that is a deployment requirement rather than taste.
 *
 * `argon2` is a native module with a prebuilt binary. A static `import` places it
 * in the module graph of every request, so if the binding fails to load — a
 * missing prebuild for the platform, a skipped install script, a libc mismatch —
 * the *whole function module* throws during import. That happens before any
 * handler code exists, so no error handling in this application can run: the
 * platform answers with a `500` and no JSON body. That is exactly the blank 500
 * observed in production, and it is undiagnosable from the client by construction.
 *
 * Loading it inside the functions that need it keeps the failure where it can be
 * reported: a login attempt returns a clear "password hashing unavailable" error,
 * every other route keeps working, and `/api/ready` can say what is wrong.
 *
 * `type` and the parameters are plain numbers, so the option object needs no
 * native binding and stays exported for callers and tests.
 */
const ARGON2ID = 2; // argon2.argon2id — stable public constant in the binding.

/** OWASP baseline for Argon2id. Recorded in the hash itself. */
export const ARGON2_OPTIONS = {
  type: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

type Argon2 = {
  hash(plaintext: string, opts: typeof ARGON2_OPTIONS): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
};

let argon2Module: Argon2 | null = null;
let argon2Failure: Error | null = null;

/** Load the native binding once, remembering a failure so it is not retried per request. */
async function argon2(): Promise<Argon2> {
  if (argon2Module) return argon2Module;
  if (argon2Failure) throw argon2Failure;
  try {
    const mod = (await import('argon2')).default as unknown as Argon2;
    argon2Module = mod;
    return mod;
  } catch (err) {
    argon2Failure = new Error(
      'Password hashing is unavailable: the argon2 native binding failed to load. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw argon2Failure;
  }
}

/** True when the password library can be loaded. Used by the readiness probe. */
export async function passwordHashingAvailable(): Promise<boolean> {
  try {
    await argon2();
    return true;
  } catch {
    return false;
  }
}

/**
 * Hash a password. Used by `scripts/set-password.mjs` and by tests; the running
 * server only ever verifies.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  return (await argon2()).hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must deny
 * access, not crash the login endpoint into a 500 that reveals the row is special.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  if (!hash || !plaintext) return false;
  try {
    return await (await argon2()).verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Burn the same work as a real verification.
 *
 * Without this, "user does not exist" answers in microseconds while "wrong
 * password" answers in ~50 ms, and the difference is a username oracle. The dummy
 * hash is generated once per process.
 */
let dummyHash: string | null = null;
export async function verifyAgainstDummy(plaintext: string): Promise<false> {
  if (!dummyHash) {
    dummyHash = await (await argon2()).hash('relay-timing-equaliser-not-a-real-password', ARGON2_OPTIONS);
  }
  await (await argon2()).verify(dummyHash, plaintext || 'x').catch(() => false);
  return false;
}

export interface CredentialRow {
  id: string;
  user_id: string;
  username: string;
  password_hash: string;
  disabled_at: string | null;
  version: number;
}

/**
 * Resolve a credential row by username.
 *
 * Usernames are compared **exactly**, not case-folded. The requested username
 * contains spaces and mixed case (`lear roadmap 289`); folding case would accept
 * near-misses the operator never provisioned, so the contract is: what was set is
 * what is accepted.
 */
export async function findCredential(db: Db, username: string): Promise<CredentialRow | undefined> {
  return db.get<CredentialRow>(
    'SELECT id, user_id, username, password_hash, disabled_at, version FROM local_credentials WHERE username = ?',
    [username],
  );
}

/** Has a password been provisioned at all? Drives the honest "not configured" state. */
export async function hasProvisionedCredential(db: Db): Promise<boolean> {
  const row = await db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM local_credentials WHERE disabled_at IS NULL',
  );
  return Number(row?.c ?? 0) > 0;
}

/**
 * Record an authentication event. Never stores the password, the hash, or any
 * prefix of either — only the fact, the address and the claimed username.
 */
export async function auditAuthEvent(
  db: Db,
  input: {
    userId?: string | null;
    sessionId?: string | null;
    kind: string;
    ip?: string;
    userAgent?: string;
    detail?: string;
  },
): Promise<void> {
  await db.run(
    'INSERT INTO auth_events (user_id, session_id, kind, ip, user_agent, detail) VALUES (?,?,?,?,?,?)',
    [
      input.userId ?? null,
      input.sessionId ?? null,
      input.kind,
      input.ip ?? '',
      String(input.userAgent ?? '').slice(0, 300),
      // The claimed username is useful evidence of a credential-stuffing attempt;
      // the password never is.
      String(input.detail ?? '').slice(0, 300),
    ],
  );
}

/** A malformed request is worth recording too: it is often the first probe. */
export function rejectBadCredentials(): Error {
  return unauthorized('Invalid username or password.');
}
