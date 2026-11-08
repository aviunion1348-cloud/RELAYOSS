/**
 * Deployment mode, for the frontend's startup probe.
 *
 * The application no longer has a sign-in screen, so it no longer needs to ask
 * "who am I" before rendering. It does still need to know *what* it is talking to:
 * the dashboard greets the operator by name and shows their role, and those come
 * from the deployment rather than from a session.
 *
 * This replaces `GET /api/auth/session`, which reported `authenticated: false`
 * with `401` for anyone without a cookie. Returning a 401 on startup was the
 * trigger for the sign-in screen, and it is why removing that screen required a
 * route that answers truthfully instead of refusing.
 *
 * It reports the operator's identity because that is genuinely what every request
 * will be attributed to — this is not a fabricated session, it is the disclosure
 * that there is no session and the deployment acts as one configured person.
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/http.ts';
import { resolveOperator } from '../auth/operator-middleware.ts';
import { getDb } from '../db/index.ts';

export async function registerOperatorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What this deployment is.
   *
   * `authMode: 'none'` is the honest value: there is no authentication. The
   * frontend keys off it to skip every sign-in branch, and an operator reading the
   * response can see immediately that the API is unauthenticated rather than
   * wondering whether a session silently failed.
   */
  app.get('/api/auth/session', async () => {
    const identity = await resolveOperator(await getDb());
    const meta = await (await getDb()).get<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    return ok({
      authenticated: true,
      authMode: 'none',
      user: {
        id: identity.userId,
        email: identity.email,
        name: identity.name,
        role: identity.role,
      },
      /** Everything is permitted, because there is no boundary to enforce. */
      permissions: new Proxy({}, { get: () => true, has: () => true }),
      expiresAt: null,
      csrfToken: null,
      people: Number(meta?.count ?? 0),
    });
  });

  /**
   * Retire the old login endpoints explicitly.
   *
   * A 404 would be accurate — the routes do not exist — but a stale browser tab or
   * a bookmark pointed at `/api/auth/login` would then look like a broken server.
   * These answer `410 Gone` with the reason, which is the correct semantic: the
   * capability was removed deliberately, not lost.
   */
  for (const path of ['/api/auth/login', '/api/auth/dev-login', '/api/auth/logout']) {
    app.post(path, async (_req, reply) => {
      reply.code(410);
      return {
        error: {
          code: 'auth_removed',
          message:
            'Authentication has been removed from this deployment. Every page and API is accessible directly; there is nothing to sign in to.',
        },
      };
    });
  }
}
