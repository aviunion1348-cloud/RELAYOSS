/**
 * Storage engine selection.
 *
 * Two engines implement one interface:
 *
 *   sqlite    `node:sqlite` — zero-dependency local dev, E2E and CI unit runs
 *   postgres  `pg`          — the production system of record (PostgreSQL 16)
 *
 * Selection is by `DATABASE_URL`. Nothing above this directory knows which one
 * is active; `npm run verify:pg` runs the whole HTTP contract suite against a
 * real PostgreSQL 16 server to prove the two behave the same where it matters.
 */
import type { Dialect } from './sql.ts';

export type Row = Record<string, unknown>;
export type SqlParams = unknown[] | Record<string, unknown>;

export interface Db {
  readonly dialect: Dialect;
  all<T = Row>(sql: string, params?: SqlParams): Promise<T[]>;
  get<T = Row>(sql: string, params?: SqlParams): Promise<T | undefined>;
  run(sql: string, params?: SqlParams): Promise<void>;
  exec(sql: string): Promise<void>;
  /** Atomic unit of work. Nested calls join the outer transaction. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  ping?(): Promise<boolean>;
  close(): Promise<void>;
}

export type { Dialect };
