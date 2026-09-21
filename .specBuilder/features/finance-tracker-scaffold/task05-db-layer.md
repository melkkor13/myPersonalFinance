# Task: Database Layer

## Status
COMPLETED

## Description
The only place SQLite knowledge is allowed to live (B2). Connection, PRAGMAs, Drizzle client,
schema, migrations, migrate runner, seed.

## Inputs
- requirements.md § FR8, FR9, FR16, FR3/B2, C4, C9, C10, C11; ADR 0005

## Steps
1. `src/db/sqlite.ts` — opens the `better-sqlite3` connection from `DB_PATH`. Applies
   `PRAGMA foreign_keys=ON` and `PRAGMA busy_timeout=5000` **unconditionally**; applies
   `PRAGMA journal_mode=WAL` **only when `DB_PATH !== ':memory:'`** (C4). Exports `ping()`
   containing the only raw `SELECT 1`. Must not throw at import time if the DB is unreachable —
   the boot-failure policy requires the server to still bind.
2. `src/db/client.ts` — the Drizzle instance over that connection (the only other file allowed
   to import `drizzle-orm/better-sqlite3`).
3. `src/db/schema.ts` — `users` and `refresh_tokens` exactly per FR9, including
   `CHECK(length(default_currency) = 3)` and `ON DELETE CASCADE`. **No other tables** (FR10).
4. `drizzle.config.ts` — `dialect: 'sqlite'`, `schema: './src/db/schema.ts'`,
   `out: './src/db/migrations'`.
5. Run `drizzle-kit generate`; **commit the `.sql` plus `meta/_journal.json` and
   `meta/*_snapshot.json`** (C9).
6. `src/db/migrate.ts` — programmatic migrate via `drizzle-orm/better-sqlite3/migrator`
   (synchronous, C10). `migrationsFolder` resolved to an **absolute path** via
   `new URL(..., import.meta.url)` (C11). Idempotent: re-running applies nothing, exits 0.
7. `src/db/seed.ts` — creates exactly one user, UUIDv7 id from `uuid`'s `v7()` (C2),
   Argon2id password hash, known email. **Repeatable**: second run creates no duplicate.
8. PRAGMA strings, table names, and the default currency as named constants.

## Expected Output
`npm run db:migrate` and `npm run db:seed` both work and are idempotent.

## Verification
After migrate, the table list is exactly `users`, `refresh_tokens`, `__drizzle_migrations`.

## Dependencies
task04

## Execution Notes
Files: `src/db/{sqlite,client,schema,migrate,seed,reset,cli}.ts`, `drizzle.config.ts`,
`src/db/migrations/0000_famous_brother_voodoo.sql` + `meta/_journal.json` + `meta/0000_snapshot.json`.
Modified: `apps/api/package.json` (build copy step, `db:reset`), `eslint.config.js` (one line).

### Key decisions
1. **Migrations-in-dist solved:** `build` = `tsc && node -e "cpSync('src/db/migrations','dist/db/migrations',{recursive:true})"`.
   `migrate.ts` resolves `new URL('./migrations/', import.meta.url)` (C11) — correct from both
   `src` (vitest) and `dist` (CLI). Verified the `.sql` and `meta/` land in `dist`.
2. **B2 kept clean:** `drizzle-orm/better-sqlite3/migrator` is imported in `client.ts` (a
   permitted location), re-exported as `runMigrations(db, folder)`; `createOwnedDb()` returns
   `{ db, close }` so CLI scripts never touch the driver. `grep -rlIE "better-sqlite3|PRAGMA"`
   over all `.ts` returns exactly `src/db/sqlite.ts` + `src/db/client.ts`.
3. **CLI scripts read `DB_PATH` directly** via `resolveDbPath()`, NOT `loadConfig()` — otherwise
   a valid 32-char `JWT_SECRET` would be a prerequisite for running a migration.
4. `eslint.config.js` now has `projectService: { allowDefaultProject: ['apps/api/drizzle.config.ts'] }`
   — that file cannot join `apps/api/tsconfig.json` (`rootDir: "src"`). Consequence:
   `drizzle.config.ts` has no Node typings, so `dbCredentials.url` is the fixed default path
   (studio-only) rather than read from `DB_PATH`.
5. `src/db/cli.ts` provides `isEntryPoint()`/`printLine()` so the three CLI scripts remain
   side-effect-free on import.

### Verification (actual)
- build / typecheck / eslint / prettier: all exit 0
- `db:migrate` twice: exit 0 both; `MIGRATION_ROWS: 1` (second applied nothing)
- `TABLES: ["__drizzle_migrations","refresh_tokens","users"]` — exactly, no finance tables
- `ANY_REAL_COLUMN: false`; all columns TEXT
- `FK_PRAGMA_LIVE: 1  BUSY: 5000  JOURNAL: wal`
- `FK_VIOLATION_REJECTED: true -> FOREIGN KEY constraint failed`
- `CURRENCY_CHECK_REJECTED: true -> CHECK constraint failed: default_currency_length_check`
- cascade: `TOKENS_BEFORE_DELETE: 1` → `TOKENS_AFTER_USER_DELETE: 0`
- seed twice: `USER_COUNT: 1`, `HASH_PREFIX_argon2id: true`, `ID_UUID_VERSION: 7`
- WAL conditional via pragma-recording stub:
  `:memory:` → `["foreign_keys = ON","busy_timeout = 5000"]`, WAL issued **false**;
  file path → adds `"journal_mode = WAL"`, WAL issued **true**
- Unreachable `DB_PATH` → `IMPORT_OK: true`, `PING_UNREACHABLE: false` — no throw at import (FR8)
- Working tree clean: no `*.db`/`-wal`/`-shm` outside `node_modules`

## Carry-forward for later tasks
- **task06 (`lib/password.ts`)**: `@node-rs/argon2` ships `Algorithm` as an **ambient const
  enum** (runtime export is `{}`), which `isolatedModules` forbids importing as a value. Pin it
  as a named constant `ARGON2ID_ALGORITHM = 2` instead of `Algorithm.Argon2id`. `seed.ts`
  already does this and should be refactored to call `lib/password.ts` once it exists.
- **task11 (boundary tests)**: match **import specifiers**, not bare text. Comments in
  `schema.ts`/`migrate.ts` that merely *mentioned* `PRAGMA`/`better-sqlite3` had to be reworded
  to avoid false positives — a naive text grep is fragile. Test the real thing: imports.
- **task10**: reuse `createOwnedDb()` / `runMigrations()` from `client.ts` for the per-file
  `:memory:` harness rather than importing the driver directly.
