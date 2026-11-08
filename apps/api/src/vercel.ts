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
import { buildApp } from './app.ts';
import { sweepTimers } from './services/clocks.ts';
import { getDb } from './db/index.ts';

/** One app instance per function instance. Cold start pays for it once. */
let ready: Promise<{ app: Awaited<ReturnType<typeof buildApp>>['app'] }> | null = null;

/** Timestamp of the last inline sweep, to keep it off the hot path. */
let lastSweep = 0;
const SWEEP_THROTTLE_MS = Number(process.env.SWEEP_THROTTLE_MS ?? 60_000);

async function getApp() {
  if (!ready) {
    ready = (async () => {
      const { app } = await buildApp();
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
