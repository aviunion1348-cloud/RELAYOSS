#!/usr/bin/env node
/**
 * Await-aware method-call rewriter (balanced, string-aware).
 *
 * Rewrites `HANDLE.method<T>(ARGS)` / `HANDLE.method<T>(ARGS).CHAIN` into
 * `await HANDLE.method<T>(ARGS)` / `(await HANDLE.method<T>(ARGS)).CHAIN` by
 * locating the real closing paren instead of regex-guessing it. Used once for
 * the async migration and kept as the honest record of the transformation.
 * Idempotent: already-awaited sites are skipped.
 */
import fs from 'fs';

const files = process.argv.slice(2);
const HANDLE = String.raw`(?:db\(\)|db|this\.db)`;
const CALL_RE = new RegExp(String.raw`${HANDLE}\.(all|get|run|exec|tx)(<[^<>()]*>)?\(`, 'y');
const AWAIT_BEFORE = /(?:^|[^\w$.])await\s+$/;

function findClose(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced call at index ${openIdx}`);
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const edits = []; // { start, end, text }
  for (let i = 0; i < src.length; i++) {
    CALL_RE.lastIndex = i;
    const m = CALL_RE.exec(src);
    if (!m) continue;
    if (m.index !== i) continue;

    const before = src.slice(Math.max(0, i - 20), i);
    const alreadyAwaited = AWAIT_BEFORE.test(before);
    const openIdx = i + m[0].length - 1;
    const closeIdx = findClose(src, openIdx);
    const rest = src.slice(closeIdx + 1);
    const chained = /^\s*[.?[]/.test(rest) || /^\./.test(rest);

    if (alreadyAwaited && !chained) {
      i = closeIdx;
      continue;
    }
    const callText = src.slice(i, closeIdx + 1);
    if (alreadyAwaited && chained) {
      // `await X(...).map()` → `(await X(...)).map()`
      const awaitStart = src.lastIndexOf('await', i);
      edits.push({ start: awaitStart, end: closeIdx + 1, text: `(await ${callText})` });
      i = closeIdx;
      continue;
    }
    edits.push({
      start: i,
      end: closeIdx + 1,
      text: chained ? `(await ${callText})` : `await ${callText}`,
    });
    i = closeIdx;
  }

  let out = src;
  for (const edit of edits.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  fs.writeFileSync(file, out);
  console.log(`${file}: ${edits.length} call sites awaited`);
}
