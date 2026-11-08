/**
 * Authentication endpoints.
 *
 *   POST /api/auth/dev-login     local development only — creates a real session
 *   POST /api/auth/oidc/exchange exchange a verified OIDC token for a session
 *   POST /api/auth/logout        revoke the current session
 *   GET  /api/auth/me            who am I (identity + permissions)
 *   POST /api/auth/dev-logout    alias used by the UI
 *   GET  /api/auth/sessions      active sessions for the current user
 *   POST /api/auth/sessions/:id/revoke
 *
 *   GET  /api/auth/login         begin authorization-code + PKCE redirect
 *   GET  /api/auth/callback      complete it: state, nonce, code, session
 *
 * The redirect flow needs a real IdP tenant to be exercised end to end; the
 * test suite runs it against an in-process provider (see test/oidc-flow.test.mjs)
 * so the flow itself is proven rather than assumed. Production still needs the
 * operator's own client id and secret — see docs/DEPLOYMENT.md.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.ts';
import { hasProvisionedCredential } from '../auth/password.ts';
import { config } from '../config.ts';
import { badRequest, forbidden, notFound, ok, unauthorized } from '../lib/http.ts';
import { nowIso } from '../lib/ids.ts';
import {
  beginFlow,
  pruneFlows,
  sanitiseReturnTo,
  consumeFlow,
  exchangeCode,
  assertNonce,
  authorizeUrl,
  failFlow,
  audit as oidcAudit,
  oidcConfigStatus,
  FLOW_TTL_MS,
} from '../auth/oidc.ts';
import {
  JwksCache,
  SESSION_COOKIE,
  createSession,
  issueCsrf,
  lookupSession,
  revokeAllSessions,
  revokeSession,
  sessionCookie,
  verifyJwt,
  authMode,
} from '../auth/index.ts';

const db = () => getDb();

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day

function secureCookies() {
  return config.env === 'production' || process.env.COOKIE_SECURE === '1';
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: { throttle?: import('../lib/rate-limit.ts').LoginThrottle } = {},
) {
  const throttle = opts.throttle;
  const jwks = new JwksCache(config.oidcJwksUri);

  /* ---------------------------------------------------------- dev login -- */
  app.post('/api/auth/dev-login', async (req, reply) => {
    // Gate: refused in production unless the same explicit opt-in that lets the
    // boot guard run dev auth is set (a local demonstration stack). The two
    // checks must agree, otherwise the documented compose stack cannot sign in.
    const demoAllowed = process.env.ALLOW_DEV_AUTH_IN_PRODUCTION === '1' && authMode() === 'dev';
    if (config.env === 'production' && !demoAllowed) {
      throw forbidden('Local development login is disabled in production');
    }
    /**
     * No alternate bypass once the shared login is provisioned.
     *
     * The requested access model is a single username and password with no guest
     * mode and no demo entry point. Leaving dev-login reachable would mean anyone
     * who can POST a user id gets a session, which is precisely the bypass the
     * requirement forbids. It stays available only while no credential exists —
     * i.e. for a fresh clone and for the test suites that predate the shared login.
     */
    if (await hasProvisionedCredential(db())) {
      throw forbidden(
        'This deployment uses the shared login. Sign in at /login.',
      );
    }
    const parsed = z.object({ userId: z.string().min(1).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid payload', parsed.error.issues);

    const userId = parsed.data.userId ?? config.demoUserId;
    // Brute-force protection is keyed by client address + claimed identity, so
    // one attacker cannot lock a real user out from a different address.
    const lockKey = `${req.ip}|${userId}`;
    const locked = throttle?.check(lockKey);
    if (locked?.locked) {
      throw forbidden(`Too many failed attempts. Try again in ${locked.retryAfterSec}s.`);
    }
    const user = await db().get<{ id: string; email: string; role: string; full_name: string; is_active: number }>(
      'SELECT id,email,role,full_name,is_active FROM users WHERE id = ?',
      [userId],
    );
    if (!user || !user.is_active) {
      throttle?.fail(lockKey);
      await db().run('INSERT INTO auth_events (kind, ip, user_agent, detail) VALUES (?,?,?,?)', [
        'login_failed', req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), userId,
      ]);
      // Same response for unknown and inactive accounts: no user enumeration.
      throw unauthorized('Invalid credentials');
    }
    throttle?.succeed(lockKey);

    const session = await createSession(db(), {
      userId: user.id,
      method: 'dev',
      ttlMs: SESSION_TTL_MS,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      ip: req.ip,
    });
    await db().run('INSERT INTO auth_events (user_id, session_id, kind, ip, user_agent) VALUES (?,?,?,?,?)', [
      user.id, session.id, 'login_dev', req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300),
    ]);

    reply.header('set-cookie', sessionCookie(session.id, SESSION_TTL_MS / 1000, secureCookies()));
    return ok({
      user: { id: user.id, email: user.email, role: user.role, name: user.full_name },
      expiresAt: new Date(session.expiresAt).toISOString(),
      csrfToken: issueCsrf(session.id, config.sessionSecret),
      // Also returned for non-browser clients that cannot hold cookies.
      bearer: `dev.${session.id}`,
    });
  });

  /* ------------------------------------------------------ oidc exchange -- */
  app.post('/api/auth/oidc/exchange', async (req, reply) => {
    if (authMode() !== 'oidc') throw forbidden('OIDC is not the configured auth mode');
    const parsed = z.object({ token: z.string().min(20) }).safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('token is required');

    const payload = await verifyJwt(parsed.data.token, {
      jwks,
      issuer: config.oidcIssuer || undefined,
      audience: config.oidcAudience || undefined,
    });

    const subject = await db().get<{ user_id: string }>(
      'SELECT user_id FROM identity_subjects WHERE issuer = ? AND subject = ?',
      [payload.iss ?? '', payload.sub ?? ''],
    );
    if (!subject) throw forbidden('This identity is not provisioned in Relay');

    const session = await createSession(db(), {
      userId: subject.user_id,
      method: 'oidc',
      ttlMs: SESSION_TTL_MS,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      ip: req.ip,
    });
    await db().run('UPDATE identity_subjects SET last_login_at = ?, claims_json = ? WHERE issuer = ? AND subject = ?', [
      nowIso(), JSON.stringify(payload).slice(0, 4000), payload.iss ?? '', payload.sub ?? '',
    ]);
    await db().run('INSERT INTO auth_events (user_id, session_id, kind, ip, user_agent) VALUES (?,?,?,?,?)', [
      subject.user_id, session.id, 'login_oidc', req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300),
    ]);

    reply.header('set-cookie', sessionCookie(session.id, SESSION_TTL_MS / 1000, secureCookies()));
    return ok({
      expiresAt: new Date(session.expiresAt).toISOString(),
      csrfToken: issueCsrf(session.id, config.sessionSecret),
    });
  });

  /* ------------------------------------------------- authorization code -- */
  /**
   * Begin the browser login. Nothing about the user is accepted from the
   * request; the only inputs are where to come back to and where the provider
   * should send the browser afterwards.
   */
  app.get('/api/auth/login', async (req, reply) => {
    if (authMode() !== 'oidc') throw forbidden('OIDC is not the configured auth mode');
    const status = oidcConfigStatus();
    if (!status.configured) {
      throw badRequest(
        `Single sign-on is not fully configured. Missing: ${status.missing.join(', ')}. ` +
        'An administrator must set these before browser sign-in can work.',
      );
    }
    const q = req.query as { returnTo?: string; redirectUri?: string };

    // The redirect URI must match the one registered with the provider. It is
    // never taken from the query string unless it matches the configured value,
    // because that is how an open redirect becomes token theft.
    const configuredRedirect = process.env.OIDC_REDIRECT_URI ?? '';
    const redirectUri = q.redirectUri && q.redirectUri === configuredRedirect ? q.redirectUri : configuredRedirect;

    await pruneFlows(db());
    const flow = await beginFlow(db(), {
      redirectUri,
      returnTo: sanitiseReturnTo(q.returnTo),
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    const url = authorizeUrl({
      issuer: config.oidcIssuer,
      clientId: process.env.OIDC_CLIENT_ID ?? '',
      redirectUri,
      state: flow.state,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    });
    return ok({ authorizeUrl: url, state: flow.state, expiresInSec: Math.floor(FLOW_TTL_MS / 1000) });
  });

  /**
   * Complete the login.
   *
   * Order matters: consume the one-time flow first (so a replay cannot proceed),
   * then exchange the code, then verify the ID token, then bind the nonce, and
   * only then create a session. Any failure leaves no session behind.
   */
  app.get('/api/auth/callback', async (req, reply) => {
    if (authMode() !== 'oidc') throw forbidden('OIDC is not the configured auth mode');
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };

    if (q.error) {
      if (q.state) await failFlow(db(), q.state, `provider: ${q.error}`, req.ip);
      return reply.code(401).send({
        error: {
          code: 'unauthorized',
          message: `Sign-in was cancelled or refused by the identity provider (${q.error_description ?? q.error}).`,
        },
      });
    }
    if (!q.code) throw badRequest('The identity provider returned no authorization code.');

    let flow;
    try {
      flow = await consumeFlow(db(), String(q.state ?? ''), req.ip);
    } catch (err) {
      throw err;
    }

    try {
      // 1. Exchange the code, with the PKCE verifier that never left the server.
      const exchanged = await exchangeCode({
        tokenEndpoint: process.env.OIDC_TOKEN_URL ?? `${config.oidcIssuer.replace(/\/$/, '')}/oauth2/token`,
        code: q.code,
        redirectUri: flow.redirect_uri,
        clientId: process.env.OIDC_CLIENT_ID ?? '',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        codeVerifier: flow.code_verifier,
      });

      // 2. Verify the signature against the provider's JWKS, and iss/aud/exp.
      const payload = await verifyJwt(exchanged.idToken, {
        jwks,
        issuer: config.oidcIssuer || undefined,
        audience: config.oidcAudience || undefined,
      });

      // 3. Bind the token to *this* request.
      assertNonce(payload as Record<string, unknown>, flow.nonce);

      // 4. The identity must already be provisioned. Sign-in never creates a
      //    user: an unknown subject is refused, not auto-provisioned.
      const subject = await db().get<{ user_id: string }>(
        'SELECT user_id FROM identity_subjects WHERE issuer = ? AND subject = ?',
        [payload.iss ?? '', payload.sub ?? ''],
      );
      if (!subject) {
        await failFlow(db(), flow.state, `unprovisioned subject ${String(payload.sub ?? '')}`, req.ip);
        throw forbidden('This identity is not provisioned in Relay. Ask an administrator for access.');
      }

      // 5. A disabled account cannot sign in, even with a valid token.
      const user = await db().get<{ id: string; is_active: number }>('SELECT id, is_active FROM users WHERE id = ?', [subject.user_id]);
      if (!user || !Number(user.is_active)) {
        await failFlow(db(), flow.state, 'account disabled', req.ip);
        throw forbidden('This account is disabled.');
      }

      const session = await createSession(db(), {
        userId: subject.user_id,
        method: 'oidc',
        ttlMs: SESSION_TTL_MS,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        ip: req.ip,
      });
      await db().run('UPDATE identity_subjects SET last_login_at = ?, claims_json = ? WHERE issuer = ? AND subject = ?', [
        nowIso(), JSON.stringify(payload).slice(0, 4000), payload.iss ?? '', payload.sub ?? '',
      ]);
      await oidcAudit(db(), flow.state, 'callback_ok', String(payload.sub ?? ''), '', req.ip);
      await db().run('INSERT INTO auth_events (user_id, session_id, kind, ip, user_agent) VALUES (?,?,?,?,?)', [
        subject.user_id, session.id, 'login_oidc', req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300),
      ]);

      reply.header('set-cookie', sessionCookie(session.id, SESSION_TTL_MS / 1000, secureCookies()));
      return ok({
        expiresAt: new Date(session.expiresAt).toISOString(),
        csrfToken: issueCsrf(session.id, config.sessionSecret),
        returnTo: sanitiseReturnTo(flow.return_to),
      });
    } catch (err) {
      // Every path out of here is a closed door: no session was created.
      await failFlow(db(), flow.state, (err as Error).message, req.ip);
      throw err;
    }
  });

  /* ------------------------------------------------------------ session -- */
  app.get('/api/auth/me', async (req) => {
    const identity = req.identity;
    if (!identity) throw unauthorized();
    const sessionId = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.split('=')[1];
    return ok({
      user: {
        id: identity.userId,
        email: identity.email,
        name: identity.name,
        role: identity.role,
      },
      method: identity.method,
      /**
       * The effective sign-in mode, which is not simply `AUTH_MODE`.
       *
       * Once a shared credential exists, the password login is the way in and the
       * demo login is refused — so the frontend must render the password form
       * rather than a list of demo identities, even if AUTH_MODE is still `dev`.
       * Reporting `config.authMode` here would show a sign-in screen whose only
       * button is guaranteed to fail.
       */
      /**
       * Report the mode the server is *enforcing*, not the raw environment value.
       * `AUTH_MODE` defaults to `auto`; returning that would make the client unable
       * to decide which sign-in screen to show.
       */
      authMode: authMode(),
      expiresAt: new Date(identity.expiresAt).toISOString(),
      csrfToken: sessionId ? issueCsrf(decodeURIComponent(sessionId), config.sessionSecret) : null,
      permissions: permissionsFor(identity.role),
    });
  });

  app.get('/api/auth/sessions', async (req) => {
    const identity = req.identity;
    if (!identity) throw unauthorized();
    const rows = await db().all<Record<string, any>>(
      `SELECT id, method, created_at, last_seen_at, expires_at, revoked_at, user_agent, ip
       FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [identity.userId],
    );
    return ok(rows.map((r) => ({
      id: r.id,
      method: r.method,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      revoked: !!r.revoked_at,
      userAgent: r.user_agent,
      ip: r.ip,
    })));
  });

  app.post('/api/auth/sessions/:id/revoke', async (req) => {
    const identity = req.identity;
    if (!identity) throw unauthorized();
    const { id } = req.params as { id: string };
    const session = await db().get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', [id]);
    if (!session) throw notFound('Session not found');
    if (session.user_id !== identity.userId && !['admin', 'lead'].includes(identity.role)) {
      throw forbidden('You can only revoke your own sessions');
    }
    await revokeSession(db(), id);
    await db().run('INSERT INTO auth_events (user_id, session_id, kind, ip) VALUES (?,?,?,?)', [
      session.user_id, id, 'revoked', req.ip,
    ]);
    return ok({ revoked: id });
  });

  app.post('/api/auth/sessions/revoke-all', async (req) => {
    const identity = req.identity;
    if (!identity) throw unauthorized();
    const count = await revokeAllSessions(db(), identity.userId);
    return ok({ revoked: count });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const identity = await (async () => {
      try {
        return req.identity ?? null;
      } catch {
        return null;
      }
    })();
    const raw = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.split('=')[1];
    if (raw) await revokeSession(db(), decodeURIComponent(raw));
    reply.header('set-cookie', sessionCookie('', 0, secureCookies()));
    if (identity) {
      await db().run('INSERT INTO auth_events (user_id, kind, ip) VALUES (?,?,?)', [identity.userId, 'logout', req.ip]);
    }
    return ok({ loggedOut: true });
  });
}

/** UI-facing capability map derived from the role, not from client state. */
export function permissionsFor(role: string) {
  const isLead = role === 'admin' || role === 'lead';
  return {
    canManageClients: isLead || role === 'member',
    canApproveTurnover: isLead,
    canWaiveGates: isLead,
    canShipReleases: isLead,
    canEditCommercials: role === 'admin' || role === 'lead',
    canManagePartners: role === 'admin',
    canManageUsers: role === 'admin',
    canDeleteProjects: role === 'admin',
    canViewAudit: isLead,
    canViewInternalNotes: role !== 'client',
  };
}
