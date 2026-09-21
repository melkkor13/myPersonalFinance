import { ERROR_CODE } from '@finance/contracts';
import { describe, expect, it } from 'vitest';

import { malformedErrorBodyHealthHandler } from '../support/handlers';
import { server } from '../support/server';
import {
  AUTHENTICATION_FAILED_MESSAGE,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_UNAUTHORIZED,
  TEST_FALLBACK_MESSAGE,
  TEST_USER_EMAIL,
  TEST_WRONG_PASSWORD,
} from '../support/constants';
import { loadWebApp } from '../support/harness';

/**
 * Error-envelope parsing and `errorMessageOf`.
 *
 * Both screens render `errorMessageOf(...)` output directly, so these two
 * functions are what stands between an API failure and a blank screen. The
 * malformed-body case matters most: `ErrorResponseSchema.safeParse` failing must
 * still yield a readable `ApiError`, never a thrown parse error.
 */

/** An error object whose `message` is empty — must fall back, not render ''. */
const EMPTY_MESSAGE_ERROR = new Error('');

/** A rejection value that is not an `Error` at all. */
const NON_ERROR_REJECTION = 'plain string rejection';

describe('error envelope parsing', () => {
  it('reads code and message from a well-formed FR5 envelope', async () => {
    const app = await loadWebApp();

    await expect(
      app.endpoints.login({ email: TEST_USER_EMAIL, password: TEST_WRONG_PASSWORD }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: STATUS_UNAUTHORIZED,
      message: AUTHENTICATION_FAILED_MESSAGE,
      body: { code: ERROR_CODE.UNAUTHENTICATED, message: AUTHENTICATION_FAILED_MESSAGE },
    });
  });

  it('falls back to a status-bearing message when the body is not the envelope', async () => {
    server.use(malformedErrorBodyHealthHandler());
    const app = await loadWebApp();

    await expect(app.endpoints.fetchHealth()).rejects.toMatchObject({
      name: 'ApiError',
      status: STATUS_INTERNAL_SERVER_ERROR,
      // No envelope was parsed, so nothing is claimed about the cause.
      body: null,
      message: `${app.constants.UNEXPECTED_RESPONSE_MESSAGE}${String(STATUS_INTERNAL_SERVER_ERROR)}`,
    });
  });
});

describe('errorMessageOf', () => {
  it('prefers the error message, and never renders an empty string', async () => {
    const { errors } = await loadWebApp();

    expect(
      errors.errorMessageOf(new Error(AUTHENTICATION_FAILED_MESSAGE), TEST_FALLBACK_MESSAGE),
    ).toBe(AUTHENTICATION_FAILED_MESSAGE);
    expect(errors.errorMessageOf(EMPTY_MESSAGE_ERROR, TEST_FALLBACK_MESSAGE)).toBe(
      TEST_FALLBACK_MESSAGE,
    );
    expect(errors.errorMessageOf(NON_ERROR_REJECTION, TEST_FALLBACK_MESSAGE)).toBe(
      TEST_FALLBACK_MESSAGE,
    );
  });
});
