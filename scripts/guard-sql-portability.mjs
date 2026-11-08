#!/usr/bin/env node
/**
 * SQL portability guard.
 *
 * The application writes one statement dialect and executes it on SQLite
 * (development) and PostgreSQL 16 (production). Every construct below exists in
 * exactly one engine, so it silently breaks the other at runtime — which is how
 * the two-argument `MIN()` and `date('now','-7 day')` regressions slipped
 * through until the PostgreSQL contract suite caught them.
 *
 * This guard fails the build instead. Exceptions must be explicit, commented
 * `// sql-portable-ok: <reason>` on the line, so a reviewer sees the decision.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [path.join(ROOT, 'apps', 'api', 'src'), path.join(ROOT, 'apps', 'api', 'test')];

/** SQLite-only constructs (would fail on PostgreSQL). */
const SQLITE_ONLY = [
  [/\bdate\(\s*'now'/i, "SQLite-only date('now') — compute the date in JS and bind it"],
  [/\bdatetime\(\s*'now'/i, "SQLite-only datetime('now') — use lib/dates.ts isoNow()/sqlNow()"],
  [/\bjulianday\s*\(/i, 'SQLite-only julianday()'],
  [/\bstrftime\s*\(/i, 'SQLite-only strftime()'],
  [/\bpragma_table_info\s*\(/i, 'SQLite-only pragma_table_info() — guard with db.dialect'],
  [/\bINSERT\s+OR\s+REPLACE\b/i, 'SQLite-only INSERT OR REPLACE — use an explicit ON CONFLICT upsert'],
  [/\bAUTOINCREMENT\b/i, 'SQLite-only AUTOINCREMENT'],
  [/\bjson_extract\s*\(/i, 'SQLite-only json_extract()'],
];

/** PostgreSQL-only constructs (would fail on SQLite). */
const PG_ONLY = [
  [/\bLEAST\s*\(/i, 'PostgreSQL-only LEAST() — use a CASE expression'],
  [/\bGREATEST\s*\(/i, 'PostgreSQL-only GREATEST() — use a CASE expression'],
  [/\bILIKE\b/i, 'PostgreSQL-only ILIKE — write LIKE and let translate() upgrade it on PG'],
  [/\bRETURNING\b/i, 'RETURNING is PostgreSQL-only here (node:sqlite cannot bind it)'],
  [/\bON\s+CONFLICT\s*\(\s*[a-z_, ]*\)\s*WHERE\b/i, 'partial-index conflict target — verify on both engines'],
];

/** Two-argument MIN(a, b) / MAX(a, b): scalar in SQLite, aggregate-only in PG. */
const SCALAR_MINMAX = [
  [/\b(MIN|MAX)\s*\(\s*[A-Za-z_][\w.]*\s*,\s*[A-Za-z_0-9][^)]*\)/i, 'two-argument MIN/MAX is SQLite-only — use a CASE expression'],
];

const RULES = [...SQLITE_ONLY, ...PG_ONLY, ...SCALAR_MINMAX];
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mjs')) continue;
    // db/sql.ts *is* the dialect translator: its patterns are the rulebook.
    if (full.endsWith(path.join('db', 'sql.ts'))) continue;
    // migrate.ts builds the dialect-specific ledger DDL by design.
    if (full.endsWith(path.join('db', 'migrate.ts'))) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/sql-portable-ok/.test(line)) return;
      const trimmed = line.trim();
      // Prose comments and JS arithmetic are not SQL: skip lines with no SQL
      // keywords, and skip `Math.min(...)`/`Math.max(...)` explicitly.
      if (!/\b(SELECT|INSERT|UPDATE|DELETE|VALUES|SET|FROM|WHERE)\b/i.test(line)) return;
      if (/Math\.(min|max)/.test(line)) return;
      if (/^\s*\*/.test(trimmed)) return; // JSDoc body
      for (const [re, message] of RULES) {
        if (re.test(line)) {
          findings.push({
            file: path.relative(ROOT, full),
            line: i + 1,
            message,
            code: line.trim().slice(0, 120),
          });
        }
      }
    });
  }
}

for (const dir of SCAN_DIRS) if (fs.existsSync(dir)) walk(dir);

if (findings.length) {
  console.error(`✗ SQL portability guard found ${findings.length} non-portable construct(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.message}`);
    console.error(`    → ${f.code}\n`);
  }
  console.error('Both engines must execute the same statement. Fix, or annotate with: // sql-portable-ok: <reason>');
  process.exit(1);
}

console.log('✓ SQL portability guard passed — statements are executable on SQLite and PostgreSQL 16.');
