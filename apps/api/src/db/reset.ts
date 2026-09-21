/**
 * `npm run db:reset` — delete the database file, then migrate from scratch.
 * (`apps/api`'s script chains `db:seed` afterwards.)
 *
 * Only the configured `DB_PATH` and its two SQLite sidecars (`-wal`, `-shm`) are
 * removed. Nothing else on disk is touched — in particular this does NOT delete
 * the `data/` directory, which may hold other files.
 *
 * A `:memory:` database has nothing to delete, so reset degrades to a plain
 * migrate.
 */
import { rmSync } from 'node:fs';

import { isEntryPoint, printLine } from './cli.js';
import { applyMigrations } from './migrate.js';
import { isInMemoryDbPath, resolveDbPath, SHM_FILE_SUFFIX, WAL_FILE_SUFFIX } from './sqlite.js';

/** CLI output. */
const RESET_DROP_MESSAGE = 'Deleted database file';
const RESET_IN_MEMORY_MESSAGE = 'In-memory database, nothing to delete';
const RESET_DONE_MESSAGE = 'Database reset';
const MESSAGE_SEPARATOR = ': ';

/** Remove `dbPath` plus its WAL/SHM sidecars. Missing files are not an error. */
export function dropDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', WAL_FILE_SUFFIX, SHM_FILE_SUFFIX]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Drop the database file (if any) and re-apply every migration. */
export function reset(dbPath: string = resolveDbPath()): void {
  if (isInMemoryDbPath(dbPath)) {
    printLine(RESET_IN_MEMORY_MESSAGE);
  } else {
    dropDatabaseFiles(dbPath);
    printLine(`${RESET_DROP_MESSAGE}${MESSAGE_SEPARATOR}${dbPath}`);
  }

  applyMigrations(dbPath);
  printLine(`${RESET_DONE_MESSAGE}${MESSAGE_SEPARATOR}${dbPath}`);
}

if (isEntryPoint(import.meta.url)) {
  reset();
}
