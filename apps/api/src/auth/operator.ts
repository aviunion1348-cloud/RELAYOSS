/**
 * The deployment identity.
 *
 * RelayOS runs here as an **internal, unauthenticated** application: there is no
 * sign-in, no session, no cookie and no CSRF token. Every request is treated as
 * coming from the workspace operator.
 *
 * Why this file exists at all, rather than every route simply losing its identity:
 *
 *   - Identity is not only a gate. It is used for *attribution* (`created_by`,
 *     `auth_events.actor`, activity feeds) and for *scoping* (`resolveReadScope`,
 *     `projectsWhere`). Deleting it would mean writing `NULL` into `created_by` —
 *     which the foreign keys reject — or silently changing what every query
 *     returns. Keeping one well-defined identity preserves that logic exactly as
 *     it was, and removes only the part that could reject a request.
 *   - It must be a real row in `users`. The schema has foreign keys from tasks,
 *     comments and audit rows to `users.id`, so an invented id would fail on the
 *     first write. The operator is therefore looked up, and the deployment is
 *     told plainly if the database has no such row instead of failing obscurely
 *     at the first mutation.
 *
 * This is not a fake user and not a mock session. It is the configured operator of
 * a single-tenant deployment, resolved from `OPERATOR_USER_ID` (default
 * `usr_owner`, the operator that first-run bootstrap creates). A database seeded with
 * the demo data resolves to its administrator instead — see `resolveOperator`.
 */
import type { FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import type { Identity } from '../auth/index.ts';

/**
 * A stable identity object.
 *
 * `method: 'operator'` is deliberately distinct from the old `dev` / `oidc` /
 * `password` values so nothing downstream can mistake this for a session that was
 * once verified, and `expiresAt` is infinitely far away because there is nothing
 * to expire.
 */
export function operatorIdentity(user: {
  id: string;
  email: string;
  role: Identity['role'];
  full_name: string;
}): Identity {
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    name: user.full_name,
    method: 'operator',
    expiresAt: Number.MAX_SAFE_INTEGER,
    claims: {},
  };
}

/**
 * Declare the Fastify request augmentation used across the routes.
 *
 * `identity` is always present once the operator hook has run, but stays optional
 * in the type because tests may inject an app whose hook they replaced.
 */
declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}

/** The id every request is attributed to. */
export function operatorUserId(): string {
  return process.env.OPERATOR_USER_ID ?? process.env.DEMO_USER_ID ?? config.operatorUserId;
}

/** Read the identity the hook attached. */
export function requestIdentity(req: FastifyRequest): Identity | undefined {
  return req.identity;
}
