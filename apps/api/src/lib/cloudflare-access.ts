/**
 * Cloudflare Access identity — verifying the edge-issued JWT (ADR 0010).
 *
 * In production the app sits behind a Cloudflare Tunnel with Cloudflare Access
 * in front of the hostname. Access authenticates the human at the edge and
 * injects the result into every proxied request as a JWT in the
 * {@link CF_ACCESS_JWT_HEADER} header. This module turns that header value into
 * a {@link CfAccessIdentity}, or into a refusal.
 *
 * ## This is not "trusting a header"
 * The header carries an **RS256 JWT** verified against Cloudflare's published
 * JWKS, with `iss` and `aud` both pinned. Forging one requires Cloudflare's
 * private key, so an attacker who reaches nginx directly — bypassing the tunnel
 * — gains nothing by inventing the header.
 *
 * The `aud` pin is load-bearing rather than decorative: it is the *only* claim
 * scoping a token to this application. A token minted for a different app in the
 * same Zero Trust account is otherwise entirely valid, correctly signed, and
 * unexpired.
 *
 * ## Framework-free (B1/B3)
 * No Fastify, no `drizzle-orm`, nothing from `src/db/**` — the boundary tests
 * assert it. Mirrors the shape of `lib/tokens.ts` deliberately, including the
 * discriminated result, so the two verifiers in this codebase read alike.
 */
import { createRemoteJWKSet, errors as joseErrors, type JWTVerifyGetKey, jwtVerify } from 'jose';

import { classifyVerificationFailure, TOKEN_FAILURE, type TokenFailureReason } from './tokens.js';

/* ------------------------------------------------------------------ *
 * Named constants
 * ------------------------------------------------------------------ */

/**
 * The header Cloudflare Access injects. Lower-case because Node normalises
 * incoming header names and `request.headers` is keyed by the normalised form —
 * the same reason `AUTHORIZATION_HEADER` in `plugins/authenticate.ts` is.
 */
export const CF_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/**
 * Access signs with RS256. Pinned so a token cannot pick its own algorithm.
 *
 * Note this is a *different* algorithm and a different key from
 * `JWT_ALGORITHM` (HS256) in `lib/tokens.ts`. The two verifiers must never be
 * merged into one that accepts both: `alg` confusion — presenting an HS256 token
 * signed with a public value as though it were RS256 — is the classic JWT break,
 * and keeping the pins separate is what forecloses it. Tests assert both.
 */
export const CF_ACCESS_ALGORITHM = 'RS256';

/**
 * Cloudflare also injects `Cf-Access-Authenticated-User-Email`, which is a
 * plain, **unsigned** convenience header. It must never be read: anything that
 * can reach nginx without traversing the tunnel can set it freely. The signed
 * JWT in {@link CF_ACCESS_JWT_HEADER} is the only trustworthy source of
 * identity. Named here because it is the obvious shortcut.
 */
export const CF_ACCESS_UNSIGNED_EMAIL_HEADER_DO_NOT_USE = 'cf-access-authenticated-user-email';

/** Scheme for the derived issuer and JWKS URLs. Access is HTTPS-only. */
const HTTPS_SCHEME = 'https://';

/** Path of the team's JWKS, relative to the team domain. */
const CF_ACCESS_CERTS_PATH = '/cdn-cgi/access/certs';

/** The claim carrying the authenticated human's address. */
const CLAIM_EMAIL = 'email';
/** Claim names `jose` reports on a `JWTClaimValidationFailed`. */
const CLAIM_AUDIENCE = 'aud';
const CLAIM_ISSUER = 'iss';

/**
 * Give up on an unreachable JWKS endpoint rather than holding the request open.
 * A Cloudflare blip must surface as a prompt 401, not as a hung connection on a
 * Raspberry Pi with a small connection budget.
 */
const JWKS_TIMEOUT_MS = 5_000;

/**
 * Minimum gap between JWKS refetches when an unknown `kid` arrives. Access
 * publishes two keys and rotates between them, so an unknown `kid` is normal
 * occasionally; without a cooldown a burst of bad tokens would become a burst of
 * outbound fetches.
 */
const JWKS_COOLDOWN_MS = 30_000;

/** How long a fetched key set is reused before being refreshed. */
const JWKS_CACHE_MAX_AGE_MS = 600_000;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** What an accepted Access JWT proves. Nothing here is read from our database. */
export interface CfAccessIdentity {
  /** The `email` claim, trimmed and lower-cased. See {@link normaliseEmail}. */
  readonly email: string;
  /** The `sub` claim — Cloudflare's identity id. Logged, never persisted. */
  readonly subject: string;
}

/**
 * The slice of `AppConfig` this module needs. Both fields are required here even
 * though they are optional on `AppConfig`, because a verifier is only ever built
 * when Access is enabled — and `config.ts` makes them mandatory in that case.
 */
export interface CfAccessVerifierConfig {
  readonly cfAccessTeamDomain: string;
  readonly cfAccessAud: string;
}

/**
 * Why an Access JWT was refused. Reuses `TokenFailureReason` rather than
 * declaring a parallel vocabulary; only the extra case is new.
 *
 * Every one of these becomes the same 401 `UNAUTHENTICATED`. The distinction is
 * for the server log.
 */
export const CF_ACCESS_FAILURE = {
  ...TOKEN_FAILURE,
  /**
   * Verified, in-date, correctly scoped — but carries no usable `email`.
   *
   * This is the shape of a **Cloudflare service token**: those authenticate a
   * machine and carry `common_name` instead. Refusing them is the point. Do not
   * "fix" this by falling back to `common_name` — auto-provisioning would then
   * create a user account named after a machine credential, and every holder of
   * that credential would share one identity.
   */
  NO_EMAIL_CLAIM: 'NO_EMAIL_CLAIM',
  /**
   * Correctly signed and in date, but minted for a **different Access
   * application** — possibly another app in this same Zero Trust account.
   */
  WRONG_AUDIENCE: 'WRONG_AUDIENCE',
  /** Signed by a different Zero Trust account than the one we are configured for. */
  WRONG_ISSUER: 'WRONG_ISSUER',
  /**
   * The JWKS could not be fetched, or held no key for the token's `kid`.
   *
   * Split out from MALFORMED because it is an entirely different operational
   * event: "Cloudflare is unreachable from the Pi, or has rotated keys faster
   * than our cache" rather than "somebody sent us a forged token". One is an
   * outage to page on, the other is background noise.
   */
  KEYS_UNAVAILABLE: 'KEYS_UNAVAILABLE',
} as const;

export type CfAccessFailureReason =
  | TokenFailureReason
  | typeof CF_ACCESS_FAILURE.NO_EMAIL_CLAIM
  | typeof CF_ACCESS_FAILURE.WRONG_AUDIENCE
  | typeof CF_ACCESS_FAILURE.WRONG_ISSUER
  | typeof CF_ACCESS_FAILURE.KEYS_UNAVAILABLE;

/** Discriminated result, so no caller can read an identity off a refusal. */
export type CfAccessVerification =
  | { readonly ok: true; readonly identity: CfAccessIdentity }
  | { readonly ok: false; readonly reason: CfAccessFailureReason };

/** Verify one header value. Built by {@link createCfAccessVerifier}. */
export type CfAccessVerifier = (token: string) => Promise<CfAccessVerification>;

/* ------------------------------------------------------------------ *
 * URL derivation
 * ------------------------------------------------------------------ */

/**
 * The `iss` value Access puts in its tokens: `https://<team domain>`, no path
 * and no trailing slash.
 *
 * `config.ts` validates `CF_ACCESS_TEAM_DOMAIN` as a bare hostname precisely so
 * this concatenation is safe.
 */
export function issuerUrlFor(teamDomain: string): string {
  return `${HTTPS_SCHEME}${teamDomain}`;
}

/** The team's JWKS endpoint. */
export function jwksUrlFor(teamDomain: string): URL {
  return new URL(`${issuerUrlFor(teamDomain)}${CF_ACCESS_CERTS_PATH}`);
}

/**
 * Trim and lower-case an address so it can be compared against `users.email`.
 *
 * SQLite's unique index is case-sensitive, and nothing else in this codebase
 * normalises email, so `Owner@example.com` from Cloudflare would otherwise
 * provision a *second* row beside an existing `owner@example.com`.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/* ------------------------------------------------------------------ *
 * The verifier
 * ------------------------------------------------------------------ */

/**
 * Build the Access JWT verifier. Call **once per process**, from
 * `buildServer()`.
 *
 * ## Why once
 * `createRemoteJWKSet` is not a pure URL wrapper: the object it returns owns the
 * key cache, the rotation handling for an unknown `kid`, and the coalescing of
 * concurrent fetches. Constructing it per request would fetch the JWKS on every
 * request and defeat all three.
 *
 * @param jwks Injected **only** by tests, which pass a `createLocalJWKSet` over
 * a locally generated key pair so the API suite stays hermetic and offline.
 * Production omits it and gets the remote set.
 */
export function createCfAccessVerifier(
  config: CfAccessVerifierConfig,
  jwks: JWTVerifyGetKey = createRemoteJWKSet(jwksUrlFor(config.cfAccessTeamDomain), {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
  }),
): CfAccessVerifier {
  const issuer = issuerUrlFor(config.cfAccessTeamDomain);

  return async function verifyCfAccessToken(token: string): Promise<CfAccessVerification> {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        // All three pinned. `audience` is what scopes the token to this app;
        // `issuer` is what scopes it to this Zero Trust account.
        algorithms: [CF_ACCESS_ALGORITHM],
        issuer,
        audience: config.cfAccessAud,
      });

      const email = payload[CLAIM_EMAIL];
      const subject = payload.sub;

      // Re-check claim types after verification, as `verifyAccessToken` does: a
      // correctly signed token that is not shaped like a human identity must
      // never be treated as one.
      if (typeof email !== 'string' || normaliseEmail(email).length === 0) {
        return { ok: false, reason: CF_ACCESS_FAILURE.NO_EMAIL_CLAIM };
      }
      if (typeof subject !== 'string' || subject.length === 0) {
        return { ok: false, reason: CF_ACCESS_FAILURE.MALFORMED };
      }

      // `identity_nonce` is deliberately ignored. It exists to call Cloudflare's
      // `/cdn-cgi/access/get-identity` endpoint for group membership, which we
      // do not do: the Access policy is the authorisation decision, and this app
      // has no roles.
      return { ok: true, identity: { email: normaliseEmail(email), subject } };
    } catch (cause) {
      return { ok: false, reason: classifyAccessFailure(cause) };
    }
  };
}

/**
 * Map a `jose` error onto a {@link CfAccessFailureReason}.
 *
 * Delegates everything it does not specialise to
 * {@link classifyVerificationFailure}, so the shared cases (expired, bad
 * signature, malformed) can never drift from the access-token verifier's view of
 * them. The three extra cases exist because they mean something operationally
 * distinct — see {@link CF_ACCESS_FAILURE}. All of them still become the same
 * 401 for the client.
 */
function classifyAccessFailure(cause: unknown): CfAccessFailureReason {
  if (
    cause instanceof joseErrors.JWKSNoMatchingKey ||
    cause instanceof joseErrors.JWKSMultipleMatchingKeys ||
    cause instanceof joseErrors.JWKSTimeout ||
    cause instanceof joseErrors.JWKSInvalid
  ) {
    return CF_ACCESS_FAILURE.KEYS_UNAVAILABLE;
  }
  if (cause instanceof joseErrors.JWTClaimValidationFailed) {
    if (cause.claim === CLAIM_AUDIENCE) {
      return CF_ACCESS_FAILURE.WRONG_AUDIENCE;
    }
    if (cause.claim === CLAIM_ISSUER) {
      return CF_ACCESS_FAILURE.WRONG_ISSUER;
    }
  }
  return classifyVerificationFailure(cause);
}
