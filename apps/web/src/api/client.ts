import { RETRY_COUNT_AFTER_REFRESH } from './constants';
import { isUnauthorized, rawRequest, type RequestOptions } from './http';
import { refreshAccessToken } from './refresh';

/**
 * The request function the app uses for access-token-protected routes.
 *
 * On 401 it awaits the shared single-flight refresh (see `refresh.ts`) and then
 * replays the request `RETRY_COUNT_AFTER_REFRESH` times — i.e. exactly once. A
 * second 401 propagates to the caller, so there is no refresh loop. If the
 * refresh fails, its `SessionExpiredError` propagates instead and the original
 * request is not replayed.
 */
export async function apiRequest<T>(path: string, options: RequestOptions): Promise<T> {
  let attemptsRemaining = RETRY_COUNT_AFTER_REFRESH;

  for (;;) {
    try {
      return await rawRequest<T>(path, options);
    } catch (error) {
      if (attemptsRemaining <= 0 || !isUnauthorized(error)) {
        throw error;
      }
      attemptsRemaining -= 1;
      await refreshAccessToken();
    }
  }
}
