/**
 * Case 23 — the API suite is hermetic: no SQLite file is created anywhere in the
 * working tree.
 *
 * Every database in this suite is `:memory:`; the three tests that genuinely need
 * a file (migration idempotence, repeatable seed) put it under the OS temp
 * directory. This test is the in-suite tripwire for that policy: it scans the
 * whole repository, excluding dependency and build directories, and fails if a
 * `.db`, `.db-wal` or `.db-shm` file exists.
 *
 * The scan is complemented by the two tests at the bottom of this file, which
 * assert the *preventive* half of the policy: `openConnection()` refuses any
 * file-backed path inside the repository tree while `VITEST` is set, so a
 * violation throws in the offending process instead of being discovered later — or
 * not at all, if the run ends before the next scan. The second of the two is the
 * control proving the guard is scoped to the tree, not to files in general.
 *
 * It is a tripwire, not the whole proof. Vitest gives no ordering guarantee
 * across files, so a file created by a later suite would not be seen here — which
 * is why the task's acceptance procedure also runs `npm run test:api` **twice**
 * and then checks `git status` and a `find` from the outside. This test catches
 * the regression on the next run at the latest, and catches a leftover artifact
 * immediately.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DB_PATH } from '../src/config.js';
import {
  IN_TREE_DB_FILE_MESSAGE,
  isInRepositoryTree,
  openConnection,
  SHM_FILE_SUFFIX,
  WAL_FILE_SUFFIX,
} from '../src/db/sqlite.js';
import { createTempDatabasePath, removeTempDatabase } from './support/harness.js';

/** Repository root, resolved from this file rather than `process.cwd()`. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The SQLite database extension the project uses. */
const DB_FILE_EXTENSION = '.db';

/** Glob patterns `find` is asked to match. */
const DB_FILE_GLOBS = [
  `*${DB_FILE_EXTENSION}`,
  `*${DB_FILE_EXTENSION}${WAL_FILE_SUFFIX}`,
  `*${DB_FILE_EXTENSION}${SHM_FILE_SUFFIX}`,
] as const;

/** Directories that are not part of the working tree under test. */
const PRUNED_DIRECTORIES = ['node_modules', '.git', 'dist', 'coverage'] as const;

/** Every database-shaped file in the repository, one path per line. */
function findDatabaseArtifacts(): string[] {
  const pruneArgs = PRUNED_DIRECTORIES.flatMap((directory, index) => [
    ...(index === 0 ? [] : ['-o']),
    '-name',
    directory,
  ]);
  const nameArgs = DB_FILE_GLOBS.flatMap((glob, index) => [
    ...(index === 0 ? [] : ['-o']),
    '-name',
    glob,
  ]);

  const output = execFileSync(
    'find',
    [REPO_ROOT, '(', ...pruneArgs, ')', '-prune', '-o', '(', ...nameArgs, ')', '-print'],
    { encoding: 'utf8' },
  );

  return output.split('\n').filter((line) => line.length > 0);
}

describe('the API suite writes no database file to the working tree (case 23)', () => {
  it('finds no .db, .db-wal or .db-shm file anywhere in the repository', () => {
    expect(findDatabaseArtifacts()).toEqual([]);
  });
});

describe('opening an in-tree database file fails loudly instead of silently (case 23)', () => {
  it('refuses DEFAULT_DB_PATH under vitest, and creates neither the file nor its directory', () => {
    const resolved = resolve(DEFAULT_DB_PATH);
    const directoryExistedBefore = existsSync(dirname(resolved));
    expect(isInRepositoryTree(DEFAULT_DB_PATH)).toBe(true);

    expect(() => openConnection(DEFAULT_DB_PATH)).toThrow(IN_TREE_DB_FILE_MESSAGE);

    // Nothing was created: not the database, and not the `data/` directory the
    // old default-argument path used to `mkdirSync` on the way in.
    expect(existsSync(resolved)).toBe(false);
    expect(existsSync(dirname(resolved))).toBe(directoryExistedBefore);
  });

  it('still allows a file-backed database outside the tree, so the guard is not a blanket ban', () => {
    const tempDbPath = createTempDatabasePath();
    expect(isInRepositoryTree(tempDbPath)).toBe(false);

    const connection = openConnection(tempDbPath);
    try {
      expect(existsSync(tempDbPath)).toBe(true);
    } finally {
      connection.close();
      removeTempDatabase(tempDbPath);
    }
  });
});
