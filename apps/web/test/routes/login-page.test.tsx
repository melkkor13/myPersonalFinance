import { ROUTES } from '@finance/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ROUTE_PATHS } from '../../src/routes/paths';
import {
  ALERT_ROLE,
  AUTHENTICATION_FAILED_MESSAGE,
  EMAIL_LABEL,
  EMPTY_COUNT,
  EXPECTED_HEALTH_TEXT,
  NO_REFRESH_CALLS,
  PASSWORD_LABEL,
  SIGN_IN_BUTTON_NAME,
  SIGNED_IN_AS_TEXT,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
  TEST_WRONG_PASSWORD,
  UNHANDLED_REJECTION_FLUSH_MS,
} from '../support/constants';
import {
  countApiRequests,
  loadWebApp,
  renderAppAt,
  trackUnhandledRejections,
} from '../support/harness';

/**
 * The login screen, in jsdom.
 *
 * - **Case 37** (failure): wrong credentials must render a *visible* error —
 *   not a blank screen, and not an unhandled rejection. Both halves are
 *   asserted: the message is queried by its `role="alert"` (the accessible
 *   contract, not a CSS class), and a rejection tracker proves nothing floated.
 *   `LoginPage` uses TanStack Query's `mutate` rather than `mutateAsync`, so the
 *   rejection is captured in `mutation.error`; if that ever changed to a bare
 *   `mutateAsync`, the tracker would catch it.
 * - **Case 11** (success, in-jsdom counterpart of the browser check): the `/me`
 *   view renders the user's email *and* the API health status.
 *
 * The real route tree, guards and providers are rendered — only the history and
 * the query cache are test-local (see `renderAppAt`).
 */

/** Waits one macrotask so a floating rejection would have been reported. */
function flushUnhandledRejections(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, UNHANDLED_REJECTION_FLUSH_MS);
  });
}

function submitCredentials(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText(EMAIL_LABEL), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(PASSWORD_LABEL), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: SIGN_IN_BUTTON_NAME }));
}

describe('login screen', () => {
  it('renders a visible error for wrong credentials, with no blank screen and no unhandled rejection (case 37)', async () => {
    const rejections = trackUnhandledRejections();
    const requests = countApiRequests();
    const app = await loadWebApp();

    renderAppAt(app, ROUTE_PATHS.LOGIN);
    await screen.findByLabelText(EMAIL_LABEL);

    submitCredentials(TEST_USER_EMAIL, TEST_WRONG_PASSWORD);

    // The API's real 401 message, rendered in the `role="alert"` paragraph.
    const alert = await screen.findByRole(ALERT_ROLE);
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent(AUTHENTICATION_FAILED_MESSAGE);

    // NOT a blank screen: the form is still mounted and usable.
    expect(screen.getByLabelText(EMAIL_LABEL)).toBeVisible();
    expect(screen.getByLabelText(PASSWORD_LABEL)).toBeVisible();
    expect(screen.getByRole('button', { name: SIGN_IN_BUTTON_NAME })).toBeEnabled();

    // NOT an unhandled rejection.
    await flushUnhandledRejections();
    rejections.stop();
    expect(rejections.reasons).toHaveLength(EMPTY_COUNT);

    // A failed login is not a reason to refresh: no session existed.
    expect(requests.countOf(ROUTES.AUTH_REFRESH)).toBe(NO_REFRESH_CALLS);
    expect(app.tokens.hasSession()).toBe(false);
  });

  it('renders the /me view with the user email and API health on success (case 11)', async () => {
    const app = await loadWebApp();

    renderAppAt(app, ROUTE_PATHS.LOGIN);
    await screen.findByLabelText(EMAIL_LABEL);

    submitCredentials(TEST_USER_EMAIL, TEST_USER_PASSWORD);

    expect(await screen.findByText(SIGNED_IN_AS_TEXT)).toBeVisible();
    expect(await screen.findByText(TEST_USER_EMAIL)).toBeVisible();
    expect(await screen.findByText(EXPECTED_HEALTH_TEXT)).toBeVisible();

    // Nothing failed on the way there.
    expect(screen.queryByRole(ALERT_ROLE)).toBeNull();
    expect(app.tokens.hasSession()).toBe(true);
  });
});
