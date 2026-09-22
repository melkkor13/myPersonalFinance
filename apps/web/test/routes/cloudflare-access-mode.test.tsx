import { CF_ACCESS_LOGOUT_PATH } from '@finance/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROUTE_PATHS } from '../../src/routes/paths';
import {
  EXPECTED_HEALTH_TEXT,
  EXPECTED_REFRESH_TOKEN_STORAGE_KEY,
  NO_REFRESH_CALLS,
  SIGNED_IN_AS_TEXT,
  TEST_USER_EMAIL,
} from '../support/constants';
import { cloudflareAccessMeHandler } from '../support/handlers';
import { countApiRequests, loadWebApp, renderAppAt } from '../support/harness';
import { server } from '../support/server';

/**
 * The web app behind Cloudflare Access (ADR 0010).
 *
 * The defining difference from password mode is that **the browser holds no
 * credential**. `localStorage` stays empty, no `Authorization` header is sent,
 * and the session exists only as Cloudflare's `HttpOnly` cookie plus the signed
 * header the edge injects — neither of which this code can see.
 *
 * The MSW handler therefore 401s any request that *does* carry a bearer token,
 * so a regression that reintroduced token storage would fail here rather than
 * passing quietly.
 */

const SIGN_OUT_BUTTON_NAME = 'Sign out';
/** `/auth/refresh` must never be called: there is no refresh token to rotate. */
const REFRESH_PATH = '/api/v1/auth/refresh';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cloudflare Access mode', () => {
  it('admits the user to /me with an empty localStorage', async () => {
    server.use(cloudflareAccessMeHandler());
    const app = await loadWebApp();

    renderAppAt(app, ROUTE_PATHS.ME);

    expect(await screen.findByText(TEST_USER_EMAIL)).toBeTruthy();
    expect(screen.getByText(SIGNED_IN_AS_TEXT)).toBeTruthy();
    expect(window.localStorage.getItem(EXPECTED_REFRESH_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('does not attempt a token refresh', async () => {
    // Without the "no refresh token means a 401 is terminal" check in
    // `client.ts`, every 401 in Access mode would fire a pointless
    // `POST /auth/refresh` with an empty body and surface SessionExpiredError.
    server.use(cloudflareAccessMeHandler());
    const app = await loadWebApp();
    const counts = countApiRequests();

    renderAppAt(app, ROUTE_PATHS.ME);
    await screen.findByText(TEST_USER_EMAIL);

    expect(counts.countOf(REFRESH_PATH)).toBe(NO_REFRESH_CALLS);
  });

  it('reports the Cloudflare Access mode to the token store', async () => {
    server.use(cloudflareAccessMeHandler());
    const app = await loadWebApp();

    renderAppAt(app, ROUTE_PATHS.ME);
    await screen.findByText(TEST_USER_EMAIL);

    expect(app.tokens.isCloudflareAccessMode()).toBe(true);
    // The mode alone is proof of a session: it is only ever set from a
    // successful `/me`, and there is no token to test for.
    expect(app.tokens.hasSession()).toBe(true);
    expect(app.tokens.getAccessToken()).toBeNull();
  });

  it('redirects /login to /me instead of showing an unusable form', async () => {
    server.use(cloudflareAccessMeHandler());
    const app = await loadWebApp();

    renderAppAt(app, ROUTE_PATHS.LOGIN);

    // The guard probes `/me`, finds a live edge session, and forwards. A
    // storage-only guard would have rendered the password form here.
    expect(await screen.findByText(TEST_USER_EMAIL)).toBeTruthy();
    expect(await screen.findByText(EXPECTED_HEALTH_TEXT)).toBeTruthy();
  });

  it('signs out by navigating to Cloudflare, not by calling /auth/logout', async () => {
    // `/cdn-cgi/access/logout` is terminated at the Cloudflare edge and never
    // reaches our origin, so this must be a full-page navigation. A `fetch`
    // would appear to succeed while leaving the user signed in.
    server.use(cloudflareAccessMeHandler());
    // jsdom's own `location.assign` throws "not implemented", and `location`
    // is non-configurable, so the whole global is stubbed for this test.
    const assign = vi.fn();
    vi.stubGlobal('location', { href: window.location.href, assign });

    const app = await loadWebApp();
    renderAppAt(app, ROUTE_PATHS.ME);
    await screen.findByText(TEST_USER_EMAIL);

    fireEvent.click(screen.getByRole('button', { name: SIGN_OUT_BUTTON_NAME }));

    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledWith(CF_ACCESS_LOGOUT_PATH);
    });
  });
});
