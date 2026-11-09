/**
 * Where the built SPA lives, in every runtime this application runs in.
 *
 * `config.webDist` is computed from `import.meta.url` — three levels up from the module
 * file, which is correct in the source tree and in `dist/`. It is *not* correct in a
 * platform bundle: the bundler flattens the module graph into a single file, so "three
 * levels up" points somewhere outside the deployed artefact and `apps/web/dist` is never
 * found. The API then has no document to serve, and a single-service deployment answers
 * `/` with a JSON 404 while `/api` works — a dashboard that loads nothing, from a
 * function that is running fine.
 *
 * So the directory is *searched for*, not computed once, and the search includes the
 * process working directory — which on a platform is the function root, the directory
 * the bundle and its included files are unpacked into.
 *
 * The files have to be there in the first place, and in a deployment bundle they are not:
 * the platform's tracer follows imports and not `fs` reads, and the service schema has no
 * key for declaring extra files. That is why `lib/embedded-web.ts` exists — the same build
 * is compiled into the API, and `app.ts` serves from it when this search finds nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { embeddedFileCount } from './embedded-web.ts';

export type WebDistResolution = {
  /** The directory that contains `index.html`, or null if none does. */
  dir: string | null;
  /** Every candidate considered, in order, with whether it existed. Useful in logs. */
  tried: Array<{ candidate: string; exists: boolean }>;
};

/**
 * Candidate directories, most specific first.
 *
 * `preferred` is whatever the caller was configured with (`WEB_DIST`, or the value
 * derived from the module location). The rest are the shapes the file tree takes:
 * a repo checkout, a bundle whose files were included at their repository paths, and a
 * lambda-style task root.
 */
export function candidateWebDirs(preferred?: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined | null) => {
    if (!value) return;
    const normalized = path.resolve(value);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  add(preferred);

  /*
   * The process working directory — the function root on a platform, the repository root
   * for `npm start`. Nothing is guaranteed to be here in a bundle; this is a candidate,
   * not an assumption.
   */
  add(path.join(process.cwd(), 'apps', 'web', 'dist'));
  add(path.join(process.cwd(), 'dist'));

  /* The container image and the repo checkout both keep the tree intact from ROOT. */
  add(path.join(process.cwd(), '..', 'apps', 'web', 'dist'));

  /* The platform's documented task root, when the working directory is something else. */
  add('/var/task/apps/web/dist');

  return candidates;
}

/** First candidate that actually contains a built `index.html`. */
export function resolveWebDist(preferred?: string): WebDistResolution {
  const tried: WebDistResolution['tried'] = [];
  for (const candidate of candidateWebDirs(preferred)) {
    let exists = false;
    try {
      exists = fs.existsSync(path.join(candidate, 'index.html'));
    } catch {
      exists = false;
    }
    tried.push({ candidate, exists });
    if (exists) return { dir: candidate, tried };
  }
  return { dir: null, tried };
}

/**
 * How this process is serving the SPA — the question a deployment always raises and can
 * never answer from the outside.
 *
 * `disk` is a workstation, a container image or `npm start`: the build directory was
 * found. `embedded` is a deployment bundle: the build was compiled in, which is the only
 * way it could have arrived. `none` is a fault — every browser path answers a JSON 404 —
 * so it is reported rather than hidden. `files` counts what is actually there either way;
 * there is no sentinel for "did not look", because not looking is how this went wrong.
 */
export function describeWebServing(resolvedDir: string | null): {
  source: 'disk' | 'embedded' | 'none';
  files: number;
} {
  if (resolvedDir) return { source: 'disk', files: countFiles(resolvedDir) };
  const embedded = embeddedFileCount();
  return embedded > 0 ? { source: 'embedded', files: embedded } : { source: 'none', files: 0 };
}

function countFiles(dir: string): number {
  let total = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else if (entry.isFile()) total += 1;
    }
  };
  try {
    walk(dir);
  } catch {
    /* An unreadable directory serves nothing; the count says so rather than throwing. */
    return 0;
  }
  return total;
}
