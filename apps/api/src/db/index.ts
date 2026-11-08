/**
 * Database driver.
 *
 * Uses the built-in `node:sqlite` synchronous binding behind a thin repository
 * boundary so the rest of the app never imports a driver directly. WAL is on,
 * FKs are enforced, statements are cached, and every mutation runs inside an
 * explicit transaction helper. A Postgres adapter can implement the same
 * `Db` interface (see db/postgres/README.md) without touching route code.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

export type Row = Record<string, unknown>;
export type SqlParams = unknown[] | Record<string, unknown>;

export class Db {
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

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, params: SqlParams = []): T[] {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, params: SqlParams = []): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, params: SqlParams = []) {
    return this.stmt(sql).run(...(params as never[]));
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  /** Atomic unit of work. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.raw.close();
  }
}

let singleton: Db | null = null;

export function getDb(): Db {
  if (!singleton) singleton = new Db(config.dbPath);
  return singleton;
}

/** Test helper — swaps in an in-memory database. */
export function setDb(db: Db) {
  singleton = db;
}
