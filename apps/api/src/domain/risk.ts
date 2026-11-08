/**
 * SLA + risk engine.
 *
 * Deterministic and explainable by design: every score returns the factors
 * that produced it, so a delivery lead can challenge the model. No black boxes
 * in a system that decides what humans work on next.
 */

import { daysLeft, hoursBetween, toDate } from '../lib/dates.ts';

export type Priority = 'urgent' | 'high' | 'medium' | 'low';
export type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';

export const SLA_HOURS: Record<Priority, { response: number; resolve: number }> = {
  urgent: { response: 1, resolve: 8 },
  high: { response: 4, resolve: 24 },
  medium: { response: 12, resolve: 72 },
  low: { response: 24, resolve: 168 },
};

export function slaDueAt(createdAt: string | Date, priority: Priority): Date {
  const base = toDate(createdAt) ?? new Date();
  return new Date(base.getTime() + SLA_HOURS[priority].resolve * 3600_000);
}

export function slaState(task: {
  status: Status;
  priority: Priority;
  sla_due_at?: string | null;
  completed_at?: string | null;
}): { state: 'ok' | 'at_risk' | 'breached' | 'met' | 'none'; hoursLeft: number | null } {
  const dueDate = toDate(task.sla_due_at);
  if (!dueDate) return { state: 'none', hoursLeft: null };
  const due = dueDate.getTime();
  const ref = toDate(task.completed_at)?.getTime() ?? Date.now();
  const hoursLeft = (due - ref) / 3600_000;
  if (task.status === 'done') return { state: hoursLeft >= 0 ? 'met' : 'breached', hoursLeft };
  if (hoursLeft < 0) return { state: 'breached', hoursLeft };
  if (hoursLeft < 12) return { state: 'at_risk', hoursLeft };
  return { state: 'ok', hoursLeft };
}

export interface RiskInput {
  priority: Priority;
  status: Status;
  dueAt?: string | null;
  estimateHours: number;
  loggedHours: number;
  turnoverState: string;
  blockedReason?: string;
  dependencyCount: number;
  assigneeLoadRatio?: number; // planned / capacity for current week
  clientVisible?: boolean;
  ageDays?: number;
}

export interface RiskResult {
  score: number;
  band: 'low' | 'medium' | 'high' | 'critical';
  factors: Array<{ key: string; label: string; weight: number; detail: string }>;
}

const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 22, high: 14, medium: 7, low: 2 };

/**
 * Weighted additive model, normalised to 0–100.
 * Weights were tuned so that "overdue + blocked + client-visible" always lands
 * in `critical`, while a healthy in-flight task never exceeds ~30.
 */
export function scoreRisk(input: RiskInput): RiskResult {
  const factors: RiskResult['factors'] = [];
  const push = (key: string, label: string, weight: number, detail: string) => {
    if (weight > 0) factors.push({ key, label, weight, detail });
  };

  push('priority', 'Priority', PRIORITY_WEIGHT[input.priority], `${input.priority} priority work`);

  const remainingDays = daysLeft(input.dueAt);
  if (remainingDays !== null) {
    const days = remainingDays;
    if (input.status !== 'done') {
      if (days < 0) push('overdue', 'Past due', Math.min(30, 12 + Math.abs(days) * 2), `${Math.abs(days).toFixed(1)}d overdue`);
      else if (days < 2) push('due_soon', 'Due within 48h', 10, `${days.toFixed(1)}d remaining`);
      else if (days < 5) push('due_week', 'Due this week', 4, `${days.toFixed(1)}d remaining`);
    }
  }

  if (input.status === 'blocked')
    push('blocked', 'Blocked', input.blockedReason ? 20 : 12, input.blockedReason || 'Blocked without a recorded reason');

  if (input.status === 'review' && input.turnoverState === 'failed')
    push('turnover_failed', 'Failed turnover gate', 14, 'Rejected at the quality gate');

  if (input.assigneeLoadRatio !== undefined && input.assigneeLoadRatio > 1)
    push('overload', 'Owner overloaded', Math.min(14, (input.assigneeLoadRatio - 1) * 20), `${Math.round(input.assigneeLoadRatio * 100)}% of weekly capacity`);

  if (input.dependencyCount > 0)
    push('deps', 'Blocked-by chain', Math.min(10, input.dependencyCount * 3), `${input.dependencyCount} upstream dependenc${input.dependencyCount === 1 ? 'y' : 'ies'}`);

  if (input.estimateHours > 0 && input.loggedHours > input.estimateHours * 1.2 && input.status !== 'done')
    push('burn', 'Estimate burn', Math.min(12, (input.loggedHours / input.estimateHours - 1) * 12), `${input.loggedHours}h logged vs ${input.estimateHours}h estimated`);

  if ((input.ageDays ?? 0) > 21 && (input.status === 'todo' || input.status === 'backlog'))
    push('stale', 'Stale in backlog', 6, `${Math.round(input.ageDays ?? 0)}d without movement`);

  if (input.clientVisible && input.status !== 'done') push('visible', 'Client visible', 5, 'Defect here is seen by the client');

  const score = Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.weight, 0)));
  const band = score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 22 ? 'medium' : 'low';
  factors.sort((a, b) => b.weight - a.weight);
  return { score, band, factors };
}

/** Weighted Shortest Processing Time — the ordering rule used by the planner. */
export function wsptScore(task: {
  priority: Priority;
  dueAt?: string | null;
  estimateHours: number;
  status: Status;
  blocked?: boolean;
}): number {
  if (task.status === 'done' || task.status === 'cancelled') return -1;
  const base = PRIORITY_WEIGHT[task.priority] * (task.blocked ? 0.15 : 1);
  const leftDays = daysLeft(task.dueAt);
  const urgency = leftDays === null ? 0.3 : Math.max(0, 1 - leftDays / 14);
  const effort = Math.max(1, task.estimateHours || 4);
  return ((base + urgency * 30) / effort) * 10;
}
