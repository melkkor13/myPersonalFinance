# 0010. Cloudflare Access as the primary authentication for browsers

Date: 2026-09-22

## Status

Accepted. Supersedes part of [ADR 0001](0001-jwt-access-token-with-db-backed-refresh-token.md)'s
"Consequences" (the acceptance of `localStorage` for refresh tokens) and **supersedes Decision 9**
of `think/deploy-to-raspberry-pi-via-github-actions.md` (move the refresh token to an `HttpOnly`
cookie). Decision 9 must not also be implemented — there is no longer a browser-held refresh token
to protect.

## Context

The application runs on a Raspberry Pi 5, reached from the internet through a Cloudflare Tunnel, and
the intended hostname is `fin.kryp7x.com`. Cloudflare Access is the authentication layer in front of
it.

Observed behaviour of Access in this Cloudflare account, against an application on the same zone
(the apex, `kryp7x.com`) that was already protected when this was written:

- `GET /` answers `302` to
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<hostname>?kid=<aud>`, sets a
  `CF_AppSession` cookie, and sends `WWW-Authenticate: Cloudflare-Access`.
- Every path redirects identically, including `/api/v1/health` and `/api/v1/openapi.json`, so an
  Access application covers the whole hostname rather than just the document root.
- The team's JWKS is at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, RS256, with two
  keys published for rotation.
- `/.well-known/openid-configuration` exposes only `issuer` and `jwks_uri`.

**`aud` is per application, not per account or per zone.** The apex's AUD tag is not
`fin.kryp7x.com`'s; a token minted for one is refused by the other, which is the pin working
correctly rather than a misconfiguration. Read the tag from the application's own Overview tab, or
from the `kid` parameter of its login redirect. It is deliberately not recorded here — hardcoding
one application's tag in the documentation is how the wrong value gets copied into `.env`.

Without this change a user authenticated **twice**: once at the edge, then again against
`POST /api/v1/auth/login`. The API ignored an identity Cloudflare had already proved, and the
scaffold's browser-side token handling — a 30-day refresh token in `localStorage` — remained the
deployment's largest outstanding security gap.

Two constraints shaped the decision:

1. **Password login cannot be removed.** It is the only way to run `npm run dev`, where no edge and
   no injected header exist, and it is the path any future CLI or mobile client will use.
2. **Cloudflare Access cannot act as an OIDC provider.** Its
   `/.well-known/openid-configuration` exposes only `issuer` and `jwks_uri` — no
   `authorization_endpoint`, no `token_endpoint`. Access _consumes_ identity providers; it does not
   present itself as one. An authorization-code flow against it was therefore never available, and
   the choice was only ever about what to do with the header it injects.

## Approaches Considered

### Option A: Verify the injected assertion on every request

The `authenticate` hook accepts a verified `Cf-Access-Jwt-Assertion` header. The browser holds no
credential at all.

**Pros:**

- Deletes the `localStorage` refresh token rather than relocating it. The credential becomes
  Cloudflare's `HttpOnly` `CF_Authorization` cookie, which this origin's JavaScript cannot read.
- Deletes the entire browser-side refresh machinery: no rotation, no replay risk, and the
  single-flight lock that exists only because rotation makes concurrent refresh a self-inflicted
  global logout becomes inert for browsers.
- No new route and no new schema.
- Cost: nothing. The Zero Trust free plan covers 50 users and verification is local JWKS work with
  no Cloudflare API calls.

**Cons:**

- Two principal-establishment paths in the guard instead of one.
- Introduces **ambient authority**, and with it CSRF exposure — see "Consequences".
- Revocation latency is the assertion's remaining lifetime (see `identity_nonce` below).

### Option B: A `POST /api/v1/auth/cloudflare` exchange endpoint

Verify the assertion once, then mint the existing access/refresh pair.

**Pros:**

- One downstream authentication model; the guard is untouched.
- Works even if some requests bypass the edge.

**Cons:**

- **Puts the refresh token straight back into `localStorage`**, reinstating the exact gap the
  deployment needed to close. This is decisive.
- The endpoint is an authority amplifier: any page load through Access can mint a 30-day credential,
  which is strictly more authority than the request that created it.
- Revoking the user at the edge leaves that 30-day chain live.

### Option C: Move session issuance to a Cloudflare Worker with KV/D1

**Pros:** would centralise sessions at the edge.
**Cons:** the product _is_ a single SQLite file on the Pi. Wholly disproportionate, and it would
split state across two systems.

## Decision

Adopt **Option A**, alongside the existing password login rather than in place of it.

- **Verification** (`apps/api/src/lib/cloudflare-access.ts`): RS256 pinned, `issuer` pinned to
  `https://<CF_ACCESS_TEAM_DOMAIN>`, `audience` pinned to `CF_ACCESS_AUD`. Keys come from
  `createRemoteJWKSet`, constructed **once** per process in `buildServer` because that object owns
  the key cache, the rotation handling for an unknown `kid`, and the coalescing of concurrent
  fetches.

  The `aud` pin is load-bearing, not decorative: it is the only claim scoping a token to _this_
  application. A token minted for a different app in the same Zero Trust account is otherwise
  correctly signed, in date, and from the right issuer.

- **This is not "trusting a header".** The value is a signed JWT verified against Cloudflare's
  published keys. Someone who reaches nginx without traversing the tunnel gains nothing by inventing
  the header. The _unsigned_ `Cf-Access-Authenticated-User-Email` header Cloudflare also sends is
  named in the source as something never to read, because it is the obvious shortcut and it is
  trivially spoofable on that path.

- **Precedence** (`apps/api/src/plugins/authenticate.ts`), in order:

  1. **A present assertion must verify.** Its presence means the edge asserted an identity, so one
     that will not verify is an anomaly — clock skew, a key-rotation gap, or tampering. This **fails
     closed** rather than falling through, because silently downgrading to a different
     authentication model on an anomaly is how bypasses get built. An _absent_ header is not an
     anomaly: it is the ordinary local-dev case, and falls through.
  2. **An explicit `Authorization: Bearer` then decides the principal**, even when a valid assertion
     is also present, so a CLI or mobile client's own token is never silently ignored.
  3. Otherwise the verified Access identity is used.
  4. Nothing usable → 401.

- **Identity mapping:** matched on the `email` claim, normalised (trimmed and lower-cased) because
  SQLite's unique index is case-sensitive and nothing else in the codebase normalises email. A user
  row is **created on first sight**. This reverses ADR 0001's "registration is a seed/CLI operation"
  for the Access path only.

- **Service tokens are refused.** They carry `common_name` and no `email`, and they pass signature,
  issuer and audience checks perfectly — so refusing them is an explicit decision about the claim
  set, not something JWT validation provides for free. The check is "is there a usable email", not
  "is `common_name` absent", so a future token type with neither claim also fails.

- **`users.password_hash` holds an Argon2id hash of 32 discarded CSPRNG bytes** for a provisioned
  account. A marker string such as `'!cloudflare-access'` was rejected: `verifyPassword` answers
  `false` for a malformed hash in microseconds versus tens of milliseconds for a real verify, which
  would have made "this address is an Access account" measurable from response time — a _better_
  account oracle than the one `TIMING_DECOY_PASSWORD_HASH` was added to destroy. Making the column
  nullable was rejected too: `string | null` propagates into `login`, and someone eventually writes
  `if (hash === null) throw` and reintroduces the same branch. Hashing real entropy means `login`
  needs **no branch at all** and inherits its byte-identical body and equal cost unchanged.

- **The web app** learns which mode it is in from `auth_mode` on `GET /api/v1/me`, the one request
  it already makes. Route guards resolve the session by probing `/me` (cached, `staleTime: 'static'`)
  with a synchronous stored-token fast path. Signing out of an Access session is a full-page
  navigation to `/cdn-cgi/access/logout`, which the edge terminates and which never reaches our
  origin — a `fetch` there would appear to succeed while leaving the user signed in.

- **Configuration:** `CF_ACCESS_ENABLED` (default `false`), `CF_ACCESS_TEAM_DOMAIN`,
  `CF_ACCESS_AUD`. Enabling the first without the other two is a fatal boot error.

## Consequences

- **Positive.** The browser holds no credential, so the `localStorage` gap is gone rather than
  moved. `POST /auth/login` is unreachable from the internet, so the unthrottled-Argon2id
  CPU-exhaustion target does not exist for external callers. `/api/v1/openapi.json` and
  `/api/v1/health` are no longer anonymously reachable. Signing in is one step instead of two. The
  API is unchanged for non-browser clients.

- **Negative — CSRF is now possible in principle, and is defended explicitly.** Access
  authentication is _ambient_: the `CF_Authorization` cookie is sent automatically, so a
  third-party page doing `fetch(url, { credentials: 'include' })` arrives fully authenticated. The
  access-token path was structurally immune to this because an attacker's page cannot set an
  `Authorization` header. The guard therefore requires the `X-Request-Id` header — which the SPA
  already sends on every request — on any non-`GET` authenticated request in Access mode. A custom
  header makes a cross-origin request non-simple, forcing a preflight, and this API deliberately
  serves no CORS headers (C15), so the preflight fails. **Nothing authenticated is mutating today**;
  this is installed now so the first finance route added is safe by default rather than depending on
  someone remembering.

- **Negative — the Access policy is now the entire authorization boundary.** With auto-provisioning,
  any address the Cloudflare policy admits gets a user row with full access to the finance data, and
  there is no second app-side allowlist. Broadening that policy — a group, a domain match, an
  "allow everyone" left behind after debugging — grants data access with no signal in this
  codebase. Provisioning is logged at `warn` for that reason: in a single-user application, creating
  an account is not an `info`-level event.

- **Negative — revocation latency equals the assertion's remaining lifetime.** Cloudflare's "revoke
  user sessions" action invalidates the `identity_nonce` claim, and the only way to observe that is
  to call `/cdn-cgi/access/get-identity` with the token on every request. We deliberately do not, so
  `identity_nonce` is ignored. Mitigate by keeping the application's Zero Trust session duration
  short (24h rather than the longer options). A _user-initiated_ logout is immediate, because the
  edge clears the cookie.

- **Neutral — identity is joined on email.** If the upstream identity provider ever changes
  someone's address they get a fresh, empty account rather than their existing one. Low risk for a
  single-user app. The fix is a nullable `users.access_subject` column with a unique index, matched
  ahead of email; `identity.subject` is carried through the service layer specifically so that
  remains possible without re-plumbing.

- **Neutral.** The `users` table does not record which accounts are passwordless, a direct
  consequence of choosing a real hash over a marker. If that is ever needed, add a separate
  `auth_provider` column — and never branch `login` on it.
