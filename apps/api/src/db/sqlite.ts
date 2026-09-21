/**
 * The SQLite engine module — **one of only two source files allowed to know the
 * database engine** (FR3/B2; the other is `client.ts`).
 *
 * B2 allowlist: `src/db/sqlite.ts`, `src/db/client.ts`, `src/db/migrations/**`,
 * `drizzle.config.ts`, `apps/api/package.json` (plus `apps/api/test/**`, exempt
 * per FR3/C16). Nothing else may name `better-sqlite3`, `drizzle-orm/better-sqlite3`
 * or `PRAGMA`. A Postgres migration later should only have to rewrite this file
 * and `client.ts`.
 *
 * ## Two hard behavioural rules
 *
 * 1. **No connection at import time** (FR8 boot-failure policy). An unreachable
 *    database is NOT fatal: the server still binds its port and
 *    `/api/v1/health` reports 503 `db: "unavailable"`. So the connection is
 *    opened lazily on first use and every entry point either returns a status or
 *    throws an error the health repository can catch. Importing this module has
 *    no side effects whatsoever.
 *
 * 2. **`PRAGMA journal_mode=WAL` is issued only for file-backed databases** (C4).
 *    WAL on `:memory:` does not throw — SQLite silently reports
 *    `journal_mode: 'memory'` — so the conditional is a correctness and
 *    testability requirement, not crash avoidance. Every pragma therefore goes
 *    through the single `applyPragma()` helper so a test can spy on
 *    `connection.pragma` and assert, statement by statement, which pragmas were
 *    and were not issued.
 *
 * Raw SQL is disallowed outside this file and `migrations/**` (FR8). The only raw
 * statement here is `SELECT_ONE_SQL`, used by `ping()` for the health check.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { DEFAULT_DB_PATH, IN_MEMORY_DB_PATH } from '../config.js';

/* ------------------------------------------------------------------ *
 * Named constants — every pragma, sentinel and raw statement (FR8)
 * ------------------------------------------------------------------ */

/** Enforce foreign keys on this connection. Applied **unconditionally**. */
export const PRAGMA_FOREIGN_KEYS_ON = 'foreign_keys = ON';

/** Wait rather than fail immediately on a locked database. Unconditional. */
export const PRAGMA_BUSY_TIMEOUT = 'busy_timeout = 5000';

/** Write-ahead logging. **File-backed databases only** (C4). */
export const PRAGMA_JOURNAL_MODE_WAL = 'journal_mode = WAL';

/** The ONLY raw SQL statement in the codebase outside `migrations/**` (FR8). */
export const SELECT_ONE_SQL = 'SELECT 1';

/** Env var carrying the database location (FR12). */
export const DB_PATH_ENV_VAR = 'DB_PATH';

/** Sidecar files SQLite creates next to a WAL-mode database. */
export const WAL_FILE_SUFFIX = '-wal';
export const SHM_FILE_SUFFIX = '-shm';

/**
 * Env var Vitest sets in every worker process. It is never set by `npm run dev`,
 * `npm start`, `db:migrate`, `db:seed` or `db:reset`, which is what keeps the
 * case-23 tripwire below strictly a test-time concern.
 */
export const VITEST_ENV_VAR = 'VITEST';

/** Separator between a message and the offending path. */
const MESSAGE_SEPARATOR = ': ';

/**
 * This module's own distance to the repository root. Identical for `src/db/` and
 * `dist/db/`, so the constant is correct under vitest and under `node dist/...`.
 */
const REPOSITORY_ROOT_RELATIVE_URL = '../../../../';

/** Repository root, resolved from this module rather than `process.cwd()`. */
const REPOSITORY_ROOT = fileURLToPath(new URL(REPOSITORY_ROOT_RELATIVE_URL, import.meta.url));

/** Message of the error thrown when a test would create a DB file in the tree. */
export const IN_TREE_DB_FILE_MESSAGE =
  'Refusing to create a file-backed SQLite database inside the repository working tree during a test run (case 23) — use :memory: or a path under the OS temp directory';

/** The open connection type, so callers never import `better-sqlite3` (B2). */
export type SqliteConnection = Database.Database;

/* ------------------------------------------------------------------ *
 * Path resolution
 * ------------------------------------------------------------------ */

/**
 * Resolve `DB_PATH` for the CLI entry points (`migrate`, `seed`, `reset`).
 *
 * These read the one variable they need instead of calling `loadConfig()`, which
 * would make a valid `JWT_SECRET` a prerequisite for running a migration. The
 * default is shared with `config.ts` so the two can never disagree. The server
 * path is unaffected: it passes its already-validated `config.dbPath` in.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DB_PATH_ENV_VAR];
  return configured === undefined || configured === '' ? DEFAULT_DB_PATH : configured;
}

/** True when `dbPath` is SQLite's private in-memory sentinel (`:memory:`). */
export function isInMemoryDbPath(dbPath: string): boolean {
  return dbPath === IN_MEMORY_DB_PATH;
}

/* ------------------------------------------------------------------ *
 * Connection + pragmas
 * ------------------------------------------------------------------ */

/**
 * The single choke point for pragma execution. Keeping it to one call site is
 * what makes "was `journal_mode=WAL` issued?" observable by a spy (C4, case 29).
 */
function applyPragma(connection: SqliteConnection, statement: string): void {
  connection.pragma(statement);
}

/**
 * Apply the session pragmas. `foreign_keys` and `busy_timeout` unconditionally;
 * `journal_mode=WAL` only for file-backed databases (C4).
 *
 * Exported so a test can drive it against its own connection.
 */
export function applyPragmas(connection: SqliteConnection, dbPath: string): void {
  applyPragma(connection, PRAGMA_FOREIGN_KEYS_ON);
  applyPragma(connection, PRAGMA_BUSY_TIMEOUT);

  if (!isInMemoryDbPath(dbPath)) {
    applyPragma(connection, PRAGMA_JOURNAL_MODE_WAL);
  }
}

/** True when `dbPath` resolves to somewhere inside the repository working tree. */
export function isInRepositoryTree(dbPath: string): boolean {
  return resolve(dbPath).startsWith(REPOSITORY_ROOT);
}

/**
 * Case 23's tripwire, at the exact moment of violation.
 *
 * `hermetic-no-db-files.test.ts` scans the tree, so it only notices an in-tree
 * `.db` on the *next* file to run — or not at all, if the run ends first. This
 * throws instead, in the offending process, with a stack trace pointing at the
 * caller that supplied the path.
 *
 * **Test-time only.** It is a no-op unless `VITEST` is set, so the real
 * `./data/finance.db` that `npm run dev`, `db:migrate`, `db:seed` and `db:reset`
 * legitimately create is completely unaffected.
 */
function assertNotInRepositoryTree(dbPath: string): void {
  if (process.env[VITEST_ENV_VAR] === undefined) {
    return;
  }

  if (isInRepositoryTree(dbPath)) {
    throw new Error(`${IN_TREE_DB_FILE_MESSAGE}${MESSAGE_SEPARATOR}${resolve(dbPath)}`);
  }
}

/**
 * Open a **new** connection with the pragmas applied.
 *
 * `dbPath` is **required**: there is deliberately no `resolveDbPath()` default
 * here. A forgotten argument used to fall back to `DEFAULT_DB_PATH` and silently
 * `mkdirSync` a database into the repository, which is exactly the footgun case 23
 * exists to catch. The CLI entry points (`migrate`, `seed`, `reset`) resolve
 * `DB_PATH` themselves and pass it down, so the default lives in one place.
 *
 * Creates the parent directory for a file-backed path (`./data/finance.db` has no
 * `data/` directory in a fresh clone — `data/` is gitignored). May throw if the
 * path is unwritable; callers that must survive that use `ping()`.
 */
export function openConnection(dbPath: string): SqliteConnection {
  if (!isInMemoryDbPath(dbPath)) {
    assertNotInRepositoryTree(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const connection = new Database(dbPath);
  applyPragmas(connection, dbPath);
  return connection;
}

/**
 * Process-wide connection, created on first use. Deliberately NOT initialised at
 * module scope: importing this file must never open a database or throw (FR8).
 */
let sharedConnection: SqliteConnection | null = null;

/**
 * The lazily opened shared connection.
 *
 * @throws whatever `better-sqlite3` throws for an unreachable/unwritable path.
 * Nothing is cached on failure, so a later call retries. `ping()` is the
 * non-throwing wrapper the health repository uses.
 */
export function getConnection(dbPath: string): SqliteConnection {
  sharedConnection ??= openConnection(dbPath);
  return sharedConnection;
}

/** Close and forget the shared connection, if one was ever opened. */
export function closeConnection(): void {
  sharedConnection?.close();
  sharedConnection = null;
}

/**
 * Liveness probe for `/api/v1/health` — the home of the only `SELECT 1` (FR8).
 *
 * Returns a status instead of throwing so health can report
 * `db: "unavailable"` with 503 rather than crashing the request.
 */
export function ping(dbPath: string): boolean {
  try {
    getConnection(dbPath).prepare(SELECT_ONE_SQL).get();
    return true;
  } catch {
    return false;
  }
}
