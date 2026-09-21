# Requirements: finance-tracker-scaffold

## Approval Status
requirements_approved: true
plan_approved: true
test_cases_approved: true

## Source
- Spec: `think/finance-tracker-scaffold.md` (all 9 decisions Accepted)
- ADRs: `docs/adr/0001` … `docs/adr/0009`
- Repo state at intake: **empty** — only `docs/adr/` and `think/` exist. No code, not a git repo.

## Problem Restatement

Build the *scaffold* for a personal finance tracker: repo layout, runtime choices, data-access
layer, API contract conventions, auth, and test harness. No finance entity (accounts,
transactions, categories, budgets) is wired end to end. The scaffold proves config, DB
connection, migrations, auth, error handling, contracts, tests, and CI — plus
`GET /api/v1/health`.

Four things must be right first time because they are expensive to change later:
1. The Node backend is a **standalone API** — no browser assumptions, versioned, self-describing.
2. **Money is never a float.**
3. **SQLite today, Postgres plausible later** — engine knowledge confined to few modules.
4. **Auth exists before the routes do.**

## Confirmed Scope

| # | Decision |
|---|---|
| S1 | Auth in scope now — login/refresh/logout, JWT access + DB-backed revocable refresh token. |
| S2 | Single user now, cloud-hosted later. Schema carries `user_id` from day one. Postgres stays a migration, not a rewrite. |
| S3 | Mobile client undecided, possibly never. Do not optimise frontend for native code sharing. Keep API language-neutral. |
| S4 | Scaffold slice = health check + auth only. |

## Functional Requirements

### FR1 — Repo shape (npm workspaces monorepo, ADR 0002)
- Root `package.json` (workspaces), `tsconfig.base.json`, `.github/workflows/ci.yml`
- `apps/api` — Fastify + TypeScript HTTP API
- `apps/web` — React 19 + Vite SPA
- `packages/contracts` — `@finance/contracts`, Zod schemas + inferred types
- `docs/adr/`, `think/` (already present)

### FR2 — Layer rules (`routes → service → repository`)
- **routes** — HTTP only: attach contract schemas, call service, return its value. No business logic, no SQL.
- **service** — business rules; throws typed domain errors; imports nothing from `src/db/**`, no Fastify, no Drizzle.
- **repository** — returns plain domain objects; owns snake_case↔camelCase mapping and minor-unit↔decimal-string conversion.

### FR3 — Import boundary rules (each asserted by its own test)
| # | Rule |
|---|---|
| B1 | `drizzle-orm` only in `*.repository.ts` and `apps/api/src/db/**`. Never in `*.routes.ts`, `*.service.ts`, `plugins/**`. |
| B2 | SQLite specifics (`better-sqlite3`, `drizzle-orm/better-sqlite3`, `PRAGMA`) only in `src/db/sqlite.ts`, `src/db/client.ts`, `src/db/migrations/**`, `drizzle.config.ts`, `apps/api/package.json`. **`apps/api/test/**` exempt.** |
| B3 | No `src/modules/**/*.service.ts` imports from `src/db/**`. |
| B4 | `apps/web/src` may not import `drizzle-orm`, `better-sqlite3`, or `apps/api/src`. |

### FR4 — Naming conventions
| Layer | Convention | Example |
|---|---|---|
| DB columns | `snake_case` | `opening_balance_minor` |
| JSON request/response fields | `snake_case` (**RESOLVED Q1 — overrides spec/ADR 0008**) | `opening_balance` |
| Money columns | integer, suffix `_minor` | `amount_minor` |
| Money in JSON | decimal **string**, never a number | `"1234.56"` |

Money mapping is a deliberate exception to plain passthrough: the `_minor` suffix is
*dropped* on the way out, and the value changes representation.
`opening_balance_minor: 123456` (INTEGER) ⇄ `opening_balance: "1234.56"` (decimal string).

Concrete consequence for the scaffold's own routes: the login/refresh responses carry
`access_token` and `refresh_token`, **not** `accessToken`/`refreshToken`. The repository layer
still owns the mapping — it is now a minor-unit/decimal conversion plus `_minor`-suffix
stripping, with no case conversion, since DB and wire now share `snake_case`.
Minor units are **hardcoded to exponent 2** (hundredths) in `lib/money.ts`; >2dp input is
rejected, not rounded. JPY/KWD are therefore unsupported — accepted limitation under A2.

### FR5 — API contract (ADR 0004, 0008)
- REST/JSON under `/api/v1/*`.
- Every API route's request and response bodies have a Zod schema in `@finance/contracts`.
  Two exemptions: the meta routes; and `204 No Content` (only `POST /api/v1/auth/logout`).
- OpenAPI 3.1 at `GET /api/v1/openapi.json`; Swagger UI at `GET /api/v1/docs` **dev only**.
- Uniform error envelope `ErrorResponse`:
  `{ "error": { "code": "VALIDATION_ERROR", "message": "…", "fields": ["email","password"] } }`
  `fields` present only for `VALIDATION_ERROR`.
- Reachable codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `INTERNAL` (500).
- Defined but unreachable in scaffold: `NOT_FOUND` (404), `CONFLICT` (409), `SERVICE_UNAVAILABLE` (503).
- **One envelope exception:** `/api/v1/health` returns `HealthResponse` on both 200 and 503.

### FR6 — Routes (five API + two meta)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | none | `{ status: "ok"\|"degraded", version, db: "ok"\|"unavailable" }`; full chain routes→service→repository→`ping()`; 200 when db ok, 503 when not |
| POST | `/api/v1/auth/login` | none | email + password → access + refresh token |
| POST | `/api/v1/auth/refresh` | refresh token | rotates: new access + new refresh, revokes presented |
| POST | `/api/v1/auth/logout` | refresh token | revokes presented refresh token; 204 |
| GET | `/api/v1/me` | access token | authenticated user; the one protected route |
| GET | `/api/v1/openapi.json` | none | meta, contracts-exempt |
| GET | `/api/v1/docs` | none | meta, dev only |

### FR7 — Auth (ADR 0001)
- **Access token:** JWT, HS256, `JWT_SECRET`, **15-min TTL** (configurable via `ACCESS_TOKEN_TTL`).
  Claims: `sub`, `iat`, `exp`. Sent as `Authorization: Bearer <token>`.
- **Refresh token:** 32 bytes CSPRNG, base64url, 30-day TTL. Only SHA-256 hash stored in
  `refresh_tokens`. Rotated on every use. Presenting an already-rotated token = compromise →
  revoke **every** refresh token for that user.
- **Single-flight refresh (mandatory client requirement):** `apps/web/src/api/refresh.ts`
  serialises refreshes — first caller refreshes, concurrent callers await the same in-flight
  promise, then retry once. Without it, parallel expiries trip replay detection and self-logout.
- **Passwords:** Argon2id via `@node-rs/argon2`, exclusively. **Zero bcrypt anywhere.**
- Web SPA: access token in memory only; refresh token in `localStorage` (acceptable only while
  localhost-only; replacement is a prerequisite for any non-localhost deploy).

### FR8 — Database (ADR 0005)
- SQLite via `better-sqlite3` through Drizzle ORM.
- `DB_PATH`, default `./data/finance.db`; tests use `:memory:`.
- `db/sqlite.ts` opens the connection, applies `PRAGMA foreign_keys=ON`,
  `PRAGMA busy_timeout=5000`, and `PRAGMA journal_mode=WAL` **only for file-backed DBs**;
  exports `ping()`.
- Raw SQL disallowed outside `db/sqlite.ts` and `db/migrations/**`. Health's `SELECT 1` lives
  in `ping()`.
- Migrations generated by `drizzle-kit`, committed as SQL, applied by `npm run db:migrate`.
- **Boot-failure policy:** invalid config is **fatal** (`config.ts` throws, exit before port
  bind). Unreachable DB is **not fatal** — server binds, `/api/v1/health` reports
  `db: "unavailable"` with 503.

### FR9 — Schema created by the scaffold
IDs are UUIDv7 strings stored as `TEXT`. Timestamps are `TEXT` ISO-8601 UTC.

| Table | Columns |
|---|---|
| `users` | `id` TEXT PK, `email` TEXT UNIQUE NOT NULL, `password_hash` TEXT NOT NULL, `default_currency` TEXT NOT NULL CHECK(length(default_currency)=3), `created_at` TEXT NOT NULL |
| `refresh_tokens` | `id` TEXT PK, `user_id` TEXT NOT NULL REFERENCES `users(id)` ON DELETE CASCADE, `token_hash` TEXT UNIQUE NOT NULL, `expires_at` TEXT NOT NULL, `revoked_at` TEXT NULL, `created_at` TEXT NOT NULL |

Plus `__drizzle_migrations` (drizzle-kit managed). **No other tables.**

### FR10 — NOT created by the scaffold (recorded only)
`accounts`, `categories`, `transactions`, `budgets`. Transfers unresolved. Idempotency rule
deliberately undecided.

### FR11 — Frontend (ADR 0007)
React 19 + Vite + TypeScript, TanStack Query, TanStack Router, Tailwind + shadcn/ui.
Charts deferred. Renders exactly two things: a login form, and a page showing `GET /api/v1/me`
plus API health. Vite proxies `/api` to the API in dev — **no CORS config on localhost**.

### FR12 — Config (`config.ts`, Zod-validated, fail-fast)
| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `NODE_ENV` | `development` | |
| `DB_PATH` | `./data/finance.db` | `:memory:` in tests |
| `JWT_SECRET` | none | **required**, min 32 chars; boot fails otherwise |
| `ACCESS_TOKEN_TTL` | `15m` | |
| `REFRESH_TOKEN_TTL` | `30d` | |
| `LOG_LEVEL` | `info` | |

`version` in `HealthResponse` is read from `apps/api/package.json` at boot — not an env var.
Web dev server on Vite default `5173`.

### FR13 — Scripts (root, delegating to workspaces)
`dev` (API + web concurrently) · `build` · `typecheck` · `lint` · `format` · `test` ·
`test:api` · `test:web` · `db:generate` · `db:migrate` · `db:seed` · `db:reset`

### FR14 — Testing
Vitest everywhere.
- **API:** `fastify.inject()` against a real `:memory:` SQLite DB, freshly migrated per test
  file. No mocked DB, and **no DB files on disk at any point during a test run**.
- **Web:** Vitest + Testing Library, network mocked with MSW, handlers typed by `@finance/contracts`.
- **Boundary tests:** static assertions for B1–B4, one test each.

### FR15 — CI
One GitHub Actions workflow on push and PR: `npm ci` → `typecheck` → `lint` → `test` → `build`.
Any failing step fails the build.

### FR16 — Seed / registration
Registration is a **seed/CLI operation**, not a public endpoint (A5). `npm run db:seed` creates
exactly one user with a known email and Argon2id-hashed known password; repeatable (upsert or
clean exit), no duplicate on second run.

## Assumptions

| # | Assumption | Status |
|---|---|---|
| A1 | TypeScript everywhere, `strict: true`, no plain JS. | **Confirmed** |
| A2 | Single currency for whole dataset, stored once as `users.default_currency`. No per-account/per-transaction currency, no FX. | **Confirmed** |
| A3 | Manual transaction entry + CSV import eventually. **No** bank aggregation (Plaid/Yodlee). | **Confirmed** |
| A4 | This phase runs on `localhost` over plain HTTP. TLS, real secret management, hardened token storage deferred. | **Confirmed** |
| A5 | Registration is a seed/CLI operation, not a public endpoint. | **Confirmed** |

## Resolved Questions

### Q1 — JSON field casing — **RESOLVED: snake_case**
The spec's naming table and **ADR 0004 line 63** fixed **camelCase**; the `/build` skill's hard
rule mandates **snake_case**. (Correction from recon: ADR **0008** contains no camelCase
statement at all — the normative one is ADR 0004 L63, with an illustrative one in ADR 0006 L67.) **Ruling: snake_case — the skill rule wins and overrides the spec.**

Consequences that must be carried out, not just noted:
- All `@finance/contracts` schemas use `snake_case` field names.
- `LoginResponse` / `RefreshResponse` return `access_token` and `refresh_token`.
- The generated OpenAPI document reflects `snake_case` throughout.
- The web client reads `snake_case` fields.
- **ADR 0008 and the naming table in `think/finance-tracker-scaffold.md` are now stale and must
  be amended** — tracked as its own task so the written record matches the code.
- Repository-layer mapping is no longer a case conversion; it is solely the
  minor-unit↔decimal-string conversion and `_minor` suffix stripping.

### Q2 — Git repository — **RESOLVED: `git init` locally, no remote**
Initialise a local git repository, add a `.gitignore` (must cover `data/`, `*.db`, `*.db-wal`,
`*.db-shm`, `node_modules`, `.env`, `dist`), and commit the scaffold. `.github/workflows/ci.yml`
is written as specified but **not executed** — no GitHub remote is created and nothing is
pushed. Therefore **test case 33 (CI gate) is deferred manual verification**, recorded in
`test-cases.md` as such rather than silently dropped.

### Q3 — Node/toolchain versions — **RESOLVED: Node 22 LTS**
Declare `"engines": { "node": ">=22" }` at the workspace root. CI runs a single Node 22 version
(no matrix). Chosen for the most reliable native prebuilds for `better-sqlite3` and
`@node-rs/argon2`.

## Edge Cases
- Missing / short (<32 char) `JWT_SECRET` → fatal, exit non-zero within 2s, message names `JWT_SECRET`, no port bound.
- Unreadable `DB_PATH` → server still binds; health 503 `db: "unavailable"`.
- `PRAGMA journal_mode=WAL` must **not** be issued for `:memory:`.
- Re-running `db:migrate` applies nothing and exits 0.
- Re-running `db:seed` creates no duplicate.
- Login with wrong password vs unregistered email → **byte-identical** 401 bodies.
- Expired access token (TTL 1s) → 401 `UNAUTHENTICATED`.
- Replayed (already-rotated) refresh token → 401 **and** all that user's refresh tokens revoked.
- Expired refresh token → 401, no new tokens issued.
- Five concurrent expired-access requests in web → exactly one `POST /auth/refresh`, all five succeed.
- FK violation on `refresh_tokens.user_id` → rejected at runtime.
- Deleting a user cascades away their refresh tokens.
- Non-domain error on authenticated `/me` → 500 `INTERNAL`, no stack/SQL/path in body, full error in server log.
- `/api/v1/docs` → 404 in production, 200 in development.
- Money: `"1.005"` and non-numeric text rejected with a clear error, never rounded.

## Success Criteria
All 33 acceptance test cases in `think/finance-tracker-scaffold.md` pass, with two documented
adjustments from the resolutions above:
- **Case 33 (CI gate)** — deferred manual verification; no GitHub remote exists (Q2).
- **Cases 8, 10, 12** — assertions now expect `snake_case` wire fields, e.g. `access_token`
  rather than `accessToken` (Q1).

Case 6 remains **vacuous by design** (no `_minor` columns exist yet) and case 16's single-flight
assertion is verified in the web test suite via MSW request counting.

Full enumeration and Automated/Manual classification lands in `test-cases.md` (Phase 3.5).

---

# Phase 2 — Codebase Exploration & Planning

## Repo state at planning time (verified)
Not a git repository. Eleven files: 9 ADRs, `think/finance-tracker-scaffold.md`, and this
requirements file. No `package.json`, `tsconfig`, `.npmrc`, `.nvmrc`, `.env`, `.gitignore`,
`.github/`, or `node_modules` anywhere. **Every file in the scaffold is a new file** — there is
no existing code to impact, so "impacted components" is the greenfield tree in FR1.

## E1 — npm registry — **RESOLVED, no longer a blocker**
The CodeArtifact token was refreshed by the user. Re-verified after refresh:
- **All 31 packages resolve** through the Momentive CodeArtifact proxy. No `FAIL` rows.
- **Native prebuilds fetch correctly through the proxy** — a real install of
  `better-sqlite3@13.0.3` + `@node-rs/argon2` + `uuid@14.0.2` succeeded in 14s, resolved
  `@node-rs/argon2-darwin-arm64@2.2.1` via optionalDependencies, and loaded both natives
  (SQLite 3.53.4). No node-gyp, no Xcode.
- **No project-local `.npmrc` is needed.** The scaffold uses the ambient registry config.

Residual risk, recorded not actioned: the CodeArtifact token expires periodically, so a future
`npm ci` (including a fresh clone) can fail with `E401` until re-authenticated. This is
environmental, not a scaffold defect. `npm view` also reported a **stale `@node-rs/argon2@2.1.0`**
while the actual install resolved `2.2.1` — the proxy's metadata can lag its tarballs, so trust
install output over `npm view` when they disagree.

## E2 — TypeScript major version — decision required (Q5)
Verified directly: `typescript-eslint@8.70.0` (the newest release) declares
`peerDependencies: { typescript: ">=4.8.4 <6.1.0", eslint: "^8.57.0 || ^9.0.0 || ^10.0.0" }`.
No typescript-eslint release supports TypeScript 7.

Published TypeScript stable versions: `… 5.9.2, 5.9.3, 6.0.2, 6.0.3, 7.0.2` (`latest` = 7.0.2).

**`typescript@6.0.3` satisfies the `<6.1.0` peer range.** So the choice is not the false dilemma
of "newest compiler" vs "working lint" — TS 6.0.3 gives a supported, conflict-free pairing one
major behind latest, with full type-aware linting and no `overrides`. See Q5.

## Pinned dependency set (all versions verified against registry.npmjs.org)

The self-consistency constraints are not optional — these four form the only working set:
`vite@8` + `vitest@5` + `@vitejs/plugin-react@6`, and `zod@4` + `fastify-type-provider-zod@7`.

| Workspace | Dependencies |
|---|---|
| root (dev) | `typescript@6.0.3`, `typescript-eslint@8.70.0`, `eslint@10.11.0`, `prettier@3.9.8`, `concurrently@10.0.5`, `vitest@5.0.1`, `@types/node@26.6.2` |
| `apps/api` | `fastify@5.12.5`, `@fastify/swagger@9.8.1`, `@fastify/swagger-ui@6.1.1`, `fastify-type-provider-zod@7.0.0`, `zod@4.6.5`, `drizzle-orm@0.45.2`, `better-sqlite3@13.0.3`, `@node-rs/argon2@2.2.1`, `jose@6.2.12`, `uuid@14.0.2`; dev: `drizzle-kit@0.31.10`, `@types/better-sqlite3@9.6.0` |
| `apps/web` | `react@19.3.0`, `react-dom@19.3.0`, `@tanstack/react-query@5.103.1`, `@tanstack/react-router@1.170.38`, `uuid@14.0.2`; dev: `vite@8.3.0`, `@vitejs/plugin-react@6.1.1`, `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3`, `msw@2.15.0`, `@testing-library/react@16.3.3`, `@testing-library/dom@10` (explicit peer), `@testing-library/jest-dom@7.0.1` |
| `packages/contracts` | `zod@4.6.5` |

**JWT library choice: `jose@6.2.12`, not `@fastify/jwt`.** `@fastify/jwt` decorates the Fastify
instance, which would put token logic in the framework layer; `lib/tokens.ts` must be a plain
module so `auth.service.ts` can use it without importing Fastify (FR2 forbids Fastify in
services). `jose` is framework-agnostic.

## Non-obvious implementation constraints discovered in recon

| # | Constraint | Why it matters |
|---|---|---|
| C1 | **`@node-rs/argon2@2.2.1`'s default algorithm IS Argon2id.** Verified: bare `hash("pw")` returns `$argon2id$v=19$…`. (An earlier recon claim that the default was Argon2*i* was **wrong** and is retracted.) | No silent-failure risk here. `lib/password.ts` will still pass `{ algorithm: Algorithm.Argon2id }` explicitly — as documentation and to pin behaviour against a future default change — but it is belt-and-braces, not a bug fix. Case 20 asserts the `$argon2id$` prefix either way. |
| C2 | **`crypto.randomUUID({ version: 7 })` silently returns a v4.** It does not throw; the option is ignored. | Must use `uuid@14`'s `v7()`. A plausible-looking stdlib call would produce non-time-ordered IDs undetectably. |
| C3 | **`uuid@14` is ESM-only.** | `apps/api` must be `"type": "module"`. Decided: ESM throughout. |
| C4 | **`PRAGMA journal_mode=WAL` on `:memory:` is a silent no-op, not an error** — re-verified: returns `[{"journal_mode":"memory"}]`, throws nothing. | The conditional in `db/sqlite.ts` is for correctness and testability (case 29), not crash avoidance. Test 29 must assert the PRAGMA is *not issued*, e.g. by spying on `.pragma()`, since the DB itself would not complain. `foreign_keys` and `busy_timeout` stay unconditional. |
| C5 | **`zod@3` cannot produce valid OpenAPI 3.1.** Zod 4's `z.toJSONSchema` emits draft 2020-12, which 3.1 requires; the v3 path emitted draft-07. | Pin `zod@4`. Do **not** add `zod-to-json-schema` or `@anatine/zod-openapi`. |
| C6 | **Raw Fastify validation errors are `FST_ERR_VALIDATION`, not our envelope.** | `plugins/errorHandler.ts` must call `hasZodFastifySchemaValidationErrors(err)` from `fastify-type-provider-zod` to map into `{ error: { code: "VALIDATION_ERROR", fields: [...] } }` for case 10. |
| C7 | **Zod response serialization emits `additionalProperties: false` and silently strips unknown keys.** | Good for case 12 (`password_hash` cannot leak) but means a repository returning extra fields fails silently rather than loudly. |
| C8 | **`withTypeProvider<ZodTypeProvider>()` does not propagate types into `fastify-plugin` children.** | Set compilers once at root in `server.ts`; re-apply `withTypeProvider` in each module plugin signature. |
| C9 | **drizzle-kit writes `migrations/meta/_journal.json` + `meta/*_snapshot.json` alongside the `.sql`.** All must be committed — the migrator reads `_journal.json` to order migrations. | Committing only `.sql` breaks `db:migrate`. `.gitignore` must not exclude them. |
| C10 | **`migrate()` from `drizzle-orm/better-sqlite3/migrator` is synchronous** and reads migrations from disk but writes nothing. | Satisfies FR14's no-disk-writes rule. Usable directly in `beforeEach` with no `await`. |
| C11 | **`migrationsFolder` resolves against `process.cwd()`**, which differs when tests run from the repo root vs `apps/api`. | Must derive an absolute path via `new URL(..., import.meta.url)`, or `npm run test` from root breaks while `test:api` passes. |
| C12 | **Each `new Database(':memory:')` is a private DB; there is no sharing across Vitest files.** | A `createTestDb()` helper per file is the correct shape. Keep Vitest `isolate: true` and `environment: 'node'`. Do not use `file::memory:?cache=shared`. |
| C13 | **Tailwind v4 has no `tailwind.config.js`, no `postcss.config.js`, no autoprefixer.** Integration is the first-party `@tailwindcss/vite` plugin; CSS is one `@import "tailwindcss"` plus `@theme` blocks. | `npx tailwindcss init` no longer applies. Do not use `@tailwindcss/postcss` (non-Vite bundlers only). |
| C14 | **`eslint@10` requires Node `^22.13.0`**, stricter than Q3's `>=22`. | Root `engines` should be `>=22.13.0`. Local Node is 22.18.0 — satisfied. |
| C15 | **No CORS plugin in the API.** Vite proxies `/api` in dev (ADR 0007 L70). | Adding CORS would mask a misconfigured proxy. |
| C16 | **B2's allowlist in ADR 0005 omits the `apps/api/test/**` exemption** that FR3 grants. | FR3 governs. Without the exemption the boundary test fails on the very test files that assert schema facts via `PRAGMA` (cases 6, 21, 29). |

## Native prebuilds — verified by actual install and load
- `better-sqlite3@13.0.3`: N-API, ships `prebuilds/darwin-arm64.node` **inside the tarball**; no
  node-gyp, no Xcode, no network prebuild step. Loaded on Node 22.18.0/darwin-arm64, SQLite 3.53.4.
  Linux x64/arm64 (glibc + musl) also present, so CI is covered.
- `@node-rs/argon2@2.2.1`: prebuilt `darwin-arm64` resolved via optionalDependencies; produced a
  real `$argon2id$v=19$m=...` hash. Prebuilds for linux gnu+musl, win32 present.

## Boundary-test implementation approach (B1–B4, cases 23–26)
Static source analysis, not runtime: Vitest tests that glob the relevant files with `fs` and
regex-match import specifiers. This is how the rules can be asserted without executing the
forbidden imports. Each rule is one test file so a failure names the violated rule directly.
The allowlists live in **named constants** (per the constants convention), not inline literals.

## Error-envelope architecture
`plugins/errorHandler.ts` is the single mapping point, with a typed domain-error hierarchy in
`apps/api/src/lib/errors.ts` (e.g. `UnauthenticatedError`). Services throw domain errors and
know nothing about HTTP status codes. Mapping order in the handler:
1. `hasZodFastifySchemaValidationErrors(err)` → 400 `VALIDATION_ERROR` + `fields` (C6)
2. known domain error → its mapped code/status
3. anything else → 500 `INTERNAL`, generic message, **full error to the Pino log, nothing
   sensitive in the body** (case 32)

`/api/v1/health` bypasses the envelope entirely and returns `HealthResponse` on both 200 and 503.

## Risks
| Risk | Mitigation |
|---|---|
| ~~Registry E401~~ | **Resolved** — token refreshed, all 31 packages + natives verified through the proxy. Residual: token re-expiry breaks future `npm ci`. |
| ~~TS / typescript-eslint peer conflict~~ | **Resolved** — TS pinned to 6.0.3, inside the peer range (Q5) |
| ~~Silent Argon2i~~ | **Retracted** — Argon2id is already the default (C1). Explicit `algorithm` kept as defensive documentation. |
| Silent UUIDv4 instead of v7 | C2; `uuid@14` `v7()` only |
| Case 33 unverifiable | No git remote (Q2); recorded as deferred manual, not dropped |
| shadcn/ui CLI vs Tailwind 4.3.3 unverified | Scaffold Tailwind v4 correctly first; add shadcn components only as the two screens need them |
| Vacuous case 6 | Accepted per ADR 0009; wired now so it bites when finance tables land |

## Task breakdown preview (Phase 3 will write these files)
1. Toolchain preflight — confirm registry auth still live and Node >=22.13 at build time
2. Workspace root: `package.json`, `tsconfig.base.json`, `.gitignore`, `git init`, eslint/prettier
3. `packages/contracts` — Zod schemas, snake_case, `ErrorResponse`, `HealthResponse`, auth schemas
4. `apps/api` skeleton — `config.ts`, `server.ts`, `index.ts`, plugins
5. `db/` — `sqlite.ts`, `client.ts`, `schema.ts`, `migrate.ts`, migrations, `seed.ts`
6. `lib/` — `money.ts`, `password.ts`, `tokens.ts`, `errors.ts`
7. `modules/health` — routes/service/repository
8. `modules/auth` — login, refresh (rotation + replay detection), logout, `/me`
9. `plugins/openapi.ts` — OpenAPI 3.1 + dev-only Swagger UI
10. API test suite (cases 2–15, 17–22, 28–30, 32)
11. Boundary tests (cases 23–26)
12. `apps/web` — Vite, Tailwind v4, TanStack, login + `/me` page, single-flight `refresh.ts`
13. Web test suite (cases 16, 27, 31) with MSW typed from contracts
14. CI workflow
15. **Amend ADR 0004 L63, ADR 0006 L67, and spec L98/L114 for the snake_case ruling**
16. Documentation task (mandatory)
17. Verification task (mandatory, final)

## Resolved Questions (Phase 2)

### Q4 — npm registry — **SUPERSEDED 2026-09-21: project-local `.npmrc` pinning npmjs.org**
Originally resolved as "use the ambient CodeArtifact registry, no `.npmrc`". **That decision was
reversed during task12** when the CodeArtifact token expired for a second time, mid-install:
`aws codeartifact login` also failed (`UnrecognizedClientException` — AWS SSO creds stale), the
install fell back to the public registry, and `package-lock.json` ended up with **362
CodeArtifact + 154 npmjs.org `resolved` URLs**. A mixed lockfile breaks `npm ci` whenever the
token is dead, which would have broken CI (FR15).

**Resolution:** a committed project-local `.npmrc` pinning
`registry=https://registry.npmjs.org`, with the rationale written into the file. Lockfile
rebuilt from scratch. Verified: **0 CodeArtifact / 516 npmjs.org URLs**, `npm ci` succeeds from
a clean tree (exit 0), typecheck clean, 136/136 tests pass, all three workspaces build.
Justified because this project consumes no internal Momentive packages. Remove `.npmrc` if that
ever changes.

**Latent bug found by this work:** nobody had run `npm ci` until now — only `npm install`. A
stale lockfile produced `EUSAGE ... lock file's esbuild@0.25.12 does not satisfy esbuild@0.28.2`.
The dependency tree is genuinely fine (three nested esbuild copies: `@esbuild-kit/core-utils`
wants `~0.18.20`, `drizzle-kit` wants `^0.25.4`, `tsx` wants `~0.28.0`, `vite` peers
`^0.27||^0.28`), so no `overrides` were needed — the lockfile just had to be regenerated. CI
would have hit this on its first run.

### Q5 — TypeScript major version — **RESOLVED: `typescript@6.0.3`**
Paired with `typescript-eslint@8.70.0` and `eslint@10.11.0`. Satisfies the `<6.1.0` peer range,
so **no `overrides` and no peer conflict**, and full type-aware lint rules remain available —
both the `typecheck` and `lint` CI gates (FR15) stay meaningful. Revisit when typescript-eslint
ships TypeScript 7 support; the bump is then a single version change.

### Q6 — OpenAPI component schemas — **RESOLVED: named `$ref` components**
`plugins/openapi.ts` uses `createJsonSchemaTransformObject({ schemas: { ... } })` from
`fastify-type-provider-zod`, registering `ErrorResponse`, `HealthResponse`, and the auth
request/response schemas as named entries under `components/schemas`. Routes reference them via
`$ref: '#/components/schemas/ErrorResponse'`.

This makes test case 8 assertable in the strict sense of the word "reference": the test walks
every non-2xx response in the generated document and asserts a `$ref` to
`#/components/schemas/ErrorResponse`, **except** `/api/v1/health`'s 503, which must `$ref`
`HealthResponse`, and `/api/v1/auth/logout`'s 204, which must declare no body at all.
