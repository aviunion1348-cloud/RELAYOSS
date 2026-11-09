#!/usr/bin/env node
/**
 * Embed the built SPA into a module the API compiles.
 *
 * The reason this exists is a deployment failure that no amount of path handling could
 * fix. The platform's bundler follows module imports and nothing else: a directory the
 * application reads with `fs` is simply not part of the deployment. The obvious remedy —
 * declaring `includeFiles` on the service — is not accepted by the services schema
 * (`services.app should NOT have additional property includeFiles`), so the files have
 * to arrive the way the bundler does follow: as an import.
 *
 * So the built SPA becomes a TypeScript module. `apps/web/dist` is walked after the Vite
 * build, every file is inlined, and the result is compiled into `dist/` with the rest of
 * the API. The server serves from disk when a build is present (development, Docker, a
 * plain `npm start`) and from this module when it is not (the deployment bundle). One
 * artefact, no configuration, nothing to remember.
 *
 * Text is inlined as text and binary as base64, because base64-encoding 800 kB of
 * JavaScript to serve it as JavaScript would be a 33% tax on every deployment for no
 * reason.
 *
 * Usage:
 *   node scripts/embed-web-assets.mjs             # embed apps/web/dist
 *   node scripts/embed-web-assets.mjs --stub      # write an empty module if none exists
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps', 'web', 'dist');
const target = path.join(root, 'apps', 'api', 'src', 'generated', 'web-assets.ts');

const stubOnly = process.argv.includes('--stub');

/** Extensions whose bytes are valid UTF-8 and can be inlined verbatim. */
const TEXT = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt', '.xml',
  '.webmanifest', '.ico.svg', '.csv', '.yml', '.yaml',
]);

const HEADER = `/**
 * GENERATED FILE — do not edit, do not commit.
 *
 * Written by \`scripts/embed-web-assets.mjs\` from \`apps/web/dist\`. It exists because the
 * deployment bundler follows imports only, so a directory read at runtime never reaches
 * the deployment. See the script for the full account.
 *
 * The checked-in state of this path (created on install) is empty on purpose: a build
 * that has not run yet should resolve and typecheck, and should serve nothing rather
 * than something stale.
 */
`;

function emptyModule() {
  return `${HEADER}export type WebAsset = { type: string; text?: string; base64?: string };
export const WEB_ASSETS: Record<string, WebAsset> = {};
export const WEB_ASSET_COUNT = 0;
`;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.eot': 'application/vnd.ms-fontobject',
      '.txt': 'text/plain; charset=utf-8',
      '.xml': 'application/xml; charset=utf-8',
      '.webmanifest': 'application/manifest+json',
      '.wasm': 'application/wasm',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.pdf': 'application/pdf',
    }[ext] ?? 'application/octet-stream'
  );
}

fs.mkdirSync(path.dirname(target), { recursive: true });

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  if (stubOnly) {
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, emptyModule());
      console.log('· web assets: no build yet, wrote an empty module so the API compiles');
    }
    process.exit(0);
  }
  console.error(
    `✗ ${path.relative(root, dist)}/index.html does not exist. Build the web app first ` +
      '(npm run build:web), then embed it.',
  );
  process.exit(1);
}

const files = walk(dist).sort();
const entries = [];
let bytes = 0;

for (const rel of files) {
  const full = path.join(dist, rel);
  const ext = path.extname(rel).toLowerCase();
  const buf = fs.readFileSync(full);
  bytes += buf.length;
  const type = mimeFor(rel);

  if (TEXT.has(ext)) {
    entries.push({ rel, type, text: buf.toString('utf8') });
  } else {
    entries.push({ rel, type, base64: buf.toString('base64') });
  }
}

const body = entries
  .map((e) =>
    e.text !== undefined
      ? `  ${JSON.stringify(e.rel)}: { type: ${JSON.stringify(e.type)}, text: ${JSON.stringify(e.text)} },`
      : `  ${JSON.stringify(e.rel)}: { type: ${JSON.stringify(e.type)}, base64: ${JSON.stringify(e.base64)} },`,
  )
  .join('\n');

const source = `${HEADER}export type WebAsset = { type: string; text?: string; base64?: string };
export const WEB_ASSETS: Record<string, WebAsset> = {
${body}
};
export const WEB_ASSET_COUNT = ${entries.length};
`;

fs.writeFileSync(target, source);

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
console.log(
  `✓ web assets embedded: ${entries.length} files, ${kb(bytes)} of source → ` +
    `${kb(Buffer.byteLength(source))} module at ${path.relative(root, target)}`,
);
