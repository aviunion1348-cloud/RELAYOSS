#!/usr/bin/env node
/**
 * Traceability audit.
 *
 * Fails when:
 *   - a `R<number>` requirement row has no explicit status token
 *   - a status token is outside the allowed vocabulary
 *   - the IDs are not unique
 *   - the numbers in the summary table disagree with the rows above it
 *
 * The summary check is the important one: it is the number people quote, and a
 * hand-maintained total drifts the moment a row is added. This makes the
 * document self-auditing instead of trusting the author.
 *
 *   node scripts/check-traceability.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'docs', 'REQUIREMENT-TRACEABILITY.md');
const STATUSES = ['Verified', 'Partial', 'Incomplete', 'Blocked', 'N/A'];

if (!fs.existsSync(FILE)) {
  console.error('✗ docs/REQUIREMENT-TRACEABILITY.md is missing');
  process.exit(1);
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const problems = [];
const seen = new Map();

for (const line of lines) {
  if (!line.startsWith('| R') || !/^\| R\d+ \|/.test(line)) continue;
  const cells = line.split('|').map((c) => c.trim());
  // | ID | Requirement | ... | Status | Notes |  → ID is cells[1]
  const id = cells[1];
  const status = cells[cells.length - 3];
  const requirement = cells[2] ?? '';
  if (!requirement) problems.push(`${id}: no requirement text`);
  if (!STATUSES.includes(status)) {
    problems.push(`${id}: invalid or missing status "${status}" (expected one of ${STATUSES.join(', ')})`);
    continue;
  }
  if (seen.has(id)) problems.push(`${id}: duplicate ID (also at line with "${seen.get(id)}")`);
  seen.set(id, requirement);
}

const counts = {};
for (const status of STATUSES) counts[status] = 0;
for (const line of lines) {
  if (!/^\| R\d+ \|/.test(line)) continue;
  const cells = line.split('|').map((c) => c.trim());
  const status = cells[cells.length - 3];
  if (STATUSES.includes(status)) counts[status] += 1;
}

// Cross-check the summary table: "| Verified | 44 | R1, R2 … |"
for (const line of lines) {
  if (!/^\| (Verified|Partial|Incomplete|Blocked|N\/A) \| \d+ \|/.test(line)) continue;
  const cells = line.split('|').map((c) => c.trim());
  const status = cells[1];
  const claimed = Number(cells[2]);
  if (claimed !== counts[status]) {
    problems.push(`summary says ${claimed} ${status}, but ${counts[status]} rows carry that status`);
  }
  // An em dash means "no requirements in this status" — a legitimate cell.
  const listed = (cells[3] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '—' && s !== '-');
  const actualIds = lines
    .filter((l) => /^\| R\d+ \|/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((c) => c[c.length - 3] === status)
    .map((c) => c[1]);
  for (const id of actualIds) {
    if (!listed.includes(id)) problems.push(`summary row "${status}" omits ${id}`);
  }
  for (const id of listed) {
    if (!seen.has(id)) problems.push(`summary row "${status}" lists unknown ${id}`);
  }
}

if (problems.length) {
  console.error('✗ Traceability audit failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(
  `✓ Traceability: ${total} requirements, all with explicit status — ` +
    STATUSES.map((s) => `${s} ${counts[s]}`).join(', '),
);
