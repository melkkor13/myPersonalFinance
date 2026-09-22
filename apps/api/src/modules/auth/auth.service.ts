/**
 * Auth service — every business rule of login, refresh, logout and `/me` (FR2, FR7).
 *
 * ## Import boundary (B1/B3, asserted statically by task11 — cases 24 and 26)
 * This file imports **no Fastify**, **no `drizzle-orm`**, and **nothing from
 * `src/db/**`**. Its only data access is `auth.repository.ts`; its only failure
 * vocabulary is `lib/errors.ts`. It knows no HTTP status codes — the route and
 * `plugins/errorHandler.ts` own those.
 *
 * ## The three behaviours that matter
 *
 * 1. **Login leaks nothing about which emails exist** (case 32). An unknown email
 *    and a wrong password take the same shape: same thrown error, therefore the
 *    same code, the same {@link UNAUTHENTICATED_MESSAGE}, and no `fields` — the
 *    bodies are byte-identical. The unknown-email branch additionally performs a
 *    **real Argon2id verify against a decoy hash** so the two paths also cost
 *    roughly the same wall-clock time; see {@link TIMING_DECOY_PASSWORD_HASH}.
 *
 * 2. **Refresh rotates** (case 7). A successful refresh mints a new access token
 *    *and* a new refresh token, and revokes the presented one. The client never
 *    reuses a refresh token, which is what makes reuse a reliable compromise
 *    signal.
 *
 * 3. **Replay of an already-rotated refresh token is treated as compromise**
 *    (case 33) — the single most important rule in this module. Because rotation
 *    revokes on use, a token that is found but already revoked means two parties
 *    hold it: the legitimate client and whoever copied it. There is no way to
 *    tell which one is calling, so the safe action is to revoke **every** refresh
 *    token for that user, ending every session, and answer 401. See
 *    {@link refresh}.
 *
 * Every failure in this file throws {@link UnauthenticatedError} and nothing else,
 * so no caller can accidentally surface a more specific reason to the client.
 * Reasons are returned to the *route* as nothing at all; they exist only as the
 * comments and constants below.
 */
import {
  type AuthMode,
  DEFAULT_CURRENCY_CODE,
  type LoginResponse,
  type MeResponse,
  type RefreshResponse,
} from '@finance/contracts';

import type { AppConfig } from '../../config.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import type { CfAccessIdentity } from '../../lib/cloudflare-access.js';
import { hashPassword, unusablePassword, verifyPassword } from '../../lib/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  isRefreshTokenExpired,
  signAccessToken,
} from '../../lib/tokens.js';

import {
  type AuthUser,
  findOrCreateUserByEmail,
  type ProvisionedUser,
  findRefreshTokenByHash,
  findUserByEmail,
  findUserById,
  insertRefreshToken,
  revokeAllRefreshTokensForUser,
  revokeRefreshTokenByHash,
} from './auth.repository.js';

/* ------------------------------------------------------------------ *
 * Named constants
 * ------------------------------------------------------------------ */

/**
 * A real Argon2id PHC string, used **only** to burn the same CPU time that a
 * genuine password check would when the email is unknown (case 32, timing leg).
 *
 * Without this, `login` returns in microseconds for an unknown email and in tens
 * of milliseconds for a known one, and the response time alone enumerates valid
 * accounts — the identical response body would be pointless.
 *
 * It is a literal rather than a hash computed at boot for two reasons: importing
 * this module must stay side-effect free (no top-level `await`), and a
 * lazily-computed decoy would make the *first* unknown-email request pay an extra
 * `hash()` and so be measurably slower than the rest.
 *
 * Its plaintext is a random string that is not a valid password for anybody, and
 * nothing is ever authenticated against it: the verify result is discarded.
 * Parameters (`m=19456,t=2,p=1`) are `@node-rs/argon2` 2.2.1 defaults, i.e. the
 * same cost as every hash `lib/password.ts` produces.
 */
const TIMING_DECOY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$o0VnwW6Pk2r4BqovSu3jAA$D4SMA5P4ltVeINsauuqAdAgBmx0j14nS8FvnTexkoJ4';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * The slice of `AppConfig` this service needs: where the database is, and the
 * secret and TTLs used to mint tokens.
 *
 * Injected by the route from `app.config` rather than imported as a singleton,
 * so a test can drive this service with `ACCESS_TOKEN_TTL=1s` (case 16) without
 * touching `process.env`. `config.ts` is not part of `src/db/**`, so depending on
 * its *type* does not breach B3.
 */
export type AuthConfig = Pick<
  AppConfig,
  'dbPath' | 'jwtSecret' | 'accessTokenTtl' | 'refreshTokenTtl'
>;

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

/**
 * Project a user onto the wire shape for `GET /api/v1/me`.
 *
 * An **explicit allowlist**, not `delete` and not a rest-spread: `password_hash`
 * is absent because the four permitted fields are named, so a column added to
 * `users` later cannot start leaking by default (case 6). Zod's response
 * serialization would also strip unknown keys (C7), but that is a second net
 * beneath this one, not the mechanism.
 */
function toMeResponse(user: AuthUser, authMode: AuthMode): MeResponse {
  return {
    id: user.id,
    email: user.email,
    default_currency: user.default_currency,
    created_at: user.created_at,
    // Not a `users` column: how this caller authenticated is a property of the
    // credential presented on this request, supplied by the `authenticate` hook.
    auth_mode: authMode,
  };
}

/**
 * Mint a refresh token for `userId`, store only its digest, and return the raw
 * token for the client (FR7, case 19).
 */
function issueRefreshToken(config: AuthConfig, userId: string, now: Date): string {
  const minted = generateRefreshToken(config, now);
  insertRefreshToken(config.dbPath, {
    userId,
    // The digest, never `minted.token` — the raw value has no column to go into.
    tokenHash: minted.tokenHash,
    expiresAt: minted.expiresAt,
  });
  return minted.token;
}

/* ------------------------------------------------------------------ *
 * Login
 * ------------------------------------------------------------------ */

/**
 * Authenticate an email/password pair and issue an access + refresh token pair.
 *
 * ## Why both failure paths look the same (case 32)
 * There is exactly one `throw` for both "no such user" and "wrong password", so
 * the response cannot differ in code, message, or the presence of `fields` —
 * `UnauthenticatedError` always carries `UNAUTHENTICATED_MESSAGE` and leaves
 * `fields` undefined, and the error handler omits the key entirely.
 *
 * The unknown-email branch runs {@link verifyPassword} against
 * {@link TIMING_DECOY_PASSWORD_HASH} first. That verify is *expected* to fail and
 * its result is discarded; it exists so that both paths perform one Argon2id
 * verification at identical cost and the response time does not reveal whether
 * the account exists.
 *
 * @throws UnauthenticatedError for an unknown email or a wrong password —
 * indistinguishably.
 */
export async function login(
  config: AuthConfig,
  email: string,
  password: string,
  now: Date = new Date(),
): Promise<LoginResponse> {
  const user = findUserByEmail(config.dbPath, email);

  if (user === undefined) {
    // Timing defence, not a check: burn the same Argon2id cost a real verify
    // would, then fail exactly as a wrong password does. The `void` is
    // deliberate — there is no result to act on.
    await verifyPassword(TIMING_DECOY_PASSWORD_HASH, password);
    throw new UnauthenticatedError();
  }

  const passwordMatches = await verifyPassword(user.password_hash, password);
  if (!passwordMatches) {
    throw new UnauthenticatedError();
  }

  return {
    access_token: await signAccessToken(user.id, config),
    refresh_token: issueRefreshToken(config, user.id, now),
  };
}

/* ------------------------------------------------------------------ *
 * Refresh — rotation and replay detection
 * ------------------------------------------------------------------ */

/**
 * Exchange a refresh token for a new access token **and a new refresh token**,
 * revoking the presented one (FR7, ADR 0001).
 *
 * ## Rotation
 * The returned `refresh_token` always differs from the presented one (case 7):
 * a fresh 32-byte CSPRNG value is minted and stored, and the presented token's
 * row is revoked in the same call. A refresh token is therefore single-use.
 *
 * ## !!! REPLAY DETECTION — the compromise path (case 33) !!!
 * Because rotation revokes on use, a *presented token that is already revoked*
 * cannot be a legitimate client that has kept up with rotation. It means the
 * token value is held by two parties — the real client and whoever copied it —
 * and the server has no way to tell which one is on this request.
 *
 * The only safe response is to assume compromise and **revoke every refresh
 * token belonging to that user**, which ends every session on every device and
 * forces a fresh login with the password. That is strictly worse for the user
 * than a plain 401, and strictly better than letting an attacker keep a live
 * chain, so the blast radius is chosen deliberately.
 *
 * The client's own protection against tripping this by accident is the mandatory
 * single-flight refresh lock (FR7, ADR 0001): two concurrent refreshes with the
 * same token are indistinguishable, here, from theft.
 *
 * ## Ordering
 * Replay is checked **before** expiry: a revoked *and* expired token is still
 * evidence of a leaked value, and the compromise response must not be skipped
 * just because the stolen token had also aged out.
 *
 * An expired (but never used) token is refused with no new tokens issued and no
 * chain-wide revocation — it is an ordinary stale credential, not evidence of
 * theft (case 34).
 *
 * @throws UnauthenticatedError when the token is unknown, replayed, or expired.
 * All three produce the identical 401 body; only the server log distinguishes
 * them, and it does so at the HTTP edge, not here.
 */
export async function refresh(
  config: AuthConfig,
  refreshToken: string,
  now: Date = new Date(),
): Promise<RefreshResponse> {
  // Look up by digest: the presented value is hashed and the hash is the key.
  // The raw token is never compared against anything stored (case 19).
  const stored = findRefreshTokenByHash(config.dbPath, hashRefreshToken(refreshToken));

  if (stored === undefined) {
    // Never issued, or issued against a different database. Nothing to revoke.
    throw new UnauthenticatedError();
  }

  if (stored.revoked_at !== null) {
    // ------------------------------------------------------------------
    // COMPROMISE. This token was already rotated away or logged out, yet it has
    // just been presented again — so the value exists in more than one place.
    // Revoke the user's ENTIRE refresh-token chain before answering 401.
    // ------------------------------------------------------------------
    revokeAllRefreshTokensForUser(config.dbPath, stored.user_id, now);
    throw new UnauthenticatedError();
  }

  if (isRefreshTokenExpired(new Date(stored.expires_at), now)) {
    // Stale, never used. No new tokens, and the rest of the chain is untouched.
    throw new UnauthenticatedError();
  }

  // The row's owner must still exist. With `ON DELETE CASCADE` this is
  // unreachable today, but authorising a token whose user has gone is not a
  // failure mode worth leaving open.
  const user = findUserById(config.dbPath, stored.user_id);
  if (user === undefined) {
    throw new UnauthenticatedError();
  }

  // ROTATE: mint the replacement first, then revoke what was presented. If the
  // insert fails, the caller keeps a token that still works, rather than being
  // logged out by a half-completed rotation.
  const response: RefreshResponse = {
    access_token: await signAccessToken(user.id, config),
    refresh_token: issueRefreshToken(config, user.id, now),
  };

  revokeRefreshTokenByHash(config.dbPath, stored.token_hash, now);

  return response;
}

/* ------------------------------------------------------------------ *
 * Logout
 * ------------------------------------------------------------------ */

/**
 * Revoke the presented refresh token. Returns nothing — the route answers
 * `204 No Content` (case 8).
 *
 * Deliberately **idempotent and silent**: an unknown, already-revoked, or expired
 * token is not an error. Logging out is the outcome the caller wants, and it is
 * already true in every one of those cases; answering 401 would tell an
 * unauthenticated caller which token values exist, and would leave a client that
 * retried a logout stuck with an error it cannot act on.
 *
 * This is not the replay path: a logout does not revoke the user's other
 * sessions. `refresh` is where reuse means compromise.
 */
export function logout(config: AuthConfig, refreshToken: string, now: Date = new Date()): void {
  revokeRefreshTokenByHash(config.dbPath, hashRefreshToken(refreshToken), now);
}

/* ------------------------------------------------------------------ *
 * Me
 * ------------------------------------------------------------------ */

/**
 * The authenticated user's profile, **without `password_hash`** (case 6).
 *
 * `userId` is the `sub` claim of a verified access token, supplied by the
 * `authenticate` hook. A token whose user no longer exists is an authentication
 * failure, not a 404: the credential no longer identifies anybody.
 *
 * @throws UnauthenticatedError when no user has that id.
 */
export function me(config: AuthConfig, userId: string, authMode: AuthMode): MeResponse {
  const user = findUserById(config.dbPath, userId);
  if (user === undefined) {
    throw new UnauthenticatedError();
  }
  return toMeResponse(user, authMode);
}

/* ------------------------------------------------------------------ *
 * Cloudflare Access
 * ------------------------------------------------------------------ */

/**
 * Resolve a verified Cloudflare Access identity to a local user, creating one on
 * first sight (ADR 0010).
 *
 * The identity has **already been proven** by `lib/cloudflare-access.ts` before
 * this is called; nothing here re-decides whether the caller is who they say
 * they are. What it decides is which `users` row that person is.
 *
 * ## Auto-provisioning makes the Access policy the authorization boundary
 * Any address the Cloudflare Access policy admits gets a row here, and every row
 * here has full access to the finance data. There is no second app-side
 * allowlist. Broadening the Access policy — a group, a domain match, an
 * "allow everyone" left behind after debugging — therefore grants data access
 * with no signal in this codebase. That is why provisioning is logged by the
 * caller at `warn`: in a single-user application, creating an account is not an
 * `info`-level event.
 *
 * ## Identity is joined on email
 * If the upstream identity provider ever changes someone's address, they get a
 * fresh empty account rather than their existing one. Accepted for now; the fix
 * is a `users.access_subject` column matched ahead of email, and
 * `identity.subject` is deliberately carried this far so that remains possible.
 */
export async function authenticateCloudflareIdentity(
  config: AuthConfig,
  identity: CfAccessIdentity,
  now: Date = new Date(),
): Promise<ProvisionedUser> {
  // Hashed BEFORE the lookup-or-insert, which is synchronous: awaiting between
  // the read and the write is what would open an interleaving window.
  const passwordHash = await hashPassword(unusablePassword());

  return findOrCreateUserByEmail(
    config.dbPath,
    identity.email,
    passwordHash,
    DEFAULT_CURRENCY_CODE,
    now,
  );
}
