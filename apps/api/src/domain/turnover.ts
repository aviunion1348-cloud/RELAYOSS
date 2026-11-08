/**
 * Turnover gates — the enforcement layer behind "strict turnover guidelines
 * for each feature and phase".
 *
 * A gate is a reusable policy (e.g. `TG-03 QA evidence attached`). Each task or
 * project phase gets a set of `turnover_checks`. Nothing can be marked `done`
 * or handed to a client until every required check is `pass` or `waived`.
 * Server-side enforcement lives in services/tasks.ts; this module holds the
 * pure evaluation logic so it can be unit tested and reused by the UI.
 */

export type TurnoverScope = 'task' | 'phase' | 'project';
export type CheckStatus = 'pending' | 'pass' | 'fail' | 'waived';

export interface GateDef {
  id: string;
  key: string;
  name: string;
  scope: TurnoverScope;
  description: string;
  required: boolean;
  owner_role: string;
  auto_rule: string;
}

export interface CheckState {
  gate_id: string;
  status: CheckStatus;
  evidence: string;
}

export interface GateEvaluation {
  ready: boolean;
  passed: number;
  required: number;
  blockers: Array<{ gate_id: string; name: string; reason: string }>;
  score: number;
}

export function evaluateGates(gates: GateDef[], checks: CheckState[]): GateEvaluation {
  const byGate = new Map(checks.map((c) => [c.gate_id, c]));
  const blockers: GateEvaluation['blockers'] = [];
  let passed = 0;
  let required = 0;

  for (const gate of gates) {
    if (gate.required) required++;
    const check = byGate.get(gate.id);
    if (check && (check.status === 'pass' || check.status === 'waived')) {
      passed++;
      continue;
    }
    if (gate.required) {
      blockers.push({
        gate_id: gate.id,
        name: gate.name,
        reason:
          !check || check.status === 'pending'
            ? 'Awaiting evidence'
            : check.status === 'fail'
              ? check.evidence || 'Failed verification'
              : 'Not started',
      });
    }
  }

  return {
    ready: blockers.length === 0,
    passed,
    required,
    blockers,
    score: gates.length === 0 ? 100 : Math.round((passed / gates.length) * 100),
  };
}

/** Machine-evaluable rules the engine can auto-satisfy from live data. */
export const AUTO_RULES: Record<string, { label: string; hint: string }> = {
  'has_description': { label: 'Description written', hint: 'Task body must be ≥ 120 characters.' },
  'has_assignee': { label: 'Owner assigned', hint: 'An accountable engineer must be on the task.' },
  'estimate_set': { label: 'Estimated', hint: 'Story points and hours estimated before work starts.' },
  'review_approved': { label: 'Peer review approved', hint: 'A different engineer than the assignee approved.' },
  'tests_recorded': { label: 'Test evidence recorded', hint: 'Evidence URL or output pasted into the check.' },
  'time_logged': { label: 'Time reconciled', hint: 'Logged hours within 20% of estimate.' },
  'client_signoff': { label: 'Client sign-off captured', hint: 'Written approval from the client contact.' },
  'handoff_link': { label: 'Excaliboard / artefact link attached', hint: 'Every phase handoff needs a live link.' },
};
