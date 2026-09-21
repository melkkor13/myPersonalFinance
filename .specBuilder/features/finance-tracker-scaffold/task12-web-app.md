# Task: Web App

## Status
COMPLETED

## Description
React 19 + Vite SPA rendering exactly two things: a login form, and a page showing `/me` plus
API health. Includes the mandatory single-flight refresh lock.

## Inputs
- requirements.md § FR11, FR7 single-flight, C13, C15; ADR 0007

## Steps
1. `apps/web/package.json` + `vite.config.ts` — `@vitejs/plugin-react@6` and
   `@tailwindcss/vite@4` in `plugins`. Dev server proxies `/api` to the API (so **no CORS**).
2. Tailwind v4: **no `tailwind.config.js`, no `postcss.config.js`, no autoprefixer** (C13).
   `src/index.css` is `@import "tailwindcss";` plus `@theme` customisation.
3. `src/api/` — fetch client typed **entirely from `@finance/contracts`**, reading snake_case
   fields (`access_token`, `refresh_token`).
4. `src/api/refresh.ts` — **single-flight lock**: on 401, the first caller performs the refresh
   and every concurrent caller awaits that same in-flight promise, then retries once. This is
   mandatory, not an optimisation — without it parallel expiries trip replay detection and
   self-logout.
5. Token storage: access token **in memory only**; refresh token in `localStorage`.
6. TanStack Router routes + TanStack Query. Login form, and a `/me` page showing email and
   health. Wrong credentials render an **error message**, not a blank screen or unhandled
   rejection.
7. Add shadcn/ui components only as these two screens need them.

## Expected Output
A working SPA against the real API.

## Verification
`npm run build` and `npm run typecheck` pass for `apps/web`.

## Dependencies
task09, task03

## Execution Notes
Created `apps/web/**`: package.json, tsconfig, vite.config.ts, vitest.config.ts, index.html,
`src/index.css` (Tailwind v4 entry), `src/main.tsx`, `src/api/{constants,errors,tokens,http,
refresh,client,endpoints,queries}.ts`, `src/auth/useSession.ts`,
`src/routes/{paths,router,RootLayout,LoginPage,MePage}`.

All types/paths from `@finance/contracts`. Wire fields read as `access_token`/`refresh_token`/
`default_currency`/`created_at` — **no casing conversion anywhere** (Q1 honoured).

### Single-flight lock
```ts
let inFlight: Promise<void> | null = null;
export function refreshAccessToken(): Promise<void> {
  inFlight ??= performRefresh().finally(() => { inFlight = null; });
  return inFlight;
}
```
- **Same-tick race:** read and write of `inFlight` occur in one synchronous step; the assignment
  completes before control returns to the event loop, so a same-tick second caller sees non-null
  and joins.
- **Clearing:** the stored promise IS the `.finally()` promise, so the lock resets on success
  *and* failure, before waiters resume — a failed refresh cannot poison later requests.
- **Retry once:** counter seeded from `RETRY_COUNT_AFTER_REFRESH = 1`; a second 401 propagates.
- **Consistent logout:** `performRefresh` catches → `clearTokens()` → rethrows
  `SessionExpiredError`, so all N waiters see the same state.
- `refresh.ts` uses `rawRequest`, never `apiRequest`, so the refresh route cannot recurse.
Verified 3/3 (throwaway vitest file, deleted — task13 owns `apps/web/test/`): 5 concurrent 401s →
`refreshCalls === 1`, all 5 resolve; second-401 → 1 refresh, 2 attempts, rejects; failed refresh
→ all 5 reject with `SessionExpiredError`, lock cleared, both tokens gone.

### Decisions
- **shadcn/ui NOT used** — plain Tailwind v4 utilities. shadcn would add `components.json`, CVA,
  `clsx`, `tailwind-merge` and Radix to render one form and one read-only panel.
- Contracts build ordering: `predev`/`prebuild`/`pretest` each run
  `npm run build -w @finance/contracts`, same pattern as `apps/api`'s `pretest`.
- Three packages added beyond the pinned list, all exact-pinned and genuinely required:
  `@types/react@19.3.0`, `@types/react-dom@19.3.0`, `jsdom@29.1.1`.

### Results
typecheck / eslint / prettier all PASS. `build -w @finance/web` PASS
(CSS 9.33 kB gzip 2.59, JS 416.21 kB gzip 130.22, 283 modules, 590ms).
`npm run test:api` still **136/136**. `test:web` exits 0 ("no test files", ready for task13).

### B4 now live and passing (9/9)
Title flipped from `apps/web/src ABSENT` to `apps/web/src present`; zero
`drizzle-orm`/`better-sqlite3`/`apps/api/src` imports. No test file was touched.

### Vite proxy proof (port 5173, no CORS)
- `GET /api/v1/health` via :5173 → `{"status":"ok","version":"0.1.0","db":"ok"}`, identical to :3000
- login via :5173 → keys `['access_token','refresh_token']`
- `/me` with bearer → real user row
- wrong password → `401 {"error":{"code":"UNAUTHENTICATED","message":"Authentication failed"}}`,
  which `LoginPage` renders in a `role="alert"` paragraph via `errorMessageOf`; uses `mutate`
  not `mutateAsync` so nothing floats (case 37 path confirmed at the API level)

## BLOCKER RAISED — mixed-registry package-lock.json
**The CodeArtifact token expired again mid-task.** `aws codeartifact login` also failed
(`UnrecognizedClientException` — AWS SSO creds need re-login). The subagent fell back to
`--registry=https://registry.npmjs.org/`, which succeeded with no peer warnings.

Consequence: `package-lock.json` now contains **362 CodeArtifact `resolved` URLs + 119
registry.npmjs.org ones**. A fresh `npm ci` would attempt the CodeArtifact URLs and fail with
E401 whenever the token is dead. This is the residual risk recorded in E1, now realised.
Needs a decision before task14 (CI runs `npm ci` per FR15).

## Note for the verification task
The dev DB seeded for the proxy proof tripped case 23's repo-wide scan, so `apps/api/data/` was
removed and the suite is back to 136/136. **Re-run `npm run db:migrate && npm run db:seed`
before browser verification.**

## BLOCKER RESOLVED (2026-09-21)
User chose **normalise to npmjs.org**. Actions taken by the orchestrator:
- Created a committed root `.npmrc` with `registry=https://registry.npmjs.org` and the rationale
  in comments.
- Deleted `node_modules` + `package-lock.json` (note: a zsh `nomatch` glob abort silently
  no-op'd the first `rm`, so the first "up to date in 624ms" install was a false success —
  re-done explicitly).
- Rebuilt: **0 CodeArtifact / 516 npmjs.org** URLs.
- **`npm ci` from a clean tree now exits 0** (it had never been run before — see the latent
  esbuild lockfile-sync bug recorded in requirements.md Q4).
- Re-verified on the rebuilt tree: typecheck clean, **136/136 tests**, all three workspaces build.
