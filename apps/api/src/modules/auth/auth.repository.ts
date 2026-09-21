/**
 * Auth repository — the **only** file in this module that may know a database
 * exists, and the only one allowed to import `drizzle-orm` (FR2, FR3/B1; the
 * rule is asserted statically by the boundary tests, cases 24 and 26).
 *
 * ## What this layer is responsible for
 *   - every `users` / `refresh_tokens` query the auth module needs;
 *   - id generation — UUIDv7 via `v7()` from the `uuid` package. **Not**
 *     `crypto.randomUUID({ version: 7 })`: that option is silently ignored and
 *     returns a v4, with no error anywhere (C2), so the ids would quietly stop
 *     being time-ordered;
 *   - timestamps — `TEXT` ISO-8601 UTC, rendered by `isoTimestamp()` so the one
 *     format in `db/schema.ts` is the only one written;
 *   - the row → domain-object mapping (FR2). Since Q1 made the wire snake_case,
 *     the mapping is now a pure key rename from Drizzle's camelCase column keys
 *     back to the physical snake_case names, with no money conversion to do —
 *     neither auth table has a `_minor` column.
 *
 * ## What it is NOT responsible for
 * No business rules, no token minting, no hashing, no HTTP. It never decides
 * whether a token is acceptable — it reports what is stored and the service
 * decides. It throws no domain errors.
 *
 * ## Only the digest is ever persisted (FR7, case 19)
 * Every function here takes or returns a `token_hash`. The raw token value has
 * no parameter and no column, so there is no code path that could write it: a
 * dump of `refresh_tokens` contains nothing replayable.
 *
 * The connection comes from `getDb()` in `db/client.ts` — the process-wide
 * lazily-opened handle that `health.repository.ts` also reaches through. This
 * module opens no connection of its own.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { getDb } from '../../db/client.js';
import { isoTimestamp, refreshTokens, users } from '../../db/schema.js';

/* ------------------------------------------------------------------ *
 * Domain objects
 * ------------------------------------------------------------------ */

/**
 * A `users` row as the rest of the module sees it.
 *
 * Keys are the physical snake_case column names (FR4 + Q1), so the profile the
 * service returns for `GET /api/v1/me` is this object minus `password_hash` —
 * a projection, not a rename. `password_hash` is present here because `login`
 * cannot verify a password without it, and it is stripped in exactly one place
 * (`toMeResponse()` in `auth.service.ts`, case 6).
 */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly default_currency: string;
  readonly created_at: string;
}

/**
 * A `refresh_tokens` row. `revoked_at` is `null` while the token is live; any
 * non-null value means the token has been rotated away or logged out, which the
 * service treats as replay (FR7, case 33).
 *
 * `expires_at` and `revoked_at` are ISO-8601 strings, exactly as stored; the
 * service parses them. The repository does not compare them against the clock —
 * "is this expired?" is a business rule.
 */
export interface StoredRefreshToken {
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

/** What the service supplies to persist a freshly minted refresh token. */
export interface NewRefreshToken {
  readonly userId: string;
  /** SHA-256 hex digest. The raw token is deliberately not accepted here. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

/** Drizzle `users` row → {@link AuthUser}. */
function toAuthUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email,
    password_hash: row.passwordHash,
    default_currency: row.defaultCurrency,
    created_at: row.createdAt,
  };
}

/** Drizzle `refresh_tokens` row → {@link StoredRefreshToken}. */
function toStoredRefreshToken(row: typeof refreshTokens.$inferSelect): StoredRefreshToken {
  return {
    id: row.id,
    user_id: row.userId,
    token_hash: row.tokenHash,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
  };
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

/**
 * The user with this exact email, or `undefined`.
 *
 * Returning `undefined` rather than throwing is what lets `login` keep the
 * unknown-email and wrong-password paths identical (case 32): both are ordinary
 * values the service handles the same way.
 */
export function findUserByEmail(dbPath: string, email: string): AuthUser | undefined {
  const row = getDb(dbPath).select().from(users).where(eq(users.email, email)).get();
  return row === undefined ? undefined : toAuthUser(row);
}

/** The user with this id, or `undefined`. Backs `GET /api/v1/me`. */
export function findUserById(dbPath: string, id: string): AuthUser | undefined {
  const row = getDb(dbPath).select().from(users).where(eq(users.id, id)).get();
  return row === undefined ? undefined : toAuthUser(row);
}

/* ------------------------------------------------------------------ *
 * Refresh tokens
 * ------------------------------------------------------------------ */

/**
 * Persist a refresh token, storing **only** its SHA-256 digest (FR7, case 19).
 *
 * @returns the stored row, so a caller can assert on it without a second read.
 */
export function insertRefreshToken(dbPath: string, token: NewRefreshToken): StoredRefreshToken {
  const row: typeof refreshTokens.$inferInsert = {
    id: uuidv7(),
    userId: token.userId,
    tokenHash: token.tokenHash,
    expiresAt: isoTimestamp(token.expiresAt),
    revokedAt: null,
    createdAt: isoTimestamp(),
  };

  getDb(dbPath).insert(refreshTokens).values(row).run();

  return toStoredRefreshToken({
    ...row,
    revokedAt: null,
  });
}

/**
 * The stored token with this digest, **whatever its state** — live, revoked, or
 * expired.
 *
 * The lookup deliberately does not filter on `revoked_at IS NULL`. A revoked row
 * that silently looked "not found" would collapse replay (case 33) into a plain
 * unknown-token 401 and the compromise would go undetected, which is precisely
 * the failure this module exists to catch.
 */
export function findRefreshTokenByHash(
  dbPath: string,
  tokenHash: string,
): StoredRefreshToken | undefined {
  const row = getDb(dbPath)
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .get();
  return row === undefined ? undefined : toStoredRefreshToken(row);
}

/**
 * Revoke the single token with this digest. Idempotent: an already-revoked row
 * keeps its original `revoked_at`, because the `IS NULL` guard means the update
 * matches no rows the second time.
 *
 * @returns how many rows were revoked — `0` when the token was unknown or was
 * already revoked.
 */
export function revokeRefreshTokenByHash(
  dbPath: string,
  tokenHash: string,
  now: Date = new Date(),
): number {
  const result = getDb(dbPath)
    .update(refreshTokens)
    .set({ revokedAt: isoTimestamp(now) })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
    .run();
  return result.changes;
}

/**
 * Revoke **every** live refresh token belonging to `userId` — the whole chain,
 * in one statement.
 *
 * This is the compromise response for refresh-token replay (FR7, case 33). It is
 * intentionally a separate, bluntly-named function rather than a flag on
 * {@link revokeRefreshTokenByHash}: the call site in `auth.service.ts` has to read
 * as "log this user's every session out", because that is what it does.
 *
 * Rows already revoked are left untouched (their `revoked_at` stays at the
 * earlier, truthful time) and still count as revoked.
 *
 * @returns how many live tokens were revoked.
 */
export function revokeAllRefreshTokensForUser(
  dbPath: string,
  userId: string,
  now: Date = new Date(),
): number {
  const result = getDb(dbPath)
    .update(refreshTokens)
    .set({ revokedAt: isoTimestamp(now) })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .run();
  return result.changes;
}
