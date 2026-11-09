/**
 * App factory — build a fully-wired Fastify instance without binding a port.
 *
 * Kept separate from index.ts so tests can use `app.inject()` against the real
 * router, error handler and middleware stack, and so a serverless adapter can
 * reuse the same graph.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { getDb, setDb, type Db } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { ensureOperator, type BootstrapResult } from './db/bootstrap.ts';
import { describeWebServing, resolveWebDist } from './lib/web-dist.ts';
import { embeddedFile, embeddedIndex, hasEmbeddedSpa } from './lib/embedded-web.ts';
import { registerRoutes } from './routes/index.ts';
import { createOperatorAuth, registerOperatorHook, resolveOperator } from './auth/operator-middleware.ts';
import { registerOperatorRoutes } from './routes/operator.ts';
import { DbLoginThrottle, consumeRateLimit } from './lib/rate-limit-store.ts';
import { RateLimiter, LoginThrottle } from './lib/rate-limit.ts';
import { tooMany } from './lib/http.ts';
import { inc, routeTemplate } from './lib/metrics.ts';
import { HttpError } from './lib/http.ts';

export interface BuildOptions {
  /** Inject a database (tests use in-memory). */
  db?: Db;
  migrateOnBoot?: boolean;
  serveStatic?: boolean;
  /**
   * Directory the SPA was built into.
   *
   * Only relevant when the API serves the browser bundle itself, which is the
   * container layout (`npm start`: one process, one origin, no CORS surface). In
   * the multi-service deployment the web bundle is a separate artifact owned by the
   * web service, so `serveStatic` is off and this path does not exist — see
   * `entrypoints/vercel.ts`. Passing it in keeps the API's own filesystem free of
   * assumptions about a build that lives in another service's output.
   */
  webDist?: string;
  logger?: boolean;
  /**
   * Inject a login throttle. Tests need this: several of them fail a login on
   * purpose, and a fresh application built inside a test would otherwise carry the
   * default limiter, which then locks the shared username for the remaining tests.
   * The limiter's real behaviour is covered by its own unit test.
   */
  throttle?: LoginThrottle;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; db: Db }> {
  /*
   * No authentication configuration is validated, because there is none.
   *
   * This used to throw before the first connection was opened if `SESSION_SECRET`
   * was absent or the password hash was malformed — a deliberate fail-fast, which
   * was correct while the API had a session boundary. With no sessions there is no
   * secret to sign, so requiring one would mean a deployment could not start over
   * a variable that no longer does anything. That is the exact class of failure
   * this change exists to remove.
   */

  const db = opts.db ?? (await getDb());
  if (opts.db) setDb(opts.db);
  const migrated = opts.migrateOnBoot ?? (process.env.SKIP_MIGRATE !== '1' && !opts.db);
  if (migrated) {
    await migrate(db, { log: () => {} });
  }

  /**
   * First-run bootstrap: one operator, and nothing else.
   *
   * This replaces a demo seed that ran on every boot of an empty database and created
   * a fictional studio — twelve people, six projects, 89 tasks, deals, invoices. It made
   * a fresh installation look populated and made invented data indistinguishable from
   * real data, which is the defect: a dashboard showing numbers nobody entered is a
   * false claim about the business, not a demonstration of the product.
   *
   * The bind that forces this to exist at all is attribution: every `created_by` is a
   * foreign key to `users`, so a database with no people cannot accept a write. One
   * operator row, named from configuration, is the minimum that makes the product
   * usable; every client, project, task and deal is entered by the operator.
   *
   * Demo data is still available, deliberately and explicitly, via `npm run db:seed`.
   */
  let bootstrap: BootstrapResult | null = null;
  try {
    bootstrap = await ensureOperator(db);
  } catch (err) {
    /*
     * A bootstrap failure must not take the API down: `/api/health` still needs to
     * answer so an operator can see the engine and run the CLI. It is logged loudly
     * because the first write will fail with the same reason.
     */
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 40,
        msg: 'operator bootstrap failed; the API will start but cannot attribute writes',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  if (bootstrap?.created || bootstrap?.boardCreated) {
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        level: 30,
        msg:
          (bootstrap.created ? `created the operator (${bootstrap.userId})` : 'operator already existed') +
          (bootstrap.boardCreated
            ? '; created an empty Studio board so a task has somewhere to go'
            : '') +
          '. No demo content: clients, projects, deals and tasks are yours to enter or import',
      }),
    );
  }

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
    bodyLimit: 2 * 1024 * 1024,
  });

  /*
   * No authentication mode is resolved, and nothing is provisioned.
   *
   * This deployment is an internal, unauthenticated application: there is no
   * sign-in, no session and no credential. The block that used to live here —
   * copying a password hash from the environment, deciding between `password`,
   * `oidc` and `dev`, and refusing to boot in production when none was
   * configured — is the machinery that turned a missing environment variable into
   * an API that answered *every* request with a refusal. It is gone.
   *
   * What remains is an identity for attribution and scoping (see
   * `auth/operator-middleware.ts`). It is resolved lazily, so a database problem
   * reports itself on the request that needs it instead of preventing boot.
   */

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  /*
   * No `credentials: true`, and no `x-csrf-token` in the allowlist.
   *
   * There is no cookie to send cross-origin and no CSRF token to carry. Leaving
   * the header advertised would suggest a token is required and invite a future
   * client to implement one that nothing checks.
   */
  await app.register(cors, {
    origin: config.corsOrigin.includes('*') ? true : config.corsOrigin,
    allowedHeaders: ['content-type', 'x-request-id', 'authorization'],
  });

  /**
   * Be liberal with empty JSON bodies: a POST that carries no payload (sweep,
   * resolve-with-defaults) should not 500 because a client set content-type.
   * Strictness belongs in schema validation, not in the parser.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = (body as string).trim();
    if (raw === '' || raw === 'null') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      const err = new Error('Malformed JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  /**
   * Unregistered content-types (form posts from a proxy, text/plain probes) are
   * accepted as an empty payload rather than rejected with 415. Registered
   * after the JSON parser so it never shadows it.
   */
  app.addContentTypeParser('*', (req, payload, done) => {
    payload.resume();
    done(null, {});
  });

  /**
   * A body-declaring content-type on a request with no body is a client bug,
   * not an error: GETs with `content-type: application/json` are common from
   * shared HTTP wrappers. Normalise it away before routing so it never becomes
   * a 415.
   */
  app.addHook('onRequest', async (req) => {
    (req as unknown as { startedAt: number }).startedAt = Date.now();
    const length = req.headers['content-length'];
    const hasBody = (length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined;
    if (!hasBody && req.headers['content-type']) {
      delete req.headers['content-type'];
    }
  });

  /**
   * Structured access log + RED metrics. One JSON line per request with the
   * correlation id, route template (never the raw URL: ids are not cardinality
   * we can afford) and duration. Request bodies and headers are never logged.
   */
  app.addHook('onResponse', async (req, reply) => {
    const startedAt = (req as unknown as { startedAt?: number }).startedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    const route = routeTemplate(req.url);
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;

    inc('relay_http_requests_total', { route, method: req.method, status: statusClass });
    if (durationMs > 500) inc('relay_http_slow_total', { route });

    if (!req.log.info) return;
    req.log.info(
      {
        reqId: req.id,
        method: req.method,
        route,
        status: reply.statusCode,
        ms: durationMs,
        actor: req.identity?.userId ?? null,
      },
      'request',
    );
  });

  /*
   * The change log.
   *
   * The live feed needs one question answered cheaply: "has anything changed since
   * X?". The obvious source is `audit_log` — an integer primary key is a perfect
   * version counter — except almost nothing wrote to it: five of forty-nine mutating
   * routes did, so the feed would have been blind to most edits and every screen would
   * have gone quietly stale.
   *
   * The fix has to be at the one place every write already passes through, not in
   * forty-nine handlers that someone will forget to extend. This hook records *that*
   * a mutation succeeded, not *what* it contained: the audit trail stays the place
   * for rich, entity-specific history, while this table exists only to be counted.
   *
   * Two properties make it cheap enough to run on every write:
   *
   *   - one statement, no transaction, appended after the response is composed;
   *   - a failure is swallowed. A change that happened but was not recorded costs a
   *     stale screen until the next write; a write that succeeded and then reported
   *     an error because bookkeeping failed is far worse.
   */
  const METHODS_THAT_CHANGE_STATE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  app.addHook('onResponse', async (req, reply) => {
    if (!METHODS_THAT_CHANGE_STATE.has(req.method)) return;
    if (reply.statusCode >= 400) return;
    // The cron sweep is a write, but it is a scheduler's write and nobody is watching.
    if (req.url.startsWith('/api/cron/')) return;
    const entityType = entityTypeFor(req.url);
    if (!entityType) return;
    try {
      await db.run(
        'INSERT INTO change_log (entity_type, entity_id, method, path) VALUES (?,?,?,?)',
        [entityType, entityIdFrom(req.url), req.method, req.url.split('?')[0].slice(0, 200)],
      );
    } catch {
      /* bookkeeping must never fail a request that already succeeded */
    }
  });

  app.setErrorHandler((rawErr: unknown, req, reply) => {
    // Fastify's own 4xx errors (unsupported media type, payload too large,
    // malformed body) carry a statusCode; map them to the API's error shape
    // instead of reporting them as internal failures.
    const fastifyStatus = (rawErr as { statusCode?: number })?.statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      const code = fastifyStatus === 401 ? 'unauthorized'
        : fastifyStatus === 403 ? 'forbidden'
        : fastifyStatus === 404 ? 'not_found'
        : fastifyStatus === 429 ? 'rate_limited'
        : fastifyStatus === 409 ? 'conflict'
        : fastifyStatus === 415 ? 'bad_request'
        : fastifyStatus === 413 ? 'bad_request'
        : 'bad_request';
      req.log.warn({ statusCode: fastifyStatus, url: req.url }, 'client_error');
      return reply.code(fastifyStatus).send({
        error: { code, message: (rawErr as Error).message || 'Invalid request' },
        requestId: req.id,
      });
    }
    const err = rawErr as Error & { statusCode?: number; validation?: unknown; details?: unknown };
    if (err instanceof HttpError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, details: err.details },
        requestId: req.id,
      });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: { code: 'validation', message: err.message }, requestId: req.id });
    }

    // A TypeError or RangeError raised while reading a request body is a *client*
    // fault, not a server one: the body carried a shape the handler did not
    // expect (`.trim` on a number, an array bound as a parameter). Reporting 500
    // hides the caller's mistake and looks like a server defect. These are mapped
    // to 400 with the field named where it is known.
    //
    // The line is drawn at errors that arise from request-shaped values only:
    // anything thrown elsewhere (a database failure, a bug in logic) is still a
    // 500 and is still logged, because pretending otherwise would hide real
    // outages.
    //
    // Rather than requiring every handler to remember to flag itself, the check
    // is on the error's origin: a TypeError/RangeError raised during this request
    // is treated as a body-shape fault, because request parsing happens inside
    // the handler. A database or logic failure surfaces as a different error type
    // and keeps its 500.
    const errName = (err as Error)?.name ?? '';
    const requestShaped = errName === 'TypeError' || errName === 'RangeError'
      // A bind error for an array/object parameter: the value came from the body.
      || /Unknown named parameter|no column named|Bind parameter|must be of type/i.test((err as Error)?.message ?? '');
    if (requestShaped) {
      req.log.warn({ err, url: req.url }, 'invalid_request_body');
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: `The request body is not valid for this endpoint (${err.message}).`,
        },
        requestId: req.id,
      });
    }
    req.log.error({ err }, 'unhandled');
    // The detail stays in the server log, keyed by request id. It is never put in
    // the response: an error message can carry a file path, a SQL fragment or a
    // table name, and the client has no need for any of them. The request id is
    // what lets an operator join the client's report to the stack trace.
    //
    // Previously the raw message was returned whenever `env !== 'production'`,
    // which meant a staging deployment pointed at real data leaked internals —
    // and a test that asserted "no leak" failed against the development build for
    // exactly that reason.
    //
    // `INTERNAL_ERROR_DETAIL=1` opts back in for local debugging, and is refused in
    // production by the boot guard.
    const showDetail = config.internalErrorDetail === true;
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message: showDetail ? `${err.message} (requestId ${req.id})` : 'Something went wrong. Quote the request id when reporting this.',
      },
      requestId: req.id,
    });
  });

  /*
   * Resolved once, because two places depend on it and they must agree.
   *
   * `serveStatic: false` used to disable the static *plugin* and leave the not-found
   * handler still reading `apps/web/dist/index.html` off the local disk — so the API
   * service in a multi-service deployment answered `GET /` with an HTML document it
   * had no business serving, while Vercel's rewrite had already assigned every
   * non-`/api` path to the web service. A request reaching the API service for a
   * browser route means the routing is wrong, and returning a 200 document hides it.
   */
  const serveStatic = opts.serveStatic ?? true;
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
    }
    if (!serveStatic) {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
    }
    /*
     * A path that names a file is a file, and a missing one is a 404.
     *
     * The obvious SPA fallback — answer every unmatched path with the document —
     * also answers `/assets/index-abc123.js` with the document and status 200. The
     * browser then reports a MIME type error rather than a missing file, and a stale
     * hashed reference renders a blank page instead of failing cleanly. This exact
     * bug was prevented by a rewrite rule (`/((?!assets/)[^.]*)`) while a static host
     * owned routing; now that this process answers browser routes itself, the rule
     * has to live here or it does not exist.
     *
     * So the document is served only for paths that cannot be a file. Anything with
     * an asset extension, anything under /assets/ or /.well-known/, is a 404 when it
     * is not on disk.
     */
    const pathname = req.url.split('?')[0].split('#')[0];
    const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
    const looksLikeFile =
      /^\/assets\//.test(pathname) ||
      /^\/\.well-known\//.test(pathname) ||
      /\.(?:js|mjs|css|map|json|txt|xml|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|wasm|pdf)$/i.test(lastSegment);
    /*
     * A file that names a real asset is served from the embedded build, then from disk.
     * This is the deployment path: `/assets/index-abc123.js` is not a route, and in a
     * bundle it is not on disk either, so without this the document would load and every
     * script it references would 404 — a blank page that looks like a JavaScript bug.
     */
    if (useEmbedded && looksLikeFile) {
      const asset = embeddedFile(pathname);
      if (asset) {
        return reply
          .type(asset.type)
          .header('cache-control', asset.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable')
          .send(asset.body);
      }
    }

    if (looksLikeFile) {
      return reply.code(404).send({ error: { code: 'not_found', message: `No such file: ${pathname}` } });
    }

    /*
     * The same search as the static root, so the not-found handler answers with the
     * document from wherever it was found — or, when there is genuinely no build,
     * refuses as JSON instead of reading a path that does not exist.
     */
    const notFoundDist = resolveWebDist(opts.webDist ?? config.webDist).dir;
    const indexFile = notFoundDist ? path.join(notFoundDist, 'index.html') : null;
    if (indexFile && fs.existsSync(indexFile)) {
      return reply.type('text/html').send(fs.readFileSync(indexFile));
    }
    if (useEmbedded) {
      const index = embeddedIndex();
      if (index) return reply.type('text/html').header('cache-control', 'no-cache').send(index.body);
    }
    /*
     * Nothing to serve, and the advice has to be accurate for the place this is running.
     * On a workstation the build is simply missing. In a bundle it means the build ran
     * without `scripts/embed-web-assets.mjs`, which is a build-order mistake rather than
     * anything the reader did — saying "run npm run build" to someone who cannot open a
     * terminal there is worse than saying nothing.
     */
    return reply.code(404).send({
      error: {
        code: 'not_found',
        message:
          'No built dashboard in this installation: no web build on disk and none embedded. ' +
          'Run `npm run build:service`, which builds the web app and embeds it in the API.',
        web: describeWebServing(notFoundDist),
      },
    });
  });

  /**
   * Rate limiting. Three budgets, because the abuse profiles differ:
   *   global  — a runaway client or scraper
   *   auth    — credential stuffing against login
   *   write   — anything that creates/approves/ships
   * Limits are per-process (documented in docs/SECURITY.md); a shared store is
   * required for cluster-wide enforcement.
   */
  /*
   * Request budgets.
   *
   * Two strategies behind one interface, chosen by whether the database is shared:
   *
   *   in-process  a Map. Correct for one container, and free.
   *   database    a conditional upsert per request. Correct for N instances, at the
   *               cost of one round-trip on every request.
   *
   * The database path is selected whenever PostgreSQL is configured, because that is
   * the only case where a per-process budget is not a budget. §10 asks for a
   * distributed limiter specifically; on a single container the in-process one is
   * strictly better, since it adds no latency and cannot fail.
   *
   * Note that the database limiter is *awaited* in the hook while the in-process one
   * is not. Both are awaited uniformly below — a resolved non-promise costs nothing.
   */
  const distributed = db.dialect === 'postgres';
  const budgetFor = (scope: string, limit: number) =>
    distributed
      ? {
          take: (key: string) =>
            consumeRateLimit(db, `${scope}:${key}`, limit, 60_000),
        }
      : new RateLimiter({ limit, windowMs: 60_000, scope });

  const globalLimiter = budgetFor('global', config.rateLimit.global);
  const authLimiter = budgetFor('auth', config.rateLimit.auth);
  const writeLimiter = budgetFor('write', config.rateLimit.write);
  /*
   * Login lockout storage — retained, though nothing writes to it now.
   *
   * The store is still constructed because `DbLoginThrottle` also backs the shared
   * rate-limit counters, and because `buildApp` accepts an injected throttle that
   * the rate-limit tests drive directly. What disappeared is the *login* that used
   * to consume the auth budget.
   */
  const loginThrottle =
    opts.throttle ??
    (db.dialect === 'postgres' ? new DbLoginThrottle(db) : new LoginThrottle());

  app.addHook('onRequest', async (req, reply) => {
    const identityKey = (req.headers.cookie ? 'cookie' : req.ip) ?? 'anon';
    const key = `${req.ip}|${identityKey}`;
    /*
     * No auth budget any more: the endpoints that used it are gone.
     *
     * The retired login paths still draw the stricter `authLimiter` in case anything
     * probes them — they answer `410 Gone`, and having that be rate-limited is
     * cheaper than having it be a free way to make the server allocate a response.
     * Everything else uses the global (read) or write budget, unchanged.
     */
    const budget = req.url.startsWith('/api/auth/')
      ? authLimiter
      : req.method === 'GET' || req.method === 'HEAD'
        ? globalLimiter
        : writeLimiter;
    // Every budget exposes `take`; the database one is async. Awaiting both keeps a
    // single code path, and a synchronous return awaits to itself.
    const decision = await budget.take(key);
    reply.header('x-ratelimit-remaining', String(decision.remaining));
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSec));
      req.log.warn({ url: req.url, ip: req.ip }, 'rate_limited');
      throw tooMany('Too many requests — slow down.', decision.retryAfterSec);
    }
  });

  /*
   * Attach the operator to every request. This hook cannot refuse one.
   *
   * `registerAuthRoutes` and `registerPasswordLogin` are no longer mounted: there
   * is no login, so there are no login endpoints. `/api/auth/session` survives as
   * a small route that reports the deployment's mode, because the frontend asks
   * for it during startup and needs an answer rather than a 404.
   */
  registerOperatorHook(app, db);
  const auth = createOperatorAuth({ db });
  await app.register(registerOperatorRoutes);
  await registerRoutes(app, { auth });

  /*
   * Locate the built SPA rather than assuming where it is. In a platform bundle the
   * module-relative answer points outside the artefact, so a correct build answered `/`
   * with a JSON 404 — see `lib/web-dist.ts`.
   */
  const resolved = resolveWebDist(opts.webDist ?? config.webDist);
  const webDist = resolved.dir;

  /*
   * `@fastify/static` is loaded only when there is a directory to serve, and never at
   * module scope.
   *
   * It is a CommonJS package that `require`s its dependencies, and in 10.1.4 one of them
   * (`content-disposition`) switched to ESM-only. On a runtime without CommonJS→ESM
   * `require` support, importing this module at the top of the file threw
   * `ERR_REQUIRE_ESM` while the function was being *loaded* — so every request, including
   * `/api/live`, returned `boot_failed` before any of our code ran. The version is pinned
   * to 10.1.3 and that is the fix; this is the structural half.
   *
   * In a deployment bundle there is no `apps/web/dist` at all — the SPA is compiled in
   * (see `lib/embedded-web.ts`) — so this import now never executes there, and a future
   * regression in that dependency's module format cannot stop the API from booting. Where
   * a directory does exist (a workstation, the container image, `npm start`) the import
   * is reached and any failure is real, so it is thrown rather than logged and ignored.
   */
  if (serveStatic && webDist) {
    let fastifyStatic: typeof import('@fastify/static').default;
    try {
      fastifyStatic = (await import('@fastify/static')).default;
    } catch (err) {
      throw new Error(
        `Could not load @fastify/static, which is required to serve ${webDist}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    await app.register(fastifyStatic, { root: webDist, wildcard: false, cacheControl: true, maxAge: '1h' });
  }
  /*
   * No directory? Use the build compiled into this process.
   *
   * A deployment bundle contains only what the bundler followed, which is imports — so
   * `apps/web/dist` is absent there even though the build produced it. The embedded copy
   * is the same files, compiled in, and it is what keeps `/` from being a JSON 404 in the
   * place that actually serves users.
   */
  const useEmbedded = serveStatic && !webDist && hasEmbeddedSpa();
  if (serveStatic && !webDist && !hasEmbeddedSpa()) {
    app.log.warn(
      'No built SPA found on disk and none embedded: browser routes will answer JSON 404. ' +
        'Run `npm run build:service` (which builds and embeds it).',
    );
  }

  return { app, db };
}

/**
 * Which entity type a mutating path touches, derived from the path itself.
 *
 * Deliberately a table rather than per-route bookkeeping: it is one place to change,
 * it works for a route that was added without thinking about the change feed, and the
 * URL is the only thing every route is guaranteed to have.
 *
 * `/api/docs/abc` → `doc`, `/api/insights/x%3Ay/dismiss` → `insight`. The first version
 * of this guessed `changes` for everything, which made every write invalidate the
 * feed's own query — a self-sustaining refresh loop. That is why the mapping is a path
 * segment and not a noun invented from the last word.
 */
function entityTypeFor(pathname: string): string | null {
  const segments = pathname.split('?')[0].split('/').filter(Boolean);
  // ['api', '<resource>', ...]
  if (segments[0] !== 'api' || segments.length < 2) return null;
  const resource = segments[1];
  const plural: Record<string, string> = {
    tasks: 'task',
    clients: 'client',
    partners: 'partner',
    projects: 'project',
    deals: 'deal',
    docs: 'doc',
    qa: 'qa_report',
    releases: 'release',
    insights: 'insight',
    clocks: 'clock',
    planner: 'planner_run',
    comms: 'thread',
    meetings: 'meeting',
    legal: 'legal_document',
    notifications: 'notification',
    'change-requests': 'change_request',
    acceptance: 'acceptance',
  };
  return plural[resource] ?? null;
}

/** The id-ish segment of a mutating path, for the record. Never used as a key. */
function entityIdFrom(pathname: string): string {
  const segments = pathname.split('?')[0].split('/').filter(Boolean);
  const candidate = segments[2] ?? '';
  // Only something that looks like an identifier: an action segment (`sweep`,
  // `dismiss`) is not an entity.
  return /^[A-Za-z0-9_.%:-]{1,80}$/.test(candidate) ? decodeURIComponent(candidate).slice(0, 80) : '';
}
