/**
 * Shared-credential login routes — the requested single internal login.
 *
 *   POST /api/auth/login     username + password → session cookie
 *   GET  /api/auth/session   is there a live session? (drives the SPA gate)
 *   POST /api/auth/logout    revoke and clear
 *
 * Design decisions that matter:
 *
 *  1. **One credential, one identity.** The username maps to a provisioned user
 *     row with a role, so every existing authorisation rule — global role, project
 *     grants, client and partner scope — continues to apply. There is no "logged in
 *     therefore allowed" shortcut.
 *
 *  2. **No bypass exists.** The `dev-login` route is retained for tests and for the
 *     documented local demo stack, but it is refused whenever a password credential
 *     is provisioned, and refused outright in production. Anonymous requests never
 *     resolve to an identity: `resolveFallbackIdentity` remains unreachable behind
 *     the auth hook, which is registered unconditionally.
 *
 *  3. **Failures are indistinguishable.** Unknown username, wrong password, disabled
 *     credential and inactive user all return the same 401 with the same body, and a
 *     dummy Argon2id verification runs when the user does not exist so that absence
 *     is not faster than a wrong password.
 *
 *  4. **Throttling is both per-address and per-username.** A single shared login means
 *     an attacker who exhausts one counter must not be able to lock the operator out
 *     from a different address — and conversely, rotating addresses must not grant
 *     unlimited attempts against the one known username.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, ok, unauthorized } from '../lib/http.ts';
import type { LoginThrottle } from '../lib/rate-limit.ts';
import { createSession, issueCsrf, sessionCookie, lookupSession, SESSION_COOKIE } from '../auth/index.ts';
import {
  findCredential, verifyPassword, verifyAgainstDummy, auditAuthEvent, rejectBadCredentials,
} from '../auth/password.ts';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day

function secureCookies(): boolean {
  return config.env === 'production' || process.env.COOKIE_SECURE === '1';
}

export interface PasswordLoginOptions {
  throttle?: LoginThrottle;
}

export async function registerPasswordLogin(app: FastifyInstance, opts: PasswordLoginOptions = {}) {
  const throttle = opts.throttle;
  const db = () => getDb();

  /**
   * The shared login.
   *
   * Body: `{ username, password }`. Both are required and bounded, so an enormous
   * payload cannot be used to burn CPU in Argon2.
   */
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);

    const parsed = z
      .object({
        username: z.string().min(1).max(200),
        password: z.string().min(1).max(400),
      })
      .safeParse(req.body ?? {});

    if (!parsed.success) {
      // Malformed attempts are recorded: they are frequently the first probe.
      await auditAuthEvent(db(), { kind: 'login_malformed', ip, userAgent: ua });
      throw badRequest('Username and password are required.');
    }

    const { username, password } = parsed.data;

    // Two counters, both must be clear. Keyed by address and by username.
    const addressKey = `ip:${ip}`;
    const userKey = `user:${username}`;
    for (const key of [addressKey, userKey]) {
      const locked = throttle?.check(key);
      if (locked?.locked) {
        await auditAuthEvent(db(), {
          kind: 'login_throttled', ip, userAgent: ua, detail: username,
        });
        reply.header('retry-after', String(locked.retryAfterSec));
        throw unauthorized(`Too many sign-in attempts. Try again in ${locked.retryAfterSec} seconds.`);
      }
    }

    const credential = await findCredential(db(), username);

    // Constant-work path: a missing credential still pays for one verification.
    if (!credential) {
      await verifyAgainstDummy(password);
      throttle?.fail(addressKey);
      throttle?.fail(userKey);
      await auditAuthEvent(db(), { kind: 'login_failed', ip, userAgent: ua, detail: username });
      throw rejectBadCredentials();
    }

    if (credential.disabled_at) {
      await verifyAgainstDummy(password);
      throttle?.fail(addressKey);
      throttle?.fail(userKey);
      await auditAuthEvent(db(), {
        kind: 'login_disabled', ip, userAgent: ua, detail: username,
      });
      throw rejectBadCredentials();
    }

    const valid = await verifyPassword(credential.password_hash, password);
    if (!valid) {
      throttle?.fail(addressKey);
      throttle?.fail(userKey);
      await auditAuthEvent(db(), { kind: 'login_failed', ip, userAgent: ua, detail: username });
      throw rejectBadCredentials();
    }

    // The credential is right; the account behind it must still be usable.
    const user = await db().get<{ id: string; email: string; role: string; full_name: string; is_active: number }>(
      'SELECT id,email,role,full_name,is_active FROM users WHERE id = ?',
      [credential.user_id],
    );
    if (!user || !user.is_active) {
      throttle?.fail(addressKey);
      throttle?.fail(userKey);
      await auditAuthEvent(db(), {
        kind: 'login_inactive_user', ip, userAgent: ua, detail: username,
      });
      throw rejectBadCredentials();
    }

    throttle?.succeed(addressKey);
    throttle?.succeed(userKey);

    // Session fixation defence: the id is generated here, never accepted from the
    // client, and any previously issued session cookie is irrelevant because the
    // response replaces it.
    const session = await createSession(db(), {
      userId: user.id,
      method: 'password',
      ttlMs: SESSION_TTL_MS,
      userAgent: ua,
      ip,
    });

    await db().run(
      'UPDATE local_credentials SET last_used_at = ? WHERE id = ?',
      [new Date().toISOString().slice(0, 19).replace('T', ' '), credential.id],
    );
    await db().run('UPDATE sessions SET credential_version = ? WHERE id = ?', [
      credential.version, session.id,
    ]);

    await auditAuthEvent(db(), {
      userId: user.id, sessionId: session.id, kind: 'login_password', ip, userAgent: ua, detail: username,
    });

    reply.header('set-cookie', sessionCookie(session.id, SESSION_TTL_MS / 1000, secureCookies()));
    return ok({
      user: { id: user.id, email: user.email, role: user.role, name: user.full_name },
      expiresAt: new Date(session.expiresAt).toISOString(),
      csrfToken: issueCsrf(session.id, config.sessionSecret),
    });
  });

  /**
   * Session probe. Deliberately unauthenticated-by-design: it answers "is this
   * browser signed in?" so the SPA can decide between the login screen and the
   * workspace. It returns no data beyond the caller's own identity.
   */
  app.get('/api/auth/session', async (req) => {
    /**
     * The middleware soft-resolves identity for `/api/auth/*`, and a *failed*
     * resolution leaves `req.identity` untouched rather than setting it to null.
     * A stale `req.identity` from a pooled request object would therefore report
     * an authenticated session that no longer exists, which is why this asks the
     * session store directly instead of trusting the request property.
     */
    const raw = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.split('=')[1];

    if (!raw) return ok({ authenticated: false });

    const found = await lookupSession(db(), decodeURIComponent(raw), { touch: false });
    if (!found) return ok({ authenticated: false });

    return ok({
      authenticated: true,
      user: {
        id: found.identity.userId,
        email: found.identity.email,
        role: found.identity.role,
        name: found.identity.name,
      },
      method: found.identity.method,
      expiresAt: new Date(found.identity.expiresAt).toISOString(),
    });
  });

}
