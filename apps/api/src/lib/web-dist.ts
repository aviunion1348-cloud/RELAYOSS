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
 * The files have to be there in the first place, which is a deployment-configuration
 * fact rather than a runtime one: `vercel.json` declares `includeFiles` for
 * `apps/web/dist/**`, because the platform's tracer follows imports and not `fs` reads.
 * `scripts/guard-deployment-config.mjs` fails the build if that declaration is missing.
 */
import fs from 'node:fs';
import path from 'node:path';

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
   * The process working directory. In a platform bundle this is the function root, and
   * `includeFiles` preserves repository-relative paths inside it.
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
