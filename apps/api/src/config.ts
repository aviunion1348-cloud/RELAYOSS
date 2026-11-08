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

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: int('PORT', 4000),
  /** SQLite file path (WAL mode). Swap to Postgres via DATABASE_URL. */
  dbPath: process.env.DB_PATH ?? path.join(ROOT, 'data', 'relay.sqlite'),
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** Demo session identity — replace with SSO/OIDC in production. */
  demoUserId: process.env.DEMO_USER_ID ?? 'usr_maya',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  corsOrigin: (process.env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()),
  /** Absolute path of the built SPA served by the API in production. */
  webDist: process.env.WEB_DIST ?? path.join(ROOT, 'apps', 'web', 'dist'),
} as const;

export type AppConfig = typeof config;
