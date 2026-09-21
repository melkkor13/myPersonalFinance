/**
 * Cases 14, 17 and 18 — schema conventions and runtime constraint enforcement.
 *
 * ## Case 14 is VACUOUS TODAY, BY DESIGN — and deliberately not skipped
 * The scaffold has only `users` and `refresh_tokens`, neither of which holds
 * money, so there is currently no `_minor` column for the second assertion to
 * bite on. The test is written to **genuinely enumerate every column of every
 * table** via `PRAGMA table_info`, so the moment `accounts`/`transactions`/
 * `budgets` land (FR10) it starts enforcing ADR 0006 automatically with no edit
 * here. The "no REAL column anywhere" half already has real teeth today.
 *
 * ## Cases 17/18 are about the LIVE CONNECTION, not the DDL
 * SQLite honours `ON DELETE CASCADE` and `REFERENCES` only when
 * `PRAGMA foreign_keys` is on **for the connection issuing the statement**. A
 * schema-level assertion would pass with enforcement switched off, so these tests
 * read the live pragma and then prove the behaviour by attempting a violation.
 *
 * `test/**` is exempt from rule B2 (C16): the `PRAGMA` calls below are the point.
 */
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isoTimestamp,
  refreshTokens,
  REFRESH_TOKENS_TABLE,
  users,
  USERS_TABLE,
} from '../src/db/schema.js';
import { hashRefreshToken } from '../src/lib/tokens.js';
import {
  COLUMN_TYPE_INTEGER,
  COLUMN_TYPE_REAL,
  MONEY_COLUMN_SUFFIX,
  PRAGMA_FOREIGN_KEYS_QUERY,
  PRAGMA_TABLE_LIST_SQL,
  TEST_USER_CURRENCY,
} from './support/constants.js';
import { independentInMemoryDatabase, required, type TestDatabase } from './support/harness.js';

/** `PRAGMA table_info(<table>)` — the per-column metadata SQLite exposes. */
function tableInfoPragma(table: string): string {
  return `table_info(${table})`;
}

/** Shape of one `PRAGMA table_info` row. */
interface ColumnInfoRow {
  readonly name: string;
  readonly type: string;
}

/** Shape of one `PRAGMA foreign_keys` row. */
interface ForeignKeysRow {
  readonly foreign_keys: number;
}

interface TableNameRow {
  readonly name: string;
}

/** `PRAGMA foreign_keys` reports 1 when enforcement is on. */
const FOREIGN_KEYS_ENABLED = 1;

/** A `user_id` that is guaranteed not to exist in `users`. */
const ORPHAN_USER_ID = '00000000-0000-7000-8000-000000000000';

/** Fragment of SQLite's own FK rejection message. */
const FOREIGN_KEY_ERROR_FRAGMENT = 'FOREIGN KEY constraint failed';

/** Refresh-token values for the cascade fixture. */
const CASCADE_TOKEN_VALUES = ['cascade-token-one', 'cascade-token-two'] as const;

/** Fixture identities for the cascade test. */
const CASCADE_USER_EMAIL = 'cascade@example.com';
const SURVIVOR_USER_EMAIL = 'survivor@example.com';
const SURVIVOR_TOKEN_VALUE = 'survivor-token';

/** Placeholder hash: these fixtures never authenticate. */
const FIXTURE_PASSWORD_HASH = 'not-a-real-hash';

/** How far in the future the fixture tokens expire. */
const FIXTURE_TOKEN_TTL_MS = 3_600_000;

/**
 * Reads and the one delete below are raw SQL on purpose: `test/**` may use
 * SQLite specifics (C16), and keeping the ORM out of the test files means
 * rule B1's static scan can never be confused by a fixture. Naming the ORM package
 * is avoided here for the same reason.
 */
const COUNT_TOKENS_FOR_USER_SQL = `SELECT COUNT(*) AS total FROM ${REFRESH_TOKENS_TABLE} WHERE user_id = ?`;
const DELETE_USER_SQL = `DELETE FROM ${USERS_TABLE} WHERE id = ?`;

interface CountRow {
  readonly total: number;
}

let database: TestDatabase;

/** Every column of every table in the database, flattened. */
function allColumns(target: TestDatabase): { table: string; name: string; type: string }[] {
  const tables = target.connection
    .prepare(PRAGMA_TABLE_LIST_SQL)
    .all()
    .map((row) => (row as TableNameRow).name);

  return tables.flatMap((table) =>
    (target.connection.pragma(tableInfoPragma(table)) as ColumnInfoRow[]).map((column) => ({
      table,
      name: column.name,
      type: column.type.toUpperCase(),
    })),
  );
}

function insertFixtureUser(target: TestDatabase, id: string, email: string): void {
  target.db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: FIXTURE_PASSWORD_HASH,
      defaultCurrency: TEST_USER_CURRENCY,
      createdAt: isoTimestamp(),
    })
    .run();
}

function insertFixtureToken(target: TestDatabase, userId: string, token: string): void {
  target.db
    .insert(refreshTokens)
    .values({
      id: uuidv7(),
      userId,
      tokenHash: hashRefreshToken(token),
      expiresAt: isoTimestamp(new Date(Date.now() + FIXTURE_TOKEN_TTL_MS)),
      revokedAt: null,
      createdAt: isoTimestamp(),
    })
    .run();
}

beforeEach(() => {
  database = independentInMemoryDatabase();
});

afterEach(() => {
  database.connection.close();
});

describe('money-column convention (case 14 — currently vacuous, wired to bite)', () => {
  it('enumerates real columns, so the assertions below are not vacuous by accident', () => {
    const columns = allColumns(database);

    // If this ever drops to zero the two assertions below would pass for the
    // wrong reason, so the scan itself is asserted first.
    expect(columns.length).toBeGreaterThan(0);
  });

  it('has no REAL column in any table (ADR 0006 — money is never a float)', () => {
    const realColumns = allColumns(database).filter((column) => column.type === COLUMN_TYPE_REAL);

    expect(realColumns).toEqual([]);
  });

  it('types every _minor column as INTEGER (vacuous today: no such column exists yet)', () => {
    const moneyColumns = allColumns(database).filter((column) =>
      column.name.endsWith(MONEY_COLUMN_SUFFIX),
    );

    for (const column of moneyColumns) {
      expect(column.type).toBe(COLUMN_TYPE_INTEGER);
    }

    // Documents the vacuity explicitly rather than hiding it: the scaffold's two
    // auth tables hold no money. This expectation must be DELETED, not relaxed,
    // when the finance tables land.
    expect(moneyColumns).toEqual([]);
  });
});

describe('foreign keys are enforced on the live connection (case 17)', () => {
  it('reports PRAGMA foreign_keys as on for the connection in use', () => {
    const [row] = database.connection.pragma(PRAGMA_FOREIGN_KEYS_QUERY) as ForeignKeysRow[];

    expect(row?.foreign_keys).toBe(FOREIGN_KEYS_ENABLED);
  });

  it('rejects a refresh_tokens row whose user_id does not exist', () => {
    expect(() => {
      insertFixtureToken(database, ORPHAN_USER_ID, CASCADE_TOKEN_VALUES[0]);
    }).toThrow(FOREIGN_KEY_ERROR_FRAGMENT);
  });
});

describe('deleting a user cascades to their refresh tokens (case 18)', () => {
  it('removes every refresh_tokens row belonging to the deleted user', () => {
    const userId = uuidv7();
    const otherUserId = uuidv7();
    insertFixtureUser(database, userId, CASCADE_USER_EMAIL);
    insertFixtureUser(database, otherUserId, SURVIVOR_USER_EMAIL);
    for (const token of CASCADE_TOKEN_VALUES) {
      insertFixtureToken(database, userId, token);
    }
    insertFixtureToken(database, otherUserId, SURVIVOR_TOKEN_VALUE);

    expect(countTokensForUser(database, userId)).toBe(CASCADE_TOKEN_VALUES.length);

    database.connection.prepare(DELETE_USER_SQL).run(userId);

    expect(countTokensForUser(database, userId)).toBe(0);
    // The other user's token is untouched — the cascade is scoped, not a wipe.
    expect(countTokensForUser(database, otherUserId)).toBe(1);
  });
});

function countTokensForUser(target: TestDatabase, userId: string): number {
  const row = target.connection.prepare(COUNT_TOKENS_FOR_USER_SQL).get(userId);
  return required(row as CountRow | undefined, COUNT_TOKENS_FOR_USER_SQL).total;
}
