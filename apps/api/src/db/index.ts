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
  if (config.databaseUrl) return new PostgresDb(config.databaseUrl);
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
