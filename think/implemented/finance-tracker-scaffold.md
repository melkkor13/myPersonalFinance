# Finance Tracker — Application Scaffold

> Status: **All nine decisions Accepted.** ADRs 0001–0009 recorded in `docs/adr/`.

## Problem Statement

We want to build a personal finance tracker (accounts, transactions, categories, budgets). Before writing feature code we need a **scaffold**: the repo layout, runtime choices, data-access layer, API contract conventions, auth, and test harness that the real features will be dropped into.

The scaffold must be right-first-time on a few things that are expensive to change later:

1. **The Node backend is a standalone API.** The web SPA is one client among possible others, and the API will eventually be reachable from a phone over the internet. So the backend must not assume a browser (no cookie-only auth path, no server-rendered HTML coupling, no session affinity) and must be versioned and self-describing from day one.
2. **Money must never be a float.** A wrong money representation corrupts data silently.
3. **SQLite today, plausibly Postgres later.** Cloud hosting is a stated future goal, so SQLite-specific behaviour must be confined to as few modules as possible rather than spread through query code.
4. **Auth must exist before the routes do.** Retrofitting ownership onto existing routes and tables is the single most expensive change on this list, so it goes in first.

### Confirmed scope

| # | Decision | Source |
|---|---|---|
| S1 | **Auth is in scope now** — real login/refresh/logout, JWT access token + DB-backed revocable refresh token. | Confirmed |
| S2 | **Single user now, cloud-hosted later.** Just one person's data, but the API will eventually be internet-reachable from a phone. Schema carries `user_id` from day one; Postgres must stay a realistic migration, not a rewrite. | Confirmed |
| S3 | **Mobile client undecided, possibly never.** Do not optimise the frontend for code sharing with a future native app. Keep the API language-neutral anyway, since cloud hosting means non-browser clients are plausible. | Confirmed |
| S4 | **Scaffold slice is health check + auth only.** No finance entity is wired end to end. The scaffold proves: config, DB connection, migrations, auth, error handling, contracts, tests, CI — and `GET /api/v1/health`. | Confirmed |

### Remaining assumptions (please correct)

| # | Assumption |
|---|-----------|
| A1 | TypeScript everywhere, `strict: true`, no plain JS. |
| A2 | Single currency for the whole dataset, stored once as `users.default_currency`. No per-account or per-transaction currency, and no FX conversion, until multi-currency is actually asked for. |
| A3 | Manual transaction entry + CSV import eventually. **No** bank aggregation (Plaid/Yodlee). |
| A4 | This phase runs on `localhost` over plain HTTP. TLS, real secret management, and hardened token storage are a separate deployment task, called out in Deferred below. |
| A5 | Registration is a seed/CLI operation, not a public endpoint — it is a single-user app, so there is no signup flow to expose. |

## Solution

### Shape

A single **Git repository** using npm workspaces, with three packages:

```
myPersonalFinance/
  package.json                 # workspaces root, shared scripts
  tsconfig.base.json
  .github/workflows/ci.yml
  apps/
    api/                       # Fastify + TypeScript HTTP API
      src/
        index.ts               # entrypoint: buildServer().listen()
        server.ts              # buildServer() — pure, no side effects on import
        config.ts              # env parsing/validation via Zod
        db/
          sqlite.ts            # engine module: connection, PRAGMAs, ping()
          client.ts            # Drizzle instance built on sqlite.ts
          schema.ts            # table definitions
          migrate.ts
          seed.ts
          migrations/          # drizzle-kit generated SQL, committed
        modules/
          health/
            health.routes.ts
            health.service.ts
            health.repository.ts # wraps ping() from db/sqlite.ts
          auth/
            auth.routes.ts
            auth.service.ts
            auth.repository.ts
        plugins/
          authenticate.ts      # verifies bearer token, populates request.user
          errorHandler.ts      # maps thrown errors to the error envelope
          openapi.ts
        lib/
          money.ts
          password.ts
          tokens.ts
      test/
      drizzle.config.ts
    web/                       # React + Vite SPA
      src/
        api/                   # fetch client typed by @finance/contracts
          refresh.ts           # single-flight refresh lock
        routes/
        components/
        lib/
      vite.config.ts
  packages/
    contracts/                 # @finance/contracts — Zod schemas + inferred types
  docs/adr/
  think/
```

### Layer rules

Each API module is `routes → service → repository`:

- **routes** — HTTP only: attach contract schemas, call the module's service function, and return that function's return value. No business logic, no SQL.
- **service** — business rules. Throws typed domain errors. Imports nothing from `src/db/**`, and neither Fastify nor Drizzle — its only data access is via its module's repository.
- **repository** — returns plain domain objects. Owns the minor-unit↔decimal-string conversion and the `_minor` suffix stripping.

Four import rules, each asserted by its own test:

| # | Rule |
|---|---|
| B1 | `drizzle-orm` may be imported only in `*.repository.ts` files and under `apps/api/src/db/**`. Never in `*.routes.ts`, `*.service.ts`, or `plugins/**`. |
| B2 | SQLite-specific identifiers (`better-sqlite3`, `drizzle-orm/better-sqlite3`, `PRAGMA`) may appear only in `apps/api/src/db/sqlite.ts`, `apps/api/src/db/client.ts`, `apps/api/src/db/migrations/**`, `apps/api/drizzle.config.ts`, and `apps/api/package.json`. **`apps/api/test/**` is exempt** — tests legitimately issue `PRAGMA table_info` and `PRAGMA foreign_keys` to assert schema facts (cases 6, 21, 29), and a boundary rule that forbade them would make those assertions impossible. B2 constrains shipped code, not the code that checks it. |
| B3 | Nothing in `apps/api/src/modules/**/*.service.ts` may import from `apps/api/src/db/**` — services reach data only through their module's repository. |
| B4 | `apps/web/src` may not import `drizzle-orm`, `better-sqlite3`, or `apps/api/src`. The web app's only data path is the HTTP API. |

### Naming conventions

| Layer | Convention | Example |
|---|---|---|
| Database columns | `snake_case` | `opening_balance_minor` |
| JSON request/response fields | `snake_case` | `opening_balance` |
| Money columns | integer, always suffixed `_minor` | `limit_minor`, `amount_minor` |
| Money in JSON | decimal **string**, never a number | `"1234.56"` |

The three money columns above (`opening_balance_minor`, `limit_minor`, `amount_minor`) belong to the planned finance tables, which the scaffold does not create — they are given here because the convention must be fixed before those tables are written.

**Money field mapping is a deliberate exception to plain passthrough:** database columns and JSON fields share `snake_case`, so there is no case conversion — but the `_minor` suffix is *dropped* on the way out, and the value changes representation, because the JSON value is not in minor units. `opening_balance_minor: 123456` (INTEGER) ⇄ `opening_balance: "1234.56"` (decimal string). The repository layer performs this conversion; `lib/money.ts` owns the arithmetic and parsing in both directions. JSON never carries a float for money, and the database never carries a decimal string.

**Minor units are assumed to be hundredths — a fixed exponent of 2.** `lib/money.ts` hard-codes that scale, which is why input with more than two decimal places is rejected. Zero-decimal currencies (JPY) and three-decimal ones (KWD, BHD) are therefore **not supported**, and `default_currency` is validated only for length, not against that assumption. This is acceptable under A2 (one currency for the whole dataset, chosen by the single user) but is a real limitation: supporting a non-2dp currency means introducing a per-currency exponent and revisiting ADR 0006.

### API contract

- REST/JSON under `/api/v1/*`.
- **Every API route's request and response bodies have a Zod schema in `@finance/contracts`**, including `/api/v1/health` and every error. Two exemptions, both deliberate: the *meta* routes below, which are generated by the OpenAPI plugin and describe the contract rather than participate in it; and **`204 No Content` responses, which have no body to schematise** — `POST /api/v1/auth/logout` is the scaffold's only such route, and its 204 is declared in OpenAPI with no response schema.
- A generated **OpenAPI 3.1** document is served at `/api/v1/openapi.json`, with Swagger UI at `/api/v1/docs` in development only.
- Uniform error envelope, defined as `ErrorResponse` in `@finance/contracts`:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "…", "fields": ["email", "password"] } }
  ```
  `fields` is present only for `VALIDATION_ERROR`.
- **Codes reachable in the scaffold:** `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `INTERNAL` (500). These three are the only ones any of the five API routes can emit, and each is covered by a test — cases 10, 11, and 32 respectively.
- **Codes defined but not yet reachable:** `NOT_FOUND` (404), `CONFLICT` (409), `SERVICE_UNAVAILABLE` (503). They are declared in the `ErrorResponse` enum now so the envelope does not change shape when the first finance routes need them; no scaffold route produces them, and no scaffold test asserts them. (The 404 in test 9 comes from Fastify's own not-found handling on a disabled meta route, not from this enum.)
- **One documented exception to the envelope:** `/api/v1/health` returns the `HealthResponse` schema on both 200 and 503, because a monitoring probe needs the component breakdown rather than an error code. This is why `SERVICE_UNAVAILABLE` is unreachable in the scaffold. Every *other* non-2xx response across the API references `ErrorResponse`.

### Routes in the scaffold

Five API routes:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | none | `HealthResponse`: `{ "status": "ok" \| "degraded", "version": "…", "db": "ok" \| "unavailable" }`. Reaches the DB through the normal chain — `health.routes.ts` → `health.service.ts` → `health.repository.ts` → `ping()` in `db/sqlite.ts`; 200 when `db` is `ok`, 503 when not |
| POST | `/api/v1/auth/login` | none | email + password → access token + refresh token |
| POST | `/api/v1/auth/refresh` | refresh token | rotates: issues a new access token and a new refresh token, revoking the presented one |
| POST | `/api/v1/auth/logout` | refresh token | revokes the presented refresh token |
| GET | `/api/v1/me` | access token | returns the authenticated user — the one protected route, proving the auth plugin works |

Two meta routes, exempt from the contracts rule: `GET /api/v1/openapi.json` and `GET /api/v1/docs` (development only).

### Auth

- **Access token:** JWT, **15-minute TTL**, `HS256`, signed with `JWT_SECRET`. Claims: `sub` (user id), `iat`, `exp`. Sent as `Authorization: Bearer <token>`.

  *Why 15 minutes.* The access-token TTL is the **revocation window**, not the login duration — the 30-day refresh token keeps the user signed in, and expiry only triggers a silent refresh, costing roughly one extra request per 15 minutes. Because a stateless JWT cannot be revoked mid-life, the TTL is exactly how long a leaked token stays usable and how long "log out this device" takes to bite. Stretching it to hours would mean paying for the two-token design without getting its main benefit. `ACCESS_TOKEN_TTL` is configurable if 15 minutes proves noisy in practice; anything beyond about an hour makes refresh-token revocation largely cosmetic.

- **Refresh token:** 32 bytes of CSPRNG randomness, base64url, 30-day TTL. Only its SHA-256 hash is stored, in `refresh_tokens`. Rotated on every use; presenting an already-rotated token is treated as compromise and revokes every refresh token for that user.
- **Single-flight refresh (client requirement).** Because rotation makes concurrent refreshes dangerous, `apps/web/src/api/refresh.ts` must serialise them: when a 401 arrives, the first caller performs the refresh and every concurrent caller awaits the same in-flight promise, then retries once. Without this lock, several parallel requests expiring together would each present the same refresh token, and the losers would trip replay detection and log the user out. That self-inflicted logout is the real cost of a short access-token TTL, and the lock is mandatory rather than an optimisation. The requirement binds any client that holds a refresh token; today `apps/web` is the only one, and test 16 covers it.
- **Passwords:** Argon2id via `@node-rs/argon2`, everywhere and exclusively — no bcrypt anywhere in the codebase.
- The web SPA holds the access token in memory only and the refresh token in `localStorage`. **Keeping a refresh token in `localStorage` is acceptable only while the app is localhost-only**; replacing that storage mechanism is a prerequisite for any non-localhost deployment and is listed under Deferred.

### Database

- SQLite via `better-sqlite3`, accessed through **Drizzle ORM**.
- File path from the `DB_PATH` variable, default `./data/finance.db`. Tests set `DB_PATH=:memory:`.
- **Engine knowledge is confined to five locations**, per rule B2: `db/sqlite.ts` opens the connection, applies `PRAGMA foreign_keys=ON` and `PRAGMA busy_timeout=5000`, applies `PRAGMA journal_mode=WAL` **only for file-backed databases** (WAL has no meaning for `:memory:`), and exports `ping()` for the health check. `db/client.ts` imports the Drizzle SQLite dialect and wraps that connection. `db/migrations/**` holds dialect-specific SQL, `drizzle.config.ts` names the dialect, and `package.json` declares the driver dependency. A Postgres move rewrites `db/sqlite.ts` and `db/client.ts`, translates the committed migrations, and swaps the dependency — repository query code stays put. It is the *repositories* that stay portable, not the whole `db/` directory.
- Raw SQL is disallowed outside `db/sqlite.ts` and `db/migrations/**`. The health check's `SELECT 1` therefore lives inside `ping()` in `db/sqlite.ts`; `health.repository.ts` wraps `ping()`, and `health.service.ts` calls the repository — so the `routes → service → repository` rule holds for the health module too.
- Migrations generated by `drizzle-kit`, committed as SQL, applied by `npm run db:migrate`.
- **Boot-failure policy.** Invalid configuration is **fatal**: `config.ts` throws and the process exits before a port is bound, because a missing `JWT_SECRET` cannot be recovered from at runtime. An unreachable database is **not fatal**: the server still binds its port and serves `/api/v1/health`, which reports `db: "unavailable"` with status 503. The reasoning is operational — a process that refuses to start cannot tell you why it is unhealthy, whereas one that starts and reports `degraded` can. Every other route is free to fail with `INTERNAL` while the database is down.

### Schema created by the scaffold

Only what auth needs, plus Drizzle's own migration-tracking table (`__drizzle_migrations`), which `drizzle-kit` creates and maintains. IDs are UUIDv7 strings stored as `TEXT`. Timestamps are `TEXT` ISO-8601 UTC.

| Table | Columns |
|---|---|
| `users` | `id` TEXT PK, `email` TEXT UNIQUE NOT NULL, `password_hash` TEXT NOT NULL, `default_currency` TEXT NOT NULL CHECK(length(default_currency) = 3), `created_at` TEXT NOT NULL |
| `refresh_tokens` | `id` TEXT PK, `user_id` TEXT NOT NULL REFERENCES `users(id)` ON DELETE CASCADE, `token_hash` TEXT UNIQUE NOT NULL, `expires_at` TEXT NOT NULL, `revoked_at` TEXT NULL, `created_at` TEXT NOT NULL |

### Planned schema — NOT created by the scaffold

Recorded so the shape is known, but deliberately not migrated. Building these before the first real feature would lock in column details we have not pressure-tested.

- `accounts` — `id`, `user_id`, `name`, `type`, `opening_balance_minor`, `archived_at`, `created_at`. Open question: whether delete is hard or soft (`archived_at` implies soft).
- `categories` — `id`, `user_id`, `name`, `parent_id`, `kind` (income/expense).
- `transactions` — `id`, `user_id`, `account_id`, `category_id`, `amount_minor` (signed), `occurred_on` (date), `payee`, `notes`, `created_at`, `updated_at`.
- `budgets` — `id`, `user_id`, `category_id`, `period` (month), `limit_minor`.
- **Transfers** are unresolved. A transfer is two rows that must be created and deleted together. How to enforce that pairing — a `transfer_group_id` column, a separate `transfers` table, or a service-level invariant — is a design question for the transactions feature, not the scaffold.

UUIDv7 client-generated IDs are chosen so an offline client could create records without a round-trip. The matching **idempotency rule is deliberately undecided** — whether a repeated create returns 200 or 409, and whether it keys off the `id` or an `Idempotency-Key` header, is a decision for the first write endpoint.

### Frontend

React 19 + Vite + TypeScript. TanStack Query for server state, TanStack Router for routing, Tailwind + shadcn/ui for components. Charts library deferred until there is something to chart. In the scaffold the web app renders exactly two things: a login form, and a page showing `GET /api/v1/me` plus the API health status. Vite proxies `/api` to the API in dev, so there is no CORS configuration on localhost.

### Config (`config.ts`, Zod-validated, fails fast on boot)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | API port |
| `NODE_ENV` | `development` | |
| `DB_PATH` | `./data/finance.db` | `:memory:` in tests |
| `JWT_SECRET` | none | **required**; boot fails if absent or under 32 chars |
| `ACCESS_TOKEN_TTL` | `15m` | see the rationale under Auth |
| `REFRESH_TOKEN_TTL` | `30d` | |
| `LOG_LEVEL` | `info` | |

Invalid or missing values here are fatal at boot; see the boot-failure policy above.

Not an environment variable: the `version` field in `HealthResponse` is read from `apps/api/package.json`'s `version` at boot, so it needs no configuration.

The web dev server runs on Vite's default `5173`.

### Scripts (root, delegating to workspaces)

`dev` (API + web concurrently) · `build` · `typecheck` · `lint` · `format` · `test` · `test:api` · `test:web` · `db:generate` (drizzle-kit) · `db:migrate` · `db:seed` · `db:reset`

### Testing

Vitest everywhere.

- **API:** `fastify.inject()` against a real `:memory:` SQLite DB, freshly migrated per test file. No mocked database, and no database files created on disk at any point during a test run.
- **Web:** Vitest + Testing Library, network mocked with MSW using handlers typed by `@finance/contracts`.
- **Boundary tests:** static assertions that all four import rules (B1–B4) above hold — one test each, cases 23–26.

### CI

One GitHub Actions workflow on push and PR: `npm ci` → `typecheck` → `lint` → `test` → `build`. Any failing step fails the build.

### Deferred (explicitly out of scope, recorded so it is not forgotten)

TLS/HTTPS · secret management beyond `.env` · rate limiting on `/auth/*` · replacing `localStorage` refresh-token storage for a non-localhost deployment · CSV import · charts · the finance tables above · the idempotency rule · transfers · multi-currency · Postgres migration · any public registration endpoint.

## Tradeoffs

### Decision 1: Repo layout — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **npm workspaces monorepo (chosen)** | Shared `contracts` package gives real FE↔BE type safety; one install, one CI; atomic cross-cutting commits | More config than a single package; occasional workspace/bundler quirks |
| Two sibling Git repositories | Clean deploy boundaries; independent versioning | Contract drift between FE and BE; duplicated tooling and CI; friction for a solo project |
| Single package, `src/server` + `src/client` | Simplest possible config | No dependency isolation; FE deps leak into the API install; can't ship the API alone |

**Accepted:** npm workspaces monorepo — shared contracts is the main structural benefit, and cloud-hosting the API later only requires that `apps/api` build independently, which workspaces permit.

### Decision 2: Backend framework — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **Fastify (chosen)** | Schema-first validation and serialization built in; first-party OpenAPI plugin; fast; strong TS support; plugin encapsulation maps cleanly onto modules | Smaller ecosystem than Express; plugin lifecycle has a learning curve |
| Express 5 | Ubiquitous; every answer online applies | No built-in validation or OpenAPI; needs several glue libraries; weaker TS story |
| NestJS | Structure, DI and OpenAPI out of the box; scales to teams | Heavy for a single-user app; substantial boilerplate and decorator magic |
| Hono | Tiny, fast, runtime-portable, excellent TS inference | Younger ecosystem; fewer mature auth/OpenAPI plugins |

**Accepted:** Fastify — built-in schema validation plus generated OpenAPI is exactly the contract discipline this scaffold is built around.

### Decision 3: API style — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **REST/JSON + OpenAPI (chosen)** | Language-neutral, so any future client works; trivially debuggable with curl; the OpenAPI doc doubles as living documentation; cacheable | Over/under-fetching; endpoints written by hand |
| GraphQL | One flexible endpoint; clients choose fields | Server complexity, N+1 risk, harder caching; heavy for CRUD-shaped data |
| tRPC | Least boilerplate and best end-to-end types for a React SPA | TypeScript-only. Viable now that mobile is undecided, but it forecloses any non-TS client and makes the API unusable without the generated TS client |

**Accepted:** REST/JSON + OpenAPI. Recorded for the future: the original justification was a native mobile client, which is now undecided, so tRPC would have been a defensible lower-effort choice for a React-only frontend. REST was kept for cloud-hosting optionality and curl-debuggability, and this choice was explicitly reviewed rather than inherited.

### Decision 4: SQLite access layer — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **Drizzle ORM + better-sqlite3 (chosen)** | SQL-shaped API; thin runtime; excellent TS inference; real migration tooling; Postgres swap is largely a dialect change | Younger than Prisma; relational-query API still evolving |
| Prisma | Mature, excellent DX, strong migrations, Studio GUI | Separate schema language and generated client; heavier; engine binary to manage |
| Raw `better-sqlite3` or Node's `node:sqlite` | Zero abstraction; full SQL control; no dependency | Hand-rolled migrations; manual row→type mapping; drifts easily; hardest to port to Postgres |
| Knex + hand-written types | Flexible query builder; battle-tested migrations | Types are manual and unenforced; more boilerplate |

**Accepted:** Drizzle — closest to SQL while keeping types honest, and the best fit for the stated Postgres escape hatch.

### Decision 5: Money representation — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **Integer minor units in DB, decimal string on the wire (chosen)** | Exact; sums directly in SQL; JSON avoids IEEE-754 entirely; standard in finance | Two representations to convert between; needs `lib/money.ts` and discipline at every boundary |
| `REAL` / float | Easiest to write | Rounding errors accumulate silently; unacceptable for money |
| Decimal string everywhere, big-decimal library | Exact; arbitrary precision; handles >2dp instruments | Cannot `SUM()` in SQLite without conversion; slower; overkill for cash accounts |

**Accepted:** integer minor units with decimal strings on the wire. Of all nine decisions, **this is the one I would resist changing most strongly** — it is the only one whose failure mode is silent data corruption.

### Decision 6: Frontend stack — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **React + Vite SPA (chosen)** | Fast dev loop; a pure HTTP client, so the API stays the only data path; largest component and charting ecosystem | No SSR (irrelevant here); routing and data fetching assembled by hand |
| Next.js | Batteries included; file routing; SSR | Server components and route handlers make it easy to reach the DB directly and bypass the API, undermining the standalone-API goal; heavier |
| SvelteKit | Less boilerplate; smaller bundles; pleasant DX | Smaller ecosystem; same API-bypass temptation via server load functions |
| Vue 3 + Vite | Gentle learning curve; good tooling | Smaller finance/charting component selection; no other advantage now that React-Native code sharing is off the table |

**Accepted:** React + Vite SPA — chosen for keeping the API as the single data path, plus ecosystem depth.

### Decision 7: Auth token strategy — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **JWT access token + DB-backed rotating refresh token (chosen)** | Stateless request path; refresh tokens revocable; works for browser and non-browser clients alike; correct shape for the future internet-facing deployment | Two-token flow to implement; access token not revocable within its 15-minute TTL; rotation requires a single-flight refresh lock in any client holding a refresh token |
| HttpOnly session cookie | Simplest and safest for a browser; instant server-side revocation | Awkward for non-browser clients; needs CSRF defences; couples the API to a browser |
| Opaque token + DB lookup per request | Instantly revocable; simple mental model | A DB round-trip on every request; less standard for third-party clients |
| Defer auth entirely | Least work now | Retrofitting ownership touches every route and table — the most expensive later change on the list |

**Accepted:** JWT access token (15 min) + DB-backed rotating refresh token (30 days), implemented in the scaffold rather than deferred. TTL rationale and the mandatory single-flight refresh lock are documented under Auth.

### Decision 8: Contract sharing — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **Zod schemas in a shared workspace package, OpenAPI generated from them (chosen)** | One source of truth; runtime validation and compile-time types from one definition; OpenAPI falls out for free | Zod→JSON-Schema conversion has occasional edge cases |
| OpenAPI spec first, generate both sides | Language-neutral source of truth; best when there are many clients | Codegen step in every loop; generated TS types are clumsier; no runtime validation for free |
| No sharing — duplicate types per app | Zero setup | Guaranteed drift; precisely the bug class this scaffold exists to prevent |

**Accepted:** Zod-first, OpenAPI generated from the schemas.

### Decision 9: Scaffold slice depth — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **Health check + auth only (chosen)** | Fastest to review; commits to no finance-table details prematurely; still proves config, DB, migrations, auth, errors, contracts, tests, CI | No CRUD pattern to copy, so the first real feature does more inventing; the money and repository conventions are documented but only unit-tested |
| Accounts end to end | Establishes the full CRUD pattern; exercises money and repository mapping for real | Locks in `accounts` column decisions before the feature is designed |
| Accounts + transactions end to end | Highest confidence; exercises foreign keys, signed amounts, filtering | Most upfront work; the transfers question would need answering now |

**Accepted:** health check + auth only, per S4. Consequence accepted: `lib/money.ts` and the repository mapping conventions are specified and unit-tested, but not proven through a real HTTP endpoint until the first finance feature, and the money-column convention test (case 6) is vacuous until those tables land.

## Decisions

**Numbering note:** ADR numbers are chronological (order of approval) while Tradeoffs section numbers are presentation order, so the two are offset — Decision 7 is ADR 0001 because auth was approved first. Always match by subject, not by number.

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](../docs/adr/0001-jwt-access-token-with-db-backed-refresh-token.md) | Auth token strategy | Accepted |
| [0002](../docs/adr/0002-npm-workspaces-monorepo.md) | Repo layout | Accepted |
| [0003](../docs/adr/0003-fastify-as-the-backend-framework.md) | Backend framework | Accepted |
| [0004](../docs/adr/0004-rest-json-with-generated-openapi.md) | API style | Accepted |
| [0005](../docs/adr/0005-drizzle-orm-over-better-sqlite3.md) | SQLite access layer | Accepted |
| [0006](../docs/adr/0006-money-as-integer-minor-units.md) | Money representation | Accepted |
| [0007](../docs/adr/0007-react-vite-spa-frontend.md) | Frontend stack | Accepted |
| [0008](../docs/adr/0008-zod-first-shared-contracts-package.md) | Contract sharing | Accepted |
| [0009](../docs/adr/0009-scaffold-slice-health-check-and-auth-only.md) | Scaffold slice depth | Accepted |

## Test Cases

Acceptance criteria for the **scaffold itself**.

| # | Scenario | Input / Precondition | Expected Outcome |
|---|---|---|---|
| 1 | Cold clone bootstrap | Fresh clone; `npm install`, write `.env` with `JWT_SECRET`, `npm run db:migrate`, `npm run dev` | API listens on `:3000`, web on `:5173`, no errors logged; `GET /api/v1/health` returns 200 `{"status":"ok","version":"<package version>","db":"ok"}` |
| 2 | Boot fails loudly on bad config | Start the API with `JWT_SECRET` unset, then with a 10-char `JWT_SECRET` | Both exit non-zero within 2s with a message naming `JWT_SECRET`; no port is bound |
| 3 | Unreachable DB degrades rather than prevents boot | Point `DB_PATH` at an unreadable path and start the API | The server still binds its port (contrast with case 2, where bad config is fatal) and `GET /api/v1/health` returns 503 with a `HealthResponse` body — `{"status":"degraded", …,"db":"unavailable"}`, not an `ErrorResponse` — proving `ping()` actually queries the DB rather than returning a constant |
| 4 | Migrations are reproducible and idempotent | `npm run db:reset`, then `npm run db:migrate` twice | First run creates `users` and `refresh_tokens`; second run applies nothing and exits 0 |
| 5 | Only auth tables exist | After migration, list tables | Exactly `users`, `refresh_tokens`, and `__drizzle_migrations`. No `accounts`, `categories`, `transactions`, or `budgets` — confirms the deferred schema really is deferred |
| 6 | Money-column convention holds | After migration, inspect column types via `PRAGMA table_info` for every table | No column anywhere has type `REAL`; every column whose name ends in `_minor` has type `INTEGER`. **Vacuous by design today** — the scaffold's two tables have no `_minor` columns — and wired now so it starts enforcing the moment the finance tables land |
| 7 | Money conversion is lossless at 2dp | Unit-test `lib/money.ts` over `"0.01"`, `"1234.56"`, `"-0.07"`, `"0.00"`, `"999999999.99"` | Each round-trips string→minor→string to the identical string; `"1234.56"` → `123456`; inputs with more than 2 decimal places (`"1.005"`) or non-numeric text are rejected with a clear error, not rounded — documenting the fixed-exponent-2 limitation rather than hiding it |
| 8 | OpenAPI document is complete and valid | `GET /api/v1/openapi.json` | Valid OpenAPI 3.1; lists all five API routes; each has a response schema and, where it takes a body, a request schema — except `/auth/logout`'s 204, which correctly declares no body; every non-2xx response references `ErrorResponse` except `/api/v1/health`'s 503, which references `HealthResponse` |
| 9 | Swagger UI is dev-only | `GET /api/v1/docs` with `NODE_ENV=production`, then with `NODE_ENV=development` | 404 in production, 200 in development |
| 10 | Request validation rejects bad input | `POST /api/v1/auth/login` with `{"email":"not-an-email"}` (no password) | 400 with `{"error":{"code":"VALIDATION_ERROR","fields":["email","password"]}}` |
| 11 | Protected route rejects missing and bad tokens | `GET /api/v1/me` with (a) no header, (b) `Bearer garbage`, (c) a token signed with the wrong secret, (d) an expired token | All four return 401 `{"error":{"code":"UNAUTHENTICATED", …}}` and never reach the handler |
| 12 | Happy-path login and access | Seeded user; `POST /api/v1/auth/login` with correct credentials, then `GET /api/v1/me` with the returned access token | Login returns 200 with `access_token` and `refresh_token`; `/me` returns 200 with that user's `id` and `email`, and no `password_hash` field in the response |
| 13 | Wrong password is indistinguishable from unknown email | `POST /api/v1/auth/login` with a valid email + wrong password, and with an unregistered email | Both return 401 with byte-identical bodies — code `UNAUTHENTICATED`, the same `message`, no `fields` — so neither reveals whether the email exists |
| 14 | Access token expires on schedule | Issue a token with `ACCESS_TOKEN_TTL=1s`, wait, call `GET /api/v1/me` | 401 `UNAUTHENTICATED` — confirms the TTL is actually enforced and configurable |
| 15 | Refresh rotates and detects replay | Login, `POST /api/v1/auth/refresh`, then call refresh again with the same (now-rotated) token | First refresh returns 200 with a new access token and a *different* refresh token; the replay returns 401 and every refresh token for that user is revoked in the DB |
| 16 | Single-flight refresh prevents self-inflicted logout | In the web app, fire five concurrent requests with an expired access token | Exactly one `POST /api/v1/auth/refresh` is issued; all five requests then succeed; the user is not logged out |
| 17 | Logout revokes | Login, `POST /api/v1/auth/logout`, then attempt refresh with that token | Logout returns 204 with an empty body; the subsequent refresh returns 401; `revoked_at` is set on the row |
| 18 | Expired refresh token is rejected | Refresh using a token whose `expires_at` is in the past | 401; no new tokens issued |
| 19 | Refresh tokens are not stored in plaintext | After login, read `refresh_tokens` | No row's `token_hash` equals the token returned to the client; `token_hash` is a 64-char hex SHA-256 digest |
| 20 | Passwords use Argon2id only | After seeding; plus a grep of the repo for `bcrypt` | `users.password_hash` starts with `$argon2id$` and does not contain the plaintext password; zero `bcrypt` matches in any manifest or source file |
| 21 | Foreign keys are enforced at runtime | Insert a `refresh_tokens` row with a non-existent `user_id` | Rejected with a foreign-key constraint error — proves `PRAGMA foreign_keys=ON` is applied on the live connection, not merely declared in the schema |
| 22 | Cascade on user delete | Delete a user who has refresh tokens | That user's `refresh_tokens` rows are gone |
| 23 | Rule B1 — Drizzle stays out of routes, services and plugins | Grep `apps/api/src` for `drizzle-orm` imports | Matches only in `*.repository.ts` and `src/db/**`; zero matches in `*.routes.ts`, `*.service.ts`, or `plugins/**` |
| 24 | Rule B2 — SQLite specifics stay in the five permitted locations | Grep `apps/api/src`, `apps/api/drizzle.config.ts`, and `apps/api/package.json` for `better-sqlite3`, `drizzle-orm/better-sqlite3`, and `PRAGMA`, **excluding `apps/api/test/**`** | Matches only in `src/db/sqlite.ts`, `src/db/client.ts`, `src/db/migrations/**`, `drizzle.config.ts`, and `package.json` |
| 25 | Rule B3 — services never touch the DB layer | Grep `apps/api/src/modules/**/*.service.ts` for imports from `src/db/` | Zero matches, including `health.service.ts`, which must go through `health.repository.ts` |
| 26 | Rule B4 — web has no path to the database | Grep `apps/web/src` for `drizzle-orm`, `better-sqlite3`, and `apps/api/src` | Zero matches — the HTTP API is the web app's only data path |
| 27 | Contracts are enforced in both apps at compile time | Rename a field in a `@finance/contracts` schema | `npm run typecheck` fails in **both** `apps/api` and `apps/web` |
| 28 | API tests are hermetic | `npm run test:api` twice in a row | All pass both times; no `.db`, `.db-wal`, or `.db-shm` file is created anywhere in the working tree at any point |
| 29 | WAL is skipped for in-memory databases | Run the API test suite with `DB_PATH=:memory:` | No `journal_mode=WAL` PRAGMA is issued; suite passes with no warnings |
| 30 | Seed is repeatable | `npm run db:seed` on a migrated empty DB, then again | Creates exactly one user with a known email and an Argon2id-hashed known password; the second run does not create a duplicate (upsert or clean exit) |
| 31 | Web login flow works against the real API | API and web both running; submit correct credentials in the browser | The `/me` page renders the user's email and the API health status; wrong credentials render an error message, not a blank screen or an unhandled rejection |
| 32 | Unexpected errors become `INTERNAL`, and leak nothing | Force the repository to throw a non-domain error (e.g. close the DB handle) on an authenticated `GET /api/v1/me` | 500 with `{"error":{"code":"INTERNAL", …}}` conforming to `ErrorResponse`; the body contains no stack trace, no SQL text, and no file path; the full error *is* written to the server log |
| 33 | CI gate | Push a branch containing a type error | GitHub Actions fails at the `typecheck` step and does not proceed to `build` |
