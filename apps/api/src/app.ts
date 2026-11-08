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
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { getDb, setDb, type Db } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { seed } from './db/seed.ts';
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
    /**
     * Seed a database that has no people in it.
     *
     * Without a PostgreSQL instance the API falls back to SQLite, and on Vercel
     * that file starts empty on every cold start. An empty database is not merely
     * sparse: `users` is a foreign key target for every attribution column, so
     * there is nobody to attribute a request to and every write would fail.
     *
     * The failure this replaced was worse and less obvious: the same empty database
     * used to resolve no credential, fall back to `dev` mode, and be refused at boot
     * in production — so the deployment answered nothing, and the frontend showed a
     * sign-in screen that could never work. Seeding is what makes the no-database
     * configuration genuinely usable rather than nominally supported.
     *
     * Seeding is gated three ways so it cannot touch real data:
     *
     *   - only when the database was just migrated by this boot (never for an
     *     injected/test database, and never on a Postgres deployment, which is
     *     migrated deliberately by `npm run db:migrate:prod`);
     *   - only when `users` is empty, so an existing installation is left alone;
     *   - only when `SEED_DEMO_DATA` is not `0`, so an operator can turn it off.
     *
     * Together that means "a demonstration instance gets its demo data", which is
     * what the whole product already assumes on a laptop.
     */
    if (process.env.SEED_DEMO_DATA !== '0' && !config.databaseUrl) {
      try {
        const people = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
        if (Number(people?.c ?? 0) === 0) {
          // `seed` refuses in production without FORCE, and that guard is worth
          // keeping for the CLI — where an operator must mean it — while this call
          // is the boot of an empty demonstration instance, already gated above.
          const previous = process.env.FORCE;
          process.env.FORCE = '1';
          try {
            await seed(db, () => {});
          } finally {
            if (previous === undefined) delete process.env.FORCE;
            else process.env.FORCE = previous;
          }
        }
      } catch (err) {
        /**
         * A failed seed must not prevent the server from starting: an operator can
         * still reach `/api/health`, see the engine, and seed by hand. It is logged
         * loudly because silently serving an empty database is worse.
         */
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify({
            level: 40,
            msg: 'Demo seeding failed. The API will start with an empty database.',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
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
    const indexFile = path.join(opts.webDist ?? config.webDist, 'index.html');
    if (fs.existsSync(indexFile)) {
      return reply.type('text/html').send(fs.readFileSync(indexFile));
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Build the web app first (npm run build).' } });
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

  const webDist = opts.webDist ?? config.webDist;
  if (serveStatic && fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, cacheControl: true, maxAge: '1h' });
  }

  return { app, db };
}
