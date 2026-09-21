# Task: Health Module

## Status
COMPLETED

## Description
`GET /api/v1/health` through the full routes→service→repository chain, proving the layering
rule holds even for the trivial case.

## Inputs
- requirements.md § FR6, FR8 boot-failure policy, FR5 envelope exception

## Steps
1. `health.repository.ts` — wraps `ping()` from `db/sqlite.ts`. No raw SQL here.
2. `health.service.ts` — calls the repository, builds `HealthResponse`. Reads `version` from
   `apps/api/package.json`. **Must not import from `src/db/**`** (B3).
3. `health.routes.ts` — attaches the `HealthResponse` contract, returns 200 when `db` is `ok`
   and **503 when not**. Returns `HealthResponse` on **both** statuses, never `ErrorResponse`.
4. Status strings (`"ok"`, `"degraded"`, `"unavailable"`) as named constants.

## Expected Output
Health endpoint reflecting real DB reachability.

## Verification
With an unreachable DB the server still binds and health returns 503 `db: "unavailable"`.

## Dependencies
task07, task05

## Execution Notes
Files: `src/modules/health/{health.repository,health.service,health.routes}.ts`.
Modified `src/server.ts` — `app.register(healthModule)` placed **after** `registerOpenApi(app)`.

- `health.repository.ts` wraps `ping()`, returns a plain boolean, no raw SQL, no drizzle.
- `health.service.ts` imports only `@finance/contracts`, `../../config.js`, and the repository —
  **zero `../db/` imports** (B3 verified).
- `health.routes.ts` is a `FastifyPluginCallback` re-applying `withTypeProvider<ZodTypeProvider>()`
  per C8; declares **both** 200 and 503 as `HealthResponseSchema`.
- `health.routes.ts` imports `HTTP_STATUS_SERVICE_UNAVAILABLE` from `lib/errors.ts` rather than
  redeclaring 503. **Reviewed and accepted** — B1-B4 restrict only `drizzle-orm`, `src/db/**`,
  and SQLite specifics; importing a status constant from `lib/` is not a violation.

### Proofs (all PASS) — /private/tmp/.../scratchpad/task08-proofs.txt
1. Healthy DB → 200, exactly `{"status":"ok","version":"0.1.0","db":"ok"}`
2. `DB_PATH=/proc/definitely/not/writable/x.db` → 503,
   `{"status":"degraded","version":"0.1.0","db":"unavailable"}`, **no `error` key**;
   `buildServer()` still succeeded (acceptance case 13)
3. **`ping()` genuinely queries** — decisive method: three runs differing only in `DB_PATH`:
   (a) real migrated DB → `ok`; (b) unwritable path → `unavailable`; (c) **a readable file
   containing non-SQLite garbage bytes** → `unavailable`. (c) is the proof: the file opens fine,
   so only executing `SELECT 1` can fail ("file is not a database"); a constant-returning
   `ping()` could not distinguish (a) from (c).
4. OpenAPI: `/api/v1/health`'s **200 and 503 both** `$ref` `HealthResponse`, not `ErrorResponse`
5. Layering verified by actual import lines: routes→service→repository→`db/sqlite.js`
6. `buildServer()` binds no port; the only `.listen(` call site is `index.ts:36`

## Carry-forward for task10 (IMPORTANT — affects the test harness design)
**`db/sqlite.ts` caches a process-wide connection.** The task08 proofs had to run each DB_PATH
case in a **separate child process**, because one process reuses the live cached handle across
cases. Consequences for the API test suite:
- A per-test-file `:memory:` DB cannot be obtained just by changing `DB_PATH` mid-process.
- Either expose a reset/dispose hook on the cached connection, inject the connection, or rely on
  Vitest's `isolate: true` + `pool: 'forks'` so each test FILE is its own process (C12 already
  requires keeping isolation on — this makes it mandatory, not merely preferable).
- Tests that need two different DB states in one file must either reset the cache or be split
  across files. Decide this explicitly rather than discovering it through a flaky test.
