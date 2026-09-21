# 0001. JWT access token with DB-backed refresh token

Date: 2026-09-20

## Status

Accepted

## Context

The finance tracker's Node backend is a standalone HTTP API. The React SPA is one client, and the API is expected to become internet-reachable later so it can be used from a phone; whether a native mobile client is ever built is undecided. Authentication therefore cannot depend on browser-only mechanisms.

Authentication also has to be decided before route and schema work begins. Ownership (`user_id`) and an auth guard touch every route and every table, so retrofitting them later is the most expensive change available in this project. The alternative considered was deferring auth entirely, since the app initially has exactly one user.

The scaffold's slice is deliberately narrow — a health check plus auth, with no finance entity wired end to end — which makes auth the only substantial domain code present at this stage.

## Approaches Considered

### Option A: JWT access token + DB-backed rotating refresh token

Short-lived signed JWT (15 minutes) sent as `Authorization: Bearer`. A long-lived opaque refresh token (30 days) whose SHA-256 hash is stored in a `refresh_tokens` table, rotated on each use and revocable by row.

**Pros:**
- Request path is stateless: no DB lookup to authenticate a normal request.
- Refresh tokens are revocable, so a lost device can be cut off.
- Transport is a plain header, so browser and non-browser clients are treated identically.
- Rotation gives detection of refresh-token replay.
- Correct shape for the planned internet-facing deployment.

**Cons:**
- Two-token flow is more implementation and more client-side logic.
- An access token cannot be revoked inside its 15-minute window.
- Requires careful secret handling (`JWT_SECRET`).
- Rotation makes concurrent refreshes hazardous, so any client holding a refresh token needs a single-flight refresh lock.

### Option B: HttpOnly session cookie

Server-side session with an opaque id in an `HttpOnly`, `Secure`, `SameSite` cookie.

**Pros:**
- Simplest and safest option for a browser; tokens are unreachable from JavaScript.
- Instant server-side revocation.
- Well-trodden, hard to get subtly wrong.

**Cons:**
- Couples the API to browser cookie semantics, contradicting the standalone-API goal.
- Awkward for any non-browser client, which must emulate a cookie jar.
- Requires CSRF defences on every mutating route.

### Option C: Opaque token with a DB lookup per request

A single random token, validated by table lookup on every request.

**Pros:**
- Instantly revocable, with no token-lifetime window.
- Simplest mental model; no signing, no claims, no expiry maths.

**Cons:**
- A database round-trip on every authenticated request.
- No standard client library support.
- Still needs an expiry and renewal story, so it does not avoid much complexity.

### Option D: Defer authentication entirely

Ship with no login. Treat the single local user as implicit and omit `user_id`.

**Pros:**
- Least work in the scaffold; the fastest route to visible features.
- Arguably matches today's actual requirement — one user, on localhost.

**Cons:**
- Adding auth later means editing every route, every query, and every table.
- Cloud hosting is a stated goal, so the work is certain to be needed, only later and more expensively.
- Encourages route code with no ownership concept, which then has to be unlearned.

## Decision

Adopt **Option A**, implemented in the scaffold rather than deferred.

Specifically:

- **Access token:** JWT, `HS256`, 15-minute TTL, claims `sub`/`iat`/`exp`, signed with a `JWT_SECRET` that must be at least 32 characters or boot fails. Sent as `Authorization: Bearer <token>`.

  **On the 15-minute TTL.** This value is the revocation window, not the login duration. Sign-in persistence comes from the 30-day refresh token; access-token expiry only triggers a silent refresh, costing roughly one extra request per 15 minutes of active use. Because a stateless JWT cannot be revoked mid-life, the TTL is precisely how long a leaked token remains usable and how long a "log out this device" action takes to take effect. Lengthening it to several hours would retain the complexity of the two-token design while discarding its principal benefit, so anything beyond roughly one hour makes refresh-token revocation largely cosmetic. `ACCESS_TOKEN_TTL` is configurable, and one hour would be defensible for a single-user deployment; the default is 15 minutes.
- **Refresh token:** 32 CSPRNG bytes, base64url-encoded, 30-day TTL. Only the SHA-256 hash is persisted, in `refresh_tokens`. Rotated on every refresh; presenting an already-rotated token is treated as compromise and revokes all of that user's refresh tokens.
- **Single-flight refresh (mandatory client-side mitigation):** rotation means two concurrent refreshes with the same token would look like a replay and revoke the user's whole token chain. Clients must therefore serialise refreshes — the first 401 performs the refresh while concurrent callers await the same in-flight promise and then retry once. In the web app this lives in `apps/web/src/api/refresh.ts`. That self-inflicted logout is the true cost of a short access-token TTL, and the lock is a requirement rather than an optimisation. It binds any client holding a refresh token; `apps/web` is currently the only one.
- **Passwords:** Argon2id via `@node-rs/argon2`, exclusively — bcrypt appears nowhere in the codebase. Login returns an identical 401 for an unknown email and a wrong password.
- **Schema:** `users` and `refresh_tokens` are created by the scaffold's migrations. All future tables carry `user_id`.
- **Enforcement:** an `authenticate` Fastify plugin populates `request.user`; `GET /api/v1/me` is the scaffold's one protected route.
- **Registration** is a seed/CLI operation. No public signup endpoint, as this is a single-user application.

## Consequences

- **Positive:** Ownership exists before any finance table does, so no retrofit is needed. Authenticated requests cost no extra DB query. The API works unchanged for a future native client or CLI. Lost-device revocation and replay detection are available from day one.
- **Negative:** More scaffold code and test surface before any finance feature ships. An access token stays valid for up to 15 minutes after a logout. Two-token handling plus a single-flight refresh lock has to be implemented in each client that holds a refresh token. The signing secret becomes operationally critical.
- **Neutral:** The web SPA keeps the access token in memory and the refresh token in `localStorage`. This is accepted only because the app is localhost-only today; hardening it is a prerequisite for any non-localhost deployment and is tracked as deferred work. Rate limiting on `/auth/*` is likewise deferred.
