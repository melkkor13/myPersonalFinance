import { ROUTES } from '@finance/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { meAlwaysUnauthorizedHandler, ME_BODY, refreshFailureHandler } from '../support/handlers';
import { server } from '../support/server';
import {
  ATTEMPTS_PER_REQUEST_WITH_RETRY,
  CONCURRENT_REQUEST_COUNT,
  EXPECTED_REFRESH_CALLS,
  EXPECTED_REFRESH_CALLS_AFTER_RELEASE,
  EXPIRED_ACCESS_TOKEN,
  FRESH_ACCESS_TOKEN,
  ROTATED_REFRESH_TOKEN,
  STATUS_UNAUTHORIZED,
  STORED_REFRESH_TOKEN,
} from '../support/constants';
import { countApiRequests, loadWebApp, type LoadedWebApp } from '../support/harness';

/**
 * # Case 22 — single-flight refresh prevents a self-inflicted logout (FR7)
 *
 * ## Why this is correctness, not an optimisation
 *
 * The API **rotates** refresh tokens: a successful `POST /api/v1/auth/refresh`
 * revokes the token that was presented and issues a new one. It also treats a
 * *replayed* (already-rotated) token as evidence of compromise and revokes
 * **every** refresh token for that user (API suite case 33).
 *
 * So if N requests 401 at the same moment — the normal case when an access
 * token expires while a page is fetching several resources — and each performed
 * its own refresh, the first would win and the other N-1 would each present the
 * token the winner had just rotated away. The API would correctly read that as
 * replay and log the user out of everything. The user would be signed out by
 * nothing but their own client's concurrency.
 *
 * The lock in `src/api/refresh.ts` removes the possibility:
 *
 * ```ts
 * let inFlight: Promise<void> | null = null;
 * export function refreshAccessToken(): Promise<void> {
 *   inFlight ??= performRefresh().finally(() => { inFlight = null; });
 *   return inFlight;
 * }
 * ```
 *
 * ## Isolating the module-level lock
 *
 * `inFlight` is module-level state. Every test here calls `loadWebApp()`, which
 * does `vi.resetModules()` and re-imports the graph, so each test gets a fresh
 * `inFlight` **and** a fresh in-memory access token. Nothing under test is
 * imported statically in this file — a static import would be a different
 * module instance from the one the test drives, and the tests would bleed into
 * each other silently.
 *
 * ## Why the mocked refresh route is slow on purpose
 *
 * `refreshHandler()` delays before responding, so the refresh cannot settle
 * before the last concurrent caller has observed its 401 and reached
 * `refreshAccessToken()`. Without that delay a passing test would not prove the
 * lock works — only that the first refresh happened to finish early.
 */

/** Puts an expired access token and a valid refresh token in place. */
function seedExpiredSession(app: LoadedWebApp): void {
  app.tokens.setTokens({
    access_token: EXPIRED_ACCESS_TOKEN,
    refresh_token: STORED_REFRESH_TOKEN,
  });
}

describe('single-flight refresh (case 22)', () => {
  let app: LoadedWebApp;

  beforeEach(async () => {
    app = await loadWebApp();
  });

  it('coalesces five concurrent 401s into exactly one refresh, and all five succeed', async () => {
    const requests = countApiRequests();
    seedExpiredSession(app);

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUEST_COUNT }, () => app.endpoints.fetchMe()),
    );

    // THE headline assertion: five parallel expiries, one refresh.
    expect(requests.countOf(ROUTES.AUTH_REFRESH)).toBe(EXPECTED_REFRESH_CALLS);

    // All five original requests completed successfully after the retry.
    expect(results).toHaveLength(CONCURRENT_REQUEST_COUNT);
    for (const me of results) {
      expect(me).toStrictEqual(ME_BODY);
    }

    // Each request was attempted twice: the 401, then the single replay.
    expect(requests.countOf(ROUTES.ME)).toBe(
      CONCURRENT_REQUEST_COUNT * ATTEMPTS_PER_REQUEST_WITH_RETRY,
    );

    // The user is NOT logged out: the rotated pair is stored and usable.
    expect(app.tokens.getAccessToken()).toBe(FRESH_ACCESS_TOKEN);
    expect(app.tokens.getRefreshToken()).toBe(ROTATED_REFRESH_TOKEN);
    expect(app.tokens.hasSession()).toBe(true);

    // The lock was released once the refresh settled.
    expect(app.refresh.isRefreshInFlight()).toBe(false);
  });

  it('retries exactly once: a second 401 propagates instead of looping', async () => {
    server.use(meAlwaysUnauthorizedHandler());
    const requests = countApiRequests();
    seedExpiredSession(app);

    await expect(app.endpoints.fetchMe()).rejects.toMatchObject({
      name: 'ApiError',
      status: STATUS_UNAUTHORIZED,
    });

    expect(requests.countOf(ROUTES.AUTH_REFRESH)).toBe(EXPECTED_REFRESH_CALLS);
    expect(requests.countOf(ROUTES.ME)).toBe(ATTEMPTS_PER_REQUEST_WITH_RETRY);
  });

  it('fails every waiter identically when the refresh itself fails, and clears both tokens', async () => {
    server.use(refreshFailureHandler());
    const requests = countApiRequests();
    seedExpiredSession(app);

    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REQUEST_COUNT }, () => app.endpoints.fetchMe()),
    );

    // Still only one refresh attempt, even though it failed.
    expect(requests.countOf(ROUTES.AUTH_REFRESH)).toBe(EXPECTED_REFRESH_CALLS);

    // Every waiter sees the same unrecoverable-session error — one consistent
    // logout, not a mix of failures and stale successes.
    expect(outcomes).toHaveLength(CONCURRENT_REQUEST_COUNT);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      const reason: unknown = outcome.status === 'rejected' ? outcome.reason : undefined;
      expect(reason).toBeInstanceOf(app.errors.SessionExpiredError);
      expect(reason).toMatchObject({ message: app.constants.SESSION_EXPIRED_MESSAGE });
    }

    // Both tokens are gone: in-memory access token and stored refresh token.
    expect(app.tokens.getAccessToken()).toBeNull();
    expect(app.tokens.getRefreshToken()).toBeNull();
    expect(app.tokens.hasSession()).toBe(false);
  });

  it('releases the lock after a failed refresh so a later request can try again', async () => {
    server.use(refreshFailureHandler());
    const requests = countApiRequests();
    seedExpiredSession(app);

    await expect(app.endpoints.fetchMe()).rejects.toBeInstanceOf(app.errors.SessionExpiredError);

    // `inFlight` holds the promise returned by `.finally()`, so it is nulled on
    // failure as well as success. If it were only cleared on success, the stale
    // rejected promise would poison every later request.
    expect(app.refresh.isRefreshInFlight()).toBe(false);

    // A fresh session, and the refresh route works again.
    server.resetHandlers();
    seedExpiredSession(app);

    await expect(app.endpoints.fetchMe()).resolves.toStrictEqual(ME_BODY);

    // Two refreshes in total: the one that failed, and the later fresh attempt.
    // A poisoned lock would have replayed the first rejection and never issued
    // this second request at all.
    expect(requests.countOf(ROUTES.AUTH_REFRESH)).toBe(EXPECTED_REFRESH_CALLS_AFTER_RELEASE);
  });
});
