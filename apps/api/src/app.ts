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
import { registerRoutes } from './routes/index.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { createAuth } from './auth/middleware.ts';
import { assertAuthConfiguration } from './auth/index.ts';
import { RateLimiter, LoginThrottle } from './lib/rate-limit.ts';
import { tooMany } from './lib/http.ts';
import { inc, routeTemplate } from './lib/metrics.ts';
import { HttpError } from './lib/http.ts';

export interface BuildOptions {
  /** Inject a database (tests use in-memory). */
  db?: Db;
  migrateOnBoot?: boolean;
  serveStatic?: boolean;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; db: Db }> {
  const db = opts.db ?? getDb();
  if (opts.db) setDb(opts.db);
  if (opts.migrateOnBoot ?? (process.env.SKIP_MIGRATE !== '1' && !opts.db)) {
    await migrate(db, { log: () => {} });
  }

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
    bodyLimit: 2 * 1024 * 1024,
  });

  assertAuthConfiguration();

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigin.includes('*') ? true : config.corsOrigin,
    credentials: true,
    allowedHeaders: ['content-type', 'x-request-id', 'x-csrf-token', 'authorization'],
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
    return reply.code(500).send({
      error: { code: 'internal_error', message: config.env === 'production' ? 'Something went wrong.' : err.message },
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
    }
    const indexFile = path.join(config.webDist, 'index.html');
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
  const globalLimiter = new RateLimiter({ limit: config.rateLimit.global, windowMs: 60_000, scope: 'global' });
  const authLimiter = new RateLimiter({ limit: config.rateLimit.auth, windowMs: 60_000, scope: 'auth' });
  const writeLimiter = new RateLimiter({ limit: config.rateLimit.write, windowMs: 60_000, scope: 'write' });
  const loginThrottle = new LoginThrottle();

  app.addHook('onRequest', async (req, reply) => {
    const identityKey = (req.headers.cookie ? 'cookie' : req.ip) ?? 'anon';
    const key = `${req.ip}|${identityKey}`;
    const budget = req.url.startsWith('/api/auth/dev-login') || req.url.startsWith('/api/auth/oidc')
      ? authLimiter
      : req.method === 'GET' || req.method === 'HEAD'
        ? globalLimiter
        : writeLimiter;
    const decision = budget.take(key);
    reply.header('x-ratelimit-remaining', String(decision.remaining));
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSec));
      req.log.warn({ url: req.url, ip: req.ip }, 'rate_limited');
      throw tooMany('Too many requests — slow down.', decision.retryAfterSec);
    }
  });

  // Authentication runs before any business route can observe a request.
  const auth = createAuth({ db });
  app.addHook('onRequest', auth.authenticate);

  await app.register(registerAuthRoutes, { throttle: loginThrottle });
  await registerRoutes(app, { auth });

  if ((opts.serveStatic ?? true) && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, cacheControl: true, maxAge: '1h' });
  }

  return { app, db };
}
