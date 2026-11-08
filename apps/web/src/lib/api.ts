/** Typed API client. Single origin: the browser always calls /api on itself. */
import type {
  AcceptanceStep, Activity, ClientSummary, DashboardData, Deal, Doc, Issue, Meta, PlanResult,
  Partner, PipelineData, ProjectDetail, ProjectSummary, QAReport, Release, ShipGate, ClockHealth, LiveTimer, Task, TaskDetail, User,
} from '../types';

const BASE = '/api';

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
 * CSRF token for cookie-authenticated mutations.
 *
 * Sessions live in an HttpOnly cookie (not readable by JS, by design), so the
 * token arrives from /api/auth/me and is cached in memory only — never
 * localStorage, so a successful XSS cannot lift a long-lived credential.
 */
let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

/** Fired when the session is gone, so the app can return to the sign-in screen. */
export const AUTH_EXPIRED_EVENT = 'relay:auth-expired';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(BASE + path, { ...init, headers, credentials: 'same-origin' });

  /**
   * Parse defensively.
   *
   * A non-JSON body used to escape as a `SyntaxError` from `JSON.parse`, which
   * reads as an application bug in the UI. It is not: a platform error page, a
   * proxy timeout, or a 502 from an upstream that never reached this app all
   * arrive as HTML. Reporting the status is honest; reporting "Unexpected token
   * '<'" sends the reader hunting for a bug that does not exist.
   */
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const err = body?.error ?? {};
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    }
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

export interface SessionInfo {
  user: SessionUser;
  method: string;
  authMode: 'oidc' | 'dev' | 'password';
  expiresAt: string;
  csrfToken: string | null;
  permissions: Record<string, boolean>;
}

export const auth = {
  async me(): Promise<SessionInfo> {
    const me = await request<SessionInfo>('/auth/me');
    setCsrfToken(me.csrfToken);
    return me;
  },
  /**
   * The shared-credential login. This is the primary sign-in for this deployment:
   * one username and one password, no registration and no guest path.
   */
  async login(username: string, password: string): Promise<SessionInfo> {
    const out = await request<{ user: SessionUser; csrfToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setCsrfToken(out.csrfToken);
    return this.me();
  },
  /** Local development only — refused once a shared credential exists, and in production. */
  async devLogin(userId?: string): Promise<SessionInfo> {
    const out = await request<{ user: SessionUser; csrfToken: string }>('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify(userId ? { userId } : {}),
    });
    setCsrfToken(out.csrfToken);
    return this.me();
  },
  async logout(): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      setCsrfToken(null);
    }
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
  project: (id: string) => request<ProjectDetail>(`/projects/${id}`),
  updatePhase: (projectId: string, phaseRowId: string, patch: Record<string, unknown>) =>
    request(`/projects/${projectId}/phases/${phaseRowId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  pipeline: () => request<PipelineData>('/pipeline'),
  updateDeal: (id: string, patch: Record<string, unknown>) =>
    request(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  clients: () => request<ClientSummary[]>('/clients'),
  partners: () => request<Partner[]>('/partners'),
  qa: (params: { projectId?: string; status?: string } = {}) => request<QAReport[]>(`/qa${qs(params)}`),
  createQA: (payload: Record<string, unknown>) => request<{ id: string }>('/qa', { method: 'POST', body: JSON.stringify(payload) }),
  updateQA: (id: string, patch: Record<string, unknown>) => request(`/qa/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  releases: () => request<Release[]>('/releases'),
  releaseGate: (id: string) => request<ShipGate>(`/releases/${id}/gate`),
  insights: () => request<{ insights: Issue[]; generatedAt: string }>('/insights'),
  activity: (limit = 30) => request<Activity[]>(`/activity?limit=${limit}`),
  notifications: () => request<Array<{ id: string; kind: string; title: string; body: string; readAt: string | null; createdAt: string }>>('/notifications'),
  readNotification: (id: string) => request(`/notifications/${id}/read`, { method: 'POST' }),
  docs: (projectId?: string) => request<Doc[]>(`/docs${qs({ projectId })}`),
  search: (q: string) =>
    request<{ tasks: Task[]; projects: Array<{ id: string; key: string; name: string }>; clients: Array<{ id: string; name: string }>; deals: Deal[]; docs: Doc[] }>(
      `/search?q=${encodeURIComponent(q)}`,
    ),
  sweepClocks: () => request<{ swept: number }>('/clocks/sweep', { method: 'POST' }),
  users: () => request<User[]>('/users'),
};
