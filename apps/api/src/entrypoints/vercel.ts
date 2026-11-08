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
import {
  bootFailure,
  bootFailureBody,
  recordBootFailure,
  resetBootFailure,
} from '../lib/misconfigured.ts';

/**
 * One app instance per function instance. Cold start pays for it once.
 *
 * `app: null` is a first-class outcome, not an absent value: it means this
 * instance tried to boot and could not, and `bootFailure()` holds the reason.
 * Modelling it in the type keeps every caller honest about checking it.
 */
type Booted = { app: Awaited<ReturnType<typeof buildApp>>['app'] };
let ready: Promise<Booted | { app: null }> | null = null;

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
      try {
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
      } catch (err) {
        /**
         * Separate a provisioning mistake from a query failure.
         *
         * `buildApp` opens the connection and runs the boot migration before any
         * route exists, so a failure here is already reduced to two causes: the
         * configuration guard refused to start, or the database could not be
         * reached. Recording which one lets `handler` answer with the actual
         * problem instead of a generic 500 that says nothing.
         *
         * The rejection is deliberately *swallowed* rather than rethrown: `ready`
         * stays resolved-empty so a warm instance does not repeat the boot attempt
         * on every request. The recorded failure is what each request reports.
         */
        /**
         * Reporting the failure must not itself be able to fail.
         *
         * `recordBootFailure` and the log line are the only things standing between
         * a misconfigured deployment and a blank 500, so a defect here would
         * reintroduce exactly the silent response this whole path exists to remove.
         * The classification is best-effort and falls back to `database` — the more
         * cautious stage, because it claims less about what the operator must fix.
         */
        let stage: 'configuration' | 'database' = 'database';
        try {
          stage = bootFailureStage(err);
        } catch { /* keep the conservative default */ }
        try {
          recordBootFailure(stage, err);
        } catch { /* the request path still reports something */ }
        try {
          // eslint-disable-next-line no-console
          console.error(
            JSON.stringify({
              level: 50,
              msg: 'API cannot boot — this instance is not serving requests. Reporting the reason on every response.',
              stage,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        } catch { /* logging must never mask the failure it describes */ }
        return { app: null };
      }
    })();
  }
  return ready;
}

/**
 * Classify a boot error by the check that produced it.
 *
 * Both checks throw plain `Error`s with descriptive messages, so the message is
 * the only discriminator available. The consequence of a wrong guess is cosmetic
 * — the report carries the original message either way — so this stays a string
 * match rather than a new error taxonomy threaded through the boot path.
 */
function bootFailureStage(err: unknown): 'configuration' | 'database' {
  const message = err instanceof Error ? err.message : String(err);
  return /is required|refused in production|is not a complete Argon2id hash|requires OIDC/.test(message)
    ? 'configuration'
    : 'database';
}

/** Answer with the recorded provisioning failure, in a shape an operator can act on. */
function replyMisconfigured(res: ServerResponse): void {
  const failure = bootFailure();
  const body = failure
    ? bootFailureBody(failure)
    : {
        code: 'misconfigured' as const,
        summary: 'This instance failed to start and no reason was recorded.',
        missing: [],
        invalid: [],
        remedy: [],
      };
  const payload = JSON.stringify({ error: body });
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  // A provisioning problem is not a credential problem: never let a proxy or the
  // browser cache this, or the deployment keeps looking broken after it is fixed.
  res.setHeader('retry-after', '30');
  res.end(payload);
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
  /**
   * Nothing may escape this function unformatted.
   *
   * A request that never gets a JSON body produces the worst diagnostic possible:
   * the client sees `500` with no detail, and a platform-generated error page is
   * indistinguishable from the application crashing, from the function failing to
   * boot, and from a proxy rejecting the request. This was observed in production —
   * `500` with a non-JSON body on every `/api` request — with no way to tell which.
   *
   * So the whole handler is wrapped: any in-process failure is answered with JSON
   * naming the stage it failed at. A genuine crash becomes a reported error rather
   * than a silence.
   */
  try {
    await handle(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /**
     * Read the request defensively.
     *
     * The error path must not depend on the thing that just failed. This is not
     * hypothetical: a test that made `req.url` throw caught the catch block itself
     * re-reading `req.url` and throwing again — so a handled failure escaped as the
     * exact blank 500 this wrapper exists to prevent. Reporting code that can fail
     * is worse than no reporting code, because it looks like it works.
     */
    let url = '(unreadable)';
    try { url = String(req.url); } catch { /* the request could not be inspected */ }
    try {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 50,
          msg: 'API handler threw before it could answer. Responding with JSON so the client sees a reason.',
          url,
          error: message,
        }),
      );
    } catch { /* logging must not mask the failure it describes */ }
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store, max-age=0');
      res.end(
        JSON.stringify({
          error: {
            code: 'handler_failed',
            stage: 'request',
            summary: 'The API function failed while handling this request.',
            detail: message,
            remedy: [
              'This is a server-side failure, not a browser or routing problem — the request reached the API.',
              'Check the deployment logs for the request id and the stack trace.',
              'If it names a module or a permission, the deployment is incomplete; redeploy.',
              'If it names the database, check DATABASE_URL and that GET /api/ready reports 200.',
            ],
          },
        }),
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/** The handler proper, separated so every failure can be caught in one place. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { app } = await getApp();

  /**
   * A failed boot is reported, not crashed.
   *
   * Before this, a missing `SESSION_SECRET` produced a 500 whose message is
   * withheld in production, so the sign-in screen could only say "check the API".
   * A 503 with the specific missing variable is both truthful — the service
   * genuinely is unavailable — and the difference between a five-minute fix and
   * an afternoon of guessing.
   */
  if (!app) {
    replyMisconfigured(res);
    return;
  }

  await maybeSweep();
  app.server.emit('request', req, res);
}

/**
 * Forget that this instance ever booted — success or failure.
 *
 * Resetting the recorded *reason* alone is not enough, and believing it was is a
 * bug this function exists to prevent: `ready` caches `{ app: null }` on a failed
 * boot, so clearing the reason while keeping the cached outcome leaves the
 * instance permanently broken and reporting a stale cause. Both halves are
 * cleared together, which is what a test (or a hot-reloading dev process) means by
 * "start over".
 */
export function resetBootState(): void {
  ready = null;
  resetBootFailure();
}

/** Exported for tests and for the readiness probe. */
export { getApp, maybeSweep, resetBootFailure };

