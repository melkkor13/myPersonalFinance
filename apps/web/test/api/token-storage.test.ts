import { describe, expect, it } from 'vitest';

import {
  EXPECTED_REFRESH_TOKEN_STORAGE_KEY,
  EMPTY_COUNT,
  FRESH_ACCESS_TOKEN,
  ROTATED_REFRESH_TOKEN,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from '../support/constants';
import { loadWebApp } from '../support/harness';

/**
 * Token storage split (FR7) — a security property, so it is asserted rather
 * than assumed.
 *
 *   - The **access token is held in memory only**. It must never reach
 *     `localStorage` or `sessionStorage`, where any script on the origin could
 *     read it after the fact and where it would outlive the tab.
 *   - The **refresh token IS in `localStorage`**, so a reload can recover the
 *     session. That is a documented, localhost-only trade-off (see the SECURITY
 *     note in `src/api/tokens.ts`); replacing it with an HttpOnly cookie is a
 *     prerequisite for any non-localhost deployment.
 *
 * The scan below walks **every** key in both web storages rather than checking
 * the one key the app uses, so writing the access token under some other name
 * would still fail.
 */

/** All values currently held in both web storages, regardless of key. */
function allStoredValues(): string[] {
  const values: string[] = [];

  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) {
        values.push(storage.getItem(key) ?? '');
      }
    }
  }

  return values;
}

describe('token storage (FR7)', () => {
  it('pins the storage key the app writes to', async () => {
    const app = await loadWebApp();

    expect(app.constants.REFRESH_TOKEN_STORAGE_KEY).toBe(EXPECTED_REFRESH_TOKEN_STORAGE_KEY);
  });

  it('keeps the access token in memory and the refresh token in localStorage', async () => {
    const app = await loadWebApp();

    await app.endpoints.login({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD });

    // In memory, readable by the HTTP layer.
    expect(app.tokens.getAccessToken()).toBe(FRESH_ACCESS_TOKEN);

    // Persisted, under the pinned key.
    expect(window.localStorage.getItem(EXPECTED_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      ROTATED_REFRESH_TOKEN,
    );

    // The access token is nowhere in either storage, under any key.
    expect(allStoredValues()).not.toContain(FRESH_ACCESS_TOKEN);
    expect(window.sessionStorage.length).toBe(EMPTY_COUNT);
  });

  it('clears both on logout', async () => {
    const app = await loadWebApp();

    await app.endpoints.login({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD });
    await app.endpoints.logout();

    expect(app.tokens.getAccessToken()).toBeNull();
    expect(app.tokens.getRefreshToken()).toBeNull();
    expect(app.tokens.hasSession()).toBe(false);
    expect(allStoredValues()).toHaveLength(EMPTY_COUNT);
  });
});
