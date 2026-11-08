#!/usr/bin/env node
/**
 * Verify that the built SPA output routes correctly under the configured rewrites.
 *
 * Why this exists, and why `vercel dev` is not enough:
 *
 *   `vercel dev` proxies the `web` service to the Vite **dev** server. That server
 *   applies its own SPA fallback and answers `index.html` for every unmatched path —
 *   verified: a request for a nonexistent hashed asset returns `200 text/html` from
 *   Vite before any rewrite of ours runs. So a dev-server test can neither confirm nor
 *   refute how a missing asset is handled.
 *
 *   In production the `web` service is a static build behind a CDN. There, the only
 *   thing deciding the fate of a missing asset is the rewrite table. A catch-all of
 *   `/(.*) → /index.html` — the obvious way to make deep links work — also catches
 *   `/assets/index-abc123.js` and answers it with the HTML document and status 200.
 *   The browser then reports a MIME type error instead of a 404, and a stale cached
 *   asset reference turns into a blank page rather than a clean miss.
 *
 * So this harness applies the actual routing table to the actual build:
 *
 *   1. Top-level rewrites select a service; first match wins; routing is final.
 *   2. Inside `web`: an existing file is served, else service rewrites in order, else 404.
 *   3. Inside `api`: the function answers. A document here is always a bug.
 *
 *   node scripts/verify-web-routing.mjs [--dist apps/web/dist] [--config vercel.json]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const dist = path.resolve(argOf('--dist', 'apps/web/dist'));
const configPath = path.resolve(argOf('--config', 'vercel.json'));

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`✗ no build at ${dist} — run the web build first (npm run build -w @relay/web)`);
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const topLevel = cfg.rewrites ?? [];
const webRewrites = cfg.services?.web?.rewrites ?? [];

// Vercel rewrites are fully anchored: the source compiles to ^...$.
const compile = (source) => new RegExp(`^${source}$`);

function route(p) {
  const ingress = topLevel.find((r) => compile(r.source).test(p));
  const service = ingress?.destination?.service;
  if (service === 'api') return 'api';
  if (service !== 'web') return 'missing';
  const filePath = path.join(dist, p);
  if (existsSync(filePath) && statSync(filePath).isFile()) return 'file';
  return webRewrites.some((r) => compile(r.source).test(p)) ? 'document' : 'missing';
}

const cases = [
  ['/', 'document', 'app entry'],
  ['/projects/pr_northwind', 'document', 'dashboard deep link'],
  ['/settings/team', 'document', 'another deep link'],
  ['/api/live', 'api', 'the API must never answer with a document'],
  ['/api/projects', 'api', 'the API must never answer with a document'],
  ['/assets/definitely-missing-abc123.js', 'missing', 'a missing asset must 404, not serve HTML'],
  ['/assets/index-nope.css', 'missing', 'a missing asset must 404, not serve HTML'],
  ['/favicon-missing-xyz.ico', 'missing', 'a missing asset must 404, not serve HTML'],
];

let failures = 0;
const LABEL = { document: 'index.html', file: 'static file', missing: '404', api: 'api service' };

for (const [p, expect, why] of cases) {
  const outcome = route(p);
  const ok = outcome === expect;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${p.padEnd(38)} -> ${LABEL[outcome].padEnd(12)} ${why}`);
}

// Positive control: a real hashed asset must resolve. Without this, the "missing" cases
// above would pass on a build that contains nothing at all.
const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8');
const referenced = [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
if (!referenced.length) {
  console.error('  FAIL index.html references no hashed assets — the build looks wrong');
  failures += 1;
} else {
  const sample = referenced[0];
  const ok = route(sample) === 'file';
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${sample.padEnd(38)} -> ${String(route(sample)).padEnd(12)} real asset resolves`);
}

if (failures) {
  console.error(`\n✗ ${failures} routing case(s) failed against ${path.relative(process.cwd(), dist)}`);
  process.exit(1);
}
console.log('\n✓ routing is correct: deep links serve the document, missing assets 404, /api never returns HTML');
