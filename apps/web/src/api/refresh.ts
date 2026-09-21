import { ROUTES, type RefreshRequest, type RefreshResponse } from '@finance/contracts';

import { HTTP_METHOD, NO_REFRESH_TOKEN_MESSAGE } from './constants';
import { SessionExpiredError } from './errors';
import { rawRequest } from './http';
import { clearTokens, getRefreshToken, setTokens } from './tokens';

/**
 * # The single-flight refresh lock (FR7, ADR 0001) — mandatory, not an optimisation
 *
 * The API **rotates** refresh tokens: a successful refresh revokes the token
 * that was presented. It also treats a *replayed* (already-rotated) token as
 * evidence of compromise and revokes **every** refresh token for that user.
 *
 * So if N requests 401 at the same moment (the normal case when an access token
 * expires while a page is fetching several resources) and each performed its own
 * refresh, the first would win and the losers would each present the token the
 * winner just rotated away. The API would correctly read that as replay and log
 * the user out of everything — a self-inflicted logout caused purely by client
 * concurrency.
 *
 * This module removes the possibility: **exactly one** `POST /auth/refresh` is
 * ever in flight, and every concurrent caller awaits that same promise.
 *
 * ## The same-tick race
 * `inFlight` is read and assigned in the *same synchronous step*, before any
 * `await`. `performRefresh()` is invoked while building the value, but the
 * assignment completes before control can return to the event loop, so a second
 * caller entering `refreshAccessToken()` in the same tick — or in any tick
 * before the refresh settles — observes a non-null `inFlight` and joins it
 * instead of starting a second request.
 *
 * ## Clearing the lock
 * The stored promise is the one produced by `.finally()`, so `inFlight` is reset
 * to `null` on **success and failure alike**, before waiters resume. Clearing
 * only on success would poison every later request with a permanently stale
 * rejected promise.
 */

/** The in-flight refresh, or `null` when none is running. */
let inFlight: Promise<void> | null = null;

/** Performs one real refresh. Never called concurrently with itself. */
async function performRefresh(): Promise<void> {
  const refreshToken = getRefreshToken();

  if (refreshToken === null) {
    clearTokens();
    throw new SessionExpiredError(new Error(NO_REFRESH_TOKEN_MESSAGE));
  }

  const request: RefreshRequest = { refresh_token: refreshToken };

  try {
    // `rawRequest`, not `apiRequest`: a 401 from the refresh route must never
    // trigger another refresh.
    const tokens = await rawRequest<RefreshResponse>(ROUTES.AUTH_REFRESH, {
      method: HTTP_METHOD.POST,
      body: request,
    });
    setTokens(tokens);
  } catch (error) {
    // The refresh token is spent or rejected: the session cannot be recovered.
    // Clearing here means every waiter below observes the same logged-out state.
    clearTokens();
    throw new SessionExpiredError(error);
  }
}

/**
 * Refreshes the access token, joining the in-flight refresh if there is one.
 *
 * @returns a promise that resolves once new tokens are stored, and rejects with
 *   `SessionExpiredError` for every waiter if the refresh failed.
 */
export function refreshAccessToken(): Promise<void> {
  // Synchronous check-and-set: no `await` between the read and the write, so
  // two callers in the same tick cannot both start a refresh.
  inFlight ??= performRefresh().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** True while a refresh is in flight. Exposed for assertions and diagnostics. */
export function isRefreshInFlight(): boolean {
  return inFlight !== null;
}
