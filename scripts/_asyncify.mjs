#!/usr/bin/env node
/**
 * Mechanical async conversion for the database-facing modules.
 *
 * The storage layer became async (PostgreSQL is a network database). Instead
 * of hand-editing ~280 call sites and mistyping one into a silently unresolved
 * promise, this script performs a precise, reviewable transformation; the
 * TypeScript compiler then proves the result: `tsc` flags every place where a
 * promise leaked into a value position.
 *
 * Scope: lines that *start* a `db.x(...)` call — the codebase formats every
 * call site that way (verified by grep) — plus `return db.x(...)` forms.
 */
import fs from 'fs';
import path from 'path';

const FILES = process.argv.slice(2);
const CALL = /^(\s*)((?:for\s*\([^)]*\)\s+)?(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*|return\s+)?(db\(\)|db|this\.db)\.(all|get|run|exec|tx)(<[^()]*>)?\(/;

for (const file of FILES) {
  let out = '';
  let changed = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = CALL.exec(line);
    if (!m) {
      out += line + '\n';
      continue;
    }
    const [prefix, indent, decl = '', handle, method, generics = ''] = m;
    out += `${indent}${decl}await ${handle}.${method}${generics}(` + line.slice(prefix.length) + '\n';
    changed += 1;
  }
  fs.writeFileSync(file, out);
  console.log(`${path.basename(file)}: ${changed} call sites awaited`);
}
