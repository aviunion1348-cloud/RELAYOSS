/**
 * Deterministic, idempotent demo seed.
 *
 * Everything the product needs to feel real on first boot: a delivery studio
 * with 6 clients, a 11-stage revenue pipeline, 7 live projects on the phase
 * spine, ~130 tasks with dependencies, turnover checks, time entries, handoff
 * artefacts and automation rules. Re-running `db seed` wipes and rebuilds only
 * the seeded rows (guard: refuses in production unless FORCE=1).
 */
import type { Db } from './index.ts';
import { id, addDays } from '../lib/ids.ts';
import { SLA_HOURS } from '../domain/risk.ts';
import { config } from '../config.ts';
import { toDate } from '../lib/dates.ts';

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry(20261108);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const daysAgo = (n: number) => addDays(new Date(), -n).toISOString().slice(0, 19).replace('T', ' ');
const daysAhead = (n: number) => addDays(new Date(), n).toISOString().slice(0, 10);
const isoNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export async function seed(db: Db, log: (m: string) => void = console.log): Promise<void> {
  if (config.env === 'production' && process.env.FORCE !== '1') {
    throw new Error('Refusing to seed a production database. Set FORCE=1 if this is intentional.');
  }

  await db.tx(async () => {
    // Wipe in FK-safe order.
    const tables = [
      'acceptance_records','sla_timers','qa_reports','edge_cases','usage_metrics','device_licenses',
      'partner_iam_users','partners','releases','docs','sla_clocks',
      'schedule_items','schedule_runs','risk_scores','capacity_snapshots','activity','audit_log',
      'notifications','saved_views','automation_rules','time_entries','turnover_checks','task_comments',
      'task_checklist','task_dependencies','task_watchers','task_labels','tasks','columns','boards','labels',
      'handoffs','milestones','project_phases','projects','deal_phase_runs','deals','pipeline_stages',
      'client_contacts','clients','team_members','teams','retention_policies','sla_policies',
      'turnover_gates','phases','users',
    ];
    for (const t of tables) await db.exec(`DELETE FROM ${t};`);

    /* ------------------------------------------------------------- people -- */
    const users = [
      ['usr_maya', 'maya@relayoss.studio', 'Maya Iyer', 'Delivery Principal', 'admin', '#8b7cf6', 'MI', 30, 4200, 14500, ['architecture','delivery','client-success']],
      ['usr_arjun', 'arjun@relayoss.studio', 'Arjun Rao', 'Staff Engineer', 'lead', '#38bdf8', 'AR', 34, 3600, 12800, ['backend','infra','performance']],
      ['usr_sofia', 'sofia@relayoss.studio', 'Sofia Marchetti', 'Product Designer', 'lead', '#f472b6', 'SM', 32, 3200, 11500, ['design','research','prototyping']],
      ['usr_dev', 'dev@relayoss.studio', 'Dev Patel', 'Senior Engineer', 'member', '#34d399', 'DP', 36, 2800, 9600, ['frontend','react','design-systems']],
      ['usr_nina', 'nina@relayoss.studio', 'Nina Kaur', 'Engineer', 'member', '#fbbf24', 'NK', 36, 2200, 8200, ['frontend','testing','accessibility']],
      ['usr_omar', 'omar@relayoss.studio', 'Omar Farouk', 'Data / AI Engineer', 'member', '#22d3ee', 'OF', 32, 3000, 11000, ['data','ml','pipelines']],
      ['usr_tara', 'tara@relayoss.studio', 'Tara Menon', 'Delivery Manager', 'lead', '#a78bfa', 'TM', 30, 2900, 9900, ['delivery','qa','process']],
      ['usr_kabir', 'kabir@relayoss.studio', 'Kabir Sethi', 'Growth & Sales', 'member', '#fb923c', 'KS', 30, 2400, 8800, ['sales','pipeline','proposals']],
    ] as const;

    for (const [idv, email, name, title, role, color, initials, cap, cost, bill, skills] of users) {
      await db.run(
        `INSERT INTO users (id,email,full_name,title,role,avatar_color,initials,capacity_hours_week,cost_rate_cents,bill_rate_cents,skills_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [idv, email, name, title, role, color, initials, cap, cost, bill, JSON.stringify(skills)],
      );
    }

    const teams: Array<[string, string, string, string, string[]]> = [
      ['tm_delivery', 'Delivery', 'delivery', 'Client delivery pods', ['usr_maya', 'usr_tara', 'usr_arjun']],
      ['tm_eng', 'Engineering', 'engineering', 'Build & platform', ['usr_arjun', 'usr_dev', 'usr_nina', 'usr_omar']],
      ['tm_design', 'Design', 'design', 'Product design & research', ['usr_sofia', 'usr_nina']],
      ['tm_growth', 'Growth', 'growth', 'Pipeline & commercials', ['usr_kabir', 'usr_maya']],
    ];
    for (const [tid, name, slug, desc, members] of teams) {
      await db.run('INSERT INTO teams (id,name,slug,description) VALUES (?,?,?,?)', [tid, name, slug, desc]);
      for (const memberId of members) {
        await db.run('INSERT INTO team_members (team_id,user_id) VALUES (?,?)', [tid, memberId]);
      }
    }

    /* ------------------------------------------------------------ clients -- */
    const clients: Array<[string, string, string, string, string, string, string, string, string, string, string, number]> = [
      ['cl_northwind', 'Northwind Health', 'northwind-health', 'Healthcare', 'NH', '#6366f1', 'strategic', 'healthy', 'Priya Raman', 'priya@northwind.health', 'VP Product', 1_250_000],
      ['cl_veer', 'Veer Logistics', 'veer-logistics', 'Logistics', 'VL', '#22d3ee', 'enterprise', 'watch', 'Rohit Malhotra', 'rohit@veerlogistics.in', 'CTO', 890_000],
      ['cl_lumen', 'Lumen & Co', 'lumen-co', 'Retail', 'LC', '#f472b6', 'growth', 'healthy', 'Aisha Khan', 'aisha@lumen.co', 'Head of Digital', 420_000],
      ['cl_sentinel', 'Sentinel Fintech', 'sentinel-fintech', 'Fintech', 'SF', '#34d399', 'enterprise', 'at_risk', 'Vikram Shah', 'vikram@sentinel.fin', 'COO', 1_480_000],
      ['cl_kite', 'Kite Consumer', 'kite-consumer', 'D2C', 'KC', '#fbbf24', 'starter', 'healthy', 'Neha Bansal', 'neha@kite.app', 'Founder', 180_000],
      ['cl_atlas', 'Atlas Energy', 'atlas-energy', 'Energy', 'AE', '#a78bfa', 'strategic', 'churn', 'Daniel Okoye', 'daniel@atlasenergy.com', 'Director IT', 2_100_000],
    ] as const;
    for (const [cid, name, slug, ind, initials, color, tier, health, contact, email, crole, mrr] of clients) {
      await db.run(
        `INSERT INTO clients (id,name,slug,industry,initials,accent_color,tier,health,primary_contact_name,primary_contact_email,primary_contact_role,mrr_cents)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, name, slug, ind, initials, color, tier, health, contact, email, crole, mrr],
      );
      await db.run('INSERT INTO client_contacts (id,client_id,name,email,role,is_primary) VALUES (?,?,?,?,?,1)', [
        id('ct'), cid, contact, email, crole,
      ]);
    }

    /* ----------------------------------------------------------- pipeline -- */
    const stages: Array<any[]> = [
      ['st_inbound', 'inbound', 'Inbound Lead', 'origin', 10, 'Signal captured from referral, site or outbound.',
        'Name, company, source, rough budget band', 'ICP fit confirmed, ≥ ₹3L potential', 3, 300000, '#64748b', 'inbox'],
      ['st_triage', 'triage', 'Triage & Qualify', 'origin', 20, '30-minute fit call with the growth lead.',
        'Lead in pipeline', 'Problem statement + decision-maker identified', 3, 400000, '#8b5cf6', 'filter'],
      ['st_consult', 'tech_consult', 'Technical Consultation', 'discovery', 30, 'Paid 60–90 min technical consultation with Maya + Arjun.',
        'Fit call booked', 'Systems map drafted on Excaliboard, risks logged', 5, 600000, '#6366f1', 'messages'],
      ['st_scope', 'scope', 'Scope & Architecture', 'discovery', 40, 'Translate the consultation into an architecture and phased plan.',
        'Consultation delivered', 'Excaliboard architecture link + effort estimate signed off internally', 7, 900000, '#0ea5e9', 'layout'],
      ['st_proposal', 'proposal', 'Proposal & Commercials', 'proposal', 50, 'Fixed-scope proposal with phase turnover gates attached.',
        'Architecture approved', 'Proposal sent with 3 pricing options', 5, 1100000, '#06b6d4', 'file-text'],
      ['st_legal', 'legal', 'Contract & Onboarding', 'proposal', 60, 'MSA, SOW, DPAs, kickoff scheduling.',
        'Verbal yes', 'Signed SOW + deposit paid', 10, 1100000, '#14b8a6', 'pen-tool'],
      ['st_kickoff', 'kickoff', 'Delivery Kickoff', 'delivery', 70, 'Pod assembled, board created, turnover gates instantiated.',
        'Deposit received', 'Board live, phases scheduled, client channel open', 4, 1100000, '#22c55e', 'rocket'],
      ['st_delivery', 'in_delivery', 'In Delivery', 'delivery', 80, 'Sprint cadence with weekly demo + turnover gates per phase.',
        'Kickoff complete', 'All phases passed turnover, UAT signed', 45, 1400000, '#eab308', 'hammer'],
      ['st_handover', 'handover', 'Handover & Enablement', 'delivery', 90, 'Runbooks, credential vault, training, 30-day hypercare.',
        'UAT signed', 'Handover approved by client + support runbook live', 10, 1400000, '#f97316', 'package-check'],
      ['st_retainer', 'retainer', 'Retainer & Growth', 'growth', 100, 'Monthly iteration retainer with quarterly roadmap reviews.',
        'Handover approved', 'Retainer signed, expansion map agreed', 14, 250000, '#a855f7', 'repeat'],
      ['st_expansion', 'expansion', 'Expansion Won', 'growth', 110, 'New scope or new business unit signed.',
        'Retainer healthy for 2 quarters', 'Expansion SOW signed', 14, 600000, '#ec4899', 'trending-up'],
      ['st_closed', 'closed', 'Closed / Parked', 'growth', 120, 'Lost, parked or dormant. Kept for win-loss analysis.',
        'Decision made', 'Loss reason + revisit date recorded', 0, 0, '#475569', 'archive'],
    ];
    for (const [sid, key, name, phase, pos, desc, entry, exit, sla, val, color, icon] of stages) {
      await db.run(
        `INSERT INTO pipeline_stages (id,key,name,phase,position,description,entry_criteria,exit_criteria,default_sla_days,default_value_cents,color,icon) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description, position = excluded.position, entry_criteria = excluded.entry_criteria, exit_criteria = excluded.exit_criteria, default_sla_days = excluded.default_sla_days, default_value_cents = excluded.default_value_cents`,
        [sid, key, name, phase, pos, desc, entry, exit, sla, val, color, icon],
      );
    }

    /* ------------------------------------------------------------- phases -- */
    const phases: Array<any[]> = [
      ['ph_discovery', 'discovery', 'Technical Consultation', 10, 'Stakeholder interviews, systems audit, constraints and success metrics.', 5, 1, '#6366f1', 'Excaliboard systems map published and shared before the phase can close.'],
      ['ph_architecture', 'architecture', 'Solution Architecture', 20, 'Target architecture, data contracts, integration map, NFR budget.', 7, 1, '#0ea5e9', 'Architecture decision records (ADRs) merged; performance budget signed.'],
      ['ph_design', 'design', 'Product Design', 30, 'Flows, high-fidelity UI, design tokens, accessibility pass.', 10, 1, '#f472b6', 'Figma handoff approved by client; all states + empty/error covered.'],
      ['ph_build', 'build', 'Implementation', 40, 'Sprint delivery against the architecture with weekly demos.', 20, 1, '#22c55e', 'Feature turnover gates green; main branch deployable at all times.'],
      ['ph_qa', 'qa', 'QA & Hardening', 50, 'Regression, performance, security and accessibility hardening.', 7, 1, '#f59e0b', 'Zero P0/P1 defects, load test within budget, a11y AA verified.'],
      ['ph_launch', 'launch', 'Launch & Observability', 60, 'Production cutover, monitoring, alerting, rollback drill.', 5, 1, '#ef4444', 'Dashboards + alerts live; rollback rehearsed and documented.'],
      ['ph_enablement', 'enablement', 'Handover & Enablement', 70, 'Runbooks, credential transfer, training, hypercare.', 7, 1, '#8b5cf6', 'Client team trained, runbook approved, credentials vaulted.'],
      ['ph_growth', 'growth', 'Growth Iterations', 80, 'Monthly iteration cycles against the roadmap and retention metrics.', 14, 1, '#a855f7', 'Quarterly roadmap review completed with client stakeholder.'],
    ];
    for (const [pid, key, name, pos, desc, sla, billable, color, policy] of phases) {
      await db.run(
        'INSERT INTO phases (id,key,name,position,description,sla_days,billable,color,turnover_policy) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description, sla_days = excluded.sla_days, turnover_policy = excluded.turnover_policy',
        [pid, key, name, pos, desc, sla, billable, color, policy],
      );
    }

    /* ------------------------------------------------------- turnover gates -- */
    const gates: Array<any[]> = [
      ['tg_t1', 'TG-01', 'Owner assigned', 'task', 'Every unit of work has exactly one accountable owner.', 1, 'lead', 'has_assignee'],
      ['tg_t2', 'TG-02', 'Acceptance criteria written', 'task', 'Description ≥ 120 chars and checklist items defined.', 1, 'member', 'has_description'],
      ['tg_t3', 'TG-03', 'Estimated & budgeted', 'task', 'Story points set; hours logged within 20% of estimate.', 1, 'lead', 'estimate_set'],
      ['tg_t4', 'TG-04', 'Peer review approved', 'task', 'A second engineer approved the diff — never the author.', 1, 'lead', 'review_approved'],
      ['tg_t5', 'TG-05', 'Test evidence attached', 'task', 'Failing-then-passing evidence, CI link or load-test output.', 1, 'member', 'tests_recorded'],
      ['tg_t6', 'TG-06', 'No open blockers', 'task', 'Dependency chain cleared.', 1, 'lead', ''],
      ['tg_p1', 'TG-07', 'Phase acceptance signed', 'phase', 'Delivery lead signs the phase acceptance record.', 1, 'lead', ''],
      ['tg_p2', 'TG-08', 'Excaliboard link published', 'phase', 'Live Excaliboard artefact linked to the phase.', 1, 'lead', 'handoff_link'],
      ['tg_p3', 'TG-09', 'Client sign-off captured', 'phase', 'Written confirmation from the client contact.', 1, 'admin', 'client_signoff'],
      ['tg_p4', 'TG-10', 'Performance budget verified', 'phase', 'Lighthouse / p95 latency within the agreed budget.', 1, 'lead', ''],
      ['tg_p5', 'TG-11', 'Docs & runbook updated', 'phase', 'ADR, README and runbook reflect the shipped state.', 1, 'member', ''],
      ['tg_p6', 'TG-12', 'Retro captured', 'phase', 'Three bullets: kept, dropped, tried.', 1, 'member', ''],
      ['tg_x1', 'TG-13', 'Launch checklist complete', 'project', 'All launch-blocking items closed.', 1, 'admin', ''],
      ['tg_x2', 'TG-14', 'Credentials vaulted & transferred', 'project', 'Secrets rotated and stored in the client vault.', 1, 'admin', ''],
      ['tg_x3', 'TG-15', 'Support runbook approved', 'project', 'Severity matrix, escalation and on-call rota documented.', 1, 'lead', ''],
    ];
    for (const [gid, key, name, scope, desc, required, role, rule] of gates) {
      await db.run(
        'INSERT INTO turnover_gates (id,key,name,scope,description,required,owner_role,auto_rule) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description, required = excluded.required, owner_role = excluded.owner_role, auto_rule = excluded.auto_rule',
        [gid, key, name, scope, desc, required, role, rule],
      );
    }

    for (const [sid, scope, prio, resp, resolve] of [
      ['sla_1', 'task', 'urgent', 1, 8],
      ['sla_2', 'task', 'high', 4, 24],
      ['sla_3', 'task', 'medium', 12, 72],
      ['sla_4', 'task', 'low', 24, 168],
    ] as const) {
      await db.run('INSERT INTO sla_policies (id,scope,priority,response_hours,resolve_hours,escalate_to) VALUES (?,?,?,?,?,?) ON CONFLICT (scope, priority) DO UPDATE SET response_hours = excluded.response_hours, resolve_hours = excluded.resolve_hours, escalate_to = excluded.escalate_to', [
        sid, scope, prio, resp, resolve, 'usr_maya',
      ]);
    }

    /* -------------------------------------------------------------- labels -- */
    const labels: Array<any[]> = [
      ['lb_client', 'client-visible', '#38bdf8', 'Appears on the client-facing status page'],
      ['lb_security', 'security', '#ef4444', 'Touches auth, secrets or PII'],
      ['lb_perf', 'performance', '#fbbf24', 'Budget-sensitive work'],
      ['lb_debt', 'tech-debt', '#94a3b8', 'Refactor / cleanup'],
      ['lb_design', 'design', '#f472b6', 'Design-system or visual work'],
      ['lb_ai', 'ai-ml', '#a855f7', 'Model, embedding or agent work'],
      ['lb_blocked_client', 'blocked-on-client', '#f97316', 'Waiting on client input'],
      ['lb_quick', 'quick-win', '#22c55e', 'Under 4 hours'],
    ];
    for (const [lid, name, color, desc] of labels) {
      await db.run('INSERT INTO labels (id,name,color,description) VALUES (?,?,?,?) ON CONFLICT (name) DO UPDATE SET color = excluded.color, description = excluded.description', [lid, name, color, desc]);
    }

    /* --------------------------------------------------------------- deals -- */
    const deals: Array<any[]> = [
      ['dl_northwind', 'cl_northwind', 'Northwind care pathway platform', 4_850_000, 'st_delivery', 'usr_maya', 92, daysAgo(64), 'Ship patient intake v2 and pass UAT by end of quarter.'],
      ['dl_veer', 'cl_veer', 'Veer fleet telemetry rebuild', 6_200_000, 'st_delivery', 'usr_arjun', 88, daysAgo(41), 'Unblock the Kafka cutover before the festive peak.'],
      ['dl_lumen', 'cl_lumen', 'Lumen storefront re-platform', 2_400_000, 'st_delivery', 'usr_sofia', 80, daysAgo(28), 'Phase 3 build; demo design tokens next Friday.'],
      ['dl_sentinel', 'cl_sentinel', 'Sentinel risk engine v3', 8_900_000, 'st_handover', 'usr_maya', 96, daysAgo(120), 'Handover to their platform team + runbook approval.'],
      ['dl_kite', 'cl_kite', 'Kite referral growth app', 950_000, 'st_proposal', 'usr_kabir', 55, daysAgo(9), 'Send 3 pricing options with phased turnover gates.'],
      ['dl_atlas', 'cl_atlas', 'Atlas grid dashboards', 7_400_000, 'st_consult', 'usr_maya', 40, daysAgo(4), 'Technical consultation booked Tuesday; pre-read systems diagram.'],
      ['dl_harbor', 'cl_veer', 'Veer driver mobile app', 3_100_000, 'st_scope', 'usr_tara', 60, daysAgo(11), 'Architecture Excaliboard to be published this week.'],
      ['dl_orbit', 'cl_sentinel', 'Sentinel data lakehouse', 5_600_000, 'st_triage', 'usr_kabir', 30, daysAgo(2), 'Qualify: do they own the data contracts?'],
      ['dl_pine', 'cl_kite', 'Kite loyalty engine', 1_800_000, 'st_inbound', 'usr_kabir', 15, daysAgo(1), 'Inbound from referral; reply within 24h.'],
      ['dl_nova', 'cl_northwind', 'Northwind clinician copilot', 3_900_000, 'st_legal', 'usr_maya', 75, daysAgo(17), 'DPA redlines with their counsel; kickoff 2 weeks out.'],
      ['dl_ember', 'cl_lumen', 'Ember omnichannel CRM', 2_200_000, 'st_closed', 'usr_kabir', 0, daysAgo(53), 'Lost on price to a dev shop; revisit in 2 quarters.'],
      ['dl_tide', 'cl_atlas', 'Atlas field ops offline app', 4_100_000, 'st_kickoff', 'usr_tara', 85, daysAgo(22), 'Pod assembled, board live — kickoff workshop Thursday.'],
    ];
    for (const [did, cid, title, value, stage, owner, prob, started, next] of deals) {
      const status = stage === 'st_closed' ? 'lost' : stage === 'st_expansion' ? 'won' : 'open';
      await db.run(
        `INSERT INTO deals (id,client_id,title,value_cents,currency,status,stage_id,owner_id,probability,started_at,next_step,lost_at,lost_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [did, cid, title, value, 'INR', status, stage, owner, prob, started, next,
          status === 'lost' ? daysAgo(50) : null, status === 'lost' ? 'Undercut on price by 38%' : ''],
      );
    }

    // Phase runs for the three delivery deals.
    const phaseRunPlan: Record<string, { status: string; start: number; due: number; progress: number }[]> = {
      dl_northwind: [
        { status: 'done', start: 60, due: 55, progress: 100 },
        { status: 'done', start: 55, due: 46, progress: 100 },
        { status: 'done', start: 46, due: 32, progress: 100 },
        { status: 'active', start: 30, due: 8, progress: 62 },
        { status: 'locked', start: 0, due: 0, progress: 0 },
      ],
      dl_veer: [
        { status: 'done', start: 40, due: 34, progress: 100 },
        { status: 'done', start: 34, due: 26, progress: 100 },
        { status: 'done', start: 26, due: 18, progress: 100 },
        { status: 'active', start: 16, due: 4, progress: 48 },
        { status: 'locked', start: 0, due: 0, progress: 0 },
      ],
      dl_lumen: [
        { status: 'done', start: 27, due: 22, progress: 100 },
        { status: 'done', start: 22, due: 16, progress: 100 },
        { status: 'active', start: 14, due: 3, progress: 71 },
        { status: 'locked', start: 0, due: 0, progress: 0 },
      ],
    };
    const runPhases = ['ph_discovery', 'ph_architecture', 'ph_design', 'ph_build', 'ph_qa'];
    for (const [did, runs] of Object.entries(phaseRunPlan)) {
      for (const [i, r] of runs.entries()) {
        await db.run(
          `INSERT INTO deal_phase_runs (id,deal_id,phase_id,status,position,started_at,due_at,completed_at,approved_by,turnover_notes)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id('dpr'), did, runPhases[i], r.status, i,
            r.start ? daysAgo(r.start) : null,
            r.due ? daysAhead(-r.due) : null,
            r.status === 'done' ? daysAgo(r.due) : null,
            r.status === 'done' ? 'usr_maya' : null,
            r.status === 'done' ? 'Turnover gate green; artefact linked on Excaliboard.' : ''],
        );
      }
    }

    /* ------------------------------------------------------------ projects -- */
    const projects: Array<any[]> = [
      ['pr_northwind', 'NRTH', 'Northwind Care Pathway', 'cl_northwind', 'dl_northwind', 'usr_maya', 'active', 'on_track', 64, 8600000, 420, 'Patient intake, triage and clinician handoff on one auditable pathway.', 'https://github.com/northwind/care-pathway'],
      ['pr_veer', 'VEER', 'Veer Telemetry Rebuild', 'cl_veer', 'dl_veer', 'usr_arjun', 'blocked', 'at_risk', 41, 11200000, 540, 'Event-driven fleet telemetry with sub-second dashboards.', 'https://github.com/veer/telemetry'],
      ['pr_lumen', 'LMN', 'Lumen Storefront', 'cl_lumen', 'dl_lumen', 'usr_sofia', 'active', 'watch', 28, 4400000, 260, 'Headless commerce re-platform with design-system first delivery.', 'https://github.com/lumen/storefront'],
      ['pr_sentinel', 'SNTL', 'Sentinel Risk Engine v3', 'cl_sentinel', 'dl_sentinel', 'usr_omar', 'review', 'on_track', 120, 15200000, 780, 'Real-time risk scoring with explainable model outputs.', 'https://github.com/sentinel/risk-engine'],
      ['pr_atlas', 'ATLS', 'Atlas Grid Dashboards', 'cl_atlas', 'dl_atlas', 'usr_maya', 'discovery', 'watch', 6, 2100000, 120, 'Operational dashboards for grid telemetry.', ''],
      ['pr_tide', 'TIDE', 'Atlas Field Ops (Offline)', 'cl_atlas', 'dl_tide', 'usr_tara', 'active', 'on_track', 22, 3900000, 300, 'Offline-first field operations app with sync conflict resolution.', 'https://github.com/atlas/field-ops'],
    ];
    for (const [pid, key, name, cid, did, owner, status, health, started, budget, hours, desc, repo] of projects) {
      await db.run(
        `INSERT INTO projects (id,key,name,client_id,deal_id,owner_id,status,health,started_at,target_end_at,budget_cents,hours_budget,description,repo_url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [pid, key, name, cid, did, owner, status, health, daysAgo(started), daysAhead(Math.max(10, 120 - started)), budget, hours, desc, repo],
      );
    }

    // Project phases
    const projectPhasePlan: Record<string, Array<[string, string, number, number, number]>> = {
      pr_northwind: [['ph_discovery', 'done', 100, 58, 55], ['ph_architecture', 'done', 100, 55, 47], ['ph_design', 'done', 100, 47, 33], ['ph_build', 'active', 62, 30, -8], ['ph_qa', 'locked', 0, 0, -22], ['ph_launch', 'locked', 0, 0, -30]],
      pr_veer: [['ph_discovery', 'done', 100, 40, 34], ['ph_architecture', 'done', 100, 34, 26], ['ph_design', 'done', 100, 26, 18], ['ph_build', 'blocked', 44, 16, -4], ['ph_qa', 'locked', 0, 0, -14], ['ph_launch', 'locked', 0, 0, -22]],
      pr_lumen: [['ph_discovery', 'done', 100, 26, 21], ['ph_architecture', 'done', 100, 21, 15], ['ph_design', 'active', 71, 13, -3], ['ph_build', 'locked', 0, 0, -18], ['ph_qa', 'locked', 0, 0, -30]],
      pr_sentinel: [['ph_discovery', 'done', 100, 110, 104], ['ph_architecture', 'done', 100, 104, 96], ['ph_design', 'done', 100, 96, 84], ['ph_build', 'done', 100, 84, 40], ['ph_qa', 'done', 100, 40, 22], ['ph_launch', 'done', 100, 22, 14], ['ph_enablement', 'active', 82, 14, -6]],
      pr_atlas: [['ph_discovery', 'active', 35, 5, -2], ['ph_architecture', 'locked', 0, 0, -16], ['ph_design', 'locked', 0, 0, -28]],
      pr_tide: [['ph_discovery', 'done', 100, 21, 16], ['ph_architecture', 'done', 100, 16, 9], ['ph_design', 'active', 58, 8, -6], ['ph_build', 'locked', 0, 0, -24]],
    };
    for (const [pid, rows] of Object.entries(projectPhasePlan)) {
      for (const [i, [phid, status, progress, ago, dueOffset]] of rows.entries()) {
        await db.run(
          `INSERT INTO project_phases (id,project_id,phase_id,status,position,progress,started_at,due_at,completed_at,turnover_passed,signoff_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [id('pph'), pid, phid, status, i, progress,
            ago ? daysAgo(ago) : null,
            dueOffset ? daysAhead(dueOffset) : null,
            status === 'done' ? daysAgo(Math.max(0, -dueOffset - 1)) : null,
            status === 'done' ? 1 : 0,
            status === 'done' ? 'usr_maya' : null],
        );
      }
    }

    /* --------------------------------------------------------------- boards -- */
    const columnDefs: Array<any[]> = [
      ['backlog', 'Backlog', 10, null, 0, '#64748b'],
      ['todo', 'Ready', 20, null, 0, '#94a3b8'],
      ['in_progress', 'In Progress', 30, 4, 0, '#6366f1'],
      ['review', 'In Review', 40, 3, 0, '#f59e0b'],
      ['blocked', 'Blocked', 50, null, 0, '#ef4444'],
      ['done', 'Shipped', 60, null, 1, '#22c55e'],
    ];

    const boardFor: Record<string, string> = {};
    for (const pid of Object.keys(projectPhasePlan)) {
      const bid = `bd_${pid.replace('pr_', '')}`;
      boardFor[pid] = bid;
      await db.run('INSERT INTO boards (id,project_id,name,description,kind) VALUES (?,?,?,?,?)', [
        bid, pid, 'Delivery', 'Sprint board with turnover gates per column.', 'delivery',
      ]);
      for (const [key, name, pos, wip, isDone, color] of columnDefs) {
        await db.run('INSERT INTO columns (id,board_id,key,name,position,wip_limit,is_done,color) VALUES (?,?,?,?,?,?,?,?)', [
          `${bid}_${key}`, bid, key, name, pos, wip, isDone, color,
        ]);
      }
    }
    // Org-wide triage board.
    await db.run('INSERT INTO boards (id,project_id,name,description,kind) VALUES (?,?,?,?,?)', [
      'bd_triage', null, 'Triage', 'Cross-project intake: bugs, client asks, incidents.', 'triage',
    ]);
    for (const [key, name, pos, wip, isDone, color] of columnDefs) {
      await db.run('INSERT INTO columns (id,board_id,key,name,position,wip_limit,is_done,color) VALUES (?,?,?,?,?,?,?,?)', [
        `bd_triage_${key}`, 'bd_triage', key, name, pos, wip, isDone, color,
      ]);
    }

    /* ---------------------------------------------------------------- tasks -- */
    type TSeed = {
      project: string; phase: string; title: string; type: string; priority: string; status: string;
      assignee: string; points: number; hours: number; logged: number; dueIn: number | null;
      labels: string[]; turnover: string; clientVisible: number; desc: string; blocked?: string;
    };

    const taskSeeds: TSeed[] = [
      // Northwind — build phase
      { project: 'pr_northwind', phase: 'ph_build', title: 'Patient intake form — multi-step validation engine', type: 'feature', priority: 'urgent', status: 'in_progress', assignee: 'usr_dev', points: 8, hours: 22, logged: 14, dueIn: 3, labels: ['lb_client', 'lb_perf'], turnover: 'in_review', clientVisible: 1, desc: 'Build the step-wise intake validator with server-side schema parity. Must handle resume-after-drop, partial saves, and a11y for screen readers.' },
      { project: 'pr_northwind', phase: 'ph_build', title: 'Clinician handoff queue with optimistic updates', type: 'feature', priority: 'high', status: 'in_progress', assignee: 'usr_nina', points: 5, hours: 16, logged: 9, dueIn: 5, labels: ['lb_client'], turnover: 'draft', clientVisible: 1, desc: 'Ordered queue of handoffs with conflict-free optimistic reordering and a live counter of unassigned patients.' },
      { project: 'pr_northwind', phase: 'ph_build', title: 'Audit log writer for every PHI access', type: 'feature', priority: 'urgent', status: 'review', assignee: 'usr_arjun', points: 8, hours: 20, logged: 21, dueIn: 1, labels: ['lb_security', 'lb_client'], turnover: 'passed', clientVisible: 1, desc: 'Append-only audit trail for all PHI reads/writes with actor, purpose and correlation id. Immutable WORM sink.' },
      { project: 'pr_northwind', phase: 'ph_build', title: 'Care pathway builder — drag & drop states', type: 'feature', priority: 'medium', status: 'todo', assignee: 'usr_dev', points: 8, hours: 24, logged: 0, dueIn: 12, labels: ['lb_design'], turnover: 'draft', clientVisible: 1, desc: 'Visual editor for care pathway states with keyboard navigation and undo history.' },
      { project: 'pr_northwind', phase: 'ph_build', title: 'Fix: date of birth accepts future dates', type: 'bug', priority: 'high', status: 'blocked', assignee: 'usr_nina', points: 2, hours: 4, logged: 1, dueIn: 2, labels: ['lb_client', 'lb_quick'], turnover: 'failed', clientVisible: 1, desc: 'QA found DOB validation accepts future dates in the manual-entry path. Needs a shared validator before fix.', blocked: 'Waiting on shared validation package from Arjun' },
      { project: 'pr_northwind', phase: 'ph_build', title: 'Reduce intake bundle size below 180kb', type: 'ops', priority: 'medium', status: 'backlog', assignee: 'usr_dev', points: 3, hours: 8, logged: 0, dueIn: null, labels: ['lb_perf'], turnover: 'draft', clientVisible: 0, desc: 'Route-level code splitting and font subsetting to stay inside the performance budget.' },
      { project: 'pr_northwind', phase: 'ph_qa', title: 'Accessibility audit — WCAG 2.2 AA', type: 'ops', priority: 'high', status: 'todo', assignee: 'usr_tara', points: 5, hours: 12, logged: 0, dueIn: 14, labels: ['lb_client'], turnover: 'draft', clientVisible: 1, desc: 'Full axe + manual screen-reader pass on the intake and handoff flows; log defects with repro clips.' },
      { project: 'pr_northwind', phase: 'ph_design', title: 'Design tokens v2 — semantic colour layer', type: 'design', priority: 'low', status: 'done', assignee: 'usr_sofia', points: 3, hours: 10, logged: 11, dueIn: -6, labels: ['lb_design'], turnover: 'passed', clientVisible: 0, desc: 'Semantic token layer so dark mode and client brand overrides share one source of truth.' },

      // Veer
      { project: 'pr_veer', phase: 'ph_build', title: 'Kafka consumer rebalance storms under peak load', type: 'bug', priority: 'urgent', status: 'blocked', assignee: 'usr_arjun', points: 8, hours: 26, logged: 18, dueIn: -2, labels: ['lb_perf'], turnover: 'failed', clientVisible: 1, desc: 'Cooperative-sticky assignor tuning plus heartbeat limits. Blocked on the client network team opening egress to the new brokers.', blocked: 'Client network team has not opened egress to broker trio' },
      { project: 'pr_veer', phase: 'ph_build', title: 'Telemetry ingest idempotency keys', type: 'feature', priority: 'high', status: 'in_progress', assignee: 'usr_omar', points: 8, hours: 20, logged: 12, dueIn: 4, labels: ['lb_perf'], turnover: 'draft', clientVisible: 0, desc: 'Exactly-once ingest using device-scoped idempotency keys stored in a TTL table.' },
      { project: 'pr_veer', phase: 'ph_build', title: 'Sub-second fleet dashboard — virtualised map layer', type: 'feature', priority: 'high', status: 'review', assignee: 'usr_nina', points: 5, hours: 18, logged: 17, dueIn: 2, labels: ['lb_client', 'lb_perf'], turnover: 'in_review', clientVisible: 1, desc: 'Canvas-based vehicle layer with clustering; budget is p95 render under 900ms at 4k vehicles.' },
      { project: 'pr_veer', phase: 'ph_build', title: 'Driver shift anomaly detector (rules v1)', type: 'research', priority: 'medium', status: 'todo', assignee: 'usr_omar', points: 5, hours: 14, logged: 0, dueIn: 9, labels: ['lb_ai'], turnover: 'draft', clientVisible: 0, desc: 'Rule-based detector for overlapping shifts and impossible speed segments; no ML yet, just explainable rules.' },
      { project: 'pr_veer', phase: 'ph_build', title: 'Dead-letter queue replay console', type: 'feature', priority: 'medium', status: 'backlog', assignee: 'usr_arjun', points: 5, hours: 16, logged: 0, dueIn: null, labels: [], turnover: 'draft', clientVisible: 0, desc: 'Ops console to inspect, filter and replay DLQ messages with audit trail.' },
      { project: 'pr_veer', phase: 'ph_qa', title: 'Load test at 3× festive peak', type: 'ops', priority: 'urgent', status: 'todo', assignee: 'usr_arjun', points: 8, hours: 20, logged: 0, dueIn: 7, labels: ['lb_perf'], turnover: 'draft', clientVisible: 1, desc: 'k6 scenario at 36k events/min with p95 ingest under 250ms; publish the report to the client.' },

      // Lumen
      { project: 'pr_lumen', phase: 'ph_design', title: 'Storefront design system — 24 components', type: 'design', priority: 'high', status: 'in_progress', assignee: 'usr_sofia', points: 8, hours: 24, logged: 16, dueIn: 3, labels: ['lb_design', 'lb_client'], turnover: 'in_review', clientVisible: 1, desc: 'Product card, rail, PDP gallery, size guide and checkout primitives, all with empty/error/loading states.' },
      { project: 'pr_lumen', phase: 'ph_design', title: 'PDP gallery — 60fps swipe on low-end Android', type: 'feature', priority: 'medium', status: 'todo', assignee: 'usr_nina', points: 5, hours: 12, logged: 0, dueIn: 8, labels: ['lb_design', 'lb_perf'], turnover: 'draft', clientVisible: 1, desc: 'Use transform-based gallery with pre-decoded images; verify on a Moto G reference device.' },
      { project: 'pr_lumen', phase: 'ph_design', title: 'Checkout flow usability test (5 users)', type: 'research', priority: 'high', status: 'review', assignee: 'usr_sofia', points: 3, hours: 10, logged: 9, dueIn: 1, labels: ['lb_client'], turnover: 'passed', clientVisible: 1, desc: 'Moderated tests on the prototype; capture drop-off reasons at the address step.' },
      { project: 'pr_lumen', phase: 'ph_build', title: 'Headless CMS content model + migrations', type: 'feature', priority: 'medium', status: 'backlog', assignee: 'usr_dev', points: 5, hours: 18, logged: 0, dueIn: null, labels: ['lb_debt'], turnover: 'draft', clientVisible: 0, desc: 'Content types for collection, product, editorial and promo; migration scripts from the legacy export.' },

      // Sentinel
      { project: 'pr_sentinel', phase: 'ph_enablement', title: 'Runbook: severity matrix & on-call rota', type: 'ops', priority: 'high', status: 'in_progress', assignee: 'usr_tara', points: 5, hours: 12, logged: 7, dueIn: 4, labels: [], turnover: 'draft', clientVisible: 1, desc: 'P0–P3 definitions, response windows, escalation ladder and who-brings-what in a sev-1.' },
      { project: 'pr_sentinel', phase: 'ph_enablement', title: 'Model explainability walkthrough for compliance', type: 'meeting', priority: 'medium', status: 'todo', assignee: 'usr_omar', points: 2, hours: 4, logged: 0, dueIn: 6, labels: ['lb_ai', 'lb_client'], turnover: 'draft', clientVisible: 1, desc: 'Walk their risk committee through SHAP-style factor attributions and the drift guardrails.' },
      { project: 'pr_sentinel', phase: 'ph_enablement', title: 'Credential rotation + vault transfer', type: 'ops', priority: 'urgent', status: 'review', assignee: 'usr_arjun', points: 3, hours: 8, logged: 8, dueIn: 1, labels: ['lb_security'], turnover: 'in_review', clientVisible: 0, desc: 'Rotate all service tokens, transfer ownership to the client vault, and record the rotation evidence.' },
      { project: 'pr_sentinel', phase: 'ph_qa', title: 'Post-launch defect triage window', type: 'ops', priority: 'medium', status: 'done', assignee: 'usr_nina', points: 3, hours: 10, logged: 12, dueIn: -9, labels: [], turnover: 'passed', clientVisible: 1, desc: '14-day hypercare triage with a daily defect burn-down posted in the shared channel.' },

      // Atlas
      { project: 'pr_atlas', phase: 'ph_discovery', title: 'Systems audit — grid telemetry sources', type: 'research', priority: 'high', status: 'in_progress', assignee: 'usr_maya', points: 5, hours: 14, logged: 6, dueIn: 2, labels: ['lb_client'], turnover: 'draft', clientVisible: 1, desc: 'Map 9 upstream feeds, their owners, refresh intervals and known data quality issues. Output an Excaliboard.' },
      { project: 'pr_atlas', phase: 'ph_discovery', title: 'Stakeholder interviews (6 sessions)', type: 'meeting', priority: 'medium', status: 'todo', assignee: 'usr_maya', points: 3, hours: 10, logged: 0, dueIn: 5, labels: [], turnover: 'draft', clientVisible: 0, desc: 'Ops, dispatch, compliance and two field engineers. Capture jobs-to-be-done verbatim.' },
      { project: 'pr_atlas', phase: 'ph_discovery', title: 'Performance budget for 50k data points', type: 'ops', priority: 'medium', status: 'backlog', assignee: 'usr_dev', points: 3, hours: 8, logged: 0, dueIn: null, labels: ['lb_perf'], turnover: 'draft', clientVisible: 0, desc: 'Define render and query budgets before any dashboard code is written.' },

      // Tide
      { project: 'pr_tide', phase: 'ph_design', title: 'Offline sync conflict resolution flows', type: 'design', priority: 'urgent', status: 'in_progress', assignee: 'usr_sofia', points: 8, hours: 22, logged: 15, dueIn: 3, labels: ['lb_design', 'lb_client'], turnover: 'in_review', clientVisible: 1, desc: 'Design the merge UI for conflicting field reports: keep-mine, keep-theirs, merge both with a diff view.' },
      { project: 'pr_tide', phase: 'ph_design', title: 'Field triage prototype (sunlight-readable)', type: 'design', priority: 'high', status: 'todo', assignee: 'usr_sofia', points: 5, hours: 16, logged: 0, dueIn: 7, labels: ['lb_design'], turnover: 'draft', clientVisible: 1, desc: 'High-contrast, glove-friendly targets, one-thumb reach for the top 6 actions.' },
      { project: 'pr_tide', phase: 'ph_architecture', title: 'CRDT vs last-write-wins decision record', type: 'research', priority: 'high', status: 'done', assignee: 'usr_arjun', points: 3, hours: 8, logged: 9, dueIn: -4, labels: ['lb_debt'], turnover: 'passed', clientVisible: 0, desc: 'ADR-014: chose a CRDT-lite map for field reports and LWW for settings; documented the tradeoff.' },

      // Triage board
      { project: 'pr_northwind', phase: 'ph_build', title: 'Triage: client reports stale counts on handoff badge', type: 'bug', priority: 'high', status: 'todo', assignee: 'usr_nina', points: 2, hours: 4, logged: 0, dueIn: 1, labels: ['lb_client', 'lb_quick'], turnover: 'draft', clientVisible: 1, desc: 'Badge does not refresh after a handoff is reassigned; likely a cache key missing the assignee.' },
      { project: 'pr_veer', phase: 'ph_build', title: 'Triage: telemetry consumer lag alert flapping', type: 'bug', priority: 'urgent', status: 'in_progress', assignee: 'usr_arjun', points: 3, hours: 6, logged: 2, dueIn: 0, labels: ['lb_perf'], turnover: 'draft', clientVisible: 1, desc: 'Alert threshold too tight for the current partition count; add a rate-of-change condition.' },
      { project: 'pr_lumen', phase: 'ph_design', title: 'Triage: promo banner contrast fails AA', type: 'bug', priority: 'medium', status: 'todo', assignee: 'usr_sofia', points: 1, hours: 2, logged: 0, dueIn: 4, labels: ['lb_design', 'lb_quick'], turnover: 'draft', clientVisible: 1, desc: 'Amber on white is 2.9:1; darken two steps and re-verify.' },
    ];

    // Expand the seed into a fuller board with generated siblings so filters,
    // WIP limits and charts have real volume.
    const extraTitles = [
      'Write integration tests for {area}', 'Instrument {area} with structured logs', 'Refactor {area} module boundaries',
      'Document {area} contract in the ADR', 'Add empty & error states to {area}', 'Harden {area} against flaky network',
      'Review {area} against the perf budget', 'Migrate {area} to the shared design tokens', 'Add feature flag for {area}',
      'Spike: evaluate {area} alternatives', 'Fix flaky test in {area}', 'Add telemetry events for {area}',
      'Audit {area} for PII leakage', 'Prepare demo script for {area}', 'Localise copy for {area}',
    ];
    const areas = ['intake', 'handoff queue', 'telemetry ingest', 'dashboard', 'checkout', 'gallery', 'risk scoring', 'sync engine', 'audit trail', 'design system', 'onboarding', 'billing hooks'];
    const projectIds = Object.keys(projectPhasePlan);
    const memberIds = ['usr_dev', 'usr_nina', 'usr_arjun', 'usr_sofia', 'usr_omar', 'usr_tara'];

    for (let i = 0; i < 58; i++) {
      const project = pick(projectIds);
      const phaseMap: Record<string, string> = {
        pr_northwind: 'ph_build', pr_veer: 'ph_build', pr_lumen: 'ph_design',
        pr_sentinel: 'ph_enablement', pr_atlas: 'ph_discovery', pr_tide: 'ph_design',
      };
      const status = pick(['backlog', 'backlog', 'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'review', 'done', 'done', 'done', 'blocked']);
      const priority = pick(['urgent', 'high', 'high', 'medium', 'medium', 'medium', 'low', 'low']);
      const title = pick(extraTitles).replace('{area}', pick(areas));
      const estimate = pick([2, 3, 3, 5, 5, 8]);
      const logged = status === 'done' ? estimate * pick([1, 1, 1.1, 1.3]) : status === 'backlog' ? 0 : estimate * pick([0.1, 0.3, 0.5, 0.7, 0.9]);
      taskSeeds.push({
        project,
        phase: phaseMap[project],
        title,
        type: pick(['feature', 'feature', 'bug', 'ops', 'research', 'design']),
        priority,
        status,
        assignee: pick(memberIds),
        points: estimate,
        hours: estimate * 4,
        logged: Math.round(logged * 4),
        dueIn: pick([-3, 1, 2, 3, 5, 6, 8, 12, 15, null as unknown as number]),
        labels: pick([[], ['lb_debt'], ['lb_client'], ['lb_perf'], ['lb_quick'], ['lb_ai'], ['lb_security'], ['lb_design', 'lb_client']]),
        turnover: status === 'done' ? 'passed' : status === 'review' ? pick(['in_review', 'passed', 'failed']) : 'draft',
        clientVisible: pick([0, 1, 1]),
        desc: `Deliver the ${title.toLowerCase()} work for this phase. Acceptance criteria: behaviour verified by a second engineer, evidence attached to the turnover gate, and no regression to the performance budget.`,
        blocked: status === 'blocked' ? pick(['Waiting on client credentials', 'Upstream API contract not final', 'Design decision pending from client']) : undefined,
      });
    }

    const counters: Record<string, number> = {};
    const projectKey: Record<string, string> = {
      pr_northwind: 'NRTH', pr_veer: 'VEER', pr_lumen: 'LMN', pr_sentinel: 'SNTL', pr_atlas: 'ATLS', pr_tide: 'TIDE',
    };
    const taskIds: string[] = [];
    // project_phase rows are the FK target; map (project, phase key) -> row id.
    const phaseRowFor = new Map<string, string>();
    for (const row of await db.all<{ id: string; project_id: string; phase_id: string }>(
      'SELECT id, project_id, phase_id FROM project_phases',
    )) {
      phaseRowFor.set(`${row.project_id}:${row.phase_id}`, row.id);
    }

    for (const [index, t] of taskSeeds.entries()) {
      const pk = projectKey[t.project];
      counters[pk] = (counters[pk] ?? 0) + 1;
      const key = `${pk}-${100 + counters[pk]}`;
      const tid = id('tsk');
      taskIds.push(tid);
      const boardId = t.labels.includes('lb_client') && t.status === 'todo' && index % 11 === 0 ? 'bd_triage' : boardFor[t.project];
      const columnKey = t.status === 'done' ? 'done' : t.status;
      const createdAt = daysAgo(Math.floor(rnd() * 34) + 2);
      const sla = SLA_HOURS[t.priority as keyof typeof SLA_HOURS];
      // Live SLA clock: completed work is judged against its completion moment,
      // open work gets a realistic spread of healthy / at-risk / breached.
      const slaBase = t.status === 'done'
        ? new Date((toDate(createdAt)?.getTime() ?? Date.now()) + sla.resolve * 0.7 * 3600_000).getTime()
        : Date.now() + (pick([-0.25, -0.1, 0.1, 0.35, 0.5, 0.75, 0.9]) * sla.resolve) * 3600_000;
      const slaDue = new Date(slaBase).toISOString().slice(0, 19).replace('T', ' ');
      const dueAt = t.dueIn === null ? null : daysAhead(t.dueIn);
      const startedAt = ['in_progress', 'review', 'blocked', 'done'].includes(t.status) ? daysAgo(Math.floor(rnd() * 8) + 1) : null;
      const completedAt = t.status === 'done' ? daysAgo(Math.floor(rnd() * 6)) : null;

      await db.run(
        `INSERT INTO tasks (id,key,project_id,board_id,column_id,project_phase_id,title,description,type,priority,status,
          assignee_id,reporter_id,story_points,estimate_hours,logged_hours,position,due_at,sla_hours,sla_due_at,sla_breached,
          started_at,completed_at,blocked_reason,turnover_criteria,turnover_state,turnover_approved_by,turnover_approved_at,
          client_visible,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tid, key, t.project, boardId, `${boardId}_${columnKey}`, phaseRowFor.get(`${t.project}:${t.phase}`) ?? null, t.title, t.desc, t.type, t.priority, t.status,
          t.assignee, pick(['usr_maya', 'usr_tara', 'usr_kabir']), t.points, t.hours, t.logged, 1000 + index * 10,
          dueAt, sla.resolve, slaDue, 0, startedAt, completedAt, t.blocked ?? '',
          'Peer review approved · evidence attached · perf budget intact',
          t.turnover, t.turnover === 'passed' ? 'usr_maya' : null, t.turnover === 'passed' ? daysAgo(1) : null,
          t.clientVisible, createdAt, daysAgo(1)],
      );

      for (const lb of t.labels) {
        const labelId = labels.find((l) => l[0] === lb)?.[0];
        if (labelId) await db.run('INSERT OR IGNORE INTO task_labels (task_id,label_id) VALUES (?,?)', [tid, labelId]);
      }
      await db.run('INSERT OR IGNORE INTO task_watchers (task_id,user_id) VALUES (?,?)', [tid, 'usr_maya']);
      if (t.status !== 'backlog') {
        await db.run('INSERT INTO task_checklist (id,task_id,label,done,position) VALUES (?,?,?,?,?)', [id('chk'), tid, 'Acceptance criteria confirmed with the client', 1, 1]);
        await db.run('INSERT INTO task_checklist (id,task_id,label,done,position) VALUES (?,?,?,?,?)', [id('chk'), tid, 'Implementation merged behind a flag', t.status === 'done' ? 1 : 0, 2]);
        await db.run('INSERT INTO task_checklist (id,task_id,label,done,position) VALUES (?,?,?,?,?)', [id('chk'), tid, 'Turnover evidence attached', t.turnover === 'passed' ? 1 : 0, 3]);
      }
      if (index % 4 === 0) {
        await db.run('INSERT INTO task_comments (id,task_id,author_id,body,created_at) VALUES (?,?,?,?,?)', [
          id('cmt'), tid, pick(['usr_maya', 'usr_arjun', 'usr_sofia', 'usr_tara']),
          pick([
            'Pulled the latest client feedback into the AC — added the empty-state requirement.',
            'Blocked on the shared validator; pairing with Arjun tomorrow morning.',
            'Demoed to the client, they asked for a keyboard-only path. Added to scope.',
            'Perf budget verified locally at 168kb (budget 180kb). Evidence attached.',
            'Split this into two: the sync piece moves to next sprint after the CRDT spike.',
          ]), daysAgo(Math.floor(rnd() * 5)),
        ]);
      }
      // Turnover checks per task
      const taskGates = gates.filter((g) => g[3] === 'task');
      for (const [gid, , gname] of taskGates) {
        const state = t.turnover === 'passed' ? 'pass' : t.turnover === 'failed' && gname.includes('Test') ? 'fail' : pick(['pending', 'pending', 'pass', 'pass', 'pass']);
        await db.run(
          'INSERT INTO turnover_checks (id,gate_id,task_id,status,evidence,checked_by,checked_at) VALUES (?,?,?,?,?,?,?)',
          [id('tchk'), gid, tid, state,
            state === 'pass' ? 'Evidence attached to the task thread.' : state === 'fail' ? 'Coverage on the error branch is 41% — needs another pass.' : '',
            state === 'pass' ? 'usr_maya' : null, state === 'pass' ? daysAgo(1) : null],
        );
      }
    }

    // Dependencies — a believable chain.
    const depPairs: Array<any[]> = [[0, 2], [1, 0], [4, 0], [8, 9], [9, 10], [13, 8], [15, 16], [21, 22], [26, 27]];
    for (const [a, b] of depPairs) {
      if (taskIds[a] && taskIds[b] && taskIds[a] !== taskIds[b]) {
        await db.run('INSERT OR IGNORE INTO task_dependencies (task_id,depends_on_id,kind) VALUES (?,?,?)', [taskIds[a], taskIds[b], 'blocks']);
      }
    }

    // Phase-level turnover checks for active project phases.
    const phaseGates = gates.filter((g) => g[3] === 'phase');
    const activePhases = await db.all<{ id: string }>("SELECT id FROM project_phases WHERE status IN ('active','blocked','done')");
    for (const ph of activePhases) {
      for (const [gid] of phaseGates) {
        const st = pick(['pending', 'pending', 'pass', 'pass']);
        await db.run('INSERT INTO turnover_checks (id,gate_id,project_phase_id,status,evidence,checked_by,checked_at) VALUES (?,?,?,?,?,?,?)', [
          id('pchk'), gid, ph.id, st, st === 'pass' ? 'Linked on the project Excaliboard.' : '', st === 'pass' ? 'usr_maya' : null, st === 'pass' ? daysAgo(2) : null,
        ]);
      }
    }

    /* --------------------------------------------------------------- time -- */
    for (let d = 0; d < 21; d++) {
      for (const uid of ['usr_arjun', 'usr_dev', 'usr_nina', 'usr_sofia', 'usr_omar', 'usr_tara']) {
        if (rnd() < 0.18) continue;
        const mins = pick([90, 120, 150, 180, 240, 300, 360]);
        const project = pick(projectIds);
        await db.run(
          'INSERT INTO time_entries (id,task_id,project_id,user_id,minutes,note,billable,approved,worked_on) VALUES (?,?,?,?,?,?,?,?,?)',
          [id('te'), null, project, uid, mins, pick(['Build + test', 'Pairing session', 'Client demo prep', 'Code review', 'Incident follow-up', 'Design crit']), 1, rnd() > 0.3 ? 1 : 0, daysAgo(d)],
        );
      }
    }

    /* ---------------------------------------------------------- handoffs -- */
    const handoffs: Array<any[]> = [
      ['pr_northwind', 'ph_build', 'Intake validation architecture — Excaliboard', 'excalidraw', 'https://excalidraw.com/#json=IMufwXh98gCBoKZVOTg3Z,_X40c3SS52YyVSaIycg4RA', 'shared', 9],
      ['pr_northwind', 'ph_qa', 'QA plan & evidence pack', 'notion', 'https://notion.so/northwind/qa-plan-v3', 'ready', 3],
      ['pr_veer', 'ph_build', 'Kafka topology + consumer groups', 'excalidraw', 'https://excalidraw.com/#json=veer-topology-2026', 'changes_requested', 6],
      ['pr_lumen', 'ph_design', 'Storefront component map', 'figma', 'https://figma.com/file/lumen-storefront-tokens', 'approved', 12],
      ['pr_tide', 'ph_design', 'Offline sync conflict flows', 'excalidraw', 'https://excalidraw.com/#json=tide-sync-conflicts', 'shared', 4],
      ['pr_sentinel', 'ph_enablement', 'Handover walkthrough recording', 'loom', 'https://loom.com/share/sentinel-handover', 'approved', 15],
      ['pr_atlas', 'ph_discovery', 'Grid telemetry systems map', 'excalidraw', 'https://excalidraw.com/#json=atlas-grid-map', 'draft', null],
    ];
    for (const [pid, phid, title, type, url, status, ago] of handoffs) {
      await db.run(
        'INSERT INTO handoffs (id,project_id,project_phase_id,title,type,url,status,created_by,shared_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id('hnd'), pid, phaseRowFor.get(`${pid}:${phid}`) ?? null, title, type, url, status, 'usr_maya', ago ? daysAgo(ago) : null],
      );
    }

    /* ------------------------------------------------------- automations -- */
    const rules: Array<any[]> = [
      ['SLA breach → escalate to delivery principal', 'task.sla_breached', 'escalate.assign', JSON.stringify({ assignee: 'usr_maya', bump_priority: true }), ''],
      ['Blocked > 48h → nudge owner in Slack', 'task.blocked_stale', 'notify.slack', JSON.stringify({ hours: 48, channel: '#delivery' }), ''],
      ['Turnover failed → reopen + tag reporter', 'turnover.failed', 'task.reopen', JSON.stringify({ tag: 'lb_debt' }), ''],
      ['Deal enters consultation → create Excaliboard stub', 'deal.stage_changed', 'handoff.create', JSON.stringify({ stage: 'tech_consult' }), ''],
      ['Phase due in 3 days → alert phase owner', 'phase.due_soon', 'notify.in_app', JSON.stringify({ days: 3 }), ''],
      ['Weekly capacity > 110% → block new assignment', 'capacity.overallocated', 'assign.block', JSON.stringify({ threshold: 110 }), ''],
    ];
    for (const [i, [name, trig, act, cfg]] of rules.entries()) {
      await db.run('INSERT INTO automation_rules (id,name,trigger_key,action_key,config_json,is_enabled,run_count,last_run_at) VALUES (?,?,?,?,?,?,?,?)', [
        id('aut'), name, trig, act, cfg, i === 5 ? 0 : 1, Math.floor(rnd() * 40), daysAgo(1),
      ]);
    }

    /* ------------------------------------------------------ notifications -- */
    const notifs: Array<any[]> = [
      ['usr_maya', 'sla', 'SLA breach risk: VEER-102', 'Kafka rebalance ticket has 0h left on the clock.', null],
      ['usr_maya', 'turnover', 'Turnover failed on NRTH-104', 'DOB validation left the gate without test evidence.', 1],
      ['usr_arjun', 'mention', 'Tara mentioned you', '"Can you pair on the shared validator after standup?"', 2],
      ['usr_sofia', 'handoff', 'Client approved the component map', 'Lumen approved the Figma handoff — phase can close.', 3],
      ['usr_dev', 'assignment', 'New task assigned: NRTH-107', 'Care pathway builder moved to Ready for you.', null],
      ['usr_tara', 'deal', 'Atlas consultation booked', 'Tuesday 11:00 IST with Daniel Okoye. Pre-read attached.', 5],
    ];
    for (const [uid, kind, title, body, ago] of notifs) {
      await db.run('INSERT INTO notifications (id,user_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)', [
        id('ntf'), uid, kind, title, body, ago === null ? isoNow() : daysAgo(ago),
      ]);
    }

    /* ---------------------------------------------------- capacity + misc -- */
    for (let wk = 0; wk < 4; wk++) {
      const weekStart = daysAhead(wk * 7 - 21);
      for (const [uid, cap] of [['usr_arjun', 34], ['usr_dev', 36], ['usr_nina', 36], ['usr_sofia', 32], ['usr_omar', 32], ['usr_tara', 30]] as const) {
        const planned = Math.round(cap * (0.6 + rnd() * 0.7));
        await db.run('INSERT INTO capacity_snapshots (id,user_id,week_start,capacity_hours,planned_hours,logged_hours) VALUES (?,?,?,?,?,?)', [
          id('cap'), uid, weekStart, cap, planned, Math.round(planned * (0.7 + rnd() * 0.3)),
        ]);
      }
    }

    /* ---------------------------------------------- operational clocks ----- */
    // Straight from the delivery-ops board. Hard targets, warn thresholds and
    // the aggressive internal stretch goal so the UI can show "green streak".
    // (id, key, name, scope, anchorEvent, target, warn, stretch, escalation, note, boardRef)
    const clocks: Array<any[]> = [
      ['ck_consult_plan', 'consult-to-plan', 'Consultation → Implementation plan', 'deal', 'technical consultation delivered', 72, 48, 36, 'lead', 'Maximum 3 days from the first technical consultation to a plan in the client’s inbox.', 'v1'],
      ['ck_revision', 'plan-revision', 'Plan revision after major changes', 'deal', 'major change requested', 32, 24, 12, 'lead', 'Revisions return within 12–32 hours. 32h is the hard ceiling, 12h the stretch.', 'v2'],
      ['ck_module', 'module-turnover', 'Module turnover', 'task', 'module moved to review', 24, 18, 12, 'lead', 'A module can never sit in review for more than one day.', 'v2'],
      ['ck_milestone', 'milestone-turnover', 'Milestone turnover', 'phase', 'milestone started', 168, 120, 96, 'lead', 'A milestone closes inside one week, including QA evidence.', 'v2'],
      ['ck_client_turn', 'client-turnover', 'Client turnover (hard ceiling)', 'project', 'phase moved to client review', 336, 240, 168, 'admin', 'Two weeks is the absolute ceiling; one week is the target we hold ourselves to.', 'v3'],
      ['ck_demo', 'first-demo', 'First demo', 'project', 'project kicked off', 336, 288, 168, 'lead', 'The client sees something running within two weeks of kickoff — no exceptions.', 'v4'],
      ['ck_ship', 'ship-after-approval', 'Ship after demo approval', 'release', 'demo approved', 120, 96, 48, 'admin', 'Once approved, the build ships within five days.', 'v5'],
      ['ck_qa_report', 'qa-report', 'QA report turnover', 'qa', 'QA report submitted', 12, 8, 6, 'lead', 'Bug and testing reports land within 12 hours of the QA pass.', 'v6'],
      ['ck_exec', 'exec-summary', 'Executive shipping summary', 'release', 'release entered demo_ready', 96, 72, 48, 'admin', 'The executive summary is prepared at least two days before the proposed shipment.', 'v6'],
      ['ck_triage', 'lead-triage', 'Lead triage of inbound', 'deal', 'inbound lead captured', 24, 12, 8, 'lead', 'Every inbound gets a qualified or declined answer inside one working day.', 'v1'],
    ];
    for (const [cid, key, name, scope, anchorEvent, target, warn, stretch, esc, note, ref] of clocks) {
      await db.run(
        `INSERT INTO sla_clocks (id,key,name,scope,anchor_event,target_hours,warn_hours,stretch_hours,enforceable,escalation,policy_note,board_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, target_hours = excluded.target_hours, warn_hours = excluded.warn_hours, stretch_hours = excluded.stretch_hours, policy_note = excluded.policy_note, board_ref = excluded.board_ref`,
        [cid, key, name, scope, anchorEvent, target, warn, stretch, 1, esc, note, ref],
      );
    }

    /* ---------------------------------------------------- partners + IAM --- */
    const partners: Array<any[]> = [
      ['pa_northwind', 'cl_northwind', 'Northwind Care Console', 'northwind', 'growth', 120, 250000, 24],
      ['pa_veer', 'cl_veer', 'Veer Fleet Console', 'veer', 'enterprise', 450, 900000, 60],
      ['pa_sentinel', 'cl_sentinel', 'Sentinel Risk Console', 'sentinel', 'enterprise', 300, 1200000, 45],
      ['pa_lumen', 'cl_lumen', 'Lumen Commerce Console', 'lumen', 'growth', 80, 180000, 18],
      ['pa_kite', 'cl_kite', 'Kite Growth Console', 'kite', 'starter', 25, 40000, 6],
    ];
    for (const [pid, cid, name, slug, plan, devices, quota, seats] of partners) {
      await db.run(
        'INSERT INTO partners (id,client_id,name,slug,console_url,plan,device_limit,api_quota_month,seat_limit) VALUES (?,?,?,?,?,?,?,?,?)',
        [pid, cid, name, slug, `https://${slug}.relayoss.studio/console`, plan, devices, quota, seats],
      );
      /*
       * Partner IAM identities.
       *
       * `user_id` is not decoration: `assertPartner` in the router resolves a partner
       * from `partner_iam_users.user_id`, so a row without one grants nobody access.
       * The seed used to insert these rows with the column unset, which meant every
       * non-admin partner request was a 404 — the console looked present in the UI
       * and was unreachable through the API for anyone but an admin. The edge-case
       * registry caught it as 124 "expected 200, got 404" failures, mostly on the
       * partner routes.
       *
       * So each partner gets a real `users` row, and the IAM row references it. The
       * first partner's owner doubles as the partner identity used by the smoke run
       * and the edge fixtures.
       */
      const iamUsers: Array<any[]> = [
        [`${slug}.owner@${slug}.app`, pick([`Priya Raman`, `Rohit Malhotra`, `Aisha Khan`, `Vikram Shah`, `Neha Bansal`]), 'owner', 1, 1],
        [`ops@${slug}.app`, 'Ops Desk', 'operator', 1, pick([0, 1, 2])],
        [`qa@${slug}.app`, 'QA Automation', 'service', 0, 1],
      ];
      for (const [email, dn, role, mfa, ago] of iamUsers) {
        const iamId = id('iam');
        // The `service` role is a machine account: it authenticates with an API key,
        // not a user session, so it deliberately has no `users` row.
        const userId = role === 'service' ? null : `usr_${slug}_${role}`;
        if (userId) {
          await db.run(
            `INSERT INTO users (id,email,full_name,title,role,initials,capacity_hours_week,cost_rate_cents,bill_rate_cents,skills_json)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              userId, email, dn, `${name} — ${role}`, 'member',
              dn.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
              0, 0, 0, JSON.stringify(['partner']),
            ],
          );
        }
        await db.run(
          'INSERT INTO partner_iam_users (id,partner_id,user_id,email,display_name,role,mfa_enabled,last_active_at,status) VALUES (?,?,?,?,?,?,?,?,?)',
          [iamId, pid, userId, email, dn, role, mfa, ago === null ? null : daysAgo(ago), mfa === 1 ? 'active' : 'invited'],
        );
      }
      for (let i = 0; i < Math.min(devices, 9); i++) {
        await db.run(
          'INSERT INTO device_licenses (id,partner_id,device_id,device_name,platform,status,assigned_to,activated_at) VALUES (?,?,?,?,?,?,?,?)',
          [id('dev'), pid, `DEV-${slug.slice(0, 3).toUpperCase()}-${1000 + i}`, pick(['Field Tablet A', 'Warehouse Scanner', 'Dispatch Console', 'Nurse Handheld', 'Driver Phone']) + ` ${i + 1}`,
            pick(['android', 'ios', 'android']), i > 7 ? 'revoked' : 'active', pick(['Field Team 1', 'Ops', 'Night Shift', '']), daysAgo(i * 3)],
        );
      }
      for (let d = 0; d < 30; d++) {
        await db.run(
          'INSERT INTO usage_metrics (id,partner_id,day,api_calls,active_users,storage_mb,uptime_pct) VALUES (?,?,?,?,?,?,?)',
          [id('usg'), pid, daysAgo(d), Math.round(quota / 30 * (0.4 + rnd() * 0.9)), Math.round(seats * (0.5 + rnd() * 0.8)),
            Math.round(200 + rnd() * 4000), Math.round((99.2 + rnd() * 0.79) * 100) / 100],
        );
      }
    }

    /* --------------------------------------------------------- edge cases -- */
    const edgeModules = [
      ['intake', 'functional'], ['handoff queue', 'concurrency'], ['telemetry ingest', 'data'],
      ['dashboard perf', 'network'], ['checkout', 'functional'], ['risk scoring', 'security'],
      ['offline sync', 'network'], ['audit trail', 'security'], ['design system', 'i18n'],
      ['device pairing', 'device'], ['permissions', 'permission'], ['billing hooks', 'data'],
    ];
    const edgeTemplates = [
      ['Double-submit while the request is still in flight', 'high'],
      ['Clock skew between device and server moves the record a day', 'medium'],
      ['Unicode RTL text in a name field breaks the card layout', 'low'],
      ['Session expires mid-wizard, wizard resumes at the right step', 'high'],
      ['Network drops between step 2 and 3, no duplicate rows created', 'critical'],
      ['Two operators claim the same queue item simultaneously', 'critical'],
      ['Decimal rounding on currency conflicts with the invoice', 'high'],
      ['Empty-state renders when the upstream feed returns zero rows', 'medium'],
      ['Permission downgrade takes effect without a re-login', 'high'],
      ['Bulk import of 10k rows does not block the request thread', 'high'],
      ['Timezone change to DST does not duplicate scheduled jobs', 'medium'],
      ['Revoked device licence fails closed within 60s', 'critical'],
    ];
    for (const pid of ['pr_northwind', 'pr_veer', 'pr_sentinel', 'pr_tide', 'pr_lumen']) {
      const target = 40 + Math.floor(rnd() * 30);
      for (let i = 0; i < target; i++) {
        const [mod, cat] = pick(edgeModules);
        const [scenario, sev] = pick(edgeTemplates);
        const status = pick(['catalogued', 'catalogued', 'covered', 'covered', 'verified', 'verified', 'verified', 'deferred']);
        await db.run(
          'INSERT INTO edge_cases (id,project_id,module,code,scenario,category,severity,status,automated,verified_by,verified_at,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [id('edge'), pid, mod, `EC-${String(1000 + i)}`, scenario, cat, sev, status,
            status === 'verified' ? pick([0, 1, 1]) : 0,
            status === 'verified' ? pick(['usr_tara', 'usr_nina', 'usr_arjun']) : null,
            status === 'verified' ? daysAgo(Math.floor(rnd() * 12)) : null,
            status === 'deferred' ? 'Client accepted the risk in writing.' : ''],
        );
      }
    }

    /* ---------------------------------------------------------- releases --- */
    const releases: Array<any[]> = [
      ['pr_northwind', 'v2.4.0', 'Intake & handoff', 'in_qa', 'lear-backend/northwind-intake', 4, null, 9, null, 'Ship behind flag northwind.intake_v2; rollback = flip flag.'],
      ['pr_northwind', 'v2.3.0', 'Clinician console', 'shipped', 'lear-backend/northwind-console', -18, -17, -14, -13, 'Previously shipped; stable.'],
      ['pr_veer', 'v1.9.0', 'Telemetry cutover', 'demo_done', 'lear-backend/veer-telemetry', -2, -1, 2, null, 'Blocked on client egress; rollback keeps the old consumer group alive.'],
      ['pr_lumen', 'v3.1.0', 'Design system + PDP', 'demo_ready', 'lear-backend/lumen-storefront', 3, null, 7, null, 'Deploy to edge; previous build stays warm for instant rollback.'],
      ['pr_sentinel', 'v3.0.0', 'Risk engine GA', 'shipped', 'lear-backend/sentinel-risk', -32, -31, -26, -25, 'Zero-downtime blue/green; model artefacts pinned by digest.'],
      ['pr_tide', 'v0.4.0', 'Offline field capture', 'planning', 'lear-backend/tide-offline', null, null, null, null, 'Awaiting conflict-flow approval.'],
    ];
    for (const [pid, version, name, status, branch, demoIn, approvedIn, shipIn, shippedIn, rollback] of releases) {
      const rid = id('rel');
      await db.run(
        `INSERT INTO releases (id,project_id,version,name,status,demo_at,demo_approved_at,exec_summary_due_at,ship_planned_at,shipped_at,branch,deploy_target,rollback_plan,exec_summary_url,demo_feedback)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [rid, pid, version, name, status,
          demoIn === null ? null : daysAhead(demoIn),
          approvedIn === null ? null : daysAhead(approvedIn),
          shipIn === null ? null : daysAhead(shipIn - 2),
          shipIn === null ? null : daysAhead(shipIn),
          shippedIn === null ? null : daysAhead(shippedIn),
          branch, 'AWS · ap-south-1', rollback,
          status === 'demo_ready' || status === 'demo_done' ? 'https://notion.so/relay/exec-summary-' + version : '',
          status === 'demo_done' ? 'Approved with one change: add a bulk-assign action before ship.' : ''],
      );
    }

    /* ------------------------------------------------------------ QA feed -- */
    const qaTitles = [
      ['p1', 'bug', 'Duplicate handoff rows when two clinicians accept at once'],
      ['p2', 'bug', 'Mobile: filter chips overflow on 360px screens'],
      ['p0', 'security', 'Audit log omits actor on PHI export'],
      ['p3', 'test', 'Regression pack for intake wizard (48 cases)'],
      ['p2', 'perf', 'Dashboard p95 above budget at 4k vehicles'],
      ['p1', 'bug', 'Stripe webhook retries create duplicate invoices'],
      ['p3', 'a11y', 'Colour contrast fails AA on the promo rail'],
      ['p2', 'bug', 'Offline queue replays stale records after app update'],
      ['p2', 'test', 'Load test report — 3× festive peak'],
      ['p1', 'bug', 'Locale switch resets the checkout step'],
    ];
    /*
     * The first report's id, remembered because the QA turnover clock below hangs
     * off a real report. It used to be the literal 'QA-2201', which names nothing
     * in this schema — `qa_reports` has no number column — so the clock pointed at
     * a row that did not exist. That made the Clocks screen show a running QA clock
     * whose Met/Pause buttons answered 404: the tenancy guard resolved the entity,
     * found nothing, and reported "not found" for a timer the list had just shown.
     */
    let firstQaId: string | null = null;
    for (let i = 0; i < 22; i++) {
      const [sev, kind, title] = qaTitles[i % qaTitles.length];
      const project = pick(['pr_northwind', 'pr_veer', 'pr_lumen', 'pr_tide', 'pr_sentinel']);
      const status = pick(['open', 'open', 'triaged', 'in_progress', 'fixed', 'verified', 'verified', 'wont_fix']);
      const submitted = daysAgo(Math.floor(rnd() * 9));
      const qaId = id('qa');
      if (!firstQaId) firstQaId = qaId;
      await db.run(
        `INSERT INTO qa_reports (id,project_id,kind,severity,title,body,status,reproduction,evidence_url,reporter_id,assignee_id,due_at,submitted_at,resolved_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [qaId, project, kind, sev, title,
          'Reported during the scheduled QA pass. Full log, HAR and screen recording attached to the ticket.',
          status, pick(['Open in a clean session, complete step 2, then hard-refresh.', 'Throttle to Slow 3G and retry the submit 3×.', 'Two tabs, same user, act within 2 seconds of each other.']),
          'https://evidence.relayoss.studio/' + id('ev'),
          pick(['usr_tara', 'usr_nina']), pick(['usr_dev', 'usr_nina', 'usr_arjun', 'usr_sofia']),
          new Date((toDate(submitted)?.getTime() ?? Date.now()) + 12 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
          submitted, ['fixed', 'verified', 'wont_fix'].includes(status) ? daysAgo(Math.floor(rnd() * 3)) : null],
      );
    }

    /* --------------------------------------------------------- sla timers -- */
    const timerPlan: Array<any[]> = [
      ['consult-to-plan', 'deal', 'dl_atlas', 'Consultation delivered — plan due', 4, 2.5, 'running', ''],
      ['plan-revision', 'deal', 'dl_kite', 'Plan revision 2 requested', 5, 30, 'running', 'Client asked for two extra pricing options.'],
      ['module-turnover', 'task', 'NRTH-103', 'Module turnover: audit log writer', 3, 26, 'missed', 'Waited on the security review — exception logged below.'],
      ['module-turnover', 'task', 'NRTH-102', 'Module turnover: handoff queue', 9, 6, 'running', ''],
      ['first-demo', 'project', 'pr_tide', 'First demo from kickoff', 22, 190, 'running', ''],
      ['exec-summary', 'release', 'v3.1.0', 'Exec summary before ship', 8, 60, 'missed', 'Summary drafted late after the client moved the ship date.'],
      ['qa-report', 'qa', firstQaId ?? '', 'QA report turnaround', 1, 9, 'running', ''],
      ['client-turnover', 'project', 'pr_veer', 'Client turnover: Kafka topology', 40, 260, 'running', 'Client review requested with their network team.'],
      ['milestone-turnover', 'phase', 'ph_build', 'Build milestone turnover', 2, 150, 'running', ''],
      ['ship-after-approval', 'release', 'v2.4.0', 'Ship after demo approval', 6, 100, 'running', ''],
    ];
    for (const [clockKey, etype, eid, label, startedAgoH, targetH, outcome, note] of timerPlan) {
      const started = new Date(Date.now() - startedAgoH * 3600_000);
      const due = new Date(started.getTime() + targetH * 3600_000);
      const warn = new Date(started.getTime() + targetH * 0.66 * 3600_000);
      await db.run(
        `INSERT INTO sla_timers (id,clock_key,entity_type,entity_id,label,started_at,due_at,warn_at,met_at,missed_at,outcome,exception_note,minutes_used)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id('tmr'), clockKey, etype, eid, label,
          started.toISOString().slice(0, 19).replace('T', ' '),
          due.toISOString().slice(0, 19).replace('T', ' '),
          warn.toISOString().slice(0, 19).replace('T', ' '),
          outcome === 'met' ? due.toISOString().slice(0, 19).replace('T', ' ') : null,
          outcome === 'missed' ? new Date(due.getTime() + 3600_000).toISOString().slice(0, 19).replace('T', ' ') : null,
          outcome, note, startedAgoH * 60],
      );
    }

    /* ------------------------------------------------------- acceptance ---- */
    const allTasks = await db.all<{ id: string; status: string; assignee_id: string; turnover_state: string }>(
      'SELECT id,status,assignee_id,turnover_state FROM tasks',
    );
    for (const t of allTasks) {
      const ladder: Array<any[]> = [];
      if (t.status === 'done') {
        ladder.push(['dev_complete', 'passed'], ['qa_approved', 'passed'], ['lead_approved', 'passed'],
          ['client_accepted', rnd() > 0.35 ? 'passed' : 'pending']);
      } else if (t.status === 'review') {
        ladder.push(['dev_complete', 'passed'], ['qa_approved', t.turnover_state === 'passed' ? 'passed' : rnd() > 0.5 ? 'pending' : 'rejected'],
          ['lead_approved', 'pending'], ['client_accepted', 'pending']);
      } else if (['in_progress', 'blocked'].includes(t.status)) {
        ladder.push(['dev_complete', 'pending'], ['qa_approved', 'pending'], ['lead_approved', 'pending'], ['client_accepted', 'pending']);
      }
      for (const [step, state] of ladder) {
        await db.run(
          'INSERT INTO acceptance_records (id,task_id,step,state,actor_id,evidence,notes,decided_at) VALUES (?,?,?,?,?,?,?,?)',
          [id('acc'), t.id, step, state,
            state === 'passed' ? (step === 'qa_approved' ? 'usr_tara' : step === 'lead_approved' ? 'usr_maya' : t.assignee_id) : null,
            state === 'passed' ? 'CI green · evidence bundle attached' : '',
            state === 'rejected' ? 'Reopened: missing turnover evidence on the error branch.' : '',
            state === 'passed' ? daysAgo(1) : null],
        );
      }
      const step = t.status === 'done' ? 'client_accepted' : t.status === 'review' ? 'lead_approved' : 'dev_complete';
      await db.run('UPDATE tasks SET acceptance_step = ? WHERE id = ?', [step, t.id]);
    }

    /* -------------------------------------------------------------- docs --- */
    const docs: Array<any[]> = [
      ['pr_northwind', 'ADR-014: intake validation strategy', 'adr', 'approved', 'Server-authoritative validation with a generated client schema. Parity is asserted by a contract test that runs on every PR; drift fails the build.', 1],
      [null, 'Delivery handbook — turnover gates', 'runbook', 'approved', 'Nothing is "done" until dev complete → QA approved → lead approved → client accepted. Each step is recorded with an actor and evidence. Phases additionally require the Excaliboard artefact and the exec summary two days before ship.', 1],
      [null, 'QA report format', 'spec', 'approved', 'Every QA pass produces a report within 12 hours: environment, build hash, scope covered, defects by severity, and the evidence bundle link.', 1],
      ['pr_veer', 'Kafka cutover runbook', 'runbook', 'in_review', 'Pre-flight: broker egress confirmed, consumer group offsets exported, rollback window agreed. Cutover in two slices with a 30-minute soak between.', 0],
      ['pr_sentinel', 'Executive shipping summary — v3.0.0', 'exec_summary', 'approved', 'Delivered 11 days early. Risk score latency dropped 62%. No open P0/P1. Handover scheduled with two training sessions and a signed runbook.', 1],
      ['pr_tide', 'Offline sync — field notes', 'note', 'draft', 'Field engineers keep the tablet in the truck overnight at 45°C; battery-first design required. Sync must survive 6 hours offline.', 0],
    ];
    for (const [pid, title, kind, status, body, visible] of docs) {
      await db.run('INSERT INTO docs (id,project_id,title,kind,body,status,author_id,client_visible,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id('doc'), pid, title, kind, body, status, pick(['usr_maya', 'usr_arjun', 'usr_tara']), visible, daysAgo(Math.floor(rnd() * 10))]);
    }

    await db.run('INSERT INTO saved_views (id,name,owner_id,surface,filters_json,is_shared) VALUES (?,?,?,?,?,1)', [
      id('vw'), 'My urgent + client-visible', 'usr_maya', 'board', JSON.stringify({ assignee: 'me', priority: ['urgent', 'high'], label: 'lb_client' }),
    ]);
    await db.run('INSERT INTO saved_views (id,name,owner_id,surface,filters_json,is_shared) VALUES (?,?,?,?,?,1)', [
      id('vw'), 'SLA at risk this week', 'usr_maya', 'board', JSON.stringify({ sla: 'at_risk' }),
    ]);

    for (const [tbl, days, desc] of [
      ['activity', 400, 'Product activity feed retention'],
      ['audit_log', 2555, 'Audit trail — 7 year regulatory retention'],
      ['notifications', 90, 'In-app notification retention'],
      ['time_entries', 2555, 'Billable time records'],
    ] as const) {
      await db.run('INSERT INTO retention_policies (id,table_name,retain_days,description) VALUES (?,?,?,?) ON CONFLICT (table_name) DO UPDATE SET retain_days = excluded.retain_days, description = excluded.description', [id('ret'), tbl, days, desc]);
    }

    /* --------------------------------------------------------- activity -- */
    const acts: Array<any[]> = [
      ['task', 'NRTH-103', 'usr_arjun', 'moved', 'moved to In Review', 1],
      ['task', 'NRTH-104', 'usr_nina', 'turnover_failed', 'failed turnover gate TG-05', 2],
      ['project', 'pr_veer', 'usr_arjun', 'blocked', 'raised a blocker on Kafka rebalance', 3],
      ['deal', 'dl_atlas', 'usr_kabir', 'stage_changed', 'moved Technical Consultation → booked Tuesday', 4],
      ['handoff', 'pr_lumen', 'usr_sofia', 'approved', 'client approved the Figma component map', 5],
      ['task', 'VEER-101', 'usr_nina', 'commented', 'asked for a perf budget confirmation', 6],
      ['phase', 'pr_sentinel', 'usr_tara', 'phase_started', 'started Handover & Enablement', 8],
      ['task', 'TIDE-102', 'usr_sofia', 'status_changed', 'moved to In Progress', 9],
    ];
    for (const [etype, eid, actor, verb, summary, ago] of acts) {
      await db.run('INSERT INTO activity (entity_type,entity_id,actor_id,verb,summary,created_at) VALUES (?,?,?,?,?,?)', [
        etype, eid, actor, verb, summary, daysAgo(ago),
      ]);
    }

    log('  ✓ seeded 8 people, 6 clients, 12 deals, 6 projects, ' + taskSeeds.length + ' tasks');
  });
}



