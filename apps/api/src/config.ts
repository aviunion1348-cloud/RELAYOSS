/**
 * Central, validated configuration. Fail fast at boot rather than at 3am.
 * No secrets are ever committed — everything comes from the environment with
 * safe local defaults (documented in .env.example).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return n;
}

/**
 * Values that are read at *use* time, not at import time.
 *
 * ESM hoists imports above module body code, so a test (or `dotenv`-style
 * loader) that sets `process.env` after its import statements would otherwise
 * be too late: the frozen `config` object would already hold the empty value.
 * That produced a real, order-dependent bug — `SESSION_SECRET` set at the top
 * of a test file was ignored because `config.ts` was imported first.
 */
const env = () => ({
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: int('PORT', 4000),
  /** SQLite file path (WAL mode). Swap to Postgres via DATABASE_URL. */
  dbPath: process.env.DB_PATH ?? path.join(ROOT, 'data', 'relay.sqlite'),
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** Demo session identity — replace with SSO/OIDC in production. */
  demoUserId: process.env.DEMO_USER_ID ?? 'usr_maya',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Background clock sweeper cadence. */
  sweepIntervalMs: int('SWEEP_INTERVAL_MS', 60_000),
  /** Auth: 'oidc' enforces bearer/cookie sessions; 'dev' is local-only. */
  authMode: (process.env.AUTH_MODE ?? 'dev') as 'oidc' | 'dev',
  oidcIssuer: process.env.OIDC_ISSUER ?? '',
  oidcAudience: process.env.OIDC_AUDIENCE ?? '',
  oidcJwksUri: process.env.OIDC_JWKS_URI ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  /**
   * Per-process request budgets (requests per minute, per client address).
   * The auth budget is intentionally small: a human logs in a handful of times
   * per minute at most. Tests raise it rather than skipping the limiter.
   */
  rateLimit: {
    global: int('RATE_LIMIT_GLOBAL', 1200),
    auth: int('RATE_LIMIT_AUTH', 30),
    write: int('RATE_LIMIT_WRITE', 240),
  },
  corsOrigin: (process.env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()),
  /** Absolute path of the built SPA served by the API in production. */
  webDist: process.env.WEB_DIST ?? path.join(ROOT, 'apps', 'web', 'dist'),
});

type Env = ReturnType<typeof env>;

/**
 * `config` is a live view over the environment: every property is resolved on
 * access, so `process.env` set after import (tests, container entrypoints) is
 * honoured, and nothing is cached across a restart-shaped config change.
 */
export const config: Env = new Proxy({} as Env, {
  get(_target, prop: string | symbol) {
    if (typeof prop === 'symbol') return undefined;
    return (env() as Record<string, unknown>)[prop];
  },
  has(_target, prop: string | symbol) {
    return typeof prop === 'string' && prop in env();
  },
  ownKeys() {
    return Reflect.ownKeys(env());
  },
  getOwnPropertyDescriptor(_target, prop: string | symbol) {
    if (typeof prop !== 'string' || !(prop in env())) return undefined;
    return { configurable: true, enumerable: true, value: (env() as Record<string, unknown>)[prop] };
  },
});

export type AppConfig = Env;
