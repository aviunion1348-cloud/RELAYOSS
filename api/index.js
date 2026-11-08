/**
 * Vercel Function entry point.
 *
 * This file exists because Vercel discovers functions at `api/*.js` relative to the
 * project root, and it must be plain JavaScript — the platform executes it
 * directly rather than compiling it. The TypeScript source it delegates to is
 * `apps/api/src/vercel.ts`, compiled by `npm run build:vercel` before this runs.
 *
 * Why the delegation is dynamic:
 *
 *   `apps/api/dist/entrypoints/vercel.js` does not exist until the build step has run. A static
 *   top-level import would make the module fail to load during Vercel's own build
 *   inspection, before the build command has produced it. A dynamic import inside
 *   the handler defers resolution to first invocation, when the file is guaranteed
 *   to exist — and gives a clear error if it is not.
 *
 * What it deliberately does NOT do:
 *
 *   - `app.listen()`. A serverless function is invoked per request; binding a port
 *     would be ignored at best and hang at worst.
 *   - `setInterval()`. Background timers do not survive between invocations, so a
 *     sweeper built on one would silently never run. Deadline processing happens
 *     lazily on request (see vercel.ts) and via the authenticated cron endpoint.
 *   - Assume process memory persists. The app graph is cached per instance as an
 *     optimisation only; correctness does not depend on it.
 */

/** @type {Promise<{ default: (req: any, res: any) => Promise<void> }> | null} */
let modulePromise = null;

export default async function handler(req, res) {
  if (!modulePromise) {
    modulePromise = import('../apps/api/dist/entrypoints/vercel.js').catch((err) => {
      modulePromise = null;
      throw err;
    });
  }

  let mod;
  try {
    mod = await modulePromise;
  } catch (err) {
    // Fail loudly and usefully: a missing build artefact is a deployment
    // configuration problem, not a runtime mystery.
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: {
          code: 'deployment_misconfigured',
          message:
            'The API build output was not found. The Vercel build command must be ' +
            '`npm run build:vercel`, which compiles apps/api before packaging the function.',
          detail: String(err?.message ?? err).slice(0, 300),
        },
      }),
    );
    return;
  }

  await mod.default(req, res);
}
