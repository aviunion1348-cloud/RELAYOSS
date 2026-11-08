/**
 * The only request hook this deployment has.
 *
 * It attaches the workspace operator to every request and cannot refuse one. That
 * is the entire policy: RelayOS is deployed here as an internal application behind
 * the organisation's own access control, so the API does not implement a second
 * one.
 *
 * What was removed, and why each removal is safe rather than merely convenient:
 *
 *   - **Session lookup.** No cookie is read. There is no session to expire, so no
 *     request can fail because one did.
 *   - **CSRF verification.** CSRF exists to stop a third-party page from riding a
 *     *victim's ambient cookie*. With no cookie there is no ambient authority to
 *     ride, so the check protected nothing. It is gone, together with the token
 *     plumbing on the client.
 *   - **The auth-mode gate.** `AUTH_MODE`, OIDC configuration, the shared password
 *     and the production refusal are no longer consulted. That gate is precisely
 *     what turned a missing environment variable into an API that answered every
 *     request with `503`, which is the failure this change exists to end.
 *   - **The per-route allowlist.** Every route is reachable, because every route
 *     was already reachable to the operator.
 *
 * What is deliberately *kept*:
 *
 *   - **Role and scope resolution.** The operator has a role in `users`, and the
 *     read/write scoping helpers still run. They now resolve against an
 *     administrator identity, so they return everything rather than nothing — but
 *     the code path is the same one that has tests, and there is no second,
 *     divergent "unscoped" query path to drift out of sync.
 *   - **Attribution.** `created_by` and audit rows still receive a real user id.
 *     The foreign keys require it, and an activity feed that says "someone" is
 *     worse than one that names the operator.
 *   - **Every business rule.** Validation, database constraints, SLA arithmetic,
 *     state machines and error handling are untouched.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.ts';
import { operatorIdentity, operatorUserId } from './operator.ts';
import type { Identity } from './index.ts';

export type OperatorApi = {
  /** The identity every request is attributed to. */
  identity: () => Identity | undefined;
  /** Role and scope helpers still take an identity; this is the one. */
  resolve: () => Promise<Identity>;
  /** No-op, kept so call sites that audited a session have somewhere to go. */
  audit: () => Promise<void>;
};

/**
 * Resolve the operator row once per process.
 *
 * `users` is the anchor for foreign keys across tasks, comments, activity and
 * audit, so the id must exist. It is resolved lazily and cached, because a boot
 * that queries eagerly would fail before `/api/health` could report *why* — and a
 * deployment whose database has no users is a seeding problem, which the caller
 * can then state precisely.
 */
let cached: Identity | null = null;
let pending: Promise<Identity> | null = null;

export function resetOperatorIdentity(): void {
  cached = null;
  pending = null;
}

export async function resolveOperator(db: Db): Promise<Identity> {
  if (cached) return cached;
  if (!pending) {
    pending = (async () => {
      const id = operatorUserId();
      const user = await db.get<{ id: string; email: string; role: Identity['role']; full_name: string }>(
        'SELECT id,email,role,full_name FROM users WHERE id = ?',
        [id],
      );
      if (user) {
        cached = operatorIdentity(user);
        return cached;
      }
      /**
       * No such user. Fall back to any administrator, then to any person at all,
       * rather than throwing: a database that predates this deployment's
       * configuration should still serve its data. If there is genuinely nobody,
       * the error names the remedy instead of failing inside a query.
       */
      const admin = await db.get<{ id: string; email: string; role: Identity['role']; full_name: string }>(
        "SELECT id,email,role,full_name FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END, id LIMIT 1",
      );
      if (!admin) {
        throw new Error(
          `No users exist in the database, so requests cannot be attributed. ` +
            `Run \`npm run db:seed\`, or set OPERATOR_USER_ID to an existing user id. (Looked for "${id}".)`,
        );
      }
      cached = operatorIdentity(admin);
      return cached;
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

export function createOperatorAuth(opts: { db: Db }): OperatorApi {
  return {
    identity: () => cached ?? undefined,
    resolve: () => resolveOperator(opts.db),
    audit: async () => {
      /* No session events are recorded: there are no sessions. */
    },
  };
}

/**
 * Install the hook.
 *
 * `onRequest` runs before routing, so `req.identity` is available to every
 * handler and to the rate limiter, exactly as the session hook used to be. The
 * difference is that it cannot throw: a failure to *resolve* the operator is
 * deferred to the first request that actually needs one, where it can be reported
 * as a normal error instead of taking the whole API down at boot.
 */
export function registerOperatorHook(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (req) => {
    try {
      req.identity = await resolveOperator(db);
    } catch {
      /* The handler will surface it with a clear message if it needs an identity. */
    }
  });
}
