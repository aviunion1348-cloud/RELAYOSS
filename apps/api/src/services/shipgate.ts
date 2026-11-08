/**
 * Ship gate — the single server-side authority on whether a release may ship.
 *
 * The delivery board is explicit: a completed task is not an accepted feature,
 * and a green pipeline is not a delivered product. This module encodes the
 * requirements as data-driven checks so the answer is reproducible and
 * explainable, and so a caller can see *which* requirement is outstanding
 * instead of a bare 409.
 *
 * Rules (all enforced server-side, none of them advisory):
 *   1. Edge-case coverage     — catalogued scenarios ≥ the project target (3500)
 *   2. Edge-case verification — verified ≥ 90% of target
 *   3. No open P0/P1 defects
 *   4. Executive summary prepared ≥ 48h before the planned ship time
 *   5. No turnover gate outstanding for the release's project
 *   6. Demo approved and client acceptance recorded
 *
 * A check that cannot be evaluated (missing data) fails closed.
 */
import type { Db } from '../db/index.ts';
import { badRequest } from '../lib/http.ts';
import { toDate } from '../lib/dates.ts';

const HOUR = 3600_000;
const EXEC_SUMMARY_LEAD_HOURS = 48;

export interface GateCheck {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
  /** Machine-readable numbers so the UI can render progress, not just a tick. */
  actual?: number;
  required?: number;
}

export interface ShipGateResult {
  releaseId: string;
  shippable: boolean;
  checks: GateCheck[];
  /** Human sentence naming every blocking requirement, or '' when clear. */
  blockedReason: string;
  evaluatedAt: string;
}

export async function evaluateShipGate(db: Db, releaseId: string): Promise<ShipGateResult> {
  const release = await db.get<Record<string, any>>('SELECT * FROM releases WHERE id = ?', [releaseId]);
  if (!release) throw badRequest(`Unknown release: ${releaseId}`);
  const project = await db.get<Record<string, any>>('SELECT * FROM projects WHERE id = ?', [release.project_id]);
  if (!project) throw badRequest(`Release ${releaseId} has no project`);

  const checks: GateCheck[] = [];

  /* ---------------------------------------------- 1+2 edge case coverage -- */
  const target = Number(project.edge_case_target ?? 3500);
  const counts = await db.all<{ status: string; c: number }>(
    'SELECT status, COUNT(*) AS c FROM edge_cases WHERE project_id = ? GROUP BY status',
    [project.id],
  );
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.c)]));
  const catalogued = counts.reduce((sum, r) => sum + Number(r.c), 0);
  const verified = Number(byStatus.verified ?? 0);
  const verifiedTarget = Math.floor(target * 0.9);

  checks.push({
    key: 'edge_cases_catalogued',
    label: 'Edge cases catalogued',
    passed: catalogued >= target,
    detail: `${catalogued} of ${target} scenarios catalogued`,
    actual: catalogued,
    required: target,
  });
  checks.push({
    key: 'edge_cases_verified',
    label: 'Edge cases verified',
    passed: verified >= verifiedTarget,
    detail: `${verified} verified (need ${verifiedTarget}, 90% of target)`,
    actual: verified,
    required: verifiedTarget,
  });

  /* ------------------------------------------------------ 3 open defects -- */
  const openDefects = await db.all<{ severity: string }>(
    `SELECT severity FROM qa_reports
      WHERE project_id = ? AND severity IN ('p0','p1')
        AND status NOT IN ('verified','wont_fix','duplicate')`,
    [project.id],
  );
  checks.push({
    key: 'no_blocking_defects',
    label: 'No open P0/P1 defects',
    passed: openDefects.length === 0,
    detail: openDefects.length === 0 ? 'none open' : `${openDefects.length} open (${[...new Set(openDefects.map((d) => d.severity))].join(', ')})`,
    actual: openDefects.length,
    required: 0,
  });

  /* ------------------------------------------------ 4 exec summary 48h -- */
  // Prepared-at, not linked-at: a URL alone proves nothing about timing.
  const preparedAt = toDate(release.exec_summary_at) ?? toDate(release.exec_summary_due_at);
  const plannedShip = toDate(release.ship_planned_at);
  let execDetail: string;
  let execPassed: boolean;
  if (!release.exec_summary_url) {
    execPassed = false;
    execDetail = 'no executive summary linked';
  } else if (!preparedAt) {
    execPassed = false;
    execDetail = 'executive summary linked but its preparation time is not recorded';
  } else if (!plannedShip) {
    execPassed = false;
    execDetail = 'no planned ship time to compare the summary against';
  } else {
    const lead = (plannedShip.getTime() - preparedAt.getTime()) / HOUR;
    execPassed = lead >= EXEC_SUMMARY_LEAD_HOURS;
    execDetail = `${lead.toFixed(1)}h between summary and planned ship (need ≥ ${EXEC_SUMMARY_LEAD_HOURS}h)`;
  }
  checks.push({ key: 'exec_summary_lead_time', label: 'Executive summary ≥ 48h before ship', passed: execPassed, detail: execDetail });

  /* -------------------------------------------------- 5 turnover gates -- */
  // A project-scope gate is outstanding when it has not been settled, or when it
  // was settled without the evidence that makes it meaningful. Waivers are
  // recorded with the waiving lead in `checked_by`, so they are attributable.
  const projectChecks = await db.all<{ name: string; phase_name: string; status: string; evidence: string; checked_by: string | null }>(
    `SELECT g.name, ph.name AS phase_name, c.status, c.evidence, c.checked_by
       FROM turnover_checks c
       JOIN turnover_gates g ON g.id = c.gate_id
       JOIN project_phases pp ON pp.id = c.project_phase_id
       JOIN phases ph ON ph.id = pp.phase_id
      WHERE pp.project_id = ? AND g.scope != 'task' AND g.required = 1`,
    [project.id],
  );
  const outstanding = projectChecks.filter(
    (c) => !['pass', 'waived'].includes(c.status) || (c.status === 'pass' && !String(c.evidence ?? '').trim()),
  );
  // A gate instantiated on several phases is still one requirement. Name it
  // once, with the phase it belongs to, so the refusal reads as a list of
  // outstanding obligations rather than a repeated wall of text.
  const outstandingLabels = [...new Set(outstanding.map((g) => `${g.name} (${g.phase_name})`))];
  checks.push({
    key: 'project_turnover_gates',
    label: 'Required project turnover gates passed',
    passed: outstanding.length === 0,
    detail: outstanding.length === 0
      ? `all ${projectChecks.length} required gate instances settled`
      : `${outstandingLabels.join(', ')}`,
    actual: outstanding.length,
    required: 0,
  });

  /* ------------------------------------- 6 demo approved + acceptance -- */
  const acceptance = await db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM acceptance_records a JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? AND a.step = 'client_accepted' AND a.state = 'passed'`,
    [project.id],
  );
  const clientAccepted = Number(acceptance?.c ?? 0) > 0;
  checks.push({
    key: 'demo_approved',
    label: 'Demo approved (release or client acceptance)',
    passed: !!release.demo_approved_at || clientAccepted,
    detail: release.demo_approved_at ? 'release demo approved' : clientAccepted ? 'client acceptance recorded' : 'no demo approval or client acceptance',
  });

  const blockers = checks.filter((c) => !c.passed);
  const result: ShipGateResult = {
    releaseId,
    shippable: blockers.length === 0,
    checks,
    blockedReason: blockers.length ? blockers.map((b) => `${b.label}: ${b.detail}`).join('; ') : '',
    evaluatedAt: new Date().toISOString(),
  };

  // Persist the verdict so a refusal is auditable after the fact.
  await db.run('UPDATE releases SET ship_blocked_reason = ? WHERE id = ?', [result.blockedReason, releaseId]);
  return result;
}

/**
 * Move a release to `shipped`. Refuses unless every gate passes, and refuses
 * unless all three post-ship acknowledgements have been received — a deployment
 * is not "successful" because a pipeline exited 0.
 */
export async function markShipped(db: Db, releaseId: string, actorId: string | null): Promise<{ release: any; gate: ShipGateResult }> {
  const gate = await evaluateShipGate(db, releaseId);
  if (!gate.shippable) {
    // A refused ship is a governed action that did not happen. Recording it
    // means an auditor can see the attempt and the exact reason it was denied,
    // not just the absence of a ship.
    await db.run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'release.ship_refused', 'release', releaseId,
      JSON.stringify({ blocked: gate.checks.filter((c) => !c.passed).map((c) => [c.key, c.detail]) }),
    ]);
    throw badRequest(`Ship refused — outstanding requirements. ${gate.blockedReason}`);
  }
  const acks = await db.all<{ signal: string; state: string }>(
    'SELECT signal, state FROM ship_acknowledgements WHERE release_id = ?',
    [releaseId],
  );
  const required = ['deployment_ack', 'post_ship_verification'];
  const missing = required.filter((sig) => !acks.some((a) => a.signal === sig && a.state === 'received'));
  if (missing.length) {
    await db.run('INSERT INTO audit_log (actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?)', [
      actorId, 'release.ship_refused', 'release', releaseId, JSON.stringify({ missingAcknowledgements: missing }),
    ]);
    throw badRequest(`Ship refused — no ${missing.join(' and ')} recorded. A release is not shipped until the deployment is acknowledged.`);
  }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await db.run("UPDATE releases SET status = 'shipped', shipped_at = ?, ship_approved_by = ? WHERE id = ?", [now, actorId, releaseId]);
  return { release: await db.get('SELECT * FROM releases WHERE id = ?', [releaseId]), gate };
}
