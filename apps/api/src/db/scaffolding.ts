/**
 * Structural scaffolding — the parts of the product that are not content.
 *
 * A delivery board needs its six columns, and the pipeline needs its twelve gates,
 * before anybody has entered a single client. Both used to exist only in
 * `db/seed.ts`, which is the *demo* seed: an installation that started empty therefore
 * had no column for a task to land in and no stage for a deal to sit in. The board
 * screen had nothing to accept work, and creating the first deal failed with
 * "Unknown stage" — the product looked broken at exactly the moment a new operator
 * first used it.
 *
 * These rows are the product's own method, not sample data: the twelve gates are the
 * consultation-to-kickoff spine, and the six columns are the delivery states. Nothing
 * here invents a client, a project or a task. `npm run db:seed` still adds the demo
 * content; this adds only the frame it hangs on.
 */
import type { Db } from './index.ts';

/** The columns every delivery board starts with, in order. */
export const DEFAULT_COLUMNS: Array<{
  key: string;
  name: string;
  wip: number | null;
  done: boolean;
  color: string;
}> = [
  { key: 'backlog', name: 'Backlog', wip: null, done: false, color: '#64748b' },
  { key: 'todo', name: 'Ready', wip: null, done: false, color: '#94a3b8' },
  { key: 'in_progress', name: 'In Progress', wip: 4, done: false, color: '#d4a44c' },
  { key: 'review', name: 'In Review', wip: 3, done: false, color: '#f5a524' },
  { key: 'blocked', name: 'Blocked', wip: null, done: false, color: '#f4486b' },
  { key: 'done', name: 'Shipped', wip: null, done: true, color: '#22c98a' },
];

/** The studio-wide board, created once, empty. */
export const DEFAULT_BOARD = {
  id: 'bd_studio',
  name: 'Studio',
  description: 'Everything the studio is working on, in one place.',
  kind: 'delivery',
} as const;

/**
 * The twelve pipeline gates: id, key, name, phase, position, description, entry
 * criteria, exit criteria, turnaround days, indicative value, colour, icon.
 */
export const PIPELINE_STAGES: Array<[
  string, string, string, string, number, string, string, string, number, number, string, string,
]> = [
  ['st_inbound', 'inbound', 'Inbound Lead', 'origin', 10, 'Signal captured from referral, site or outbound.',
    'Name, company, source, rough budget band', 'ICP fit confirmed, ≥ ₹3L potential', 3, 300000, '#64748b', 'inbox'],
  ['st_triage', 'triage', 'Triage & Qualify', 'origin', 20, '30-minute fit call with the growth lead.',
    'Lead in pipeline', 'Problem statement + decision-maker identified', 3, 400000, '#8b5cf6', 'filter'],
  ['st_consult', 'tech_consult', 'Technical Consultation', 'discovery', 30, 'Paid 60–90 min technical consultation with the delivery lead.',
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

/**
 * Ensure the frame exists. Idempotent, and safe to call on every boot.
 *
 * - A board is created only when `boards` is completely empty, so an installation that
 *   already has boards (seeded, or created by hand) is never touched.
 * - Stages are upserted by key, because the gate list is versioned with the product:
 *   an installation that predates a gate should gain it rather than run forever with a
 *   pipeline that cannot express a stage the interface shows.
 */
export async function ensureScaffolding(db: Db): Promise<{ boardCreated: boolean }> {
  const existing = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM boards');
  let boardCreated = false;

  if (Number(existing?.c ?? 0) === 0) {
    await db.run(
      'INSERT INTO boards (id,project_id,name,description,kind) VALUES (?,?,?,?,?)',
      [DEFAULT_BOARD.id, null, DEFAULT_BOARD.name, DEFAULT_BOARD.description, DEFAULT_BOARD.kind],
    );
    let position = 0;
    for (const column of DEFAULT_COLUMNS) {
      await db.run(
        'INSERT INTO columns (id,board_id,key,name,position,wip_limit,is_done,color) VALUES (?,?,?,?,?,?,?,?)',
        [
          `${DEFAULT_BOARD.id}_${column.key}`, DEFAULT_BOARD.id, column.key, column.name,
          position++, column.wip, column.done ? 1 : 0, column.color,
        ],
      );
    }
    boardCreated = true;
  }

  for (const stage of PIPELINE_STAGES) {
    await db.run(
      `INSERT INTO pipeline_stages (id,key,name,phase,position,description,entry_criteria,exit_criteria,default_sla_days,default_value_cents,color,icon)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
         position = excluded.position, entry_criteria = excluded.entry_criteria,
         exit_criteria = excluded.exit_criteria, default_sla_days = excluded.default_sla_days,
         default_value_cents = excluded.default_value_cents`,
      [...stage],
    );
  }

  return { boardCreated };
}
