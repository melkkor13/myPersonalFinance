# Developer guide

Setup, architecture, conventions and testing. Read [gotchas.md](gotchas.md) as well — it holds
the things that will otherwise cost you an afternoon.

## Setup

See the quickstart in the [README](../README.md). Two points worth repeating:

- **Node >= 22.13.0** (not 22.0) — `eslint@10` requires `^22.13.0`.
- **`.env` is loaded by the npm scripts, not by the application.** `dev`, `start`, `db:migrate`,
  `db:seed` and `db:reset` in `apps/api/package.json` pass Node's
  `--env-file-if-exists=../../.env`. So `cp .env.example .env`, set `JWT_SECRET`, and
  `npm run dev` just works. The **test** scripts omit the flag on purpose, to keep the suites
  hermetic. Invoking `node dist/index.js` directly also bypasses it — see
  [gotchas.md](gotchas.md).

## Toolchain

| Tool                            | Version       | Why pinned                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                      | 6.0.3         | `typescript-eslint@8.70.0` peers `typescript >=4.8.4 <6.1.0`. TS 7 has no typescript-eslint support, so 6.0.3 is the newest version that keeps type-aware linting working with no `overrides` and no peer conflict (Q5). Revisit when typescript-eslint ships TS 7 support. |
| ESLint                          | 10.11.0       | flat config, `eslint.config.js`                                                                                                                                                                                                                                             |
| Vite / Vitest / plugin-react    | 8 / 5 / 6     | self-consistent set; mixing majors breaks                                                                                                                                                                                                                                   |
| Zod / fastify-type-provider-zod | 4.6.5 / 7.0.0 | Zod 4 is required for OpenAPI 3.1 (draft 2020-12)                                                                                                                                                                                                                           |
| better-sqlite3                  | 13.0.3        | N-API prebuilds inside the tarball; no node-gyp                                                                                                                                                                                                                             |
| @node-rs/argon2                 | 2.2.1         | prebuilds via optionalDependencies                                                                                                                                                                                                                                          |

All versions are exact-pinned, not ranged.

### `eslint.config.js` omits `@eslint/js` — known gap

The config extends only typescript-eslint's `strictTypeChecked` + `stylisticTypeChecked`. ESLint
**core** `recommended` rules are therefore absent; all linting comes from typescript-eslint's
presets (which do include the eslint-recommended adjustments for TypeScript, but not the core
recommended set itself).

The reason is environmental, not principled: `@eslint/js@10.11.0` 404'd on the CodeArtifact proxy
in use at build time (its metadata listed only up to 10.0.1). **Worth revisiting** — add
`@eslint/js` at an available version and extend `js.configs.recommended` first in the chain.

Type-aware linting uses `projectService: true`. Two tooling files sit outside every workspace
`tsconfig.json` `include` (because `apps/api/tsconfig.json` sets `rootDir: "src"`) and are
listed in `allowDefaultProject`: `apps/api/drizzle.config.ts` and `apps/api/vitest.config.ts`.
A consequence: `drizzle.config.ts` has no Node typings, so its `dbCredentials.url` is the fixed
default path (used by `drizzle-kit studio` only) rather than read from `DB_PATH`.

---

## Architecture

### `routes → service → repository`

One direction only. Each layer has a hard job description (FR2):

| Layer          | File pattern      | May do                                                                                                                   | May NOT do                                                                               |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **routes**     | `*.routes.ts`     | HTTP only: attach contract schemas, call the service, choose a status code, return its value                             | business logic, SQL, any DB access                                                       |
| **service**    | `*.service.ts`    | business rules; throw typed domain errors from `lib/errors.ts`                                                           | import anything from `src/db/**`, import Fastify, import Drizzle, know HTTP status codes |
| **repository** | `*.repository.ts` | own the DB access; return plain domain objects; own minor-unit ⇄ decimal-string conversion and `_minor` suffix stripping | leak Drizzle types or rows upward                                                        |

Two supporting rules that follow from this:

- Services throw domain errors and know nothing about status codes. `plugins/errorHandler.ts` is
  the single place a domain error becomes an HTTP status and an `ErrorResponse`.
- Raw SQL is allowed only in `db/sqlite.ts` and `db/migrations/**`. Health's `SELECT 1` lives
  inside `ping()` for that reason.

Deliberately permitted and easy to mistake for a violation: `health.repository.ts` imports
`../../db/sqlite.js`. That is a repository importing the db layer, which is its whole purpose.
B3 constrains _services_, not repositories.

Plugins (`errorHandler`, `authenticate`, `openapi`) are applied as **plain functions taking the
root instance**, not via `app.register()`. `setErrorHandler` / `setNotFoundHandler` bind to the
encapsulation context they are called in, so a non-`fastify-plugin` wrapper would cover only its
own child context and miss sibling module routes — and `fastify-plugin` is not a declared
dependency.

Module plugins **must be registered after `registerOpenApi(app)`**. `@fastify/swagger` collects
the route table through an `onRoute` hook, which only sees routes added after it; register
earlier and your routes are silently missing from the OpenAPI document.

### Import boundary rules B1–B4

These are not conventions. Each one has its own Vitest file, and each will fail CI.

| Rule   | Statement                                                                                                                                                                                                                                                                                                                                | Test file                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **B1** | `drizzle-orm` may be imported **only** in `*.repository.ts` and `apps/api/src/db/**`. Never in `*.routes.ts`, `*.service.ts`, `plugins/**`.                                                                                                                                                                                              | `apps/api/test/boundary-b1-drizzle-orm.test.ts`      |
| **B2** | SQLite specifics (`better-sqlite3`, `drizzle-orm/better-sqlite3`, and `PRAGMA` in executable SQL) may appear **only** in `src/db/sqlite.ts`, `src/db/client.ts`, `src/db/migrations/**`, `drizzle.config.ts`, `apps/api/package.json`. **`apps/api/test/**` is exempt** — test files legitimately issue `PRAGMA` to assert schema facts. | `apps/api/test/boundary-b2-sqlite-specifics.test.ts` |
| **B3** | No `*.service.ts` may import anything from `src/db/**` — including `health.service.ts`.                                                                                                                                                                                                                                                  | `apps/api/test/boundary-b3-service-db.test.ts`       |
| **B4** | `apps/web/src` may not import `drizzle-orm`, `better-sqlite3`, or anything from `apps/api/src`.                                                                                                                                                                                                                                          | `apps/api/test/boundary-b4-web-isolation.test.ts`    |

The point of B1/B2 is that SQLite knowledge stays in a handful of files, so a Postgres move is a
migration rather than a rewrite ([ADR 0005](adr/0005-drizzle-orm-over-better-sqlite3.md)).

**Implementation: TypeScript AST analysis, not grep.** `apps/api/test/support/imports.ts` parses
each file with `ts.createSourceFile` (parse-only — no program, no type checker) and collects
four import forms: `ImportDeclaration`, `ExportDeclaration` (re-export), `ImportEqualsDeclaration`,
and `CallExpression` for `require()` and dynamic `import()`. This matters because a text grep
false-positives on any comment that merely _mentions_ `PRAGMA` or `better-sqlite3` — two earlier
tasks had to reword prose to keep a regex scan green, which is exactly the wrong tail wagging the
dog. B3/B4 additionally _resolve_ relative specifiers to repo-relative paths, so
`../../db/nested/deeper/x.js` is caught as surely as `../../db/client.js`.

B2's `PRAGMA` rule is the one non-import check: a string/template-literal scan, so `PRAGMA` in a
comment stays legal while `PRAGMA` in executable SQL is caught.

Each rule file also carries a self-check (test case 38) that feeds synthetic known-bad source
strings through the same extractor — bare import, subpath import, dynamic `import()`,
`require()`, deep relative path — and asserts each is flagged, plus an innocent fixture (a prose
comment and a string merely naming the package) that must **not** be flagged. Plus non-vacuity
guards asserting the scan found a non-empty file set. That last guard earned its keep: a wrong
`REPO_ROOT` (`../../../` instead of `../../../../`) once made every scan find zero files and pass
vacuously, and the guard caught it.

### Conventions

- **No magic literals.** Route paths, status values, error codes and validation bounds are named
  constants in `packages/contracts/src/constants.ts` and imported everywhere. A path cannot drift
  between the router, the OpenAPI document and the web client.
- **snake_case on the wire, snake_case in the DB.** No case conversion at any layer (Q1).
- **Money columns** are `INTEGER`, suffixed `_minor`. Money on the wire is a decimal **string**.
  Never a float, never a JSON number.
- **IDs** are UUIDv7 strings in `TEXT` columns. Timestamps are ISO-8601 UTC strings in `TEXT`.
- **ESM throughout**, `"type": "module"` in every package. `uuid@14` is ESM-only, which settled it.
- **`strict: true`** plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules`, `noEmitOnError`. See `tsconfig.base.json`.

### Database schema

Created by the scaffold (`apps/api/src/db/schema.ts`, migration
`src/db/migrations/0000_famous_brother_voodoo.sql`):

- `users` — `id` TEXT PK, `email` TEXT UNIQUE NOT NULL, `password_hash` TEXT NOT NULL,
  `default_currency` TEXT NOT NULL CHECK(length = 3), `created_at` TEXT NOT NULL
- `refresh_tokens` — `id` TEXT PK, `user_id` TEXT NOT NULL REFERENCES `users(id)` ON DELETE
  CASCADE, `token_hash` TEXT UNIQUE NOT NULL, `expires_at` TEXT NOT NULL, `revoked_at` TEXT NULL,
  `created_at` TEXT NOT NULL
- `__drizzle_migrations` — managed by drizzle-kit

Nothing else. A test asserts the table list is **exactly** these three.

Session pragmas applied by `db/sqlite.ts`: `foreign_keys=ON` and `busy_timeout=5000`
unconditionally, `journal_mode=WAL` **only for file-backed databases**.

Adding a migration: edit `src/db/schema.ts`, run `npm run db:generate`, then commit the generated
`.sql` **and** `src/db/migrations/meta/_journal.json` **and** `meta/*_snapshot.json`. The migrator
reads `_journal.json` to order migrations, so committing only the `.sql` breaks `db:migrate`. The
`.gitignore` carries a comment warning against ever adding a `meta/` or `*.json` ignore.

---

## Configuration

`apps/api/src/config.ts`, Zod-validated at boot. Per FR12:

| Variable            | Default             | Notes                                                                                                                                                |
| ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`              | `3000`              | 1–65535                                                                                                                                              |
| `NODE_ENV`          | `development`       | `development` \| `test` \| `production`. Controls whether Swagger UI exists.                                                                         |
| `DB_PATH`           | `./data/finance.db` | Relative to the process cwd. `npm run db:migrate` runs with cwd `apps/api`, so the default file is `apps/api/data/finance.db`. Tests use `:memory:`. |
| `JWT_SECRET`        | **none — required** | min 32 chars. HS256 signing key.                                                                                                                     |
| `ACCESS_TOKEN_TTL`  | `15m`               |                                                                                                                                                      |
| `REFRESH_TOKEN_TTL` | `30d`               |                                                                                                                                                      |
| `LOG_LEVEL`         | `info`              | Pino level                                                                                                                                           |

`version` in `HealthResponse` is read from `apps/api/package.json` at boot via
`new URL('../package.json', import.meta.url)` — correct from both `src/` and `dist/` — and is
not an env var.

There is deliberately **no module-level config singleton**. Importing `config.ts` has no side
effects; `loadConfig()` is called only by `index.ts`, which hands the result to `buildServer()`,
which decorates the instance with it. `server.ts` imports the config **type-only**, so it has
zero runtime env dependency and stays a pure factory that binds no port. Empty-string env vars
are treated as unset, so `JWT_SECRET=` reports "required" rather than "too short".

### Boot-failure policy

The two halves of this are intentionally different, and both are tested.

**Invalid config is FATAL.** `loadConfig()` throws, `index.ts` exits non-zero, and **no port is
bound**. The message always names the offending variable:

```
Invalid environment configuration:
  - JWT_SECRET: is required but was not set
```

```
Invalid environment configuration:
  - JWT_SECRET: Too small: expected string to have >=32 characters
```

Measured 0.166 s and 0.263 s respectively, with `lsof -iTCP:3000 -sTCP:LISTEN` empty in both
cases.

**An unreachable database is NOT fatal.** Nothing in `config.ts` opens or validates the DB;
`DB_PATH` is carried as an opaque string. The server still binds, and
`GET /api/v1/health` reports 503 with `{"status":"degraded","version":"0.1.0","db":"unavailable"}`.
The rationale: a database blip should degrade the service, not prevent it from starting and
reporting _why_ it is degraded.

---

## Testing

Vitest everywhere.

```bash
npm run test          # both suites: 138 API + 12 web = 150
npm run test:api      # 20 files, 138 tests
npm run test:web      # 4 files, 12 tests
```

Full local CI gate, in the order `.github/workflows/ci.yml` uses:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

### API suite

- `fastify.inject()` against a **real** `:memory:` SQLite database, freshly migrated per test
  file. No mocked DB, no fake repository.
- **No DB file is written to disk at any point.** The three tests that genuinely need a
  file-backed database (migration idempotence, repeatable seed) create it under the OS temp
  directory via `createTempDatabasePath()` and delete it afterwards — never inside the repo tree.
  A dedicated test (`hermetic-no-db-files.test.ts`) scans the working tree for `.db`, `.db-wal`
  and `.db-shm` artifacts.
- `pool: 'forks'` + `isolate: true` gives **one process per test file**. This is mandatory, not
  stylistic: `db/sqlite.ts` caches a process-wide connection, so a test cannot get a different
  database just by changing `DB_PATH`. Three files deliberately poison their process
  (`health-degraded` must never prime a connection; `error-envelope-internal` closes the live
  connection to force a real driver throw; `db-pragmas` spies on pragma calls) and rely on this.
  Never switch to `pool: 'threads'` or `isolate: false`.
- Within a file, `freshInMemoryDatabase()` in `test/support/harness.ts` does
  `closeDb()` → `getConnection(':memory:')` → `runMigrations(...)`. That is the only supported
  way to get a clean database mid-file.
- `boot-config.test.ts` runs in its own later project group (`sequence.groupOrder: 1`). Its
  assertions are wall-clock budgets (config must fail in under 2 s), and running it alongside 19
  other forks turned a ~0.3 s spawn into ~1.5 s from pure CPU contention. The budget is
  unchanged; only the measurement noise was removed.
- `pretest` runs `npm run build -w @finance/contracts && npm run build`. A Vitest alias would not
  be enough: two tests spawn real `node dist/...` child processes that resolve
  `@finance/contracts` through its real `exports` map and need `dist/`.

### Web suite

- Vitest + Testing Library + jsdom, network mocked with **MSW**, handlers typed by
  `@finance/contracts` and taking their paths from `ROUTES`. So renaming a contract field breaks
  the mocks too, which is what makes contract enforcement meaningful.
- `server.listen({ onUnhandledRequest: 'error' })`, so a stray request is a test failure rather
  than a silent pass. Request counting goes through MSW's own `request:start` event, so unmatched
  requests are counted too.
- Module-level state (`inFlight` in `refresh.ts`, the in-memory access token) is reset per test
  via `vi.resetModules()` + a dynamic `import()` helper. Test files never statically import those
  modules — a static import would be a _different_ instance from the one under test.
- `passWithNoTests` was deliberately **removed** from `apps/web/vitest.config.ts` so an empty
  suite can never masquerade as success.

### Boundary tests

Four files, one per rule, so a failure names the violated rule directly. See B1–B4 above.

### Tests are checked for teeth, not just for passing

Where a test could pass vacuously, it carries an explicit guard or a recorded mutation check:

- Making `journal_mode=WAL` unconditional makes `db-pragmas` fail.
- Removing the single-flight lock makes the web suite fail with `expected 5 to be 1`.
- Changing `.finally` to `.then` in `refresh.ts` makes a dedicated lock-release test fail.
- Adding a violating import makes the corresponding B1–B4 test fail.

If you change one of these behaviours and no test goes red, the test has rotted — fix the test.
