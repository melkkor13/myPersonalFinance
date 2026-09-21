# Task: @finance/contracts Package

## Status
COMPLETED

## Description
The single source of truth for all API request/response shapes, as Zod v4 schemas with
inferred types. All wire field names are snake_case (Q1).

## Inputs
- requirements.md § FR5, FR4, Q1, Q6, C5

## Steps
1. `packages/contracts/package.json` — name `@finance/contracts`, `"type": "module"`,
   dependency `zod@4.6.5`, exports map pointing at built or source entry.
2. `tsconfig.json` extending the base.
3. Define in `src/`:
   - `ErrorCode` enum: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `INTERNAL`, `NOT_FOUND`,
     `CONFLICT`, `SERVICE_UNAVAILABLE` — the last three defined but unreachable (FR5).
   - `ErrorResponse`: `{ error: { code, message, fields?: string[] } }`.
   - `HealthResponse`: `{ status: "ok"|"degraded", version: string, db: "ok"|"unavailable" }`.
   - `LoginRequest`: `{ email, password }`; `LoginResponse`: `{ access_token, refresh_token }`.
   - `RefreshRequest`: `{ refresh_token }`; `RefreshResponse`: `{ access_token, refresh_token }`.
   - `LogoutRequest`: `{ refresh_token }` (204, no response body).
   - `MeResponse`: `{ id, email, default_currency, created_at }` — **no password_hash**.
4. Export inferred types via `z.infer`.
5. Use Zod v4 idioms (`z.email()` not `z.string().email()`).
6. Error codes and route path strings as named constants, not inline literals.

## Expected Output
A typechecking package exporting all schemas + types.

## Verification
`npm run typecheck` passes. Every field name is snake_case.

## Dependencies
task02

## Execution Notes
- Files: `package.json`, `tsconfig.json`, `src/{constants,errors,health,auth,index}.ts`.
- `z.toJSONSchema` verified to emit `"$schema": "https://json-schema.org/draft/2020-12/schema"`
  on every schema — confirms C5 and the OpenAPI 3.1 path with no extra library.
- snake_case verified two ways: `grep -rE '"[a-z]+[A-Z]'` returns no matches, and the emitted
  JSON Schema `properties` keys are all snake_case. `password_hash` appears only in a doc comment.
- typecheck, eslint (`strictTypeChecked`), prettier all exit 0. `eslint.config.js` needed no
  change — `projectService: true` discovered the package tsconfig.
- Exports: `"types": "./src/index.ts"` + `"import": "./dist/index.js"`. Types resolve from
  source (no build-order dependency for `typecheck`), runtime resolves from built JS.

## Carry-forward constraint (affects task04, task10, task12, task13, task14)
**`@finance/contracts` must be BUILT before anything imports it at runtime.** Types come from
source but runtime comes from `dist/`, which is gitignored and absent on a fresh clone.
Therefore:
- Root `dev` script must build contracts first (or the API will fail to import at boot).
- `test`, `test:api`, `test:web` must depend on contracts being built.
- CI (task14) currently orders `typecheck → lint → test → build`; **`test` would fail on a cold
  clone** because `build` comes after it. Either add a contracts prebuild step or reorder.
  Flag resolved in task14.
