/**
 * SQL dialect translation.
 *
 * The application writes one SQL dialect (SQLite-flavoured, `?` placeholders)
 * because it keeps the zero-dependency local story intact. PostgreSQL is the
 * production system of record, so every statement passes through here on the
 * way to the server. The translation is deliberately small, explicit and
 * tested — not a general-purpose ORM layer.
 *
 * Handled:
 *   - `?` placeholders           → `$1..$n` (skips quoted strings, comments)
 *   - `INSERT OR IGNORE INTO`    → `INSERT INTO … ON CONFLICT DO NOTHING`
 *   - `INSERT OR REPLACE INTO`   → rejected: callers must be explicit about the
 *                                  conflict target (see `upsertInto`)
 *   - `excluded.`                → `EXCLUDED.`
 *   - `LIKE`                     → `ILIKE` (parity with SQLite's ASCII
 *                                  case-insensitive LIKE)
 *   - `A IS NOT 1`-style ints    → untouched; callers use booleans properly
 *
 * Column types: timestamps are stored as UTC ISO-8601 TEXT and compared
 * lexicographically. That works identically in both engines and keeps the
 * comparison semantics byte-for-byte the same, which is what a cross-engine
 * test suite needs.
 */

export type Dialect = 'sqlite' | 'postgres';

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/** Split SQL into string-literal-aware chunks so `?` inside quotes is left alone. */
function rewritePlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (next === "'") {
          out += next;
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') { inLineComment = true; out += ch; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; out += ch + next; i += 2; continue; }
    if (ch === "'") { inSingle = true; out += ch; i += 1; continue; }
    if (ch === '"') { inDouble = true; out += ch; i += 1; continue; }
    if (ch === '?') { n += 1; out += `$${n}`; i += 1; continue; }

    out += ch;
    i += 1;
  }
  return out;
}

/** `INSERT OR IGNORE INTO t (…) VALUES (…)` → `… ON CONFLICT DO NOTHING`. */
function rewriteInsertIgnore(sql: string): string {
  const m = /^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\s+/i.exec(sql);
  if (!m) return sql;
  let body = sql.slice(m[0].length);
  body = stripTrailingSemicolon(body);
  if (!/ON\s+CONFLICT/i.test(body)) body += ' ON CONFLICT DO NOTHING';
  return `${m[1]}INSERT INTO ${body}`;
}

function stripTrailingSemicolon(s: string): string {
  const t = s.replace(/;\s*$/, '');
  return t;
}

/** Explicit, checked upsert builder so no statement guesses its conflict target. */
export function upsertInto(
  table: string,
  columns: string[],
  conflictColumns: string[],
  dialect: Dialect,
): string {
  if (!IDENT.test(table)) throw new Error(`Unsafe table identifier: ${table}`);
  for (const c of [...columns, ...conflictColumns]) {
    if (!IDENT.test(c)) throw new Error(`Unsafe column identifier: ${c}`);
  }
  const cols = columns.join(',');
  const marks = columns.map((_, i) => (dialect === 'postgres' ? `$${i + 1}` : '?')).join(',');
  const updates = columns
    .filter((c) => !conflictColumns.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  const target = conflictColumns.join(',');
  const action = updates ? `DO UPDATE SET ${updates}` : 'DO NOTHING';
  return `INSERT INTO ${table} (${cols}) VALUES (${marks}) ON CONFLICT (${target}) ${action}`;
}

export function translate(sql: string, dialect: Dialect): string {
  if (dialect === 'sqlite') return sql;
  if (/INSERT\s+OR\s+REPLACE/i.test(sql)) {
    throw new Error(
      'INSERT OR REPLACE is not portable. Use upsertInto(table, columns, conflictColumns, dialect).',
    );
  }
  let out = rewriteInsertIgnore(sql);
  out = rewritePlaceholders(out);
  out = out.replace(/\bexcluded\./g, 'EXCLUDED.');
  // Word-boundary LIKE → ILIKE, but never `ILIKE` → `IILIKE`.
  out = out.replace(/(?<!I)\bLIKE\b/gi, 'ILIKE');
  return out;
}

/** Count the expected parameter slots; used to fail loudly on arity mismatch. */
export function placeholderCount(sql: string, dialect: Dialect): number {
  const translated = translate(sql, dialect);
  if (dialect === 'sqlite') return (translated.match(/\?/g) ?? []).length;
  const matches = translated.match(/\$\d+/g) ?? [];
  return new Set(matches).size;
}
