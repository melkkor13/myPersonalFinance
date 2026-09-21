# 0009. Scaffold slice limited to health check and auth

Date: 2026-09-20

## Status

Accepted

## Context

"Scaffold" needs a definition, because it can mean anything from empty directories to a working feature. The useful question is how much must be built to prove the structural decisions are sound, without committing prematurely to details that have not been thought through.

Two forces pull in opposite directions:

- Authentication must exist up front (ADR 0001). Ownership (`user_id`) and an auth guard touch every route and every table, so retrofitting them is the most expensive change available in this project.
- The finance tables have genuinely unresolved design questions: whether account deletion is hard or soft, how transfers are represented as paired rows, and what the idempotency rule is for client-supplied UUIDv7 identifiers. Migrating those tables now would freeze answers that have not been reasoned through.

## Approaches Considered

### Option A: Health check plus auth only

Build config, database connection, migrations, error handling, contracts, tests, and CI. Ship `GET /api/v1/health` and the auth routes. Create only the `users` and `refresh_tokens` tables. Document the finance tables without migrating them.

**Pros:**
- Fastest to review and correct while the structure is still cheap to change.
- Commits to no finance-table column decisions prematurely.
- Still proves every structural element: config validation, the database connection and its PRAGMAs, migrations, the auth flow, the error envelope, the shared contracts package, hermetic tests, and CI.
- Auth, the genuinely expensive-to-retrofit piece, is in place.

**Cons:**
- No CRUD endpoint to copy, so the first finance feature has more to invent — pagination, filtering, and the route/service/repository rhythm for a real entity.
- `lib/money.ts` and the repository mapping conventions are specified and unit-tested but never exercised through an HTTP endpoint.
- The money-column convention test is vacuous until the finance tables exist, so its assertion is unproven.

### Option B: Accounts end to end

Add the `accounts` table and full CRUD alongside the above.

**Pros:**
- Establishes a complete CRUD pattern for later features to imitate.
- Exercises money conversion and repository mapping through real requests.
- Makes the money-column test meaningful immediately.

**Cons:**
- Requires deciding the `accounts` columns, the soft-versus-hard delete question, and the idempotency rule before the feature has been designed.
- More surface to review before any structural feedback is obtained.

### Option C: Accounts and transactions end to end

**Pros:**
- Highest confidence in the patterns; exercises foreign keys, signed amounts, date filtering, and pagination.

**Cons:**
- The most upfront work, and the transfers representation would have to be settled now.
- Largest amount of code written before the structure has been validated.

## Decision

Adopt **Option A**.

**In scope:** npm workspaces layout; `@finance/contracts`; Fastify server with `buildServer()`; Zod-validated configuration that fails fast on boot while an unreachable database only degrades the health check; the SQLite connection with its PRAGMAs and `ping()` wrapped by `health.repository.ts`; `drizzle-kit` migrations creating `users` and `refresh_tokens`; the full auth flow (login, refresh with rotation, logout, `GET /api/v1/me`); the error-handling plugin and `ErrorResponse`; generated OpenAPI; `lib/money.ts` with unit tests; a seed script; boundary tests for the import rules; the web login form and `/me` page with a single-flight refresh lock; and CI.

**Out of scope but documented:** the `accounts`, `categories`, `transactions`, and `budgets` tables; transfers; the idempotency rule; CSV import; charts; multi-currency; TLS; secret management; rate limiting on `/auth/*`; hardened refresh-token storage; and Postgres migration.

## Consequences

- **Positive:** Structural decisions are reviewable quickly, while changing them is still cheap. No finance-table column is frozen before its feature is designed. Authentication and ownership exist before any table that needs them. The deferred-schema boundary is itself asserted by a test, so scope creep into those tables is visible.
- **Negative:** The first finance feature carries more design work, since there is no CRUD exemplar. The money and repository-mapping conventions are documented and unit-tested but unproven end to end, and the money-column convention test is vacuous until those tables land — so the first finance feature must confirm the assertion actually fires.
- **Neutral:** The finance schema is recorded in the specification as a planned shape, so the intent is not lost, but carries no migration and no authority. Each unresolved question — soft delete, transfers, idempotency — is explicitly named as belonging to the feature that will settle it.
