/**
 * The SPA, served from the compiled module when there is no directory to serve from.
 *
 * `scripts/embed-web-assets.mjs` writes the built document and its assets into
 * `src/generated/web-assets.ts` after the Vite build, so they are compiled into `dist/`
 * with the rest of the API. That is the only form of "static file" a bundler will carry:
 * it follows imports, so a module travels and a directory does not.
 *
 * On a workstation, in Docker and behind `npm start` this is dead weight — `web-dist.ts`
 * finds the real directory and nothing here is read. In a deployment bundle the
 * directory does not exist at all, and this is what serves `/` instead of a JSON 404.
 *
 * The generated module is gitignored; `npm install` writes an empty one so the project
 * typechecks and runs before any build. `WEB_ASSET_COUNT` of 0 therefore means "not
 * built", not "built and empty".
 */
import { WEB_ASSETS, WEB_ASSET_COUNT } from '../generated/web-assets.ts';

export type EmbeddedAsset = { type: string; body: Buffer };

/** True when a built SPA was embedded at build time. */
export function hasEmbeddedSpa(): boolean {
  return WEB_ASSET_COUNT > 0 && 'index.html' in WEB_ASSETS;
}

/** The document, for a browser route that has no file of its own. */
export function embeddedIndex(): EmbeddedAsset | null {
  return assetAt('index.html');
}

/**
 * A file from the embedded build.
 *
 * Paths are normalised and confined to the embedded map: `..` segments are rejected
 * rather than resolved, because a traversal attempt should be a miss, not a look
 * somewhere else. The map is looked up with a plain key, so nothing outside it is
 * reachable however the path is spelled.
 */
export function embeddedFile(urlPath: string): EmbeddedAsset | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]!.split('#')[0]!);
  } catch {
    /* A malformed escape is not a file. Answering 5xx here would be a crash by URL. */
    return null;
  }
  const key = decoded.replace(/^\/+/, '');
  if (!key || key.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return assetAt(key);
}

function assetAt(key: string): EmbeddedAsset | null {
  const asset = WEB_ASSETS[key];
  if (!asset) return null;
  const body = asset.text !== undefined ? Buffer.from(asset.text, 'utf8') : Buffer.from(asset.base64 ?? '', 'base64');
  return { type: asset.type, body };
}
