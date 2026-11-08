/**
 * Database handle.
 *
 * `DATABASE_URL=postgres://…` selects the PostgreSQL driver (production);
 * otherwise a local SQLite file is used (zero-dependency development, tests).
 * Both satisfy the same async `Db` interface, so no service, route or domain
 * module needs to know which engine is running.
 */
import { config } from '../config.ts';
import { PostgresDb } from './postgres.ts';
import type { Db } from './types.ts';

export type { Db, Row, SqlParams } from './types.ts';
export type { Dialect } from './sql.ts';

let singleton: Db | null = null;

/**
 * The in-flight construction, shared by concurrent first requests so they await
 * one connection instead of racing to open several. Cleared on failure, so a
 * transient error is retried rather than poisoning the instance for its lifetime.
 */
let pending: Promise<Db> | null = null;

/**
 * The SQLite driver is loaded on demand, never at module load.
 *
 * `node:sqlite` is a built-in module whose availability depends on the Node
 * version: 22.5 introduced it behind `--experimental-sqlite`, and later 22.x
 * releases expose it unflagged. A *static* import therefore puts a
 * version-dependent built-in into the module graph of every request — including
 * deployments that use PostgreSQL and will never touch SQLite.
 *
 * The consequence is severe and silent. Where the built-in is unavailable, the
 * import throws while the module graph is being evaluated, so the function gets no
 * handler at all: the platform answers `500` with no body, and no `try/catch` in
 * this application can run, because there is no code to catch it. That is exactly
 * the blank 500 a real deployment produced.
 *
 * Importing it inside the branch that needs it confines the failure to the SQLite
 * path, where it can be reported like any other error.
 */
async function loadSqlite(): Promise<typeof import('./sqlite.ts').SqliteDb> {
  try {
    const mod = await import('./sqlite.ts');
    return mod.SqliteDb;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      'SQLite is unavailable in this runtime, and no DATABASE_URL is configured. ' +
        '`node:sqlite` requires Node 22.5+ (with --experimental-sqlite on early 22.x). ' +
        `Set DATABASE_URL to use PostgreSQL instead. Underlying error: ${detail}`,
    );
  }
}

export async function createDb(): Promise<Db> {
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
  const SqliteDb = await loadSqlite();
  return new SqliteDb(config.dbPath);
}

/**
 * The process-wide connection.
 *
 * Async because the SQLite driver is loaded on demand (see `loadSqlite`). The
 * in-flight construction is memoised rather than the finished value, so concurrent
 * first requests await one connection instead of racing to open several — and a
 * failed construction is forgotten, so a transient error can be retried instead of
 * poisoning the instance for its lifetime.
 */
export async function getDb(): Promise<Db> {
  if (singleton) return singleton;
  if (!pending) {
    pending = createDb().then(
      (db) => {
        singleton = db;
        pending = null;
        return db;
      },
      (err) => {
        pending = null;
        throw err;
      },
    );
  }
  return pending;
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
