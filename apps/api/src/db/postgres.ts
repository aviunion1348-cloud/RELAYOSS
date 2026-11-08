/**
 * PostgreSQL driver (`pg`, node-postgres).
 *
 * This is the production system of record. Statements arrive in the SQLite
 * dialect the application writes and are translated here (`?` → `$n`,
 * `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `LIKE` → `ILIKE`) so both
 * engines execute the *same* application code path.
 *
 * Transactions pin one pooled client for their whole scope, use READ COMMITTED
 * (the default) and are always released — a leaked client would slowly starve
 * the pool, which is exactly the kind of production failure that only shows up
 * under load.
 */
import pg from 'pg';
import type { Db, Row, SqlParams } from './types.ts';
import { translate } from './sql.ts';

// Postgres BIGINT/NUMERIC arrive as strings by default. Cash is stored in
// integer cents and counters as integers, so map them to numbers once, here,
// rather than sprinkling Number() through the route layer.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  private pool: pg.Pool;
  private txClient: pg.PoolClient | null = null;
  private depth = 0;
  private closed = false;

  constructor(connectionString: string, opts: { max?: number; connectionTimeoutMs?: number } = {}) {
    this.pool = new pg.Pool({
      connectionString,
      max: opts.max ?? 10,
      connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
      idleTimeoutMillis: 30_000,
      application_name: 'relay-api',
    });
    // A pool error must never crash the process; it is surfaced via /health.
    this.pool.on('error', (err) => {
      console.error(JSON.stringify({ level: 50, msg: 'pg pool error', err: err.message }));
    });
  }

  private async query<T = Row>(sql: string, params: SqlParams = []): Promise<pg.QueryResult<T>> {
    this.assertOpen();
    const text = translate(sql, 'postgres');
    const values = Array.isArray(params) ? params : Object.values(params);
    // A Promise bound as a value is always a missing `await`. node-postgres
    // would happily serialise it as "[object Promise]" and corrupt the row.
    for (let i = 0; i < values.length; i++) {
      if (values[i] instanceof Promise) {
        throw new TypeError(
          `Bound a Promise as SQL parameter ${i + 1} — a database/service call is missing 'await'.`,
        );
      }
    }
    const runner = this.txClient ?? this.pool;
    return runner.query<T>(text, values as never[]);
  }

  async all<T = Row>(sql: string, params: SqlParams = []): Promise<T[]> {
    return (await this.query<T>(sql, params)).rows;
  }

  async get<T = Row>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params)).rows[0];
  }

  async run(sql: string, params: SqlParams = []): Promise<{ changes: number }> {
    const result = await this.query(sql, params);
    return { changes: Number(result?.rowCount ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    this.assertOpen();
    const runner = this.txClient ?? this.pool;
    await runner.query(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.depth > 0) return fn();
    const client = await this.pool.connect();
    this.txClient = client;
    this.depth++;
    try {
      await client.query('BEGIN');
      const out = await fn();
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      this.depth--;
      this.txClient = null;
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pool.end();
  }

  /** A pool that has been ended must fail loudly, never silently return []. */
  private assertOpen() {
    if (this.closed) throw new Error('PostgresDb is closed — the connection pool has been released.');
  }
}
