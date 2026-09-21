/**
 * Cases 3 and 4 — the committed migrations are reproducible and idempotent, and
 * create **exactly** the two auth tables.
 *
 * Case 3's assertion is literally about exit codes, so the two runs are real
 * `node dist/db/migrate.js` child processes rather than in-process calls. That
 * needs a file-backed database, which lives in the **OS temp directory** — never
 * the repository tree (case 23). `dist/` is produced by the `pretest` step.
 *
 * `test/**` is exempt from rule B2 (C16), so reading `sqlite_master` directly
 * here is deliberate.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DRIZZLE_MIGRATIONS_TABLE,
  EXPECTED_TABLES,
  REFRESH_TOKENS_TABLE,
  USERS_TABLE,
} from '../src/db/schema.js';
import { DB_PATH_ENV_VAR } from '../src/db/sqlite.js';
import {
  EXIT_CODE_SUCCESS,
  FORBIDDEN_FINANCE_TABLES,
  PRAGMA_TABLE_LIST_SQL,
} from './support/constants.js';
import {
  createTempDatabasePath,
  independentInMemoryDatabase,
  openExistingDatabase,
  removeTempDatabase,
  required,
  type TestDatabase,
} from './support/harness.js';

/** The compiled migrate entry point, resolved relative to this file. */
const MIGRATE_SCRIPT = fileURLToPath(new URL('../dist/db/migrate.js', import.meta.url));

/** The same Node binary the suite runs under. */
const NODE_EXECUTABLE = process.execPath;

/** How many migrations drizzle has recorded as applied. */
const MIGRATION_COUNT_SQL = `SELECT COUNT(*) AS applied FROM ${DRIZZLE_MIGRATIONS_TABLE}`;

/** Table list in the order `PRAGMA_TABLE_LIST_SQL` returns (alphabetical). */
const SORTED_EXPECTED_TABLES = [...EXPECTED_TABLES].sort();

interface TableNameRow {
  readonly name: string;
}

interface MigrationCountRow {
  readonly applied: number;
}

let tempDbPath: string;

/**
 * Run the migrate CLI against the temp database.
 *
 * @returns the exit code. `execFileSync` throws on a non-zero exit, so a return
 * value at all means the process exited 0 — which is precisely case 3's claim.
 */
function runMigrateCli(): number {
  execFileSync(NODE_EXECUTABLE, [MIGRATE_SCRIPT], {
    env: { ...process.env, [DB_PATH_ENV_VAR]: tempDbPath },
    stdio: 'pipe',
  });
  return EXIT_CODE_SUCCESS;
}

/** Every user table in `database`, alphabetically. */
function tableNamesOf(database: TestDatabase): string[] {
  return database.connection
    .prepare(PRAGMA_TABLE_LIST_SQL)
    .all()
    .map((row) => (row as TableNameRow).name);
}

/** Read a fact from the temp file database, always closing the handle. */
function withTempDatabase<T>(read: (database: TestDatabase) => T): T {
  const database = openExistingDatabase(tempDbPath);
  try {
    return read(database);
  } finally {
    database.connection.close();
  }
}

/** Read a fact from a throwaway freshly migrated `:memory:` database. */
function withFreshMemoryDatabase<T>(read: (database: TestDatabase) => T): T {
  const database = independentInMemoryDatabase();
  try {
    return read(database);
  } finally {
    database.connection.close();
  }
}

beforeAll(() => {
  tempDbPath = createTempDatabasePath();
});

afterAll(() => {
  removeTempDatabase(tempDbPath);
});

describe('migrations are reproducible and idempotent (case 3)', () => {
  it('creates users and refresh_tokens on the first run and exits 0', () => {
    expect(runMigrateCli()).toBe(EXIT_CODE_SUCCESS);

    expect(withTempDatabase(tableNamesOf)).toEqual(SORTED_EXPECTED_TABLES);
  });

  it('applies nothing on the second run and still exits 0', () => {
    const appliedBefore = withTempDatabase(migrationCountOf);

    expect(runMigrateCli()).toBe(EXIT_CODE_SUCCESS);

    expect(withTempDatabase(migrationCountOf)).toBe(appliedBefore);
    expect(withTempDatabase(tableNamesOf)).toEqual(SORTED_EXPECTED_TABLES);
  });
});

describe('only the two auth tables exist (case 4, FR10)', () => {
  it('creates exactly users, refresh_tokens and __drizzle_migrations', () => {
    const names = withFreshMemoryDatabase(tableNamesOf);

    expect(names).toEqual(SORTED_EXPECTED_TABLES);
    expect(names).toContain(USERS_TABLE);
    expect(names).toContain(REFRESH_TOKENS_TABLE);
  });

  it('creates none of the deferred finance tables', () => {
    const names = new Set(withFreshMemoryDatabase(tableNamesOf));

    for (const forbidden of FORBIDDEN_FINANCE_TABLES) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});

function migrationCountOf(database: TestDatabase): number {
  const row = database.connection.prepare(MIGRATION_COUNT_SQL).get();
  return required(row as MigrationCountRow | undefined, MIGRATION_COUNT_SQL).applied;
}
