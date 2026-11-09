/** Typed API client. Single origin: the browser always calls /api on itself. */
import type {
  AcceptanceStep, Activity, ClientSummary, DashboardData, Deal, Doc, Issue, Meta, PlanResult,
  Partner, PipelineData, ProjectDetail, ProjectSummary, QAReport, Release, ShipGate, ClockHealth, LiveTimer, Task, TaskDetail, User,
} from '../types';

const BASE = '/api';

/**
 * How long a request may stay unanswered before it is abandoned.
 *
 * Without this, a request that never receives a response never settles, and the
 * promise the UI is awaiting never resolves. The screen then waits for a result
 * that is not coming; that is the "it just buffers" failure, and no amount of
 * error handling downstream can catch a promise that never rejects. A serverless
 * invocation that is killed, a proxy that holds a connection open, or a dropped
 * mobile connection all produce it.
 *
 * 20 seconds is chosen against the product's own behaviour, not a round number:
 * the heaviest screen is the planner over a long horizon, which answers in well
 * under a second on seeded data. Anything past 20s is not slow, it is stuck — and
 * a stale spinner is worse than an error, because the error can be retried.
 *
 * Callers can override it per request (a long report export would be entitled to)
 * via `deadlineMs`.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The request did not complete: no HTTP status was ever received.
 *
 * Kept distinct from `ApiError` so the UI can say "the connection failed" rather
 * than inventing a status code. `code` is `timeout` when the deadline above
 * fired and `network` when the browser reported a transport failure, which is
 * the difference between "the server is thinking too long" and "the server was
 * never reached".
 */
export class NetworkError extends Error {
  code: 'timeout' | 'network';
  constructor(code: 'timeout' | 'network', message: string) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
  }
}

/**
 * No CSRF token, and no session-expiry signal.
 *
 * CSRF protection exists to stop a third-party page from riding a *victim's
 * ambient cookie*. This deployment sets no cookie, so there is no ambient
 * authority to ride and nothing for a token to bind to. The token cache, the
 * `x-csrf-token` header and the `relay:auth-expired` event that navigated back to
 * a sign-in screen are all gone rather than left as dead code that implies a
 * security property which no longer exists.
 */

/**
 * Exposed for one purpose: proving the deadline fires.
 *
 * A timeout that is never exercised is a timeout that quietly stops working — and
 * the failure mode it prevents (waiting forever) is invisible to every test that
 * runs against a healthy server. `scripts/smoke-web.mjs` races this against an
 * endpoint that never answers.
 *
 * `base` is overridable only for that test: in the browser the base must stay the
 * single-origin `/api`.
 */
export async function requestWithDeadline<T>(path: string, init?: RequestInit & { deadlineMs?: number; base?: string }): Promise<T> {
  return request<T>(path, init);
}

async function request<T>(path: string, init?: RequestInit & { deadlineMs?: number; base?: string }): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body) headers['content-type'] = 'application/json';

  /*
   * A deadline, enforced by the browser rather than trusted from the server.
   *
   * `AbortSignal.timeout` aborts the fetch itself, so the socket is released and
   * the promise below rejects — the one thing that turns "buffering forever" into
   * an error a screen can show. `init.signal` is honoured when a caller supplies
   * its own (the search box cancels superseded keystrokes that way); combining
   * both means a manual cancel still works and the deadline still applies.
   */
  const deadline = init?.deadlineMs ?? DEFAULT_TIMEOUT_MS;
  /*
   * Build the deadline defensively, and inside the protected region.
   *
   * `AbortSignal.timeout` is Safari 16+ and Chrome 103+; `AbortSignal.any` is
   * newer still. On an older browser these are `undefined`, so calling them throws
   * a TypeError — and because this ran *before* the try block below, that error
   * escaped as a raw TypeError from every single request. One missing API, every
   * panel dead at once, reported as "the request never reached the server". It was
   * my bug, and it is the exact "fails in every feature" shape worth guarding.
   *
   * The fallback is a plain timer with `AbortController`, which every browser that
   * can run this bundle at all supports. The deadline is a safety net, not a
   * feature — it must never be the reason the application stops working.
   */
  const controller = AbortSignal.timeout && typeof AbortSignal.timeout === 'function' ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let signal: AbortSignal;
  try {
    if (controller) {
      timer = setTimeout(() => controller.abort(), deadline);
      signal = init?.signal
        ? (AbortSignal.any?.([init.signal, controller.signal]) ?? controller.signal)
        : controller.signal;
    } else if (init?.signal && AbortSignal.any) {
      signal = AbortSignal.any([init.signal, AbortSignal.timeout(deadline)]);
    } else {
      // A caller-supplied signal without `AbortSignal.any`: honour the deadline,
      // since a stuck request is worse than an uncancellable one.
      signal = AbortSignal.timeout(deadline);
    }
  } catch {
    /*
     * No usable abort primitive at all. Proceed without a deadline rather than
     * failing the request: an unbounded wait is bad, and every screen failing is
     * worse.
     */
    signal = init?.signal ?? new AbortController().signal;
  }

  /*
   * `credentials: 'omit'` states the intent: no cookie is sent, because the API
   * authenticates nothing by cookie. Leaving `same-origin` would keep working, but
   * it would also quietly re-enable cookie semantics if one were ever set.
   */
  let res: Response;
  try {
    res = await fetch((init?.base ?? BASE) + path, { ...init, headers, credentials: 'omit', signal });
  } catch (cause) {
    if (timer) clearTimeout(timer);
    /*
     * The fetch itself failed, so there is no status to report. Previously this
     * escaped as a bare `TypeError: Failed to fetch` — and, before the timeout
     * existed, a hang never got here at all, which is exactly how a screen could
     * wait forever with no error to render.
     */
    const aborted = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    if (aborted) {
      throw new NetworkError(
        'timeout',
        `No response from the server within ${Math.round(deadline / 1000)}s. The request was abandoned so the page does not wait indefinitely.`,
      );
    }
    throw new NetworkError(
      'network',
      // The browser's own text is kept: on a misrouted deployment it names the
      // actual fault (blocked, refused, CORS) instead of a guess about the API.
      `The request never reached the server${cause instanceof Error && cause.message ? `: ${cause.message}` : '.'}`,
    );
  }

  /**
   * Parse defensively.
   *
   * A non-JSON body used to escape as a `SyntaxError` from `JSON.parse`, which
   * reads as an application bug in the UI. It is not: a platform error page, a
   * proxy timeout, or a 502 from an upstream that never reached this app all
   * arrive as HTML. Reporting the status is honest; reporting "Unexpected token
   * '<'" sends the reader hunting for a bug that does not exist.
   */
  if (timer) clearTimeout(timer);
  const text = await res.text();
  let body: any = null;
  let parsed = false;
  if (text) {
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      body = null;
    }
  }

  /**
   * A *successful* response that is not JSON is not a success.
   *
   * This is the other way a screen could buffer, and on a deployment it is the
   * likeliest one. The checks below only rejected a bad *status*, so a `200` whose
   * body was an HTML page — which is exactly what the platform returns when `/api`
   * is routed to the web service instead of the API service, or when a stale
   * service is promoted — parsed to `null`, sailed through, and was handed to the
   * component as `data`. The component's `!data` check then treated it as "still
   * loading" and showed a skeleton, with no error anywhere to explain it.
   *
   * Reporting it as a routing fault is the honest answer: the request reached
   * something, and that something served the wrong application.
   */
  if (res.ok && !parsed) {
    const looksHtml = /^\s*<(!doctype|html)/i.test(text);
    throw new NetworkError(
      'network',
      looksHtml
        ? 'The API address served an HTML page instead of JSON. This is a routing fault: /api is being answered by the web application rather than the API service.'
        : `The API returned ${res.status} with a body that is not JSON (${text.length} bytes). The response cannot be used.`,
    );
  }

  if (!res.ok) {
    const err = body?.error ?? {};
    /*
     * A 401 is no longer a navigation instruction. Previously it fired an event
     * that returned the whole application to the sign-in screen; with no sign-in
     * screen there is nowhere to return to, and the correct behaviour is to report
     * the failure to the component that asked and let it show what it can.
     */
    throw new ApiError(
      res.status,
      err.code ?? 'unknown',
      // A misconfigured deployment reports `summary` rather than `message`.
      err.message ?? err.summary ?? (body === null && res.status >= 500
        ? `The API returned ${res.status} with a non-JSON response.`
        : res.statusText || `Request failed with ${res.status}`),
      err,
    );
  }
  return (body?.data ?? body) as T;
}

/** The detail a deployment sends when it cannot serve requests. */
export interface MisconfiguredDetail {
  code: 'misconfigured';
  stage?: 'configuration' | 'database';
  summary: string;
  missing: string[];
  /** Absent but not fatal, with the consequence of its absence. */
  optional?: Array<{ name: string; consequence: string }>;
  invalid: Array<{ name: string; problem: string }>;
  remedy: string[];
}

/**
 * True when the API answered that it is not provisioned.
 *
 * Checked by shape as well as by code: the frontend and the API are separate
 * services with independent build artifacts, so a frontend built from a newer
 * commit can face an older API that has no `misconfigured` code yet.
 */
export function isMisconfigured(err: unknown): err is ApiError & { details: MisconfiguredDetail } {
  if (!(err instanceof ApiError)) return false;
  const details = err.details as Partial<MisconfiguredDetail> | undefined;
  return err.status === 503 && Boolean(details) && Array.isArray((details as MisconfiguredDetail).remedy);
}


export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'lead' | 'member' | 'client' | 'bot';
}

/**
 * What the API reports about this deployment.
 *
 * Not a session. There is no session. It carries the operator's name and role so
 * the shell can display them, and `authMode: 'none'` states plainly that nothing
 * authenticates.
 */
export interface SessionInfo {
  user: SessionUser;
  authMode: 'none' | 'oidc' | 'dev' | 'password';
  method?: string;
  expiresAt?: string | null;
  csrfToken?: string | null;
  permissions?: Record<string, boolean>;
}

export const auth = {
  /**
   * Deployment description. Called once at startup, and never used to gate
   * anything: the dashboard renders whether or not this succeeds.
   */
  async me(): Promise<SessionInfo> {
    return request<SessionInfo>('/auth/session');
  },
  /**
   * Signing in and out is gone.
   *
   * These remain as explicit failures rather than being deleted, so that any
   * component still wired to them fails loudly during development instead of
   * appearing to work. `410 Gone` is what the API answers too.
   */
  async login(): Promise<never> {
    throw new ApiError(410, 'auth_removed', 'Authentication has been removed from this deployment.');
  },
  async devLogin(): Promise<never> {
    throw new ApiError(410, 'auth_removed', 'Authentication has been removed from this deployment.');
  },
  async logout(): Promise<void> {
    /* Nothing to end. */
  },
  /**
   * The demo identities offered by the local sign-in screen.
   *
   * Not `/users`: that is the authenticated staff directory and requires a
   * session, which a visitor on the sign-in screen does not have — so calling it
   * here made the picker fail 100% of the time with a 401 that read as "the API
   * is not running". `/auth/dev-users` is the anonymous, minimal counterpart.
   */
  async users(): Promise<Array<{ id: string; name: string; role: string; title: string; initials: string; color: string }>> {
    const users = await request<Array<Record<string, any>>>('/auth/dev-users');
    return users.map((u) => ({ id: u.id, name: u.name ?? u.fullName, role: u.role, title: u.title, initials: u.initials, color: u.color }));
  },
};

const qs = (params: Record<string, unknown>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

export interface TaskFilters {
  boardId?: string;
  projectId?: string;
  assignee?: string;
  priority?: string[];
  status?: string[];
  type?: string[];
  labelId?: string;
  q?: string;
  mine?: boolean;
  clientVisible?: boolean;
  limit?: number;
}

export const api = {
  meta: () => request<Meta>('/meta'),
  dashboard: () => request<DashboardData>('/dashboard'),
  tasks: (filters: TaskFilters = {}) =>
    request<{ data: Task[]; meta: { total: number } } | Task[]>(`/tasks${qs(filters as Record<string, unknown>)}`).then(
      (r) => (Array.isArray(r) ? r : r.data),
    ),
  task: (id: string) => request<TaskDetail>(`/tasks/${id}`),
  createTask: (payload: Record<string, unknown>) => request<TaskDetail>('/tasks', { method: 'POST', body: JSON.stringify(payload) }),
  updateTask: (id: string, patch: Record<string, unknown>) =>
    request<TaskDetail>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  comment: (id: string, body: string) => request<{ id: string }>(`/tasks/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
  toggleChecklist: (taskId: string, itemId: string, done: boolean) =>
    request(`/tasks/${taskId}/checklist/${itemId}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
  addChecklist: (taskId: string, label: string) =>
    request(`/tasks/${taskId}/checklist`, { method: 'POST', body: JSON.stringify({ label }) }),
  turnoverCheck: (taskId: string, gateId: string, status: string, evidence?: string) =>
    request<TaskDetail>(`/tasks/${taskId}/turnover/${gateId}`, { method: 'PATCH', body: JSON.stringify({ status, evidence }) }),
  acceptance: (taskId: string, step: AcceptanceStep, state: 'passed' | 'rejected', evidence?: string, notes?: string) =>
    request(`/tasks/${taskId}/acceptance`, { method: 'POST', body: JSON.stringify({ step, state, evidence, notes }) }),
  planner: (horizon = 21) => request<PlanResult>(`/planner?horizon=${horizon}`),
  clocks: () => request<{ clocks: ClockHealth[]; timers: LiveTimer[] }>('/clocks'),
  resolveTimer: (id: string, outcome: string, note?: string) =>
    request(`/clocks/timers/${id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome, note }) }),
  projects: () => request<ProjectSummary[]>('/projects'),
  createProject: (payload: Record<string, unknown>) =>
    request<{ id: string; key: string; name: string }>('/projects', { method: 'POST', body: JSON.stringify(payload) }),
  deleteProject: (id: string) =>
    request<{ id: string; removed: Record<string, number> }>(`/projects/${id}`, { method: 'DELETE' }),
  project: (id: string) => request<ProjectDetail>(`/projects/${id}`),
  updatePhase: (projectId: string, phaseRowId: string, patch: Record<string, unknown>) =>
    request(`/projects/${projectId}/phases/${phaseRowId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  pipeline: () => request<PipelineData>('/pipeline'),
  createDeal: (payload: Record<string, unknown>) =>
    request<{ id: string }>('/deals', { method: 'POST', body: JSON.stringify(payload) }),
  deleteDeal: (id: string) => request<{ id: string }>(`/deals/${id}`, { method: 'DELETE' }),
  updateDeal: (id: string, patch: Record<string, unknown>) =>
    request(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  clients: () => request<ClientSummary[]>('/clients'),
  createClient: (payload: Record<string, unknown>) =>
    request<ClientSummary>('/clients', { method: 'POST', body: JSON.stringify(payload) }),
  partners: () => request<Partner[]>('/partners'),
  createPartner: (payload: Record<string, unknown>) =>
    request<Partner>('/partners', { method: 'POST', body: JSON.stringify(payload) }),
  deletePartner: (id: string) => request<{ id: string }>(`/partners/${id}`, { method: 'DELETE' }),
  qa: (params: { projectId?: string; status?: string } = {}) => request<QAReport[]>(`/qa${qs(params)}`),
  createQA: (payload: Record<string, unknown>) => request<{ id: string }>('/qa', { method: 'POST', body: JSON.stringify(payload) }),
  updateQA: (id: string, patch: Record<string, unknown>) => request(`/qa/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  releases: () => request<Release[]>('/releases'),
  createRelease: (payload: Record<string, unknown>) =>
    request<Release>('/releases', { method: 'POST', body: JSON.stringify(payload) }),
  updateRelease: (id: string, patch: Record<string, unknown>) =>
    request<Release>(`/releases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteRelease: (id: string) => request<{ id: string }>(`/releases/${id}`, { method: 'DELETE' }),
  releaseGate: (id: string) => request<ShipGate>(`/releases/${id}/gate`),
  /*
   * The change feed: one integer that says whether anything was written.
   *
   * `since` is exclusive, so the caller passes the last id it accounted for.
   */
  changes: (since: number) =>
    request<{ since: number; latestId: number; changed: string[]; writes: number }>(
      `/changes?since=${since}`,
    ),
  audit: (params: { limit?: number; entityType?: string } = {}) =>
    request<Array<{
      id: number; action: string; entityType: string; entityId: string;
      actor: string | null; actorInitials: string | null;
      before: unknown; after: unknown; createdAt: string;
    }>>(`/audit${qs(params)}`),
  insights: () => request<{
    insights: Issue[];
    dismissed: Array<{
      key: string; kind: string; subject: string; reason: string;
      dismissedBy: string | null; dismissedAt: string; mutedUntil: string | null;
      /** The live finding, or `null` when it no longer fires. */
      insight: Issue | null;
    }>;
    generatedAt: string;
  }>('/insights'),
  /*
   * Acknowledging a finding. The analysis is untouched — what is recorded is that a
   * person looked at it and chose to accept it, with a reason and a name.
   */
  dismissInsight: (key: string, payload: { reason?: string; muteHours?: number }) =>
    request<{ key: string; dismissed: true; mutedUntil: string | null }>(
      `/insights/${encodeURIComponent(key)}/dismiss`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  restoreInsight: (key: string) =>
    request<void>(`/insights/${encodeURIComponent(key)}/dismiss`, { method: 'DELETE' }),
  activity: (limit = 30) => request<Activity[]>(`/activity?limit=${limit}`),
  notifications: () => request<Array<{ id: string; kind: string; title: string; body: string; readAt: string | null; createdAt: string }>>('/notifications'),
  readNotification: (id: string) => request(`/notifications/${id}/read`, { method: 'POST' }),
  docs: (projectId?: string) => request<Doc[]>(`/docs${qs({ projectId })}`),
  /*
   * The document writes.
   *
   * Until now `docs()` was the whole contract: the knowledge base could be read and
   * never written, which is a strange thing for the one artefact in a delivery org
   * that people actually author.
   *
   * `remove()` returns `void` because the route answers 204 with no body; asking for
   * JSON there would parse an empty string and throw on a successful delete.
   */
  createDoc: (payload: {
    title: string;
    kind?: string;
    body?: string;
    status?: string;
    projectId?: string | null;
    clientVisible?: boolean;
  }) => request<Doc>('/docs', { method: 'POST', body: JSON.stringify(payload) }),
  updateDoc: (id: string, patch: Partial<Pick<Doc, 'title' | 'kind' | 'body' | 'status'>> & { clientVisible?: boolean }) =>
    request<Doc>(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDoc: (id: string) => request<void>(`/docs/${id}`, { method: 'DELETE' }),
  updateClient: (id: string, patch: Record<string, unknown>) =>
    request<ClientSummary>(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteClient: (id: string) => request<void>(`/clients/${id}`, { method: 'DELETE' }),
  updatePartner: (id: string, patch: Record<string, unknown>) =>
    request<Partner>(`/partners/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  search: (q: string) =>
    request<{ tasks: Task[]; projects: Array<{ id: string; key: string; name: string }>; clients: Array<{ id: string; name: string }>; deals: Deal[]; docs: Doc[] }>(
      `/search?q=${encodeURIComponent(q)}`,
    ),
  sweepClocks: () => request<{ swept: number }>('/clocks/sweep', { method: 'POST' }),
  users: () => request<User[]>('/users'),
};
