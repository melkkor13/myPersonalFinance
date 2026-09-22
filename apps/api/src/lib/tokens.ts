/**
 * Token issuing and verification (FR7, ADR 0001).
 *
 * ## Why `jose` and not the Fastify JWT plugin
 * That plugin decorates the Fastify instance, which would put token logic in
 * the framework layer — and FR2 forbids `auth.service.ts` from importing Fastify
 * at all. `jose` is framework-agnostic, so this module is a plain function
 * library that the service, the plugin, and unit tests can all call identically.
 *
 * ## Why no `process.env`
 * Secrets and TTLs arrive as parameters (or as the {@link TokenConfig} slice of
 * `AppConfig`). `config.ts` deliberately exposes no singleton, so importing this
 * module has no side effects and a test can issue a 1-second-TTL token without
 * touching the environment (acceptance case 16).
 *
 * ## Refresh tokens are opaque, and only their digest is stored
 * The value handed to the client is 32 CSPRNG bytes, base64url. The database
 * stores **only** its SHA-256 hex digest, so a dump of `refresh_tokens` cannot be
 * replayed (acceptance case 19: every `token_hash` is 64 hex chars and never
 * equals the client's token).
 *
 * No Fastify, no Drizzle (B1/B3).
 */
import { createHash, randomBytes } from 'node:crypto';

import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';

import type { AppConfig } from '../config.js';

/* ------------------------------------------------------------------ *
 * Named constants — algorithms, encodings, byte lengths, claim names
 * ------------------------------------------------------------------ */

/** The only JWS algorithm this application signs or accepts (FR7). */
export const JWT_ALGORITHM = 'HS256';

/** Claim carrying the user id. The access token has no other identity claim. */
export const CLAIM_SUBJECT = 'sub';
/** Issued-at claim, set by `jose` from the signing clock. */
export const CLAIM_ISSUED_AT = 'iat';
/** Expiry claim, derived from the configured access-token TTL. */
export const CLAIM_EXPIRES_AT = 'exp';
/** Exactly the claims an access token carries — nothing else (FR7). */
export const ACCESS_TOKEN_CLAIMS = [CLAIM_SUBJECT, CLAIM_ISSUED_AT, CLAIM_EXPIRES_AT] as const;

/** CSPRNG bytes in a refresh token. 32 bytes → 43 unpadded base64url chars. */
export const REFRESH_TOKEN_BYTES = 32;
/** URL-safe, unpadded encoding for the token handed to the client. */
export const REFRESH_TOKEN_ENCODING = 'base64url';
/** Digest stored in `refresh_tokens.token_hash`. */
export const REFRESH_TOKEN_DIGEST_ALGORITHM = 'sha256';
/** Digest encoding — hex, so the stored value is a fixed-width text column. */
export const REFRESH_TOKEN_DIGEST_ENCODING = 'hex';
/** Length of a SHA-256 hex digest. Asserted by acceptance case 19. */
export const REFRESH_TOKEN_DIGEST_LENGTH = 64;

/** Encoding of the HS256 secret before it is handed to `jose`. */
const SECRET_ENCODING_UTF8 = 'utf8';

/** `Authorization` header scheme for the access token. */
export const BEARER_SCHEME = 'Bearer';
/** Separator between the scheme and the token in the header value. */
const BEARER_SEPARATOR = ' ';

/** Milliseconds per second, for the `exp`/`iat` claims, which are in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/** TTL suffixes accepted by {@link parseDurationToSeconds}, in seconds each. */
const SECONDS_PER_SECOND = 1;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_WEEK = 604_800;
const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: SECONDS_PER_SECOND,
  sec: SECONDS_PER_SECOND,
  secs: SECONDS_PER_SECOND,
  second: SECONDS_PER_SECOND,
  seconds: SECONDS_PER_SECOND,
  m: SECONDS_PER_MINUTE,
  min: SECONDS_PER_MINUTE,
  mins: SECONDS_PER_MINUTE,
  minute: SECONDS_PER_MINUTE,
  minutes: SECONDS_PER_MINUTE,
  h: SECONDS_PER_HOUR,
  hr: SECONDS_PER_HOUR,
  hrs: SECONDS_PER_HOUR,
  hour: SECONDS_PER_HOUR,
  hours: SECONDS_PER_HOUR,
  d: SECONDS_PER_DAY,
  day: SECONDS_PER_DAY,
  days: SECONDS_PER_DAY,
  w: SECONDS_PER_WEEK,
  week: SECONDS_PER_WEEK,
  weeks: SECONDS_PER_WEEK,
};

/** `15m`, `30d`, `1s` — the `jose` duration syntax `config.ts` already validates. */
const DURATION_PATTERN = /^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>[a-z]+)$/i;

const ERROR_INVALID_DURATION = 'is not a valid TTL (expected e.g. "15m", "30d", "1s")';
const QUOTE = '"';
const MESSAGE_SEPARATOR = ' ';

/** Raised only for a malformed TTL string; `config.ts` normally catches these first. */
export class TokenConfigurationError extends Error {
  override readonly name = 'TokenConfigurationError';

  constructor(reason: string, value: string) {
    super(`${QUOTE}${value}${QUOTE}${MESSAGE_SEPARATOR}${reason}`);
  }
}

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The slice of `AppConfig` this module needs. Accepts a whole `AppConfig` too. */
export type TokenConfig = Pick<AppConfig, 'jwtSecret' | 'accessTokenTtl' | 'refreshTokenTtl'>;

/** The verified access-token payload — exactly the three claims FR7 allows. */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
}

/**
 * Why a token was refused.
 *
 * Every one of these becomes a 401 `UNAUTHENTICATED` at the HTTP edge — the
 * client is told nothing more (acceptance case 31). The distinction exists for
 * the server log and for tests: "your clock ran out" and "you forged this" are
 * very different operational events.
 */
export const TOKEN_FAILURE = {
  /** Well-formed, correctly signed, but `exp` has passed (case 16). */
  EXPIRED: 'EXPIRED',
  /** Well-formed, but not signed with `JWT_SECRET`, or a different algorithm. */
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  /** Not a JWT at all, or missing/ill-typed required claims (`Bearer garbage`). */
  MALFORMED: 'MALFORMED',
} as const;

export type TokenFailureReason = (typeof TOKEN_FAILURE)[keyof typeof TOKEN_FAILURE];

/** Discriminated result, so no caller can read claims off a rejected token. */
export type AccessTokenVerification =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: TokenFailureReason };

/** A freshly minted refresh token: the client's copy and the database's copy. */
export interface RefreshTokenPair {
  /** Returned to the client. Never persisted. */
  readonly token: string;
  /** SHA-256 hex digest — the only form stored (case 19). */
  readonly tokenHash: string;
  /** Absolute expiry, for `refresh_tokens.expires_at`. */
  readonly expiresAt: Date;
}

/* ------------------------------------------------------------------ *
 * Access tokens
 * ------------------------------------------------------------------ */

/** Encode the HS256 secret. `jose` takes key material as bytes, not a string. */
function secretKey(jwtSecret: string): Uint8Array {
  return Buffer.from(jwtSecret, SECRET_ENCODING_UTF8);
}

/**
 * Sign an access token for `userId`.
 *
 * Claims are exactly `sub`, `iat`, `exp` — no email, no roles, nothing that would
 * go stale between issue and expiry. TTL comes from `config.accessTokenTtl`,
 * which is why case 16 can set it to `1s` and observe real expiry.
 */
export async function signAccessToken(userId: string, config: TokenConfig): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(config.accessTokenTtl)
    .sign(secretKey(config.jwtSecret));
}

/**
 * Verify an access token, distinguishing the three ways it can fail.
 *
 * Never throws for an untrusted token: a caller that forgets to check `ok`
 * cannot accidentally read claims, because they are not on the failure branch.
 */
export async function verifyAccessToken(
  token: string,
  config: TokenConfig,
): Promise<AccessTokenVerification> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config.jwtSecret), {
      algorithms: [JWT_ALGORITHM],
    });

    const { sub, iat, exp } = payload;
    if (typeof sub !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') {
      // Correctly signed but not one of ours — treat as malformed, never as valid.
      return { ok: false, reason: TOKEN_FAILURE.MALFORMED };
    }

    return { ok: true, claims: { sub, iat, exp } };
  } catch (cause) {
    return { ok: false, reason: classifyVerificationFailure(cause) };
  }
}

/**
 * Map a `jose` verification error onto a {@link TokenFailureReason}.
 *
 * Exported because `lib/cloudflare-access.ts` verifies a *different* JWT (RS256,
 * from the Cloudflare Access edge) but classifies its failures identically. A
 * second `instanceof` ladder there would drift from this one the first time
 * `jose` adds an error class.
 */
export function classifyVerificationFailure(cause: unknown): TokenFailureReason {
  if (cause instanceof joseErrors.JWTExpired) {
    return TOKEN_FAILURE.EXPIRED;
  }
  if (
    cause instanceof joseErrors.JWSSignatureVerificationFailed ||
    cause instanceof joseErrors.JOSEAlgNotAllowed
  ) {
    return TOKEN_FAILURE.INVALID_SIGNATURE;
  }
  // `JWSInvalid`, `JWTInvalid`, `JWTClaimValidationFailed`, and anything else.
  return TOKEN_FAILURE.MALFORMED;
}

/**
 * Pull the token out of an `Authorization: Bearer <token>` header value.
 *
 * @returns `undefined` for a missing header, a different scheme, or an empty
 * token — all of which the caller turns into the same 401 (case 31a).
 */
export function extractBearerToken(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) {
    return undefined;
  }
  const separatorIndex = headerValue.indexOf(BEARER_SEPARATOR);
  if (separatorIndex === -1) {
    return undefined;
  }
  const scheme = headerValue.slice(0, separatorIndex);
  const token = headerValue.slice(separatorIndex + BEARER_SEPARATOR.length).trim();
  if (scheme.toLowerCase() !== BEARER_SCHEME.toLowerCase() || token.length === 0) {
    return undefined;
  }
  return token;
}

/* ------------------------------------------------------------------ *
 * Refresh tokens
 * ------------------------------------------------------------------ */

/**
 * Mint a refresh token: {@link REFRESH_TOKEN_BYTES} CSPRNG bytes, base64url.
 *
 * Returns the client's token, its digest, and its absolute expiry. The caller
 * persists `tokenHash` and `expiresAt` and returns only `token`.
 */
export function generateRefreshToken(
  config: TokenConfig,
  now: Date = new Date(),
): RefreshTokenPair {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString(REFRESH_TOKEN_ENCODING);
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: expiresAtFrom(config.refreshTokenTtl, now),
  };
}

/**
 * SHA-256 hex digest of a refresh token — the lookup key for a presented token
 * and the only form ever written to the database.
 */
export function hashRefreshToken(token: string): string {
  return createHash(REFRESH_TOKEN_DIGEST_ALGORITHM)
    .update(token)
    .digest(REFRESH_TOKEN_DIGEST_ENCODING);
}

/** True when `expiresAt` is at or before `now`. Stored expiry is checked, not `exp`. */
export function isRefreshTokenExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/* ------------------------------------------------------------------ *
 * TTL arithmetic
 * ------------------------------------------------------------------ */

/**
 * `"15m"` → `900`. Supports second, minute, hour, day, and week suffixes — the
 * subset of `jose`'s duration syntax the configuration schema can produce.
 *
 * @throws TokenConfigurationError for an unparseable TTL.
 */
export function parseDurationToSeconds(duration: string): number {
  const groups = DURATION_PATTERN.exec(duration.trim())?.groups;
  const amount = groups?.amount;
  const unit = groups?.unit?.toLowerCase();
  if (amount === undefined || unit === undefined) {
    throw new TokenConfigurationError(ERROR_INVALID_DURATION, duration);
  }

  const unitSeconds = DURATION_UNIT_SECONDS[unit];
  if (unitSeconds === undefined) {
    throw new TokenConfigurationError(ERROR_INVALID_DURATION, duration);
  }

  return Number.parseFloat(amount) * unitSeconds;
}

/** Absolute expiry `ttl` after `now`. Used for `refresh_tokens.expires_at`. */
export function expiresAtFrom(ttl: string, now: Date = new Date()): Date {
  return new Date(now.getTime() + parseDurationToSeconds(ttl) * MILLISECONDS_PER_SECOND);
}
