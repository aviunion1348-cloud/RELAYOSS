/**
 * Database handle.
 *
 * `DATABASE_URL=postgres://…` selects the PostgreSQL driver (production);
 * otherwise a local SQLite file is used (zero-dependency development, tests).
 * Both satisfy the same async `Db` interface, so no service, route or domain
 * module needs to know which engine is running.
 */
import { config } from '../config.ts';
import { SqliteDb } from './sqlite.ts';
import { PostgresDb } from './postgres.ts';
import type { Db } from './types.ts';

export type { Db, Row, SqlParams } from './types.ts';
export type { Dialect } from './sql.ts';

let singleton: Db | null = null;

export function createDb(): Db {
  if (config.databaseUrl) {
    /**
     * Serverless connection budgeting.
     *
     * `pg` defaults to 10 connections per pool. A single long-lived container can
     * afford that; a serverless platform cannot, because every concurrent instance
     * holds its own pool — twenty functions × ten connections exhausts a typical
     * managed Postgres and the failure looks like random timeouts under load.
     *
     * DATABASE_POOL_MAX keeps the total bounded, and the provider's *pooled*
     * connection string (PgBouncer, Neon pooler, Supabase pgBouncer) is what makes
     * the product safe at scale. Both are documented in the deployment guide.
     */
    const poolMax = Number(process.env.DATABASE_POOL_MAX ?? (process.env.VERCEL ? 3 : 10));
    return new PostgresDb(config.databaseUrl, {
      max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 3,
    });
  }
  return new SqliteDb(config.dbPath);
}

export function getDb(): Db {
  if (!singleton) singleton = createDb();
  return singleton;
}

/** Test/setup helper — swaps in a specific engine instance. */
export function setDb(db: Db | null) {
  singleton = db;
}

export async function closeDb() {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}
