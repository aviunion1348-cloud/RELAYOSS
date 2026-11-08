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
import { Db, getDb, setDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { registerRoutes } from './routes/index.ts';
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
    migrate(db, { log: () => {} });
  }

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigin.includes('*') ? true : config.corsOrigin,
    credentials: true,
    allowedHeaders: ['content-type', 'x-actor-id', 'x-request-id'],
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

  app.addHook('onRequest', async (req) => {
    (req as unknown as { startedAt: number }).startedAt = Date.now();
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.log.info) return;
    const startedAt = (req as unknown as { startedAt?: number }).startedAt ?? Date.now();
    req.log.info({ statusCode: reply.statusCode, ms: Date.now() - startedAt, path: req.url }, 'request');
  });

  app.setErrorHandler((rawErr: unknown, req, reply) => {
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

  await registerRoutes(app);

  if ((opts.serveStatic ?? true) && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, cacheControl: true, maxAge: '1h' });
  }

  return { app, db };
}
