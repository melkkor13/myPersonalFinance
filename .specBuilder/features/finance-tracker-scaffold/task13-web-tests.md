# Task: Web Test Suite

## Status
COMPLETED

## Description
Vitest + Testing Library with MSW handlers typed from `@finance/contracts`.

## Inputs
- test-cases.md, requirements.md § FR14; ADR 0008

## Steps
1. Vitest + jsdom config for `apps/web`; MSW server setup.
2. **MSW handlers must import their types from `@finance/contracts`** (ADR 0008) so a contract
   change breaks the mocks too.
3. Case 16 — single-flight refresh: fire five concurrent requests with an expired access token;
   assert **exactly one** `POST /api/v1/auth/refresh` was issued (count MSW invocations), all
   five requests then succeed, and the user is not logged out.
4. Login form tests: success path renders the `/me` view; failure path renders an error message.
5. Case 27 is cross-cutting: renaming a contract field must fail `typecheck` in **both** apps —
   verified as a documented manual procedure in the verification task.

## Expected Output
Green web suite.

## Verification
`npm run test:web` passes.

## Dependencies
task12

## Execution Notes
Files under `apps/web/test/`: `support/{constants,handlers,server,setup,harness.tsx}`,
`api/{refresh-single-flight,token-storage,error-envelope}.test.ts`,
`routes/login-page.test.tsx`, `test/tsconfig.json`.
**12 web tests; API suite unchanged at 136. Total 148.**

Also edited: `apps/web/vitest.config.ts` (**removed `passWithNoTests`** so an empty suite can no
longer masquerade as success; added `setupFiles`, `restoreMocks`) and `apps/web/package.json`
`typecheck` → `tsc -p tsconfig.json --noEmit && tsc -p test/tsconfig.json --noEmit` (without it
the new `test/**` files sit outside every project and go unchecked by both tsc and typed ESLint).
**No `apps/web/src/**` edits** — `refresh.ts` verified byte-identical to its pre-mutation copy.

### ADR 0008 honoured
MSW handlers take paths from `ROUTES` and annotate every request/response with
`@finance/contracts` types, with bodies built from `ERROR_CODE`/`HEALTH_STATUS`/`DB_STATUS`.
snake_case throughout. So a contract rename breaks the mocks too — which is what makes case 28
meaningful.

### Module-level `inFlight` reset
`vi.resetModules()` + dynamic `import()` per test via `loadWebApp()`, which returns freshly
evaluated modules plus `routeTree`. Test files never statically import those modules (a static
import would be a different instance from the one under test). This also resets the second piece
of module state, the in-memory access token.

**Honest nuance recorded by the subagent:** with the *correct* implementation the lock always
settles to `null`, so cross-test bleed is invisible today. It was proven real by mutation — with
`.then` instead of `.finally` and the reset removed, the poisoned rejected promise leaks into the
next test, which then fails in 2ms without issuing a single request.

### Results (actual)
```
npm run test:web    4 files / 12 tests passed    1.06s
npm run test:api    20 files / 136 tests passed  (unchanged)
npm run test        136/136 then 12/12
typecheck clean (3 workspaces, both web projects) | eslint exit 0 | prettier clean
build -w @finance/web  283 modules, 416.21 kB gzip 130.22, 136ms
DB artifacts: zero, before and after both suites
```

### Case 22 mutation evidence (two mutations, both reverted)
1. Lock removed (`return performRefresh()` with no `inFlight` guard):
   `AssertionError: expected 5 to be 1` on `countOf(ROUTES.AUTH_REFRESH)` → 2 failed / 10 passed
2. **`.finally` → `.then`** (lock cleared only on success):
   `AssertionError: expected true to be false` on `isRefreshInFlight()` → 1 failed / 11 passed
   — this is the subtle poisoned-promise bug, caught by a dedicated test.

Case 22 asserts beyond `refreshCalls === 1`: all five `/me` calls resolve to the `MeResponse`
fixture, `/me` attempted exactly 10 times (5 x 401 + 5 replays), the rotated pair is stored,
`hasSession()` true (not logged out), and the lock released. Separate tests cover retry-once
(second 401 propagates as `ApiError` 401), consistent failure (all 5 reject with the same
`SessionExpiredError`, both tokens cleared), and lock release.

Case 37 queries by `role="alert"`, asserts the alert is visible with the API's real
`Authentication failed` text, the form is still mounted and the button enabled (no blank screen),
**zero unhandled rejections after a macrotask flush**, and that no refresh was attempted.

`countApiRequests()` counts via MSW's own `request:start` event, so unmatched requests count too;
`server.listen({ onUnhandledRequest: 'error' })` makes a stray request a failure rather than a
silent pass.
