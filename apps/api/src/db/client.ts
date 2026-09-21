/**
 * The Drizzle instance over the SQLite connection — the second and last file
 * allowed to import `drizzle-orm/better-sqlite3` (FR3/B2).
 *
 * The migrator import lives here too, on purpose: `drizzle-orm/better-sqlite3/migrator`
 * is a SQLite-specific specifier, so importing it from `migrate.ts` would breach
 * B2. `runMigrations()` re-exports that capability engine-agnostically, which is
 * exactly the seam a Postgres migration would swap out.
 *
 * Like `sqlite.ts`, this module opens nothing at import time (FR8): the shared
 * instance is created on first use.
 */
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';
import { closeConnection, getConnection, openConnection, type SqliteConnection } from './sqlite.js';

/** The application's database handle. Repositories depend on this type only. */
export type Db = BetterSQLite3Database<typeof schema>;

/** Wrap an existing connection. Used by tests, which own their own `:memory:` DB. */
export function createDb(connection: SqliteConnection): Db {
  return drizzle(connection, { schema });
}

/**
 * A database handle that owns its connection, for short-lived CLI scripts.
 * `close()` is the only way those scripts release the connection, which keeps
 * `better-sqlite3` out of `migrate.ts` / `seed.ts` / `reset.ts` (B2).
 */
export interface OwnedDb {
  readonly db: Db;
  readonly close: () => void;
}

/**
 * Open a brand-new connection and wrap it — for short-lived CLI scripts.
 *
 * `dbPath` is required (see `openConnection()`): the callers that want
 * `DB_PATH`'s default (`migrate`, `seed`, `reset`) call `resolveDbPath()` and pass
 * the result, so no code path can silently materialise `./data/finance.db`.
 */
export function createOwnedDb(dbPath: string): OwnedDb {
  const connection = openConnection(dbPath);
  return {
    db: createDb(connection),
    close: () => {
      connection.close();
    },
  };
}

/** Process-wide instance, created lazily so importing this file is side-effect free. */
let sharedDb: Db | null = null;

/**
 * The lazily created shared database handle.
 *
 * `dbPath` is required for the same reason as `openConnection()`: a missing
 * argument must be a compile error, never a silent fall back to
 * `DEFAULT_DB_PATH`. Every repository already passes the validated
 * `config.dbPath` down.
 *
 * @throws if the underlying connection cannot be opened. Callers that must
 * survive an unreachable database use `ping()` from `sqlite.ts` instead (FR8).
 */
export function getDb(dbPath: string): Db {
  sharedDb ??= createDb(getConnection(dbPath));
  return sharedDb;
}

/** Close the shared connection and drop the cached handle. */
export function closeDb(): void {
  sharedDb = null;
  closeConnection();
}

/**
 * Apply the committed migrations in `migrationsFolder`.
 *
 * Synchronous for better-sqlite3 (C10) — no `await`, and it writes nothing to
 * disk beyond the target database, which is what lets tests migrate a `:memory:`
 * DB with no files on disk (FR14).
 */
export function runMigrations(db: Db, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
