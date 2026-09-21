# Task: Auth Module

## Status
COMPLETED

## Description
Login, refresh with rotation and replay detection, logout, and the one protected route.

## Inputs
- requirements.md § FR6, FR7, FR9; ADR 0001

## Steps
1. `auth.repository.ts` — user lookup by email; refresh-token insert/find-by-hash/revoke;
   revoke-all-for-user. **Only the SHA-256 hash is ever persisted** (never the token value).
2. `auth.service.ts` — business rules, throws domain errors, no Fastify, no Drizzle, no
   `src/db/**` import:
   - **login**: verify Argon2id hash; issue access + refresh. Wrong password and unknown email
     must produce a **byte-identical** 401 (same code, same message, no `fields`).
   - **refresh**: validate not expired and not revoked; **rotate** — issue a new access and a
     new refresh token and revoke the presented one. If the presented token is already
     rotated/revoked, treat as compromise: **revoke every refresh token for that user** and 401.
   - **logout**: revoke the presented refresh token; returns nothing (204).
   - **me**: return the authenticated user without `password_hash`.
3. `auth.routes.ts` — the four routes, contracts attached, `authenticate` plugin on `/me`.
   `POST /auth/logout` returns **204 with an empty body** and declares no response schema.
4. Route paths, TTLs, and error messages as named constants.

## Expected Output
Four working routes.

## Verification
Rotation issues a different refresh token; replay revokes all of that user's tokens.

## Dependencies
task07, task05, task06

## Execution Notes
Files: `src/modules/auth/{auth.repository,auth.service,auth.routes}.ts`.
Modified `src/server.ts` — `app.register(authModule)` after `registerOpenApi(app)`.

- `auth.repository.ts` is the only file importing `drizzle-orm` (B1). Its API takes/returns
  **digests only** — no function accepts a raw token parameter, so plaintext cannot reach the DB
  by mistake. UUIDv7 via `uuid`'s `v7()`.
- `auth.service.ts` imports no Fastify, no drizzle, nothing from `src/db/**` (B1/B3 verified).
- **Timing defence implemented:** the unknown-email branch runs a real `verifyPassword()`
  against a constant Argon2id PHC decoy (`TIMING_DECOY_PASSWORD_HASH`) and discards the result,
  so both failure paths perform one Argon2id verification. Kept as a literal rather than a
  boot-time hash so the module stays side-effect-free on import and the first unknown-email
  request is not slower than subsequent ones. Measured: 8.7ms (wrong password) vs 7.3ms
  (unknown email).

### Proofs — 33/33 checks PASS — /private/tmp/.../scratchpad/task09-proofs.txt
1. Login + `/me`: snake_case present, camelCase absent, **no `password_hash` anywhere**
2. Byte-identical 401s: identical bodies AND identical `content-length`, no `fields`
3. Rotation: new access token, **different** refresh token, old row revoked
4. **Replay: 401 and 2/2 of the user's rows revoked**
5. Expired refresh: 401, row count unchanged 3→3 (no tokens issued)
6. Logout: 204, zero-length payload, no content-type, `revoked_at` set, later refresh 401
7. Hash-only storage: no stored hash equals the token, all 64-char hex, returned token's digest present
8. All four case-31 inputs → 401 `UNAUTHENTICATED`
9. OpenAPI: 5 routes, 3.1.0, logout 204 has **no `content`**, every non-2xx `$ref`s
   `ErrorResponse` except health 503 → `HealthResponse`
10. `buildServer()` binds no port

## Carry-forward for task10 (BOTH are flakiness/crash traps)
1. **The 204 exemption must be `response: { 204: z.null() }`.** An empty `content: {}` entry
   **crashes** `@fastify/swagger` (unguarded read of the first media type), and omitting 204
   entirely drops the status from the document. `z.null()` is the only shape that emits `204`
   with no `content`. The handler sends `null` and Fastify strips the payload.
2. **JWT `iat`/`exp` are second-granular, so a refresh issued within the same wall-clock second
   as the login re-mints a BYTE-IDENTICAL access token.** Any assertion that "the refreshed
   access token differs" is flaky unless the test crosses a second boundary (the proof waits
   1.1s). The security-relevant assertion — that the **refresh** token differs — is unaffected
   and is what case 7 should lean on.
