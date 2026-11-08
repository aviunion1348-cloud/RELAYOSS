/**
 * Row → domain mappers and shared SQL fragments.
 * Keeps snake_case persistence details out of the HTTP contract.
 */

import { toDate } from '../lib/dates.ts';

export const TASK_SELECT = `
  SELECT t.*,
         a.full_name  AS assignee_name,
         a.initials   AS assignee_initials,
         a.avatar_color AS assignee_color,
         r.full_name  AS reporter_name,
         p.key        AS project_key,
         p.name       AS project_name,
         p.client_id  AS client_id,
         c.name       AS client_name,
         c.accent_color AS client_color,
         ph.name      AS phase_name,
         ph.color     AS phase_color,
         (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id)        AS comment_count,
         (SELECT COUNT(*) FROM task_checklist ck WHERE ck.task_id = t.id)       AS checklist_total,
         (SELECT COUNT(*) FROM task_checklist ck WHERE ck.task_id = t.id AND ck.done = 1) AS checklist_done,
         (SELECT COUNT(*) FROM task_dependencies d WHERE d.task_id = t.id)      AS dependency_count,
         (SELECT COUNT(*) FROM tasks sub WHERE sub.parent_id = t.id)            AS subtask_count
  FROM tasks t
  LEFT JOIN users a       ON a.id = t.assignee_id
  LEFT JOIN users r       ON r.id = t.reporter_id
  LEFT JOIN projects p    ON p.id = t.project_id
  LEFT JOIN clients c     ON c.id = p.client_id
  LEFT JOIN project_phases pp ON pp.id = t.project_phase_id
  LEFT JOIN phases ph     ON ph.id = pp.phase_id
`;

export function mapTask(row: Record<string, any>) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    description: row.description,
    type: row.type,
    priority: row.priority,
    status: row.status,
    columnId: row.column_id,
    boardId: row.board_id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    clientId: row.client_id,
    clientName: row.client_name,
    clientColor: row.client_color,
    phaseName: row.phase_name,
    phaseColor: row.phase_color,
    assignee: row.assignee_id
      ? { id: row.assignee_id, name: row.assignee_name, initials: row.assignee_initials, color: row.assignee_color }
      : null,
    reporter: row.reporter_name ? { name: row.reporter_name } : null,
    storyPoints: row.story_points,
    estimateHours: row.estimate_hours,
    loggedHours: row.logged_hours,
    dueAt: row.due_at,
    slaDueAt: row.sla_due_at,
    slaHours: row.sla_hours,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    blockedReason: row.blocked_reason,
    turnoverState: row.turnover_state,
    turnoverCriteria: row.turnover_criteria,
    acceptanceStep: row.acceptance_step,
    clientVisible: !!row.client_visible,
    position: row.position,
    parentId: row.parent_id,
    branch: row.branch,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    counts: {
      comments: row.comment_count ?? 0,
      checklist: row.checklist_total ?? 0,
      checklistDone: row.checklist_done ?? 0,
      dependencies: row.dependency_count ?? 0,
      subtasks: row.subtask_count ?? 0,
    },
  };
}

export function mapUser(row: Record<string, any>) {
  let skills: string[] = [];
  try {
    skills = JSON.parse(row.skills_json ?? '[]');
  } catch {
    skills = [];
  }
  return {
    id: row.id,
    email: row.email,
    name: row.full_name,
    title: row.title,
    role: row.role,
    initials: row.initials,
    color: row.avatar_color,
    timezone: row.timezone,
    capacityHoursWeek: row.capacity_hours_week,
    billRateCents: row.bill_rate_cents,
    costRateCents: row.cost_rate_cents,
    skills,
    isActive: !!row.is_active,
  };
}

export function mapClient(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    industry: row.industry,
    initials: row.initials,
    color: row.accent_color,
    tier: row.tier,
    health: row.health,
    contactName: row.primary_contact_name,
    contactEmail: row.primary_contact_email,
    contactRole: row.primary_contact_role,
    mrrCents: row.mrr_cents,
    notes: row.notes,
  };
}

export function mapProject(row: Record<string, any>) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    clientId: row.client_id,
    clientName: row.client_name,
    clientColor: row.client_color,
    status: row.status,
    health: row.health,
    owner: row.owner_id ? { id: row.owner_id, name: row.owner_name, initials: row.owner_initials, color: row.owner_color } : null,
    startedAt: row.started_at,
    targetEndAt: row.target_end_at,
    budgetCents: row.budget_cents,
    hoursBudget: row.hours_budget,
    description: row.description,
    repoUrl: row.repo_url,
    edgeCaseTarget: row.edge_case_target,
    branch: row.branch_name,
    deployTarget: row.deploy_target,
    demoCadenceDays: row.demo_cadence_days,
    retentionRisk: row.retention_risk,
    taskCount: row.task_count ?? 0,
    doneCount: row.done_count ?? 0,
    openTasks: row.open_count ?? 0,
    loggedHours: row.logged_hours ?? 0,
    progress: row.task_count ? Math.round(((row.done_count ?? 0) / row.task_count) * 100) : 0,
  };
}

export function mapDeal(row: Record<string, any>) {
  return {
    id: row.id,
    title: row.title,
    clientId: row.client_id,
    clientName: row.client_name,
    clientColor: row.client_color,
    valueCents: row.value_cents,
    currency: row.currency,
    status: row.status,
    stageKey: row.stage_key,
    stageName: row.stage_name,
    stagePhase: row.stage_phase,
    stageColor: row.stage_color,
    owner: row.owner_name ? { id: row.owner_id, name: row.owner_name, initials: row.owner_initials, color: row.owner_color } : null,
    probability: row.probability,
    startedAt: row.started_at,
    expectedCloseAt: row.expected_close_at,
    nextStep: row.next_step,
    lostReason: row.lost_reason,
    slaDays: row.default_sla_days,
    ageDays: Math.floor((Date.now() - (toDate(row.started_at)?.getTime() ?? Date.now())) / 86400000),
  };
}
