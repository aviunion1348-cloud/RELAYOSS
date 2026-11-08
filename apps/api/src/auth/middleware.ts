/**
 * Request authentication + authorisation boundary.
 *
 * Order of resolution (first match wins, and every rejection is audited):
 *   1. Session cookie  → server-side session row (browser sessions; CSRF enforced
 *      on state-changing requests)
 *   2. `Authorization: Bearer <jwt>` → OIDC verification (service-to-service,
 *      CLI, partner portal API clients)
 *   3. `AUTH_MODE=dev` only → signed dev session created by POST /api/auth/dev-login
 *
 * `x-actor-id` is **never** trusted: in development it is honoured only when
 * `ALLOW_DEV_ACTOR_HEADER=1` is explicitly set for local scripting, and it can
 * never be combined with a real session.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { forbidden, unauthorized } from '../lib/http.ts';
import {
  JwksCache,
  readCookie,
  lookupSession,
  verifyJwt,
  verifyCsrf,
  SESSION_COOKIE,
  authMode,
  type Identity,
} from './index.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuthContext {
  db: Db;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}

async function audit(
  ctx: AuthContext,
  input: { userId?: string | null; sessionId?: string | null; kind: string; ip?: string; userAgent?: string; detail?: string },
) {
  try {
    await ctx.db.run(
      'INSERT INTO auth_events (user_id, session_id, kind, ip, user_agent, detail) VALUES (?,?,?,?,?,?)',
      [input.userId ?? null, input.sessionId ?? null, input.kind, input.ip ?? null, input.userAgent ?? null, input.detail ?? ''],
    );
  } catch {
    // Auditing must never break authentication; failures surface in logs.
  }
}

export function createAuth(ctx: AuthContext) {
  // One shared cache for the process; key rotation refetches at most once/min.
  const jwks = new JwksCache(config.oidcJwksUri);

  async function resolve(req: FastifyRequest): Promise<Identity> {
    const ip = req.ip;
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);

    /* 1 — session cookie ------------------------------------------------- */
    const cookieId = readCookie(req, SESSION_COOKIE);
    if (cookieId) {
      const found = await lookupSession(ctx.db, cookieId);
      if (!found) {
        await audit(ctx, { kind: 'session_invalid', ip, userAgent: ua, detail: 'unknown, revoked or expired' });
        throw unauthorized('Session expired or revoked');
      }
      if (MUTATING.has(req.method)) {
        const csrf = req.headers['x-csrf-token'];
        if (!verifyCsrf(cookieId, typeof csrf === 'string' ? csrf : undefined, config.sessionSecret)) {
          await audit(ctx, { userId: found.identity.userId, sessionId: cookieId, kind: 'csrf_rejected', ip, userAgent: ua, detail: req.url });
          throw forbidden('Missing or invalid CSRF token');
        }
      }
      return found.identity;
    }

    /* 2 — bearer token ---------------------------------------------------- */
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      const token = header.slice(7).trim();
      /*
       * Dev bearer tokens are session ids minted by /api/auth/dev-login. They are
       * accepted only in 'dev' mode, which cannot be selected in production — so in
       * a real deployment this branch is unreachable and the cookie session is the
       * only way in alongside a verified OIDC JWT.
       */
      if (authMode() === 'dev' && token.startsWith('dev.')) {
        const found = await lookupSession(ctx.db, token.slice(4));
        if (!found) throw unauthorized('Dev session expired');
        return found.identity;
      }
      const payload = await verifyJwt(token, {
        jwks,
        issuer: config.oidcIssuer || undefined,
        audience: config.oidcAudience || undefined,
      });
      const subject = await ctx.db.get<{ user_id: string }>(
        'SELECT user_id FROM identity_subjects WHERE issuer = ? AND subject = ?',
        [payload.iss ?? '', payload.sub ?? ''],
      );
      if (!subject) {
        await audit(ctx, { kind: 'login_unknown_subject', ip, userAgent: ua, detail: String(payload.sub ?? '') });
        throw forbidden('This identity is not provisioned in Relay');
      }
      const user = await ctx.db.get<{ id: string; email: string; role: Identity['role']; full_name: string; is_active: number }>(
        'SELECT id,email,role,full_name,is_active FROM users WHERE id = ?',
        [subject.user_id],
      );
      if (!user || !user.is_active) throw forbidden('Account is inactive');
      return {
        userId: user.id,
        email: user.email,
        role: user.role,
        name: user.full_name,
        method: 'oidc',
        expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now() + 300_000,
        claims: payload as Record<string, unknown>,
      };
    }

    /* 3 — local development ------------------------------------------------ */
    if (authMode() === 'dev') {
      const actorHeader = req.headers['x-actor-id'];
      if (typeof actorHeader === 'string' && actorHeader.trim() && process.env.ALLOW_DEV_ACTOR_HEADER === '1') {
        const user = await ctx.db.get<{ id: string; email: string; role: Identity['role']; full_name: string }>(
          'SELECT id,email,role,full_name FROM users WHERE id = ?',
          [actorHeader.trim()],
        );
        if (!user) throw unauthorized('Unknown actor');
        await audit(ctx, { userId: user.id, kind: 'login_dev_header', ip, userAgent: ua });
        return { userId: user.id, email: user.email, role: user.role, name: user.full_name, method: 'dev', expiresAt: Date.now() + 60_000, claims: {} };
      }
      // No credential at all. Auto-signing-in the demo user is available for
      // scripted demos, but it is opt-in (`DEMO_AUTO_LOGIN=1`), never implicit:
      // an anonymous request must not silently become an admin.
      if (process.env.DEMO_AUTO_LOGIN === '1') {
        const demo = await ctx.db.get<{ id: string; email: string; role: Identity['role']; full_name: string }>(
          'SELECT id,email,role,full_name FROM users WHERE id = ?',
          [config.demoUserId],
        );
        if (demo) {
          return { userId: demo.id, email: demo.email, role: demo.role, name: demo.full_name, method: 'dev', expiresAt: Date.now() + 60_000, claims: {} };
        }
      }
      await audit(ctx, { kind: 'anonymous_rejected', ip, userAgent: ua, detail: req.url });
      throw unauthorized('Authentication required');
    }

    throw unauthorized('Authentication required');
  }

  return {
    async authenticate(req: FastifyRequest, _reply: FastifyReply) {
      const url = req.url.split('?')[0];
      if (!url.startsWith('/api')) return;
      // Operational probes are machine-consumed (orchestrators, Prometheus) and
      // expose no user data: health, liveness, readiness and metrics.
      if (url.startsWith('/api/health') || url === '/api/live' || url === '/api/ready' || url === '/api/metrics') return;

      /**
       * Scheduled work authenticates with its own bearer secret, not a session.
       *
       * The handler performs the comparison in constant time and refuses when
       * CRON_SECRET is unset. Letting the session hook run first would make a
       * machine-to-machine call depend on a cookie it can never have.
       */
      if (url === '/api/cron/sweep') return;

      // Creating a session is the one truly anonymous operation. `/api/auth/login`
      // and `/api/auth/session` are the shared-credential equivalents: the first
      // mints a session from a username and password, the second only reports
      // whether the caller already has one.
      if (
        url === '/api/auth/dev-login'
        || url === '/api/auth/oidc/exchange'
        || url === '/api/auth/login'
        || url === '/api/auth/session'
      ) return;

      // Session-management endpoints soft-resolve: `/auth/me` answers "who am
      // I", and `/auth/logout` must still work for an already-expired session.
      if (url.startsWith('/api/auth/')) {
        try {
          req.identity = await resolve(req);
        } catch {
          /* handlers decide whether identity is required */
        }
        return;
      }

      req.identity = await resolve(req);
    },
    resolve,
    audit,
  };
}

export type AuthApi = ReturnType<typeof createAuth>;

/** Role gate. Returns the identity so handlers can stay one line. */
export function requireRole(identity: Identity | undefined, roles: Identity['role'][]): Identity {
  if (!identity) throw unauthorized();
  if (!roles.includes(identity.role)) {
    throw forbidden(`Requires role: ${roles.join(' | ')}`);
  }
  return identity;
}

/**
 * Project-scoped access check.
 *   admin/lead  → org-wide, all projects
 *   member      → projects they are a member of, or are assigned work in
 *   client      → projects of the client they represent
 * Absence of a relationship is a denial, not a default-allow.
 */
export async function requireProjectAccess(
  db: Db,
  identity: Identity,
  projectId: string | null,
  need: 'read' | 'write' = 'read',
): Promise<void> {
  if (!projectId) {
    if (need === 'write' && !['admin', 'lead', 'member'].includes(identity.role)) throw forbidden('Insufficient role');
    return;
  }
  if (identity.role === 'admin' || identity.role === 'lead') return;

  const member = await db.get<{ access: string }>(
    'SELECT access FROM project_members WHERE project_id = ? AND user_id = ?',
    [projectId, identity.userId],
  );
  if (member) {
    if (need === 'write' && member.access === 'viewer') throw forbidden('Viewer access is read-only');
    return;
  }

  const assigned = await db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND (assignee_id = ? OR reporter_id = ?)',
    [projectId, identity.userId, identity.userId],
  );
  if ((assigned?.c ?? 0) > 0) return;

  if (identity.role === 'client') {
    const owned = await db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM projects WHERE id = ? AND client_id IN (SELECT client_id FROM client_portal_users WHERE user_id = ?)',
      [projectId, identity.userId],
    );
    if ((owned?.c ?? 0) > 0) return;
  }

  throw forbidden('No access to this project');
}
