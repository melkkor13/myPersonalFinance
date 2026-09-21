/**
 * drizzle-kit configuration — generates the SQL migrations in
 * `src/db/migrations/` from `src/db/schema.ts`.
 *
 * One of the five locations where SQLite specifics are allowed (FR3/B2).
 *
 * `dialect: 'sqlite'` is the current API; the legacy `driver: 'better-sqlite'`
 * form is gone in drizzle-kit 0.31. Generated artefacts (`*.sql`,
 * `meta/_journal.json`, `meta/*_snapshot.json`) are all committed — the migrator
 * reads `_journal.json` to order and identify migrations, so committing only the
 * `.sql` would silently break `db:migrate` (C9).
 *
 * Kept standalone on purpose: drizzle-kit loads this file through its own
 * bundler, so it must not depend on the app's module graph (and must not open a
 * native database connection).
 */
import { defineConfig } from 'drizzle-kit';

/** Mirrors `DEFAULT_DB_PATH` in `src/config.ts` (FR12). */
const DEFAULT_DB_PATH = './data/finance.db';
/** Drizzle dialect. Not `driver: 'better-sqlite'`, which is removed. */
const DIALECT = 'sqlite';
/** Single source of truth for the tables (FR9). */
const SCHEMA_PATH = './src/db/schema.ts';
/** Where the committed migrations live. */
const MIGRATIONS_OUT = './src/db/migrations';

export default defineConfig({
  dialect: DIALECT,
  schema: SCHEMA_PATH,
  out: MIGRATIONS_OUT,
  // Not required by `generate`; present only so `drizzle-kit studio` can connect.
  // Fixed to the default path rather than read from `DB_PATH`: this file is
  // bundled by drizzle-kit outside any tsconfig project, so it stays free of
  // `process`/Node typings. Runtime code resolves `DB_PATH` in `src/db/sqlite.ts`.
  dbCredentials: {
    url: DEFAULT_DB_PATH,
  },
});
