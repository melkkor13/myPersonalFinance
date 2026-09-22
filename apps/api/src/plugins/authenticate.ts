/**
 * Access-token authentication for the one protected route (FR6, FR7).
 *
 * Exposed as an `onRequest` hook, not as a global plugin: only
 * `GET /api/v1/me` is access-token protected, so routes opt in explicitly
 * (`{ onRequest: authenticate }`). A default-on hook would have to carry a
 * public-route allowlist, and forgetting to update that list is how a route
 * silently becomes unauthenticated.
 *
 * ## Why an `onRequest` hook
 * `onRequest` runs before body parsing and before the handler. A rejected token
 * therefore throws `UnauthenticatedError` from the hook, the handler never runs
 * (case 31), and `plugins/errorHandler.ts` performs the single mapping to
 * 401 `UNAUTHENTICATED`. This file writes no status code and no body.
 *
 * ## One response for every failure
 * Missing header, wrong scheme, `Bearer garbage`, a token signed with the wrong
 * secret, and an expired token all throw the same {@link UnauthenticatedError}
 * carrying {@link UNAUTHENTICATED_MESSAGE}, so the 401 bodies are byte-identical
 * (cases 31, 32). The distinguishing `TokenFailureReason` goes to the log only.
 *
 * No Drizzle (B1): the access-token path authorises from the token's `sub` claim
 * alone. The Cloudflare Access path does need a `users` row, and reaches it
 * through `auth.service.ts` — the same layer `/me` uses — never through a
 * repository or `src/db/**` directly.
 *
 * ## Two credentials, one principal (ADR 0010)
 * See {@link authenticate} for the precedence rules. Both paths end at the same
 * `request.user`, and every failure of either throws the same
 * {@link UnauthenticatedError}.
 */
import { AUTH_MODE, type AuthMode } from '@finance/contracts';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

import { CF_ACCESS_JWT_HEADER } from '../lib/cloudflare-access.js';
import { UNAUTHENTICATED_MESSAGE, UnauthenticatedError } from '../lib/errors.js';
import { extractBearerToken, verifyAccessToken } from '../lib/tokens.js';
import { authenticateCloudflareIdentity } from '../modules/auth/auth.service.js';

/* ------------------------------------------------------------------ *
 * Named constants
 * ------------------------------------------------------------------ */

/**
 * Request header carrying the access token. Lower-case because Node normalises
 * incoming header names, and `request.headers` is keyed by the normalised form.
 */
export const AUTHORIZATION_HEADER = 'authorization';

/**
 * Header the web client already sends on every request
 * (`apps/web/src/api/http.ts`). In Cloudflare Access mode it doubles as the
 * CSRF defence — see {@link assertNotCrossSite}.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Methods that cannot change state, and so need no CSRF defence. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Log lines. The refusal reason is server-side only — never sent to the client. */
const LOG_MESSAGE_MISSING_TOKEN = 'Request has no usable credential';
const LOG_MESSAGE_REJECTED_TOKEN = 'Access token rejected';
const LOG_MESSAGE_REJECTED_ASSERTION = 'Cloudflare Access assertion rejected';
const LOG_MESSAGE_MISSING_REQUEST_ID = 'Rejected possible cross-site request with no request id';
const LOG_MESSAGE_PROVISIONED_USER = 'Provisioned new user from Cloudflare Access identity';

/* ------------------------------------------------------------------ *
 * Request augmentation
 * ------------------------------------------------------------------ */

/**
 * The authenticated principal. Exactly what the access token proves — the user
 * id from `sub` — and nothing that could be stale (FR7 allows no other claim).
 */
export interface AuthenticatedUser {
  readonly id: string;
  /**
   * Which credential proved this request. Surfaced on `GET /api/v1/me` so the
   * web app knows whether "sign out" means `POST /auth/logout` or a navigation
   * to Cloudflare's own logout endpoint.
   */
  readonly mode: AuthMode;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by {@link authenticate}. `undefined` on any route that does not use the
     * hook, so a handler cannot mistake an unauthenticated request for an
     * authenticated one by reading this property.
     */
    user?: AuthenticatedUser;
  }
}

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

/**
 * Verify `Authorization: Bearer <token>` and populate `request.user`.
 *
 * @throws UnauthenticatedError for a missing, malformed, wrongly-signed, or
 * expired token. The throw is mapped to 401 `UNAUTHENTICATED` by
 * `plugins/errorHandler.ts`; the route handler is never reached.
 */
/**
 * Reject a request that a third-party page could have caused the browser to send.
 *
 * ## Why this exists only in Cloudflare Access mode
 * The access-token path is structurally immune to CSRF: the credential lives in
 * an `Authorization` header that an attacker's page cannot set on a cross-origin
 * request. Access authentication is the opposite — it is **ambient**. The
 * `CF_Authorization` cookie is sent automatically, so `evil.com` doing
 * `fetch(url, { credentials: 'include' })` gets an assertion attached by the
 * edge and arrives here fully authenticated.
 *
 * ## The mechanism
 * Requiring a custom header makes a cross-origin request "non-simple", so the
 * browser must preflight it. This API deliberately serves **no CORS headers**
 * (C15), so the preflight fails and the real request is never sent. Same-origin
 * requests from our own SPA are unaffected: `apps/web/src/api/http.ts` already
 * sends `X-Request-Id` on every call.
 *
 * Nothing authenticated is mutating *today* — `GET /api/v1/me` is the only
 * guarded route. This is installed now so that the first finance route to be
 * added is safe by default rather than depending on someone remembering.
 */
function assertNotCrossSite(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }
  if (request.headers[REQUEST_ID_HEADER] === undefined) {
    request.log.warn({ method: request.method }, LOG_MESSAGE_MISSING_REQUEST_ID);
    throw new UnauthenticatedError();
  }
}

/**
 * Verify a credential and populate `request.user`.
 *
 * ## Precedence
 * 1. **A present `Cf-Access-Jwt-Assertion` must verify.** Its presence means the
 *    edge asserted an identity, so one that will not verify is an anomaly —
 *    clock skew, a key-rotation gap, or tampering. Falling back to a different
 *    authentication model on an anomaly is how bypasses get built, so this fails
 *    closed rather than falling through. An **absent** header is not an anomaly:
 *    it is the ordinary local-`npm run dev` case, and falls through.
 * 2. **An `Authorization: Bearer` token then decides the principal**, even when a
 *    valid assertion is also present. A CLI or mobile client presenting its own
 *    token must never have that token silently ignored in favour of whatever
 *    identity the edge happens to carry.
 * 3. Otherwise the verified Access identity is used, provisioning a user row on
 *    first sight.
 * 4. Nothing usable → 401.
 *
 * @throws UnauthenticatedError for a missing, malformed, wrongly-signed, expired,
 * or wrongly-scoped credential. The throw is mapped to 401 `UNAUTHENTICATED` by
 * `plugins/errorHandler.ts`; the route handler is never reached.
 */
export const authenticate: onRequestAsyncHookHandler = async function authenticateRequest(
  request: FastifyRequest,
): Promise<void> {
  // The verifier and the config both come off the instance, decorated by
  // `buildServer()`, so this module reads no configuration of its own and a test
  // can drive it with a 1-second TTL (case 16) or a local JWKS.
  const { config, cfAccessVerifier } = request.server;

  const assertion = request.headers[CF_ACCESS_JWT_HEADER];
  const identity =
    cfAccessVerifier !== undefined && typeof assertion === 'string'
      ? await cfAccessVerifier(assertion)
      : undefined;

  // Step 1: fail closed on a present-but-unverifiable assertion.
  if (identity !== undefined && !identity.ok) {
    request.log.warn({ reason: identity.reason }, LOG_MESSAGE_REJECTED_ASSERTION);
    throw new UnauthenticatedError();
  }

  // Step 2: an explicit bearer token wins.
  const token = extractBearerToken(request.headers[AUTHORIZATION_HEADER]);
  if (token !== undefined) {
    const verification = await verifyAccessToken(token, config);
    if (!verification.ok) {
      request.log.warn({ reason: verification.reason }, LOG_MESSAGE_REJECTED_TOKEN);
      throw new UnauthenticatedError();
    }
    request.user = { id: verification.claims.sub, mode: AUTH_MODE.PASSWORD };
    return;
  }

  // Step 3: the verified edge identity.
  if (identity?.ok === true) {
    assertNotCrossSite(request);

    const { user, created } = await authenticateCloudflareIdentity(config, identity.identity);
    if (created) {
      // `warn`, not `info`: in a single-user app a new account is an event worth
      // noticing. `subject` is Cloudflare's opaque identity id; the email is
      // deliberately not logged, and the raw assertion never is — it is a live
      // bearer credential until it expires.
      request.log.warn(
        { subject: identity.identity.subject, userId: user.id },
        LOG_MESSAGE_PROVISIONED_USER,
      );
    }
    request.user = { id: user.id, mode: AUTH_MODE.CLOUDFLARE_ACCESS };
    return;
  }

  // Step 4.
  request.log.warn(LOG_MESSAGE_MISSING_TOKEN);
  throw new UnauthenticatedError();
};

/** Re-exported so tests can assert every 401 body against one constant. */
export { UNAUTHENTICATED_MESSAGE };
