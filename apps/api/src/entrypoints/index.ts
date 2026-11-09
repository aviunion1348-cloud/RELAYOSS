/**
 * The deployed service entrypoint.
 *
 * This file is small on purpose. `vercel.json` declares it as the `app` service's
 * entrypoint with `framework: "fastify"`, and the platform's Node launcher
 * (`@vercel/node`, `compileUserCode`) does this with it:
 *
 *   1. replaces `http.Server.prototype.listen` with a stub that records the server and
 *      **returns without binding and without calling the callback**;
 *   2. `await import(entrypoint)` with the stub in place;
 *   3. peels nested `.default` values;
 *   4. if the result is a function, calls it per request; else uses a captured server;
 *      else throws `Can't detect way to handle request`.
 *
 * Two entrypoints have already failed this contract in production, both with the same
 * opaque `500 FUNCTION_INVOCATION_FAILED` and no application log line:
 *
 *   - **No default export and no listen.** The launcher found neither a function nor a
 *     server and threw before the first request.
 *   - **`await new Promise(r => server.listen(port, () => r()))`.** Step 1 swallows the
 *     callback, so the promise never settles, the module import never resolves, and the
 *     invocation times out. Binding a port was the wrong fix for this launcher: it is
 *     the launcher that binds, and only after the module finishes importing.
 *
 * So this file exports a **function** and never binds anything. `apps/api/src/index.ts`
 * remains the process that listens — that is the `npm start` and Docker path, where
 * nothing stubs `listen`.
 *
 * Everything else is imported dynamically, inside the handler, wrapped in try/catch.
 * Static imports are evaluated before any of our code runs, so a failure in one of them
 * (a native binding missing from the bundle, a module that wants configuration at load)
 * kills the invocation where no error handling exists and produces exactly the
 * unexplained 500 this file keeps causing. Loaded lazily, the same failure becomes a
 * JSON response that names it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** What the app module is expected to hand back. Kept narrow so the boundary is typed. */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

let handlerPromise: Promise<Handler> | null = null;

/**
 * Load the real handler once, and if loading fails, hand back a handler that reports
 * the failure instead of rethrowing it.
 *
 * The load is cached on the module, which lives as long as the function instance: a
 * cold start pays for it once.
 */
function loadHandler(): Promise<Handler> {
  handlerPromise ??= import('./vercel.js')
    .then((mod) => {
      const handler = mod.default;
      if (typeof handler !== 'function') {
        throw new Error(
          'entrypoints/vercel.ts did not export a handler function; got ' + typeof handler,
        );
      }
      return handler as Handler;
    })
    .catch((err: { message?: string } | unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      /*
       * Log to stderr as JSON in the same shape as the app's own logger, so this line is
       * greppable in the platform's log viewer — which is where the previous failures
       * had to be diagnosed from, with nothing to read.
       */
      try {
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify({ level: 50, msg: 'API entrypoint could not load the app', error: message }),
        );
      } catch { /* logging must not mask the failure it describes */ }
      return reportLoadFailure(message) as Handler;
    });
  return handlerPromise;
}

/** Answer every request with the load error, in the app's own error envelope shape. */
function reportLoadFailure(message: string): Handler {
  return (req, res) => {
    const body = JSON.stringify({
      error: {
        code: 'boot_failed',
        summary:
          'The API module could not be loaded, so no request can be served. The reason is in this ' +
          'response and in the function log line that accompanies it.',
        detail: message,
        stage: 'module_load',
      },
    });
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store, max-age=0');
    res.setHeader('x-relay-request-path', (() => { try { return String(req.url); } catch { return ''; } })());
    res.end(body);
  };
}

/**
 * The handler the platform calls, once per request.
 *
 * Returns the handler's promise rather than `void` so the launcher can await it; a
 * synchronous throw after headers are sent would otherwise escape as an unhandled
 * rejection, which the platform reports as a failed invocation.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await loadHandler();
  await app(req, res);
}
