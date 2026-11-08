/**
 * SQLite driver (`node:sqlite`, built into Node 22).
 *
 * Async interface over the synchronous binding — the app is now engine-agnostic,
 * and the local path stays dependency-free. WAL, foreign keys and a busy
 * timeout are configured per connection.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row, SqlParams } from './types.ts';

export class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private raw: DatabaseSync;
  private cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  /** A Promise bound as a value is always a missing `await` — fail loudly. */
  private check(params: SqlParams) {
    if (!Array.isArray(params)) return;
    for (let i = 0; i < params.length; i++) {
      const v = params[i];
      if (v instanceof Promise) {
        throw new TypeError(
          `Bound a Promise as SQL parameter ${i + 1} — a database/service call is missing 'await'.`,
        );
      }
    }
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  async all<T = Row>(sql: string, params: SqlParams = []): Promise<T[]> {
    this.check(params);
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  async get<T = Row>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    this.check(params);
    return this.stmt(sql).get(...(params as never[])) as T | undefined;
  }

  async run(sql: string, params: SqlParams = []): Promise<void> {
    this.check(params);
    this.stmt(sql).run(...(params as never[]));
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = await fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  async ping(): Promise<boolean> {
    try {
      this.raw.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.cache.clear();
    this.raw.close();
  }
}
