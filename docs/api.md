# API reference

Base path: `/api/v1`. Dev origin: `http://localhost:3000` (or `http://localhost:5173` via the
Vite proxy — identical responses).

**The machine-readable source of truth is `GET /api/v1/openapi.json`**, generated from the Zod
schemas in `@finance/contracts` at boot. This page is prose around that document; if the two
ever disagree, the document is right and this page is stale.

Swagger UI is at `GET /api/v1/docs` and is **development only** — the `@fastify/swagger-ui`
plugin is registered inside a `NODE_ENV === 'development'` branch, so in production the route
does not exist at all and falls through to the not-found handler as a 404.

## Field casing: `snake_case`, everywhere

Every request and response field is `snake_case`: `access_token`, `refresh_token`,
`default_currency`, `created_at`. This was ruling **Q1** in the requirements, and it **overrode**
the original spec and [ADR 0004](adr/0004-rest-json-with-generated-openapi.md) line 63, which
had specified camelCase. ADR 0004 and ADR 0006 now carry `## Amendments` sections recording the
change. There is no `accessToken` anywhere in this codebase, and no case conversion at any
layer — DB columns and wire fields share the same casing.

The repository layer still owns one mapping, but it is no longer a case conversion: money
columns are stored as integer minor units with a `_minor` suffix and go over the wire as decimal
**strings** with the suffix dropped (`amount_minor: 123456` ⇄ `amount: "1234.56"`). No such
column exists yet — see [gotchas.md](gotchas.md).

---

## Routes

Five API routes plus two meta routes.

| Method | Path                   | Auth                                   | Success                               |
| ------ | ---------------------- | -------------------------------------- | ------------------------------------- |
| GET    | `/api/v1/health`       | none                                   | 200 / 503, `HealthResponse` both      |
| POST   | `/api/v1/auth/login`   | none                                   | 200 `LoginResponse`                   |
| POST   | `/api/v1/auth/refresh` | refresh token in body                  | 200 `RefreshResponse`                 |
| POST   | `/api/v1/auth/logout`  | refresh token in body                  | 204, no body                          |
| GET    | `/api/v1/me`           | `Authorization: Bearer <access token>` | 200 `MeResponse`                      |
| GET    | `/api/v1/openapi.json` | none                                   | 200, OpenAPI 3.1 document             |
| GET    | `/api/v1/docs`         | none                                   | 200 in development, 404 in production |

The meta routes are exempt from the contracts rule (FR5) and are `hide: true` in the document,
so it does not document itself.

### `GET /api/v1/health`

No request body. Response (`HealthResponse`) on **both** 200 and 503:

```json
{ "status": "ok", "version": "0.1.0", "db": "ok" }
```

| Field     | Type        | Values                                                    |
| --------- | ----------- | --------------------------------------------------------- |
| `status`  | string enum | `ok` \| `degraded`                                        |
| `version` | string      | read from `apps/api/package.json` at boot, not an env var |
| `db`      | string enum | `ok` \| `unavailable`                                     |

- 200 when the database answered.
- 503 when it did not: `{"status":"degraded","version":"0.1.0","db":"unavailable"}`.

**This is the one documented exception to the error envelope.** A 503 here returns
`HealthResponse`, _not_ `ErrorResponse`, because a monitoring probe needs the per-component
breakdown (which leg is down), not a generic error code. The route declares
`HealthResponseSchema` for both statuses, and a test walks the OpenAPI document asserting that
health's 503 is the only non-2xx response in the whole API that does not `$ref` `ErrorResponse`.

The DB leg is a real query: routes → `health.service.ts` → `health.repository.ts` → `ping()`,
which executes `SELECT 1`. It is not a constant — a readable file containing non-SQLite bytes
opens fine and still reports `unavailable`, which is how the test proves the query happens.

### `POST /api/v1/auth/login`

Request (`LoginRequest`):

```json
{ "email": "owner@example.com", "password": "change-me-please-123" }
```

`email` is a validated email address, max 254 chars. `password` is 8–512 chars.

Response 200 (`LoginResponse`):

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiJ9...",
  "refresh_token": "_GGI9hEqkJLbXHvmCLk-jPle3E81weCGddgp3XX9_A4"
}
```

Errors: 400 `VALIDATION_ERROR`, 401 `UNAUTHENTICATED`.

**Wrong password and unknown email return byte-identical 401 bodies** — same code, same
`message`, no `fields`, same `content-length` — so the response cannot be used to enumerate
registered emails. The unknown-email branch also runs a real Argon2id verification against a
constant decoy hash so the two paths take comparable time (measured 8.7 ms vs 7.3 ms).

### `POST /api/v1/auth/refresh`

Request (`RefreshRequest`): `{ "refresh_token": "<token>" }`
Response 200 (`RefreshResponse`): a new `access_token` **and** a new `refresh_token`.

The presented token is revoked as part of the rotation. Errors: 400 `VALIDATION_ERROR`, 401
`UNAUTHENTICATED` (unknown, expired, revoked, or replayed token).

### `POST /api/v1/auth/logout`

Request (`LogoutRequest`): `{ "refresh_token": "<token>" }`

**Response: 204 with no body, and no declared response schema.** This is one of the two
documented contract exemptions in FR5 (the other is the meta routes). In the OpenAPI document
the 204 entry has a description and no `content`. Errors: 400 `VALIDATION_ERROR` for a malformed
request body. Logging out is idempotent.

### `GET /api/v1/me`

The one protected route. Header: `Authorization: Bearer <access_token>`.

Response 200 (`MeResponse`):

```json
{
  "id": "01a0c468-4ffd-7716-8b1c-5409e6573f70",
  "email": "owner@example.com",
  "default_currency": "USD",
  "created_at": "2026-09-21T14:39:25.693Z"
}
```

`id` is a UUIDv7. `default_currency` is exactly 3 chars (ISO 4217 alpha-3). `created_at` is
ISO-8601 UTC. **`password_hash` is never present** — it is stripped at the repository boundary,
and Zod response serialization emits `additionalProperties: false`, so an accidental extra key
is dropped rather than leaked.

Errors: 401 `UNAUTHENTICATED` for a missing header, a malformed token, a token signed with the
wrong secret, or an expired token. The `authenticate` `onRequest` hook throws before the handler
runs, so an unauthenticated request never reaches route logic.

---

## The error envelope

Every error response except health's 503 has this shape (`ErrorResponse`):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "fields": ["email", "password"]
  }
}
```

`fields` is present **only** for `VALIDATION_ERROR`; every other code omits the key entirely
rather than sending an empty array.

`plugins/errorHandler.ts` is the single mapping point, in this order:

1. `hasZodFastifySchemaValidationErrors(err)` → 400 `VALIDATION_ERROR` with `fields`. Without
   this branch Fastify would emit its own raw `FST_ERR_VALIDATION` shape instead of the envelope.
2. A known domain error from `lib/errors.ts` → its mapped code and status.
3. Anything else → 500 `INTERNAL` with a generic message. The full error and stack go to the
   Pino log at level 50; the response body contains no stack trace, no SQL text and no file path.

### Which codes are reachable

**Reachable** — a route that exists today can return these:

| Code               | Status | Where from                                                                    |
| ------------------ | ------ | ----------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 400    | Zod request-schema failure on any route with a body                           |
| `UNAUTHENTICATED`  | 401    | bad credentials, bad/expired access token, bad/expired/replayed refresh token |
| `INTERNAL`         | 500    | any unexpected throw                                                          |

**Declared but unreachable from a route:**

| Code                  | Status | Note                                                                                                                                                                                       |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOT_FOUND`           | 404    | **Is** returned — by `setNotFoundHandler` for any unmatched route, e.g. `GET /api/v1/nope` → `{"error":{"code":"NOT_FOUND","message":"Resource not found"}}`. No _route handler_ emits it. |
| `CONFLICT`            | 409    | nothing emits it                                                                                                                                                                           |
| `SERVICE_UNAVAILABLE` | 503    | nothing emits it; health's 503 uses `HealthResponse`, not this enum                                                                                                                        |

They are enumerated in `ERROR_CODE` now, deliberately: adding a code later would change the
`ErrorResponse` enum and therefore the generated OpenAPI document, which is a breaking contract
change for every client. Declaring them up front means the envelope shape never changes when the
first finance routes need them. `packages/contracts/src/errors.ts` also exports
`REACHABLE_ERROR_CODES` and `UNREACHABLE_ERROR_CODES` so tests and docs cannot drift from the
enum, and `ERROR_CODE_HTTP_STATUS` in `apps/api/src/lib/errors.ts` is typed
`Readonly<Record<ErrorCode, number>>` — adding a code fails to compile until its status is
decided.

---

## Auth flow

See [ADR 0001](adr/0001-jwt-access-token-with-db-backed-refresh-token.md).

- **Access token** — JWT, HS256, signed with `JWT_SECRET`. Claims: `sub`, `iat`, `exp`. TTL
  **15 minutes** (`ACCESS_TOKEN_TTL`). Sent as `Authorization: Bearer <token>`. Stateless; not
  stored server-side and therefore not individually revocable.
- **Refresh token** — 32 CSPRNG bytes, base64url (43 chars), TTL **30 days**
  (`REFRESH_TOKEN_TTL`). Only its SHA-256 digest (64 hex chars) is stored, in
  `refresh_tokens.token_hash`; the plaintext exists only in the response and on the client. The
  repository API accepts and returns digests only — no function takes a raw token — so plaintext
  cannot reach the database by mistake.
- **Rotation** — every successful refresh issues a new refresh token and revokes the presented
  one (`revoked_at` set).
- **Replay = compromise.** Presenting an already-rotated refresh token returns 401 **and revokes
  every refresh token for that user**, not just the replayed one. Verified live: after replaying
  a rotated token, the token that had legitimately replaced it is also rejected with 401.
- **Passwords** — Argon2id via `@node-rs/argon2`, exclusively. Zero bcrypt anywhere in the repo;
  a test asserts that.

### Consequence for any client

Because a replay revokes everything, a client that fires N parallel refreshes when an access
token expires will log itself out. The web app's single-flight lock in
`apps/web/src/api/refresh.ts` exists to prevent exactly that and is **mandatory for any refresh
token holder**, not an optimisation. See [gotchas.md](gotchas.md).

Client-side token storage today: access token in memory only; refresh token in `localStorage`.
Acceptable only while this is localhost-only over plain HTTP (assumption A4); replacing it is a
prerequisite for any non-localhost deploy (ADR 0009).

---

## OpenAPI document notes

- `openapi: "3.1.0"`. Zod v4's native `z.toJSONSchema` emits JSON Schema draft 2020-12, which
  3.1 requires; Zod 3 emitted draft-07 and could not produce a valid 3.1 document. No
  `zod-to-json-schema`, no `@anatine/zod-openapi`.
- Components are named and referenced, not inlined: routes `$ref`
  `#/components/schemas/ErrorResponse` and friends.
- The document contains **16** component schemas, not 8:
  `fastify-type-provider-zod@7` emits both an output and an input projection of each schema. So
  request bodies reference the `...Input` variant — `POST /api/v1/auth/login`'s body is
  `{"$ref":"#/components/schemas/LoginRequestInput"}`. This is expected; see
  [gotchas.md](gotchas.md).
