/**
 * Case 15 — `journal_mode=WAL` is **never issued** for an in-memory database.
 *
 * ## Why this asserts on the CALL, not on the database state
 * SQLite silently no-ops `PRAGMA journal_mode=WAL` on `:memory:`: it does not
 * throw, and it answers `journal_mode: 'memory'`. So a test that only read the
 * resulting journal mode back would pass even if the pragma were issued
 * unconditionally — it would be vacuous.
 *
 * `db/sqlite.ts` routes every pragma through one private `applyPragma()` helper
 * precisely so this is observable: driving the exported `applyPragmas()` with a
 * stub connection that **records** every `pragma()` argument lets the test assert
 * the WAL statement is absent for `:memory:` and present for a file path.
 *
 * The file-path case uses a path that is never opened (no connection is created
 * at all), so nothing is written to disk anywhere (case 23).
 */
import { describe, expect, it } from 'vitest';

import { IN_MEMORY_DB_PATH } from '../src/config.js';
import {
  applyPragmas,
  isInMemoryDbPath,
  openConnection,
  PRAGMA_BUSY_TIMEOUT,
  PRAGMA_FOREIGN_KEYS_ON,
  PRAGMA_JOURNAL_MODE_WAL,
  type SqliteConnection,
} from '../src/db/sqlite.js';
import {
  JOURNAL_MODE_MEMORY,
  PRAGMA_JOURNAL_MODE_QUERY,
  STUB_FILE_DB_PATH,
} from './support/constants.js';

/** Shape of a `PRAGMA journal_mode` reply row. */
interface JournalModeRow {
  readonly journal_mode: string;
}

/**
 * The minimum surface `applyPragmas()` touches, with every statement recorded.
 *
 * Only `pragma()` is needed, so the stub is cast to the connection type rather
 * than implementing all of `better-sqlite3`'s API.
 */
function recordingConnection(): { statements: string[]; connection: SqliteConnection } {
  const statements: string[] = [];
  const stub = {
    pragma: (statement: string): unknown => {
      statements.push(statement);
      return [];
    },
  };
  return { statements, connection: stub as unknown as SqliteConnection };
}

describe('session pragmas (case 15)', () => {
  it('never issues journal_mode=WAL for :memory:', () => {
    const { statements, connection } = recordingConnection();

    applyPragmas(connection, IN_MEMORY_DB_PATH);

    expect(statements).toEqual([PRAGMA_FOREIGN_KEYS_ON, PRAGMA_BUSY_TIMEOUT]);
    expect(statements).not.toContain(PRAGMA_JOURNAL_MODE_WAL);
  });

  it('does issue journal_mode=WAL for a file-backed path', () => {
    const { statements, connection } = recordingConnection();

    applyPragmas(connection, STUB_FILE_DB_PATH);

    expect(statements).toEqual([
      PRAGMA_FOREIGN_KEYS_ON,
      PRAGMA_BUSY_TIMEOUT,
      PRAGMA_JOURNAL_MODE_WAL,
    ]);
  });

  it('classifies only the :memory: sentinel as in-memory', () => {
    expect(isInMemoryDbPath(IN_MEMORY_DB_PATH)).toBe(true);
    expect(isInMemoryDbPath(STUB_FILE_DB_PATH)).toBe(false);
  });

  it('leaves a real :memory: connection in journal_mode=memory, with no warning', () => {
    const connection = openConnection(IN_MEMORY_DB_PATH);

    try {
      const [row] = connection.pragma(PRAGMA_JOURNAL_MODE_QUERY) as JournalModeRow[];

      // Documents WHY the call-level assertions above are the real test: this
      // value would read `memory` whether or not WAL had been requested.
      expect(row?.journal_mode).toBe(JOURNAL_MODE_MEMORY);
    } finally {
      connection.close();
    }
  });
});
