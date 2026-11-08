/**
 * The project-access question, and nothing else.
 *
 * This file used to hold the request pipeline: cookie parsing, session lookup,
 * bearer-token verification, CSRF validation, the development-identity path and
 * the per-route allowlist. All of it existed to decide whether to let a request
 * through, and all of it is gone — the deployment is single-tenant and
 * unauthenticated, so there is no one to let in or keep out.
 *
 * What survives is this one function, because twelve routes call it before a write
 * and each is asking a question that still has a meaningful answer: *may this
 * mutation proceed?* It may. The alternative — deleting it from twelve call sites —
 * would have made the diff larger, obscured which operations were once privileged,
 * and risked a mistake in a mutation's logic while editing its guard.
 *
 * The role and tenancy decisions that used to live here are not silently dropped.
 * They are documented as removed in `docs/AUTH-REMOVAL.md` (what each one
 * protected, and what now protects it instead — usually nothing, which is stated
 * plainly rather than implied).
 */
import type { Db } from '../db/index.ts';
import type { Identity } from './index.ts';

/**
 * Project access — retired.
 *
 * Was: an admin or lead reached every project; a member reached their grants and
 * anything they were assigned; a client reached their own organisation's projects;
 * everyone else was refused `403`. Now: every caller is the same operator, so
 * every caller is allowed.
 *
 * What is *not* lost: the row-level checks in the routes themselves —
 * `assertTimerInScope`, `assertClientInScope`, the `notFound` guards — still verify
 * that the entity exists and belongs where the caller claims. Those are
 * data-integrity checks rather than authorisation, they are still enforced, and
 * they are what stops a mistyped id from becoming a silent write.
 */
export async function requireProjectAccess(
  db: Db,
  identity: Identity,
  projectId: string | null,
  need: 'read' | 'write' = 'read',
): Promise<void> {
  void db;
  void identity;
  void projectId;
  void need;
}
