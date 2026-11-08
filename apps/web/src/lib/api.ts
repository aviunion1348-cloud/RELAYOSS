/** Typed API client. Single origin: the browser always calls /api on itself. */
import type {
  AcceptanceStep, Activity, ClientSummary, DashboardData, Deal, Doc, Issue, Meta, PlanResult,
  Partner, PipelineData, ProjectDetail, ProjectSummary, QAReport, Release, ClockHealth, LiveTimer, Task, TaskDetail, User,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = body?.error ?? { code: 'unknown', message: res.statusText };
    throw new ApiError(res.status, err.code, err.message, err.details);
  }
  return (body?.data ?? body) as T;
}

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
