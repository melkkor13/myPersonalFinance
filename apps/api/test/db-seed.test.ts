/**
 * Cases 9 and 20 — the seed is repeatable, and passwords are Argon2id only.
 *
 * `db/seed.ts` opens its own connection through `createOwnedDb()`. For
 * `:memory:` that would be a second, unmigrated database, so this suite is the
 * one place that uses a **file-backed** database — created under the OS temp
 * directory and deleted afterwards, never inside the repository tree (case 23).
 *
 * Case 20's repo-wide grep is deliberately **scoped to source files and
 * manifests**. An unscoped search matches the planning and ADR markdown that
 * *mandates* its absence, which would make the assertion permanently red for the
 * wrong reason.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { USERS_TABLE } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/migrate.js';
import { seed, SEED_USER_EMAIL, SEED_USER_PASSWORD } from '../src/db/seed.js';
import { ARGON2ID_HASH_PREFIX, isArgon2idHash } from '../src/lib/password.js';
import {
  createTempDatabasePath,
  openExistingDatabase,
  removeTempDatabase,
  required,
  type TestDatabase,
} from './support/harness.js';

/** Repository root, resolved from this file rather than `process.cwd()`. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The forbidden password-hashing library, assembled from two fragments.
 *
 * Written this way on purpose: if the name appeared as a single literal, the
 * scoped grep below would match **this file** and the test could never pass.
 */
const FORBIDDEN_HASH_LIBRARY = ['b', 'crypt'].join('');

/** File types the ban is enforced over: source and manifests only. */
const SCANNED_FILE_GLOBS = [
  '--include=*.ts',
  '--include=*.tsx',
  '--include=*.js',
  '--include=*.mjs',
  '--include=*.cjs',
  '--include=*.json',
  '--include=*.yml',
  '--include=*.yaml',
] as const;

/** Directories that are never anyone's source. */
const EXCLUDED_DIRECTORIES = [
  '--exclude-dir=node_modules',
  '--exclude-dir=dist',
  '--exclude-dir=coverage',
  '--exclude-dir=.git',
] as const;

/** `grep` exit code meaning "no lines selected" — the outcome case 20 wants. */
const GREP_EXIT_NO_MATCH = 1;

/** SQL the suite uses to inspect the seeded row (`test/**` is exempt from B2). */
const SELECT_SEED_USERS_SQL = `SELECT id, email, password_hash FROM ${USERS_TABLE} WHERE email = ?`;
const COUNT_USERS_SQL = `SELECT COUNT(*) AS total FROM ${USERS_TABLE}`;

interface SeedUserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
}

interface CountRow {
  readonly total: number;
}

let tempDbPath: string;

function openTempDatabase(): TestDatabase {
  return openExistingDatabase(tempDbPath);
}

function countUsers(): number {
  const database = openTempDatabase();
  try {
    const row = database.connection.prepare(COUNT_USERS_SQL).get();
    return required(row as CountRow | undefined, COUNT_USERS_SQL).total;
  } finally {
    database.connection.close();
  }
}

function readSeedUsers(): SeedUserRow[] {
  const database = openTempDatabase();
  try {
    return database.connection.prepare(SELECT_SEED_USERS_SQL).all(SEED_USER_EMAIL) as SeedUserRow[];
  } finally {
    database.connection.close();
  }
}

/** Lines matching the forbidden library, scoped to source files and manifests. */
function grepForForbiddenHashLibrary(): string {
  try {
    return execFileSync(
      'grep',
      ['-rIil', ...SCANNED_FILE_GLOBS, ...EXCLUDED_DIRECTORIES, FORBIDDEN_HASH_LIBRARY, REPO_ROOT],
      { encoding: 'utf8' },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === GREP_EXIT_NO_MATCH) {
      return '';
    }
    throw error;
  }
}

beforeAll(() => {
  tempDbPath = createTempDatabasePath();
  applyMigrations(tempDbPath);
});

afterAll(() => {
  removeTempDatabase(tempDbPath);
});

describe('seed is repeatable (case 9)', () => {
  it('creates exactly one user with the known email on the first run', async () => {
    const result = await seed(tempDbPath);

    expect(result.created).toBe(true);
    expect(result.email).toBe(SEED_USER_EMAIL);
    expect(countUsers()).toBe(1);
    expect(readSeedUsers()).toHaveLength(1);
  });

  it('creates no duplicate on the second run and reports it did nothing', async () => {
    const result = await seed(tempDbPath);

    expect(result.created).toBe(false);
    expect(countUsers()).toBe(1);
  });
});

describe('passwords are Argon2id only (case 20)', () => {
  it('stores an Argon2id PHC hash, not the plaintext', () => {
    const [user] = readSeedUsers();
    const seedUser = required(user, SELECT_SEED_USERS_SQL);

    expect(seedUser.password_hash.startsWith(ARGON2ID_HASH_PREFIX)).toBe(true);
    expect(isArgon2idHash(seedUser.password_hash)).toBe(true);
    expect(seedUser.password_hash).not.toContain(SEED_USER_PASSWORD);
  });

  it('has zero matches for the forbidden hash library in any source file or manifest', () => {
    expect(grepForForbiddenHashLibrary()).toBe('');
  });
});
