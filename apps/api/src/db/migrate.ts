/**
 * `npm run db:migrate` — applies the committed migrations in `src/db/migrations/`.
 *
 * ## Why the folder path is built from `import.meta.url` (C11)
 * Drizzle resolves a relative `migrationsFolder` against `process.cwd()`, which
 * differs between `npm run db:migrate` (cwd = `apps/api`) and `npm test` from the
 * repo root. Resolving against this module's own URL makes it correct from any cwd.
 *
 * ## Why `build` copies the migrations into `dist/`
 * `tsc` only emits `.ts` inputs, so the generated `.sql` and `meta/` files would
 * be missing from `dist/db/migrations` and `node dist/db/migrate.js` would apply
 * nothing. `apps/api`'s `build` script therefore copies `src/db/migrations` to
 * `dist/db/migrations` after compiling, which keeps this same
 * `./migrations/`-relative-to-me resolution correct in both `src` (vitest) and
 * `dist` (the CLI).
 *
 * Idempotent: drizzle records applied migrations in `__drizzle_migrations`, so a
 * second run applies nothing and exits 0.
 *
 * Migration is synchronous under the SQLite driver (C10) — there is nothing to
 * await. The driver-specific migrator import lives in `client.ts` to respect B2.
 */
import { fileURLToPath } from 'node:url';

import { createOwnedDb, runMigrations } from './client.js';
import { isEntryPoint, printLine } from './cli.js';
import { resolveDbPath } from './sqlite.js';

/** Migrations directory, relative to THIS module (C11). */
const MIGRATIONS_FOLDER_RELATIVE_URL = './migrations/';

/** CLI output. Named constants per the no-magic-strings rule. */
const MIGRATE_START_MESSAGE = 'Applying migrations';
const MIGRATE_DONE_MESSAGE = 'Migrations up to date';
const MESSAGE_SEPARATOR = ': ';

/** Absolute path to the committed migrations, valid from any working directory. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL(MIGRATIONS_FOLDER_RELATIVE_URL, import.meta.url),
);

/**
 * Apply every pending migration to `dbPath`, then close the connection.
 *
 * Opens its own short-lived connection rather than the shared one so the CLI
 * exits cleanly and never leaves a handle open for the server.
 */
export function applyMigrations(dbPath: string = resolveDbPath()): void {
  const owned = createOwnedDb(dbPath);
  try {
    runMigrations(owned.db, MIGRATIONS_FOLDER);
  } finally {
    owned.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  const dbPath = resolveDbPath();
  printLine(`${MIGRATE_START_MESSAGE}${MESSAGE_SEPARATOR}${dbPath}`);
  applyMigrations(dbPath);
  printLine(`${MIGRATE_DONE_MESSAGE}${MESSAGE_SEPARATOR}${dbPath}`);
}
