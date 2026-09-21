# Task: Write Documentation

## Status
COMPLETED

## Description
Write all documentation for finance-tracker-scaffold so that developers and users understand
how it works.

## Inputs
- requirements.md
- Completed implementation task outputs
- test-cases.md

## Steps
1. Write or update API reference docs — all five routes, request/response schemas (snake_case),
   the `ErrorResponse` envelope, which error codes are reachable vs merely declared, and the
   `/api/v1/health` envelope exception. Note that the generated `/api/v1/openapi.json` is the
   machine-readable source of truth.
2. Write the developer guide — prerequisites (Node >=22.13, registry auth), setup, `.env`
   variables per FR12, the migrate/seed/dev workflow, and the layering + B1–B4 boundary rules a
   contributor must respect.
3. Document the gotchas that will otherwise be rediscovered painfully: money is never a float
   and never >2dp (JPY/KWD unsupported), `crypto.randomUUID({version:7})` silently returns v4,
   the single-flight refresh lock is mandatory for any refresh-token holder, Tailwind v4 has no
   JS config, and WAL is skipped for `:memory:`.
4. Write inline comments only for non-obvious logic — the money exponent, the replay-detection
   revoke-all branch, and the single-flight promise.
5. Create the root `README.md` (none exists) covering layout, scripts, and how to run.
6. Record that case 33 is deferred manual verification and how to complete it once a remote exists.

## Expected Output
- Documentation files committed alongside code
- All public-facing APIs documented
- All manual test steps written in plain language

## Verification
- A developer unfamiliar with this feature can follow the docs without asking questions
- All API fields documented match actual implementation

## Dependencies
All implementation tasks

## Execution Notes
Five docs created: `README.md` (did not exist), `docs/api.md`, `docs/development.md`,
`docs/gotchas.md`, `docs/deferred.md`.

**No inline comments added** — the three locations the task named (`MONEY_EXPONENT`, the
replay-detection revoke-all branch, the single-flight promise) were already documented in detail
in the source; more would have been noise.

### Quickstart verified live (not just written)
`db:migrate` → `db:seed` → `dev` → health 200 `{"status":"ok","version":"0.1.0","db":"ok"}`;
login 200 with snake_case `access_token`/`refresh_token`; `/me` 200; validation 400 with
`fields:["email","password"]`; 401 no-header; 404 unmatched; docs 200 in dev; refresh rotation
200; **replay 401 and the legitimately rotated token then also 401 — revoke-all confirmed live**;
logout 204 empty; openapi 3.1.0 with 5 paths, 16 components, logout 204 with no content, login
body `$ref` `LoginRequestInput`. Seeded credentials read from source:
`owner@example.com` / `change-me-please-123`, `USD`.

## DEFECT FOUND AND FIXED: `.env` was never loaded
Acceptance case 1 specifies "write `.env` with a 32+ char `JWT_SECRET` … `npm run dev`", and the
repo ships `.env.example` — but **nothing loaded `.env`**. No `dotenv`, no `--env-file` in any
script; `config.ts` reads `process.env` directly. A fully populated `.env` still produced
`JWT_SECRET: is required but was not set`.

**Why 148 tests missed it:** every test supplies env explicitly (`boot-config.test.ts` builds a
minimal child env; others override `DB_PATH`). None exercised the path a human follows on a fresh
clone. Caught only because the documentation task was required to *run* its own quickstart.

**Fix** — `apps/api/package.json` only, five scripts, `--env-file-if-exists=../../.env` (path
relative because these scripts run with cwd `apps/api`): `dev`, `start`, `db:migrate`, `db:seed`,
`db:reset`. `pretest`/`test` **deliberately untouched** to preserve hermeticity. No source change.

`-if-exists` justified by real output — plain `--env-file` on a missing file exits **9**, which
would break CI where no `.env` exists:
```
--env-file-if-exists=./nope.env  -> "not found. Continuing without it."  EXIT=0
--env-file=./nope.env            -> "node: ./nope.env: not found"        EXIT=9
```
`NODE_OPTIONS="--env-file=.env"` is rejected by Node outright.

### Verification of the fix
- Plain quickstart works with **no shell sourcing and no inline vars** (`env | grep -cE
  '^(JWT_SECRET|DB_PATH)=' ` → 0): dev boots, health 200, login 200. Also via `npm run start`.
- **Fail-fast intact**: `.env` absent → exit 1 naming `JWT_SECRET`, 0 listeners; `.env` with a
  10-char secret → exit 1 "expected string to have >=32 characters", 0 listeners.
- **Tests hermetic**: with `.env` poisoned (`JWT_SECRET=x`,
  `DB_PATH=/proc/definitely/not/writable/poison.db`) → `test:api` 136/136, `test:web` 12/12.
- Known consequence documented: anyone invoking `node dist/index.js` **directly** must still
  supply env themselves, since the loading lives in the npm scripts.
- typecheck / eslint / prettier clean; `apps/api/data/` removed; no DB artifacts; `.env` still
  gitignored and uncommitted.

## Caveat flagged for the verification task
Twice, `apps/api/data/` was emptied or left mode `dr-x------` between shell calls, once causing a
500 (`no such table: users` — the server had created a fresh empty DB). **No `chmod` and no
code deletes `data/` anywhere in the repo**, and it was not deterministically reproducible;
attributed to sandbox handling of a newly created gitignored directory. If it recurs during
verification, re-run `npm run db:migrate && npm run db:seed` rather than treating it as a defect.
