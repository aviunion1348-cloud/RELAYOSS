/**
 * The service entry point.
 *
 * `framework: "fastify"` makes Vercel run this module as a **server**, not as a
 * per-request function: it executes the file and expects a process listening on
 * `PORT`. The previous version of this file was the serverless shape — it built the
 * app, exported a `(req, res)` handler and never listened — which is right for a
 * function and fatal for a service. Nothing bound the port, so the platform had
 * nothing to route to and answered every request with
 * `500 FUNCTION_INVOCATION_FAILED`, including `/`, before any application code ran.
 *
 * That is also why no diagnostic appeared. Every failure path in this repository
 * reports through a response, and a server that never listens cannot send one.
 *
 * The shape below is deliberately sequential:
 *
 *   1. **Listen immediately**, on a plain handler. Binding the port is the one thing
 *      the platform kills us for not doing, so it happens before anything slow or
 *      failure-prone. Requests that arrive during the cold start wait on the boot
 *      promise rather than being refused.
 *
 *   2. **Boot once**, behind that handler. `buildApp()` opens the database and runs
 *      pending migrations; this process also serves the built SPA, so `npm start`,
 *      Docker and Vercel behave identically — one process, one origin.
 *
 *   3. **On failure, stay up and explain.** A wrong configuration or an unreachable
 *      database answers 503 with the stage and the remedy. Exiting would produce the
 *      opaque platform error this file exists to replace, and an exit code is
 *      invisible where this runs.
 */
import { createServer, type Server } from 'node:http';
import { buildApp } from '../app.ts';
import { config } from '../config.ts';
import { bootFailure, bootFailureBody, recordBootFailure } from '../lib/misconfigured.ts';

type Booted = { app: Awaited<ReturnType<typeof buildApp>>['app'] };
type Outcome = Booted | { app: null };

/**
 * Classify a boot error by the check that produced it.
 *
 * Both checks throw plain `Error`s with descriptive messages, so the message is the
 * only discriminator available. A wrong guess is cosmetic — the report carries the
 * original message either way — so this stays a string match rather than a new error
 * taxonomy threaded through the boot path.
 */
function bootFailureStage(err: unknown): 'configuration' | 'database' {
  const message = err instanceof Error ? err.message : String(err);
  return /is required|refused in production|is not a complete Argon2id hash|requires OIDC|DATABASE_URL is not set/.test(
    message,
  )
    ? 'configuration'
    : 'database';
}

async function boot(): Promise<Outcome> {
  try {
    const { app } = await buildApp();
    /*
     * `ready()` is mandatory, not an optimisation: Fastify installs its hook pipeline
     * here, and `inject`-style mounting without it fails on the first request inside
     * the pre-parsing hooks with a TypeError.
     */
    await app.ready();
    return { app };
  } catch (err) {
    let stage: 'configuration' | 'database' = 'database';
    try {
      stage = bootFailureStage(err);
    } catch { /* keep the cautious default */ }
    try {
      recordBootFailure(stage, err);
    } catch { /* the request path still reports something */ }
    try {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 50,
          msg: 'API cannot boot — staying up so the reason can be read instead of answered with an opaque 500.',
          stage,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch { /* logging must not mask the failure it describes */ }
    return { app: null };
  }
}

/**
 * Answer a request when there is no app.
 *
 * Plain `http` on purpose: the app is the thing that failed, so the reporting path
 * must not depend on it. Reporting code that can itself fail is worse than none,
 * because it looks like it works.
 */
function replyMisconfigured(res: import('node:http').ServerResponse): void {
  let payload: string;
  try {
    const failure = bootFailure();
    payload = JSON.stringify({
      error: failure
        ? bootFailureBody(failure)
        : {
            code: 'misconfigured',
            summary: 'This instance failed to start and no reason was recorded.',
            missing: [],
            invalid: [],
            remedy: [],
          },
    });
  } catch {
    payload = JSON.stringify({ error: { code: 'misconfigured', summary: 'Failed to start.' } });
  }
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  // A provisioning problem is not a credential problem: nothing may cache this, or
  // the deployment keeps looking broken after it is fixed.
  res.setHeader('retry-after', '30');
  res.end(payload);
}

let bootPromise: Promise<Outcome> | null = null;
const getApp = () => (bootPromise ??= boot());

async function dispatch(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const outcome = await getApp();
  if (!outcome.app) {
    replyMisconfigured(res);
    return;
  }
  /*
   * Let Fastify handle the request on this server's socket. `app.server` is the same
   * kind of `http.Server`, and Fastify's request pipeline is already installed on it
   * by `ready()`; emitting the event hands over without a second listener on the port.
   */
  outcome.app.server.emit('request', req, res);
}

async function main(): Promise<Server> {
  const { port, host } = config;

  const server: Server = createServer((req, res) => {
    void dispatch(req, res).catch((err: unknown) => {
      /*
       * Last line of defence. A crash here produces the platform error page, so even
       * this path answers JSON with a reason.
       */
      try {
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify({
            level: 50,
            msg: 'request dispatch failed',
            url: (() => { try { return String(req.url); } catch { return '(unreadable)'; } })(),
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } catch { /* nothing left to try */ }
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: { code: 'handler_failed', summary: 'Request failed.' } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  /*
   * Report the port the kernel actually assigned, not the one requested: with PORT=0
   * (tests, and any supervisor that hands out ports) the requested value is 0 and the
   * real one is only available from the socket. A log line that says ":0" is a log
   * line that cannot be used to reach the process that printed it.
   */
  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound ? bound.port : port;
  // Listening first means the platform routes to us while the rest happens.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 30, msg: `listening on ${host}:${boundPort}`, port: boundPort }));

  const outcome = await getApp();
  if (outcome.app) {
    /*
     * Fastify's own listener is not started — this server owns the port and hands
     * requests to Fastify's pipeline. That keeps one socket, one origin, and no
     * window in which two listeners disagree.
     */
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 30, msg: 'API ready' }));
  }

  return server;
}

/*
 * The service contract is "bind PORT", and that is what `main()` does. The default
 * export is the listening server as well, because a launcher that imports the module
 * instead of executing it checks for a callable or a server before routing anything;
 * a module that listens but exports nothing is rejected by that check before its
 * listener is ever reached. Exporting the live server satisfies both shapes without a
 * second socket.
 */
const server = await main();
export default server;
