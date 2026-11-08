/**
 * Vercel Functions entry point.
 *
 * The difference from `index.ts` is deliberate and important:
 *
 *   index.ts    builds the app, calls `app.listen()`, and starts a `setInterval`
 *               sweeper. That is correct for a long-lived container and wrong for
 *               serverless — a function executes per request, `listen` would try to
 *               bind a port nothing routes to, and an interval would either never
 *               fire or fire unpredictably across instances.
 *
 *   vercel.ts   builds the app once per instance and exports the request handler.
 *               No listen, no interval, no reliance on process memory surviving.
 *
 * This file lives in `entrypoints/` rather than beside `index.ts`, and that is a
 * deployment requirement rather than tidiness. Vercel's Fastify framework preset
 * discovers its entrypoint from a fixed list of names in the service root — `src/
 * index.{js,ts}`, `src/app.{js,ts}`, `src/server.{js,ts}`, or those three at the
 * top level. It does not find `src/vercel.ts`. Without a file it recognises, Vercel
 * infers the runtime from whatever it *can* see and can end up invoking
 * `src/index.ts`, which is the long-lived entry: it calls `app.listen()` and boots
 * a `setInterval` sweeper. A serverless invocation dies on the listen and the
 * sweeper never fires, so the deployment would look healthy and process deadlines
 * never.
 *
 * `entrypoints/index.ts` re-exports this handler under a name Vercel looks for, so
 * the preset resolves to the serverless entry and never to the container one.
 *
 * Two serverless-specific concerns are handled here rather than being left to
 * chance:
 *
 *  1. **Connection exhaustion.** Each instance holds a pool. `pg` defaults to 10
 *     connections per pool, so twenty concurrent functions would open two hundred
 *     connections and exhaust a typical managed Postgres. The pool size is capped
 *     by DATABASE_POOL_MAX (default 3) and idle clients are retired quickly, so the
 *     total stays within the provider's limit even with many instances. The correct
 *     production setup still uses the provider's *pooled* connection string.
 *
 *  2. **Lazy deadline processing.** Relying on a cron alone would mean SLA breaches
 *     go unrecorded between invocations — and on Vercel's Hobby plan a cron runs
 *     once a day. So a sweep is performed inline, at most once every
 *     SWEEP_THROTTLE_MS, on requests that are already doing delivery work. The cron
 *     endpoint remains, for correctness on Pro and for backfill.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../app.ts';
import { sweepTimers } from '../services/clocks.ts';
import { getDb } from '../db/index.ts';

/** One app instance per function instance. Cold start pays for it once. */
let ready: Promise<{ app: Awaited<ReturnType<typeof buildApp>>['app'] }> | null = null;

/** Timestamp of the last inline sweep, to keep it off the hot path. */
let lastSweep = 0;
const SWEEP_THROTTLE_MS = Number(process.env.SWEEP_THROTTLE_MS ?? 60_000);

async function getApp() {
  if (!ready) {
    ready = (async () => {
      /**
       * The API function serves exactly one thing: the API.
       *
       * In services mode the browser bundle is a separate service with its own
       * build artifact and its own public domain — Vercel rewrites every non-`/api`
       * path straight to it, so a static file can never reach this function. Leaving
       * `serveStatic` on would make the function read `apps/web/dist` from its own
       * bundle directory: absent, and if anything ever did land there it would
       * duplicate the web service and let the two drift.
       *
       * `apps/api/src/index.ts` keeps serving static files, because the container
       * layout is one process on one origin and `npm start` must still work.
       */
      const { app } = await buildApp({ serveStatic: false });
      /**
       * `ready()` is mandatory here, not an optimisation. Without it Fastify has
       * not finished installing its hook pipeline, and the first request fails
       * inside the pre-parsing hook runner with a TypeError — a crash that only
       * shows up in serverless, where `listen()` (which awaits ready internally)
       * is never called.
       */
      await app.ready();
      return { app };
    })();
  }
  return ready;
}

/**
 * Run the clock sweep no more than once per SWEEP_THROTTLE_MS.
 *
 * Idempotent by construction: `sweepTimers` only transitions timers whose deadline
 * has already passed and whose outcome is still `running`, so a second overlapping
 * sweep finds nothing. Errors are swallowed deliberately — a failed sweep must not
 * fail the user's request, and the failure is reported by the cron endpoint.
 */
async function maybeSweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_THROTTLE_MS) return;
  lastSweep = now;
  try {
    await sweepTimers(getDb());
  } catch {
    /* the cron endpoint surfaces sweep failures; a user request must still succeed */
  }
}

/**
 * Vercel's Node runtime accepts a handler of `(req, res)`. Fastify exposes exactly
 * that shape in `app.server`, so the app is mounted rather than re-implemented.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { app } = await getApp();
  await maybeSweep();
  app.server.emit('request', req, res);
}

/** Exported for tests and for the readiness probe. */
export { getApp, maybeSweep };
