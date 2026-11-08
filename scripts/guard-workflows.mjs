/**
 * Minimal structural check for the workflow files — run by `npm run guard`.
 *
 * A real YAML parser would be better, but adding a dependency to lint two files is
 * not worth it, and the failure this catches is narrow.
 *
 * Written because a CI run failed with `jobs: total_count 0` and no logs: the
 * workflow was unparseable, and GitHub reported it as a bare failure. The cause was
 * an `env:` key whose only children were comments — valid-looking, invalid YAML.
 *
 * This cannot replace a real parser, but it catches the specific class of mistake
 * (a mapping key with no children) plus tab indentation, which is what actually
 * happens when a workflow is edited by hand.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = '.github/workflows';
let bad = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  const full = path.join(dir, file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const problems = [];

  lines.forEach((line, i) => {
    if (/^\t/.test(line) || /^\s*\t/.test(line)) problems.push(`line ${i + 1}: tab indentation`);

    // A mapping key with nothing under it (only comments or blanks following).
    const m = /^(\s*)([A-Za-z_.-]+):\s*(#.*)?$/.exec(line);
    if (!m) return;
    const indent = m[1].length;
    let j = i + 1;
    let hasChild = false;
    let sawListSibling = false;
    for (; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim() || next.trim().startsWith('#')) continue;
      const nextIndent = next.match(/^\s*/)[0].length;
      if (nextIndent > indent) { hasChild = true; break; }
      if (nextIndent === indent && /^\s*-\s/.test(next)) { sawListSibling = true; break; }
      break;
    }
    /*
     * A null value is legal in a few places — GitHub treats a bare trigger key as
     * "no filters", so `pull_request:` with nothing under it is correct. What is
     * not legal in practice is a *block* mapping like `env:` or `jobs:` with no
     * children, which is the mistake that broke CI here.
     */
    const NULL_IS_FINE = new Set(['pull_request', 'workflow_dispatch', 'push', 'schedule']);
    if (!hasChild && !sawListSibling && !NULL_IS_FINE.has(m[2])) {
      problems.push(`line ${i + 1}: "${m[2]}:" has no value or children`);
    }
  });

  if (problems.length) {
    bad += 1;
    console.error(`✗ ${full}`);
    for (const p of problems) console.error(`    ${p}`);
  } else {
    console.log(`✓ ${full}`);
  }
}
if (bad) { console.error(`\n${bad} workflow file(s) look malformed`); process.exit(1); }
