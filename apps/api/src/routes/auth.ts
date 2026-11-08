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
 * Interactive authorization-code redirect flow is intentionally absent: it
 * requires a real IdP tenant (client id/secret). The verification boundary it
 * hands off to — JWKS + RS256/ES256 + iss/aud/exp — is implemented and tested.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, forbidden, notFound, ok, unauthorized } from '../lib/http.ts';
import { nowIso } from '../lib/ids.ts';
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
} from '../auth/index.ts';

const db = () => getDb();

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day

function secureCookies() {
  return config.env === 'production' || process.env.COOKIE_SECURE === '1';
}

export async function registerAuthRoutes(app: FastifyInstance) {
  const jwks = new JwksCache(config.oidcJwksUri);

  /* ---------------------------------------------------------- dev login -- */
  app.post('/api/auth/dev-login', async (req, reply) => {
    // Hard gate: this endpoint does not exist in production.
    if (config.env === 'production') throw forbidden('Local development login is disabled in production');
    const parsed = z.object({ userId: z.string().min(1).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid payload', parsed.error.issues);

    const userId = parsed.data.userId ?? config.demoUserId;
    const user = await db().get<{ id: string; email: string; role: string; full_name: string; is_active: number }>(
      'SELECT id,email,role,full_name,is_active FROM users WHERE id = ?',
      [userId],
    );
    if (!user) throw notFound('Unknown user');
    if (!user.is_active) throw forbidden('Account is inactive');

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
    if (config.authMode !== 'oidc') throw forbidden('OIDC is not the configured auth mode');
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
      authMode: config.authMode,
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
