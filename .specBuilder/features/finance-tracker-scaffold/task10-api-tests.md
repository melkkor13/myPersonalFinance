# Task: API Test Suite

## Status
COMPLETED

## Description
Vitest suite covering the API-side acceptance cases via `fastify.inject()` against a real
in-memory SQLite DB.

## Inputs
- test-cases.md (authoritative), requirements.md § FR14, C10, C11, C12

## Steps
1. Vitest config for `apps/api`: `environment: 'node'`, `isolate: true` (C12).
2. `createTestDb()` helper — `new Database(':memory:')` per test file, synchronous `migrate()`
   with an absolute `migrationsFolder` (C10, C11). **No DB file written to disk at any point.**
3. Cover: config fail-fast (2), DB-unreachable degradation (3), migration idempotence (4),
   table inventory (5), money-column convention (6, vacuous), OpenAPI completeness and `$ref`s
   (8), dev-only Swagger UI (9), validation envelope (10), auth rejection of all four bad-token
   cases (11), happy-path login + `/me` with no `password_hash` (12), indistinguishable login
   failure (13), TTL enforcement (14), rotation + replay (15), logout revocation (17), expired
   refresh (18), hashed-only storage (19), Argon2id + zero-bcrypt grep (20), FK enforcement
   (21), cascade delete (22), hermetic reruns (28), no WAL on `:memory:` (29), repeatable seed
   (30), `INTERNAL` leaking nothing (32).
4. `money.ts` unit tests (7): round-trip the five specified values; assert `"1.005"` and
   non-numeric text are **rejected, not rounded**.
5. Test fixtures may use `PRAGMA` freely — `apps/api/test/**` is exempt from B2 (C16).

## Expected Output
Green suite, twice in a row, with no `.db`/`.db-wal`/`.db-shm` anywhere in the tree.

## Verification
`npm run test:api` twice; `git status` clean of DB artifacts.

## Dependencies
task08, task09

## Execution Notes
`apps/api/vitest.config.ts`, `apps/api/test/tsconfig.json`, and 16 test files + 2 support files
under `apps/api/test/`. **96 tests, 16 files, all passing — twice.**

### Results (actual)
```
npm run test:api        16 files / 96 tests passed   6.06s
npm run test:api (2nd)  16 files / 96 tests passed   5.86s
npm run typecheck       exit 0     npx eslint .   exit 0     prettier --check   clean
find for *.db/*.db-wal/*.db-shm   -> no output (clean tree)
```

### Trap 1 — connection isolation (no source edit needed)
`db/sqlite.ts` already exposed `closeConnection()`, re-exported as `closeDb()` from `client.ts`.
Two layers: (1) `pool: 'forks'` + `isolate: true` gives one process per test FILE — three files
depend on this because they deliberately poison the process (`health-degraded` must never prime
a connection, `error-envelope-internal` closes the live connection to force a real driver throw,
`db-pragmas`); (2) within a file, `freshInMemoryDatabase()` does
`closeDb()` → `getConnection(':memory:')` → `runMigrations(...)`, so `beforeEach` gets a clean DB
and the auth suites are per-test isolated rather than order-dependent.

### Trap 9 — contracts build: `pretest` step, not a Vitest alias
`pretest` = `npm run build -w @finance/contracts && npm run build`. An alias would only fix
resolution *inside* Vitest, but cases 3 and 29 spawn real `node dist/…` child processes that
resolve `@finance/contracts` through the real `exports` map and need `dist/` regardless.
Verified from a genuinely cold state (`rm -rf` both dist dirs).

### Non-source edits
- `apps/api/package.json`: added `pretest`; `typecheck` now also runs
  `tsc -p test/tsconfig.json --noEmit` (test files cannot join `apps/api/tsconfig.json` because
  of `rootDir: "src"`).
- `eslint.config.js`: one line — `apps/api/vitest.config.ts` added to `DEFAULT_PROJECT_FILES`,
  same precedent as `drizzle.config.ts`.
**No `src/**` file was changed — no test revealed a defect.**

### Mutation checks (anti-vacuity, the notable bit)
- Making `journal_mode=WAL` unconditional in `sqlite.ts` → `db-pragmas` fails 1/4 ✓
- Adding a source file containing the forbidden hash-library name → `db-seed` fails 1/4 ✓
Both reverted and re-verified green. Case 14 also carries an explicit anti-vacuity guard that
enumerates real columns, plus a comment naming the `toEqual([])` line to delete when the finance
tables land.

### Notable design wart found (not a defect, worth knowing)
`db/seed.ts` uses `createOwnedDb()`, which for `:memory:` opens a **second, unmigrated**
database — so `seed()` cannot be run against the shared in-memory DB at all. `db-seed.test.ts`
therefore uses a temp-dir file DB; every other suite inserts users via a harness fixture. Fine
in production (seed targets a file DB) but a trap for anyone writing future in-memory seed tests.

### Case coverage: all 27 required cases covered, none dropped
2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 29, 30, 31, 32, 33, 34, 35, 36.
Confirmed not attempted (out of scope for this task): 11, 12, 22, 24-28, 37, D1.
Case 7 asserts **refresh**-token rotation, not access-token difference (trap 2).
Case 20's grep is scoped to source/manifests and assembles the library name from two fragments
so the test cannot match itself.

## Post-hoc fix 1: cold-start flake in case 29 (boot-config.test.ts)
Reproduced by the orchestrator (run 1 of 6 failed): `exits non-zero, inside the 2s budget` took
**2128ms** against a 2000ms budget. The implementation was correct (warm exits 0.166-0.263s);
the test was measuring cold filesystem cache and vitest fork contention, not fail-fast behaviour.
CI performs exactly one cold run, so this would have been a red build.

**Fix, in two parts, with the 2000ms budget and every assertion unchanged:**
1. `boot-config.test.ts` — a file-level `beforeAll` performs ONE unmeasured throwaway
   `attemptBoot(TOO_SHORT_JWT_SECRET)` and discards it, paying the cold-start cost outside the
   timed window. File-level so the single warm-up covers both `describe.each` variants.
2. `apps/api/vitest.config.ts` — split into two projects via `test.projects` +
   `sequence.groupOrder` (vitest 5.0.1): project `api` (all tests except boot-config,
   `groupOrder: 0`) and project `api-timing` (boot-config only, `groupOrder: 1`). The timed
   spawn therefore runs on an idle machine. Both share `pool: 'forks'`, `isolate: true`,
   `environment: 'node'`, so the process-wide-connection invariants still hold.

**Result: worst case 379ms = 19% of budget** (was 1469ms = 73%). Spread collapsed from
296-1469ms to 349-379ms across 10 consecutive runs. Case A is no longer ~2x case B.
**Accepted cost: suite duration 5.2-5.4s → 6.9-7.3s (+1.8s, +33%)** — the intrinsic price of no
longer overlapping boot-config's five sequential child-process spawns with the rest of the suite.
Judged worth it to remove a CI flake.

Mutation re-verified after the change: a 3s delay before the config check → both timed cases
FAIL (`expected 3397 to be less than 2000`). Reverted; `src/**` byte-identical (26-file shasum
diff clean); 136 tests, 20 files.

## Post-hoc fix 2: case-23 DB-artifact leak — DIAGNOSIS CORRECTED
An agent reported `hermetic-no-db-files.test.ts` failing ~1 run in 8 with a real
`apps/api/data/finance.db` present, tracing it to a teardown race reaching the no-argument
fallbacks at `client.ts:39`/`:58` → `DEFAULT_DB_PATH`.

**That diagnosis was WRONG, and the root cause was orchestration, not code.**

Disproof: `openConnection()` is the sole `new Database()` call site, so nothing can create a
`.db` without passing through it. Instrumented to log path + stack + argv on any
non-`:memory:`, non-tmpdir open, then **16 full suites + 10 isolated `auth-access-token` runs**:
0 failures, 0 artifacts. At the reported 1/8 and 2/6 rates that batch had ~88% and ~98% chance of
a hit. The only file-backed opens logged were the deliberate
`/proc/definitely/not/writable/finance.db` from `health-degraded`, plus tmpdir paths.

Why it was unreachable: **the `dbPath === undefined` branches were dead code.** No call site in
`src/**` or `test/**` invoked `getDb`/`getConnection`/`openConnection`/`ping`/`createOwnedDb`
without an argument — every repository signature is `dbPath: string` (required), fed from the
validated `config.dbPath` (`:memory:` in tests). The described race could at worst reopen an
unmigrated `:memory:` DB, never create a file.

**Actual cause: the orchestrator ran two agents in parallel.** The documentation agent's
quickstart verification (`npm run dev`, `db:migrate`) wrote `apps/api/data/finance.db` — `.env`
sets `DB_PATH=./data/finance.db` and those scripts load it via `--env-file-if-exists` — while the
timing agent's test loops were scanning the tree. Same explanation for the stray `data/` the
documentation agent wrongly attributed to sandbox behaviour. **Lesson: do not run an agent that
boots the app concurrently with one that asserts on repo-tree cleanliness.**

### The footgun was still real and is now closed
- `src/db/sqlite.ts` — `openConnection`, `getConnection`, `ping` lost their `= resolveDbPath()`
  default parameters; `dbPath` is now **required**. Added a test-time-only tripwire:
  `openConnection()` throws `IN_TREE_DB_FILE_MESSAGE` if a file-backed path resolves inside the
  repo tree *and* `process.env.VITEST` is set. New constants `VITEST_ENV_VAR`,
  `IN_TREE_DB_FILE_MESSAGE`, `REPOSITORY_ROOT`, plus exported `isInRepositoryTree()`.
- `src/db/client.ts` — `createOwnedDb(dbPath: string)` and `getDb(dbPath: string)` now
  required-arg; both dead ternaries removed.
- `test/hermetic-no-db-files.test.ts` — 2 new tests: the guard refuses `DEFAULT_DB_PATH` and
  creates neither the file nor `data/`; a tmpdir path still opens (control, proving the guard is
  scoped to the tree, not to files generally). **136 → 138 tests**, none weakened or skipped.
- `applyMigrations`/`seed`/`reset` keep their `resolveDbPath()` defaults — the one intentional
  `DB_PATH` seam. The tests' `afterAll` was deliberately left alone: `disposeDatabase()` exists
  for Trap 1 and is already correctly ordered after `await app.close()`.

### Proof
Runtime guard, via a throwaway test doing the exact diagnosed late re-entry:
```
Error: Refusing to create a file-backed SQLite database inside the repository working tree
during a test run (case 23) — use :memory: or a path under the OS temp directory: .../apps/api/data/finance.db
  at assertNotInRepositoryTree (sqlite.ts:160) → openConnection (:179) → getConnection (:202) → getDb (client.ts:69)
```
No file and no `data/` created. Compile-time half: `error TS2554: Expected 1 arguments, but got 0`
x4 for all four functions.

26 consecutive full-suite runs (`data/` deleted before each, whole tree scanned after each):
**0 failures, 0 artifacts, 138/138 every run.** Isolated: `auth-access-token` 10 runs clean
(was 2/6), `auth-logout` 10 runs clean (was 1/6). Production quickstart re-verified: health 200
`{"status":"ok","version":"0.1.0","db":"ok"}`. typecheck / eslint / prettier clean.
