/**
 * Minting Cloudflare Access assertions for the test suite — **entirely offline**.
 *
 * The production verifier resolves keys with `jose`'s `createRemoteJWKSet`, which
 * fetches the team's JWKS over the network at verify time. The API suite is
 * hermetic and has no network, so every test builds its verifier over
 * `createLocalJWKSet` instead, backed by a key pair generated here. That is the
 * only reason `createCfAccessVerifier` takes an injectable `jwks` argument.
 *
 * `apps/api/test/cf-access-auth.test.ts` proves the hermeticity rather than
 * assuming it, by making `fetch` throw and asserting a valid assertion still
 * authenticates.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from 'jose';

import { CF_ACCESS_ALGORITHM, issuerUrlFor } from '../../src/lib/cloudflare-access.js';
import {
  TEST_CF_ACCESS_AUD,
  TEST_CF_ACCESS_EMAIL,
  TEST_CF_ACCESS_SUBJECT,
  TEST_CF_ACCESS_TEAM_DOMAIN,
} from './constants.js';

/** Default assertion lifetime — long enough that no test races it. */
const DEFAULT_TTL = '1h';

/** A generated RSA key pair plus a local resolver for its public half. */
export interface CfAccessTestKeys {
  readonly privateKey: CryptoKey;
  /** Hand this to `createCfAccessVerifier` as its second argument. */
  readonly jwks: JWTVerifyGetKey;
}

/**
 * Generate a fresh RS256 key pair and a local JWKS over its public half.
 *
 * `extractable: true` is required because `exportJWK` has to read the public key
 * back out to build the key set.
 */
export async function generateCfAccessKeys(): Promise<CfAccessTestKeys> {
  const { privateKey, publicKey } = await generateKeyPair(CF_ACCESS_ALGORITHM, {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    jwks: createLocalJWKSet({ keys: [{ ...jwk, alg: CF_ACCESS_ALGORITHM }] }),
  };
}

/**
 * Claims a test may override. Every field defaults to something a real, valid
 * Cloudflare assertion would carry, so each case states only its own deviation.
 */
export interface CfAccessClaimOverrides {
  /** `null` omits the claim entirely — the service-token shape. */
  readonly email?: string | null;
  readonly audience?: string;
  readonly issuer?: string;
  readonly subject?: string | null;
  readonly expiresIn?: string;
  /** Present on service tokens instead of `email`. */
  readonly commonName?: string;
  /** Sign with a different key — e.g. another team's, or a forgery. */
  readonly signingKey?: CryptoKey;
}

/** Mint an assertion. Valid by default; each override makes it invalid one way. */
export async function mintCfAccessAssertion(
  keys: CfAccessTestKeys,
  overrides: CfAccessClaimOverrides = {},
): Promise<string> {
  const { email = TEST_CF_ACCESS_EMAIL, subject = TEST_CF_ACCESS_SUBJECT } = overrides;

  const claims: Record<string, unknown> = {};
  if (email !== null) {
    claims.email = email;
  }
  if (overrides.commonName !== undefined) {
    claims.common_name = overrides.commonName;
  }

  let token = new SignJWT(claims)
    .setProtectedHeader({ alg: CF_ACCESS_ALGORITHM })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? issuerUrlFor(TEST_CF_ACCESS_TEAM_DOMAIN))
    .setAudience(overrides.audience ?? TEST_CF_ACCESS_AUD)
    .setExpirationTime(overrides.expiresIn ?? DEFAULT_TTL);

  if (subject !== null) {
    token = token.setSubject(subject);
  }

  return token.sign(overrides.signingKey ?? keys.privateKey);
}

/** Request headers carrying an assertion. Twin of `bearer()` in the harness. */
export function cfAccessAssertion(token: string): Record<string, string> {
  return { 'cf-access-jwt-assertion': token };
}
