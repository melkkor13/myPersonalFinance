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
 * No Drizzle (B1): `/me` is authorised from the token's `sub` claim alone; the
 * user row is loaded by the module's repository, not here.
 */
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

import { UNAUTHENTICATED_MESSAGE, UnauthenticatedError } from '../lib/errors.js';
import { extractBearerToken, verifyAccessToken } from '../lib/tokens.js';

/* ------------------------------------------------------------------ *
 * Named constants
 * ------------------------------------------------------------------ */

/**
 * Request header carrying the access token. Lower-case because Node normalises
 * incoming header names, and `request.headers` is keyed by the normalised form.
 */
export const AUTHORIZATION_HEADER = 'authorization';

/** Log lines. The refusal reason is server-side only — never sent to the client. */
const LOG_MESSAGE_MISSING_TOKEN = 'Request has no usable Bearer access token';
const LOG_MESSAGE_REJECTED_TOKEN = 'Access token rejected';

/* ------------------------------------------------------------------ *
 * Request augmentation
 * ------------------------------------------------------------------ */

/**
 * The authenticated principal. Exactly what the access token proves — the user
 * id from `sub` — and nothing that could be stale (FR7 allows no other claim).
 */
export interface AuthenticatedUser {
  readonly id: string;
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
export const authenticate: onRequestAsyncHookHandler = async function authenticateRequest(
  request: FastifyRequest,
): Promise<void> {
  const token = extractBearerToken(request.headers[AUTHORIZATION_HEADER]);
  if (token === undefined) {
    request.log.warn(LOG_MESSAGE_MISSING_TOKEN);
    throw new UnauthenticatedError();
  }

  // The secret and TTLs come from the config decorated onto the instance by
  // `buildServer()`, so this module imports no configuration of its own and a
  // test can drive it with a 1-second TTL (case 16).
  const verification = await verifyAccessToken(token, request.server.config);
  if (!verification.ok) {
    request.log.warn({ reason: verification.reason }, LOG_MESSAGE_REJECTED_TOKEN);
    throw new UnauthenticatedError();
  }

  request.user = { id: verification.claims.sub };
};

/** Re-exported so tests can assert every 401 body against one constant. */
export { UNAUTHENTICATED_MESSAGE };
