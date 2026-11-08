/** Shared client-side types mirroring the API contract. */

export type Priority = 'urgent' | 'high' | 'medium' | 'low';
export type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';
export type RiskBand = 'low' | 'medium' | 'high' | 'critical';
export type AcceptanceStep = 'dev_complete' | 'qa_approved' | 'lead_approved' | 'client_accepted';

export interface User {
  id: string;
  email: string;
  name: string;
  title: string;
  role: 'admin' | 'lead' | 'member' | 'client' | 'bot';
  initials: string;
  color: string;
  capacityHoursWeek: number;
  skills: string[];
  billRateCents: number;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  description?: string;
}

export interface ClientSummary {
  id: string;
  name: string;
  slug: string;
  industry: string;
  initials: string;
  color: string;
  tier: string;
  health: 'healthy' | 'watch' | 'at_risk' | 'churn';
  contactName: string;
  contactRole: string;
  contactEmail?: string;
  mrrCents: number;
  openValueCents: number;
  wonValueCents: number;
  projectCount: number;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  clientId: string;
  clientName: string;
  clientColor: string;
  status: string;
  health: string;
  owner: { id: string; name: string; initials: string; color: string } | null;
  budgetCents: number;
  hoursBudget: number;
  targetEndAt: string | null;
  progress: number;
  taskCount: number;
  doneCount: number;
  openTasks: number;
  loggedHours: number;
  branch: string;
  deployTarget: string;
  edgeCaseTarget: number;
  demoCadenceDays: number;
  retentionRisk: string;
  description: string;
}

export interface Task {
  id: string;
  key: string;
  title: string;
  type: string;
  priority: Priority;
  status: Status;
  columnId: string;
  boardId: string;
  projectId: string | null;
  projectKey: string | null;
  clientName: string | null;
  clientColor: string | null;
  phaseName: string | null;
  phaseColor: string | null;
  assignee: { id: string; name: string; initials: string; color: string } | null;
  storyPoints: number;
  estimateHours: number;
  loggedHours: number;
  dueAt: string | null;
  slaDueAt: string | null;
  blockedReason: string;
  turnoverState: 'draft' | 'in_review' | 'passed' | 'failed' | 'waived';
  acceptanceStep: AcceptanceStep;
  clientVisible: boolean;
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  counts: { comments: number; checklist: number; checklistDone: number; dependencies: number; subtasks: number };
  sla?: 'ok' | 'at_risk' | 'breached' | 'met' | 'none';
  slaHoursLeft?: number | null;
  risk?: { score: number; band: RiskBand; factors: Array<{ key: string; label: string; weight: number; detail: string }> };
}

export interface TurnoverCheck {
  gateId: string;
  key: string;
  name: string;
  description: string;
  required: boolean;
  ownerRole: string;
  autoRule: string;
  status: 'pending' | 'pass' | 'fail' | 'waived';
  evidence: string;
  checkedAt: string | null;
}

export interface TaskDetail extends Omit<Task, 'counts' | 'labels'> {
  description: string;
  reporter: { name: string } | null;
  labels: Label[];
  project: { id: string; key: string; name: string } | null;
  client: { name: string; color: string } | null;
  phase: { name: string; color: string } | null;
  turnoverCriteria: string;
  branch: string;
  prUrl: string;
  comments: Array<{ id: string; body: string; createdAt: string; author: { name: string; initials: string; color: string } }>;
  checklist: Array<{ id: string; label: string; done: boolean }>;
  acceptance: Array<{ step: AcceptanceStep; state: 'pending' | 'passed' | 'rejected' | 'skipped'; actorId: string | null; evidence: string; notes: string; decidedAt: string | null }>;
  turnover: { ready: boolean; passed: number; required: number; score: number; blockers: Array<{ gate_id: string; name: string; reason: string }>; checks: TurnoverCheck[] };
  timers: Array<{ id: string; label: string; clock: string; dueAt: string; outcome: string; minutesUsed: number }>;
  activity: Array<{ verb: string; summary: string; createdAt: string; actor: { name: string; initials: string; color: string } | null }>;
  dependencies: Array<{ id: string; key: string; title: string; status: string; priority: string }>;
  blockedBy: Array<{ id: string; key: string; title: string; status: string }>;
  subtasks: Array<{ id: string; key: string; title: string; status: string; priority: string }>;
  timeEntries: Array<{ minutes: number; note: string; workedOn: string; user: string }>;
}

export interface ClockHealth {
  key: string;
  name: string;
  scope: string;
  targetHours: number;
  warnHours: number;
  stretchHours: number | null;
  policyNote: string;
  boardRef: string;
  escalation: string;
  running: number;
  met: number;
  missed: number;
  waived: number;
  compliancePct: number;
  avgHours: number | null;
  atRisk: number;
}

export interface LiveTimer {
  id: string;
  clock: string;
  clockName: string;
  scope: string;
  entityType: string;
  entityId: string;
  label: string;
  startedAt: string;
  dueAt: string;
  outcome: string;
  exceptionNote: string;
  hoursLeft: number;
  progressPct: number;
  targetHours: number;
}

export interface Deal {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
  clientColor: string;
  valueCents: number;
  currency: string;
  status: string;
  stageKey: string;
  stageName: string;
  stagePhase: string;
  stageColor: string;
  owner: { id: string; name: string; initials: string; color: string } | null;
  probability: number;
  startedAt: string;
  nextStep: string;
  lostReason: string;
  slaDays: number;
  ageDays: number;
  phases?: Array<{ id: string; name: string; color: string; status: string; phase_key: string }>;
}

export interface PipelineData {
  columns: Array<{
    id: string;
    key: string;
    name: string;
    phase: string;
    color: string;
    icon: string;
    description: string;
    entryCriteria: string;
    exitCriteria: string;
    slaDays: number;
    deals: Deal[];
    valueCents: number;
  }>;
  deals: Deal[];
  summary: {
    pipelineValueCents: number;
    weightedCents: number;
    openDeals: number;
    wonValueCents: number;
    lostValueCents: number;
    avgAgeDays: number;
    byPhase: Record<string, number>;
  };
}

export interface QAReport {
  id: string;
  title: string;
  kind: string;
  severity: string;
  status: string;
  project: { id: string; name: string; key: string };
  reporter: string;
  assignee: string;
  reproduction: string;
  evidenceUrl: string;
  submittedAt: string;
  resolvedAt: string | null;
  dueAt: string | null;
  hoursLeft: number | null;
  overdue: boolean;
}

export interface Release {
  id: string;
  version: string;
  name: string;
  status: string;
  project: { id: string; name: string; key: string };
  clientName: string;
  clientColor: string;
  demoAt: string | null;
  demoApprovedAt: string | null;
  execSummaryDueAt: string | null;
  execSummaryUrl: string;
  shipPlannedAt: string | null;
  shippedAt: string | null;
  branch: string;
  deployTarget: string;
  rollbackPlan: string;
  demoFeedback: string;
  /** Server-computed ship gate. Present so the UI can never show a green
   *  light the server would refuse. */
  gate?: ShipGate;
  acknowledgements?: Array<{ signal: string; state: string; source: string; receivedAt: string | null }>;
}

export interface ShipGateCheck {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
  actual?: number;
  required?: number;
}

export interface ShipGate {
  releaseId: string;
  shippable: boolean;
  checks: ShipGateCheck[];
  blockedReason: string;
  evaluatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  phases: Array<{
    id: string;
    key: string;
    name: string;
    color: string;
    description: string;
    status: string;
    progress: number;
    slaDays: number;
    turnoverPolicy: string;
    startedAt: string | null;
    dueAt: string | null;
    completedAt: string | null;
    signoff: string | null;
    turnoverPassed: boolean;
    taskCount: number;
    doneCount: number;
    gateScore: number;
    gates: Array<{ id: string; key: string; name: string; required: boolean; status: string; evidence: string }>;
  }>;
  edgeCases: {
    total: number;
    target: number;
    verified: number;
    progressPct: number;
    byStatus: Record<string, number>;
    byCategory: Array<{ category: string; count: number }>;
  };
  releases: Release[];
  handoffs: Array<{ id: string; title: string; type: string; url: string; status: string; shared_at: string | null }>;
  qa: QAReport[];
  docs: Array<{ id: string; title: string; kind: string; status: string; updated_at: string; client_visible: number }>;
  timers: LiveTimer[];
  shipGate: { edgeCases: boolean; edgeVerified: boolean; openP0: boolean; execSummary: boolean; clientAccepted: boolean };
}

export interface Partner {
  id: string;
  name: string;
  slug: string;
  consoleUrl: string;
  plan: string;
  status: string;
  clientName: string;
  clientColor: string;
  deviceLimit: number;
  devicesActive: number;
  apiQuota: number;
  apiCalls: number;
  seatLimit: number;
  seats: number;
  mfaPct: number;
  uptimePct: number;
  usage: Array<{ day: string; apiCalls: number; activeUsers: number }>;
}

export interface Issue {
  kind: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  body: string;
  action: { label: string; taskId: string } | null;
}

export interface Activity {
  id: number;
  entityType: string;
  entityId: string;
  verb: string;
  summary: string;
  createdAt: string;
  actor: { name: string; initials: string; color: string } | null;
}

export interface Doc {
  id: string;
  title: string;
  kind: string;
  body: string;
  status: string;
  projectName: string | null;
  clientVisible: boolean;
  updatedAt: string;
}

export interface Meta {
  users: User[];
  labels: Label[];
  clients: ClientSummary[];
  projects: ProjectSummary[];
  boards: Array<{ id: string; name: string; kind: string; projectId: string | null; projectKey: string | null; projectName: string | null; color: string | null }>;
  currentUser: User;
  priorities: Priority[];
  types: string[];
  acceptanceLadder: AcceptanceStep[];
  slaHours: Record<Priority, { response: number; resolve: number }>;
}

export interface PlanResult {
  items: Array<{
    task_id: string;
    key: string;
    title: string;
    assignee_id: string;
    assignee_name: string;
    sequence: number;
    planned_start: string;
    planned_end: string;
    planned_hours: number;
    risk_score: number;
    risk_band: string;
    critical: boolean;
    slack_days: number;
    rationale: string;
    project: { id: string; key: string; name: string } | null;
  }>;
  unassigned: Array<{ task_id: string; key: string; title: string; reason: string }>;
  stats: {
    horizonDays: number;
    tasksScheduled: number;
    tasksUnassigned: number;
    totalHours: number;
    utilisation: number;
    lateTasks: number;
    criticalCount: number;
    overloadedPeople: Array<{ user_id: string; name: string; planned: number; capacity: number }>;
    throughputPerWeek: number;
    makespanDays: number;
  };
  perPerson: Array<{ user_id: string; name: string; hours: number; capacity: number; utilisation: number; days: Record<string, number> }>;
  generatedAt: string;
}

export interface DashboardData {
  kpis: {
    openTasks: number;
    inFlight: number;
    blocked: number;
    shippedThisWeek: number;
    atRisk: number;
    slaBreaches: number;
    turnoverBlocked: number;
    pipelineValueCents: number;
    weightedCents: number;
    openDeals: number;
    clientHealth: { healthy: number; watch: number; atRisk: number; churn: number };
    billableHoursWeek: number;
  };
  byStatus: Record<string, number>;
  throughput: Array<{ day: string; completed: number; created: number }>;
  focus: Task[];
  escalations: Task[];
  workload: Array<{ id: string; name: string; initials: string; color: string; capacity: number; planned: number; utilisation: number; activeTasks: number }>;
  projects: Array<{ id: string; key: string; name: string; status: string; health: string; clientName: string; color: string; progress: number; total: number; done: number }>;
  clocks: ClockHealth[];
  timers: LiveTimer[];
  pipelineByPhase: Array<{ phase: string; valueCents: number; count: number }>;
}
