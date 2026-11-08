/**
 * Read scope — the single source of truth for "what may this identity see?".
 *
 * Before this module, authorisation was enforced per-endpoint with
 * `requireProjectAccess`, which works for a route that is handed one project id.
 * It fails for anything that *enumerates*: search, suggestions, filters, counts,
 * related-record lookups. Each of those grew its own (absent) filter, and the
 * result was a cross-tenant leak in `/api/search`.
 *
 * The model here is a resolved scope, built once per request:
 *
 *   admin / lead   → org-wide (every project, every client)
 *   member         → projects they are granted, plus projects they have work in
 *   client         → projects belonging to the client they represent
 *   partner        → projects explicitly shared with their partner tenant
 *
 * Every predicate is expressed as SQL that can be composed into a WHERE clause,
 * so filtering happens in the database and cannot be forgotten in one branch.
 * Counts and pagination use the same predicate as the rows — there is no
 * "count everything, return some" split that leaks through a total.
 *
 * Staleness rule: because predicates are evaluated against live rows on every
 * query, a revoked grant takes effect immediately. There is no index to be stale.
 */
import type { Db } from '../db/index.ts';
import type { Identity } from '../auth/index.ts';

export interface ReadScope {
  identity: Identity;
  /** Org-wide visibility (admin/lead). */
  unrestricted: boolean;
  /** Client ids this identity represents (client users), else []. */
  clientIds: string[];
  /** Partner tenant ids this identity belongs to (partner users), else []. */
  partnerIds: string[];
  /** Project ids reachable directly by grant or by assigned work. */
  projectIds: string[];
  /** True when the identity may never see internal (non-client-visible) data. */
  externalOnly: boolean;
}

/**
 * Resolve the scope for an identity. Runs at most four cheap queries; callers
 * that need several lists (search) resolve once and reuse.
 */
export async function resolveReadScope(db: Db, identity: Identity): Promise<ReadScope> {
  const role = identity.role;
  const unrestricted = role === 'admin' || role === 'lead';

  const partnerRows = await db.all<{ partner_id: string }>(
    "SELECT partner_id FROM partner_iam_users WHERE user_id = ? AND status = 'active'",
    [identity.userId],
  );
  const partnerIds = partnerRows.map((r) => r.partner_id);

  const clientRows =
    role === 'client'
      ? await db.all<{ client_id: string }>('SELECT client_id FROM client_portal_users WHERE user_id = ?', [identity.userId])
      : [];
  const clientIds = clientRows.map((r) => r.client_id);

  let projectIds: string[] = [];
  if (!unrestricted) {
    const granted = await db.all<{ project_id: string }>(
      'SELECT project_id FROM project_members WHERE user_id = ?',
      [identity.userId],
    );
    const assigned = await db.all<{ project_id: string }>(
      'SELECT DISTINCT project_id FROM tasks WHERE assignee_id = ? OR reporter_id = ?',
      [identity.userId, identity.userId],
    );
    // A client user sees their own organisation's projects — it is their data,
    // not another tenant's. This mirrors `requireProjectAccess` exactly; two
    // authorisation paths that disagree is how the search leak happened.
    //
    // Deliberately NOT included: any other client's projects. That is the
    // tenant boundary the tests defend. If the agency later wants to hide an
    // internal initiative from a client portal, the place for that is an
    // explicit sharing flag on the project — not an implicit header or an
    // enumeration difference between endpoints.
    const viaClient = clientIds.length
      ? await db.all<{ id: string }>(`SELECT id FROM projects WHERE client_id IN (${clientIds.map(() => '?').join(',')})`, clientIds)
      : [];
    const viaPartner = partnerIds.length
      ? await db.all<{ project_id: string }>(
          `SELECT project_id FROM partner_projects WHERE partner_id IN (${partnerIds.map(() => '?').join(',')})`,
          partnerIds,
        )
      : [];
    projectIds = [
      ...new Set([
        ...granted.map((r) => r.project_id),
        ...assigned.map((r) => r.project_id),
        ...viaClient.map((r) => r.id),
        ...viaPartner.map((r) => r.project_id),
      ]),
    ];
  }

  return {
    identity,
    unrestricted,
    clientIds,
    partnerIds,
    projectIds,
    // A client user is external. A partner user is external to the agency's
    // internal discussion even though they are staff elsewhere.
    externalOnly: role === 'client',
  };
}

/** `IN (?, ?, …)` with the ids inlined as parameters, or a clause that matches
 *  nothing. Returning `1 = 0` (not `IN ()`, which some engines reject) is what
 *  makes "no grants" mean "no rows" rather than "all rows". */
function inClause(column: string, values: string[]): { sql: string; params: string[] } {
  if (!values.length) return { sql: '1 = 0', params: [] };
  return { sql: `${column} IN (${values.map(() => '?').join(',')})`, params: values };
}

/**
 * Projects the scope may read. Always usable as a sub-select:
 *   `WHERE p.id IN (SELECT id FROM projects WHERE <projectsWhere>)`
 */
export function projectsWhere(scope: ReadScope, alias = 'p'): { sql: string; params: string[] } {
  if (scope.unrestricted) return { sql: '1 = 1', params: [] };
  const { sql, params } = inClause(`${alias}.id`, scope.projectIds);
  return { sql: sql === '1 = 0' ? '1 = 0' : `(${sql})`, params };
}

/**
 * Tasks the scope may read.
 *
 * A client user only ever sees client-visible work in their own projects — the
 * internal backlog is not theirs to browse, and that has to be a database
 * predicate rather than a UI decision.
 */
export function tasksWhere(scope: ReadScope, alias = 't'): { sql: string; params: string[] } {
  if (scope.unrestricted) return { sql: '1 = 1', params: [] };
  const { sql, params } = inClause(`${alias}.project_id`, scope.projectIds);
  if (sql === '1 = 0') return { sql: '1 = 0', params: [] };
  if (scope.externalOnly) {
    // `client_visible` is a SMALLINT/INTEGER 0|1 in both engines.
    return { sql: `((${sql}) AND ${alias}.client_visible = 1)`, params };
  }
  return { sql: `(${sql})`, params };
}

/** Documents: internal docs are invisible to client users unless marked shared. */
export function docsWhere(scope: ReadScope, alias = 'd'): { sql: string; params: string[] } {
  if (scope.unrestricted) return { sql: '1 = 1', params: [] };
  const projectPredicate = scope.projectIds.length
    ? inClause(`${alias}.project_id`, scope.projectIds)
    : { sql: '1 = 0', params: [] as string[] };
  if (projectPredicate.sql === '1 = 0') return { sql: '1 = 0', params: [] };
  if (scope.externalOnly) {
    return {
      sql: `((${projectPredicate.sql}) AND ${alias}.client_visible = 1)`,
      params: projectPredicate.params,
    };
  }
  return { sql: `(${projectPredicate.sql})`, params: projectPredicate.params };
}

/** Clients: a client user sees only its own org; staff see what they work with. */
export function clientsWhere(scope: ReadScope, alias = 'c'): { sql: string; params: string[] } {
  if (scope.unrestricted) return { sql: '1 = 1', params: [] };
  if (scope.clientIds.length) return inClause(`${alias}.id`, scope.clientIds);
  if (!scope.projectIds.length) return { sql: '1 = 0', params: [] };
  // Staff who work with a client's project may see that client's record.
  return {
    sql: `${alias}.id IN (SELECT client_id FROM projects WHERE id IN (${scope.projectIds.map(() => '?').join(',')}))`,
    params: scope.projectIds,
  };
}

/** Deals are commercial pipeline data: never visible to client or partner users. */
export function dealsWhere(scope: ReadScope, alias = 'd'): { sql: string; params: string[] } {
  if (scope.unrestricted) return { sql: '1 = 1', params: [] };
  if (scope.externalOnly || scope.partnerIds.length) return { sql: '1 = 0', params: [] };
  if (!scope.clientIds.length && !scope.projectIds.length) {
    return { sql: `${alias}.owner_id = ?`, params: [scope.identity.userId] };
  }
  const clientPredicate = scope.clientIds.length ? inClause(`${alias}.client_id`, scope.clientIds) : { sql: '1 = 0', params: [] as string[] };
  if (clientPredicate.sql === '1 = 0') {
    // Staff see deals they own, plus deals for clients they have project work in.
    return {
      sql: `(${alias}.owner_id = ? OR ${alias}.client_id IN (SELECT client_id FROM projects WHERE id IN (${scope.projectIds.map(() => '?').join(',')})))`,
      params: [scope.identity.userId, ...scope.projectIds],
    };
  }
  return clientPredicate;
}

/**
 * Assert the scope may read one project, before any row is fetched.
 *
 * Used by single-record endpoints so a denial is identical to a missing record
 * (no enumeration oracle) and cannot be bypassed by guessing an id.
 */
export async function assertProjectInScope(scope: ReadScope, projectId: string | null): Promise<void> {
  if (!projectId) return;
  if (scope.unrestricted) return;
  if (scope.projectIds.includes(projectId)) return;
  // 404, not 403. A 403 would confirm that the record exists and merely isn't
  // yours, which is an enumeration oracle: an attacker learns which ids are
  // real by comparing responses. Tenancy denials are indistinguishable from
  // absence. Role denials (e.g. a member waiving a gate) stay 403, because
  // those are about the caller's capability, not about whether a row exists.
  const { notFound } = await import('../lib/http.ts');
  throw notFound('Not found');
}
