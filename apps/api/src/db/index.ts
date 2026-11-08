/**
 * Database handle.
 *
 * PostgreSQL in every deployment, selected by `DATABASE_URL`. A local SQLite file
 * remains available for development and the unit tests, and it has to be asked for
 * explicitly (`DB_PATH`, or `createDb({ engine: 'sqlite' })`) — it is never chosen
 * by omission in a runtime that is serving traffic.
 *
 * That distinction is the whole point of this module. The previous rule was
 * "`DATABASE_URL` if present, otherwise SQLite in a writable directory", and on a
 * serverless platform "a writable directory" meant `/tmp`. The consequence was not
 * a visible failure: the API booted, accepted writes, read them back, and lost them
 * when the instance was recycled — a database that behaves exactly like one until
 * it does not. A deployment with no `DATABASE_URL` now refuses to start and says
 * which variable is missing, which is a failure a person can fix in a minute.
 *
 * Both drivers satisfy the same async `Db` interface, so no service, route or domain
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

/**
 * Is this runtime a long-running server, or a one-shot script and a test?
 *
 * The distinction decides whether a missing `DATABASE_URL` is a misconfiguration or
 * an ordinary local setup. A server that will serve traffic must not silently use a
 * file; a test that passes its own `Db` instance never reaches here at all.
 */
function isServingRuntime(): boolean {
  // Serverless (Vercel, Lambda, Cloud Run) is never a place for a local file:
  // there is no durable disk, and the instance is recycled under the data.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.K_SERVICE) return true;
  // A production process is serving traffic by definition.
  if (process.env.NODE_ENV === 'production') return true;
  // Local development, the CLI and the test harnesses.
  return false;
}

export async function createDb(opts: { engine?: 'postgres' | 'sqlite' } = {}): Promise<Db> {
  if (opts.engine === 'sqlite') return new (await loadSqlite())(config.dbPath);

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
  /*
   * No DATABASE_URL. That is fine for a local script and a misconfiguration for a
   * server, so the answer differs by runtime rather than by preference.
   */
  if (isServingRuntime()) {
    throw new Error(
      'DATABASE_URL is not set. This deployment requires PostgreSQL: there is no local-file ' +
        'fallback, because a file inside a serverless runtime is per-instance and discarded. ' +
        'Set DATABASE_URL to a PostgreSQL connection string (the pooled one from your provider ' +
        'is strongly preferred) and redeploy. See docs/DEPLOYMENT.md.',
    );
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
