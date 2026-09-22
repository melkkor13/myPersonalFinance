import { RETRY_COUNT_AFTER_REFRESH } from './constants';
import { isUnauthorized, rawRequest, type RequestOptions } from './http';
import { refreshAccessToken } from './refresh';
import { getRefreshToken } from './tokens';

/**
 * The request function the app uses for access-token-protected routes.
 *
 * On 401 it awaits the shared single-flight refresh (see `refresh.ts`) and then
 * replays the request `RETRY_COUNT_AFTER_REFRESH` times — i.e. exactly once. A
 * second 401 propagates to the caller, so there is no refresh loop. If the
 * refresh fails, its `SessionExpiredError` propagates instead and the original
 * request is not replayed.
 *
 * A 401 with **no stored refresh token** is terminal: there is nothing to
 * refresh with. This is the normal case under Cloudflare Access, where the
 * browser holds no tokens at all (ADR 0010) — without this check every 401
 * would fire a `POST /auth/refresh` with an empty body, get a 400, and surface
 * `SessionExpiredError` in place of the real failure.
 */
export async function apiRequest<T>(path: string, options: RequestOptions): Promise<T> {
  let attemptsRemaining = RETRY_COUNT_AFTER_REFRESH;

  for (;;) {
    try {
      return await rawRequest<T>(path, options);
    } catch (error) {
      if (attemptsRemaining <= 0 || !isUnauthorized(error) || getRefreshToken() === null) {
        throw error;
      }
      attemptsRemaining -= 1;
      await refreshAccessToken();
    }
  }
}
