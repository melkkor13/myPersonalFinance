# Test Cases: finance-tracker-scaffold

## Approval Status
test_cases_approved: true

Derived from the 33 acceptance cases in `think/finance-tracker-scaffold.md`, adjusted for the
Q1 (snake_case) and Q2 (no git remote) rulings. Spec case numbers are preserved in the `Spec #`
column so nothing is silently dropped.

**Test Type definitions**
- **Unit** — a single module in isolation, dependencies mocked/stubbed
- **Integration** — multiple components together, or against a real DB/service
- **Manual** — requires human verification (UI flows, visual checks, exploratory)

---

## Happy Path

| # | Spec # | Scenario | Test Type | Assertions | How to Verify |
|---|---|---|---|---|---|
| 1 | 1 | Cold clone bootstrap | Manual | API on `:3000`, web on `:5173`, no errors logged; `GET /api/v1/health` → 200 `{"status":"ok","version":"<pkg version>","db":"ok"}` | Fresh state: `npm install`, write `.env` with 32+ char `JWT_SECRET`, `npm run db:migrate`, `npm run db:seed`, `npm run dev`, then curl health |
| 2 | 1 | Health reports ok through the full chain | Integration | 200; `status: "ok"`, `db: "ok"`, `version` equals `apps/api/package.json` version; the DB was actually queried (not a constant) | `fastify.inject()` on a migrated `:memory:` DB |
| 3 | 4 | Migrations reproducible and idempotent | Integration | First run creates `users` + `refresh_tokens`; **second run applies nothing and exits 0** | `npm run db:reset`, then `npm run db:migrate` twice; assert exit codes and table state |
| 4 | 5 | Only auth tables exist | Integration | Table list is **exactly** `users`, `refresh_tokens`, `__drizzle_migrations`. No `accounts`, `categories`, `transactions`, `budgets` | Query `sqlite_master` after migrate |
| 5 | 8 | OpenAPI document complete and valid | Integration | Valid OpenAPI **3.1**; all five API routes present; named `components/schemas`; each route has a response schema and, where it takes a body, a request schema; logout's 204 declares **no** body; every non-2xx `$ref`s `ErrorResponse` **except** health's 503 → `HealthResponse` | `GET /api/v1/openapi.json`, walk the document |
| 6 | 12 | Happy-path login and access | Integration | Login 200 with `access_token` + `refresh_token` (**snake_case**, per Q1); `/me` 200 with correct `id` and `email`; **no `password_hash` in the response** | Seed a user, inject login then `/me` with the returned token |
| 7 | 15 | Refresh rotates | Integration | 200; new access token; refresh token **differs** from the presented one; old row revoked | Login, then `POST /api/v1/auth/refresh` |
| 8 | 17 | Logout revokes | Integration | **204 with an empty body**; `revoked_at` set on the row; subsequent refresh → 401 | Login, logout, inspect DB, then attempt refresh |
| 9 | 30 | Seed is repeatable | Integration | Creates exactly one user with the known email and an Argon2id hash; **second run creates no duplicate** (upsert or clean exit) | `npm run db:seed` twice on a migrated empty DB; count rows |
| 10 | 7 | Money conversion lossless at 2dp | Unit | `"0.01"`, `"1234.56"`, `"-0.07"`, `"0.00"`, `"999999999.99"` each round-trip string→minor→string **identically**; `"1234.56"` → `123456` | `lib/money.ts` unit tests |
| 11 | 31 | Web login flow against the real API | Manual | `/me` page renders the user's email **and** the API health status | API + web running; submit correct credentials in the browser (Playwright) |
| 12 | 1 | Full CI gate passes locally | Integration | `typecheck`, `lint`, `test`, `build` all exit 0 | `npm run typecheck && npm run lint && npm run test && npm run build` |

---

## Edge Cases

| # | Spec # | Scenario | Test Type | Assertions | How to Verify |
|---|---|---|---|---|---|
| 13 | 3 | Unreachable DB degrades rather than blocks boot | Integration | Server **still binds its port** (contrast case 15 below, where bad config is fatal); health → **503** with a `HealthResponse` body `{"status":"degraded",…,"db":"unavailable"}` — **not** an `ErrorResponse`. Proves `ping()` really queries | Point `DB_PATH` at an unreadable path, start, curl health |
| 14 | 6 | Money-column convention holds | Integration | No column in any table has type `REAL`; every column ending `_minor` is `INTEGER`. **Vacuous by design today** — the two auth tables have no `_minor` columns — wired now so it bites when finance tables land | `PRAGMA table_info` over every table after migrate |
| 15 | 29 | WAL skipped for in-memory DBs | Integration | `journal_mode=WAL` is **never issued** when `DB_PATH=':memory:'`; suite passes with no warnings. **Must assert the call was not made** (e.g. spy on `.pragma()`) — SQLite silently no-ops it and returns `journal_mode: 'memory'` without throwing, so asserting on DB state alone would pass vacuously | Spy on the pragma calls in `db/sqlite.ts` |
| 16 | 14 | Access token expires on schedule | Integration | 401 `UNAUTHENTICATED` after expiry — confirms the TTL is enforced **and** configurable | Issue a token with `ACCESS_TOKEN_TTL=1s`, wait, call `/me` |
| 17 | 21 | Foreign keys enforced at runtime | Integration | Insert rejected with a FK constraint error — proves `PRAGMA foreign_keys=ON` is applied to the **live connection**, not merely declared in the schema | Insert a `refresh_tokens` row with a non-existent `user_id` |
| 18 | 22 | Cascade on user delete | Integration | That user's `refresh_tokens` rows are gone | Delete a user holding refresh tokens; count rows |
| 19 | 19 | Refresh tokens never stored in plaintext | Integration | No row's `token_hash` equals the token returned to the client; each `token_hash` is a **64-char hex** SHA-256 digest | After login, read `refresh_tokens` |
| 20 | 20 | Passwords use Argon2id only | Integration | `users.password_hash` starts with `$argon2id$` and does **not** contain the plaintext; a repo-wide grep for `bcrypt` returns **zero** matches in any manifest or source file | Seed, inspect the hash, grep the repo |
| 21 | 9 | Swagger UI is dev-only | Integration | 404 with `NODE_ENV=production`; 200 with `NODE_ENV=development` | `GET /api/v1/docs` under both env values |
| 22 | 16 | Single-flight refresh prevents self-inflicted logout | Integration | **Exactly one** `POST /api/v1/auth/refresh` is issued; all five requests then succeed; the user is **not** logged out | Web suite: fire five concurrent requests with an expired access token; count MSW invocations |
| 23 | 28 | API tests are hermetic | Integration | All pass **both** times; **no `.db`, `.db-wal`, or `.db-shm` file created anywhere in the working tree at any point** | `npm run test:api` twice; `git status` + `find` for DB artifacts |
| 24 | 23 | Rule B1 — Drizzle out of routes/services/plugins | Integration | `drizzle-orm` matches **only** in `*.repository.ts` and `src/db/**`; zero in `*.routes.ts`, `*.service.ts`, `plugins/**` | Static source scan (not runtime import) |
| 25 | 24 | Rule B2 — SQLite specifics confined to five locations | Integration | `better-sqlite3`, `drizzle-orm/better-sqlite3`, `PRAGMA` match **only** in `src/db/sqlite.ts`, `src/db/client.ts`, `src/db/migrations/**`, `drizzle.config.ts`, `package.json`. **`apps/api/test/**` excluded from the scan** — test files legitimately use PRAGMA to assert schema facts (cases 14, 17, 15) | Static source scan with the test-dir exemption |
| 26 | 25 | Rule B3 — services never touch the DB layer | Integration | Zero `src/db/` imports in any `*.service.ts`, **including `health.service.ts`** | Static source scan |
| 27 | 26 | Rule B4 — web has no path to the database | Integration | Zero matches for `drizzle-orm`, `better-sqlite3`, `apps/api/src` in `apps/web/src` | Static source scan |
| 28 | 27 | Contracts enforced in both apps at compile time | Manual | `npm run typecheck` fails in **both** `apps/api` and `apps/web` | Rename a field in a `@finance/contracts` schema, run typecheck, revert |

---

## Error / Failure Cases

| # | Spec # | Scenario | Test Type | Assertions | How to Verify |
|---|---|---|---|---|---|
| 29 | 2 | Boot fails loudly on bad config | Integration | Both cases exit **non-zero within 2s** with a message naming `JWT_SECRET`; **no port is bound** | Start with `JWT_SECRET` unset, then with a 10-char value |
| 30 | 10 | Request validation rejects bad input | Integration | 400 `{"error":{"code":"VALIDATION_ERROR","fields":["email","password"]}}` — the mapped envelope, **not** Fastify's raw `FST_ERR_VALIDATION` shape | `POST /api/v1/auth/login` with `{"email":"not-an-email"}` and no password |
| 31 | 11 | Protected route rejects missing and bad tokens | Integration | All four → 401 `{"error":{"code":"UNAUTHENTICATED",…}}` and **never reach the handler** | `GET /api/v1/me` with (a) no header, (b) `Bearer garbage`, (c) wrong-secret token, (d) expired token |
| 32 | 13 | Wrong password indistinguishable from unknown email | Integration | Both 401 with **byte-identical bodies** — same code, same `message`, **no `fields`** — so neither reveals whether the email exists | Login with valid email + wrong password, and with an unregistered email; compare raw bodies |
| 33 | 15 | Refresh replay detected as compromise | Integration | Replay → 401 **and every refresh token for that user is revoked** in the DB | Login, refresh, then refresh again with the rotated token; inspect all rows for that user |
| 34 | 18 | Expired refresh token rejected | Integration | 401; **no new tokens issued** | Refresh with a token whose `expires_at` is in the past |
| 35 | 32 | Unexpected errors become `INTERNAL` and leak nothing | Integration | 500 `{"error":{"code":"INTERNAL",…}}` conforming to `ErrorResponse`; body contains **no stack trace, no SQL text, no file path**; the full error **is** written to the server log | Force a non-domain throw (e.g. close the DB handle) on an authenticated `GET /api/v1/me` |
| 36 | 7 | Money rejects >2dp and non-numeric input | Unit | `"1.005"` and non-numeric text are **rejected with a clear error, not rounded** — documenting the fixed-exponent-2 limitation rather than hiding it | `lib/money.ts` unit tests |
| 37 | 31 | Wrong credentials in the browser render an error | Manual | An error message renders — **not** a blank screen, **not** an unhandled rejection | Submit wrong credentials in the browser (Playwright) |
| 38 | — | Boundary tests actually bite | Integration | Deliberately adding a violating import makes the corresponding B1–B4 test **fail** | Add a bad import, run the suite, confirm failure, revert |

---

## Deferred / Blocked

| # | Spec # | Scenario | Status | Reason |
|---|---|---|---|---|
| D1 | 33 | CI gate — push a branch containing a type error; Actions fails at `typecheck` and does not proceed to `build` | **Deferred manual** | Per Q2 there is **no git remote**, so GitHub Actions never runs in this feature. `ci.yml` is written and YAML-validated, but the gate itself is unverifiable here. To complete later: add a remote, push a branch with a deliberate type error, confirm the run fails at `typecheck`. |
| D2 | 31 / 16 | Browser-based verification | **At risk** | The `playwright` MCP server failed to connect this session (`CONNECTION_CLOSED`). If still down at verification time, cases 11, 37 must be reported **blocked, not passed**. Case 22's single-flight assertion is independently covered by the web suite via MSW, so it is not at risk. |

---

## Out of Scope

Not tested, because the scaffold does not build them (FR10, ADR 0009):
- **Finance tables** — `accounts`, `categories`, `transactions`, `budgets`. Case 14 is therefore
  vacuous today and is wired only to start enforcing when they land.
- **Transfers** — the paired-row invariant is an open design question, not scaffold behaviour.
- **Idempotency rule** for client-supplied UUIDv7 ids — deliberately undecided.
- **`NOT_FOUND` / `CONFLICT` / `SERVICE_UNAVAILABLE`** — declared in the `ErrorResponse` enum so
  the envelope shape is stable, but **no scaffold route emits them**, so no test asserts them.
  (The 404 in case 21 comes from Fastify's own not-found handling on a disabled meta route, not
  from this enum.)
- **Multi-currency / non-2dp currencies** — JPY and KWD are unsupported by design; the fixed
  exponent of 2 is asserted in case 36 rather than worked around.
- **CORS** — no CORS config exists; Vite proxies `/api` in dev, and a CORS test would encode a
  behaviour we deliberately don't have.
- **Rate limiting on `/auth/*`**, TLS, secret management beyond `.env`, replacing `localStorage`
  refresh-token storage, CSV import, charts, Postgres migration, and any public registration
  endpoint — all explicitly deferred by ADR 0009.
- **Public registration** — registration is a seed/CLI operation (A5), so there is no signup
  endpoint to test.
