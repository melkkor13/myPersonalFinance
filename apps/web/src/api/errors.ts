import type { ErrorBody } from '@finance/contracts';

import { SESSION_EXPIRED_MESSAGE } from './constants';

/**
 * Errors the API layer raises. Both carry a human-readable `message`, because
 * the login screen must render one (case 37) rather than a blank screen.
 */

/** A non-2xx HTTP response. `body` is the FR5 envelope when the API sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorBody | null;

  constructor(status: number, message: string, body: ErrorBody | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The refresh itself failed, so the session is unrecoverable and the tokens
 * have been cleared. Every waiter on the single-flight lock receives this, so
 * a failed refresh logs the user out once and consistently.
 */
export class SessionExpiredError extends Error {
  constructor(cause?: unknown) {
    super(SESSION_EXPIRED_MESSAGE, { cause });
    this.name = 'SessionExpiredError';
  }
}

/** Safe message extraction for rendering; never returns an empty string. */
export function errorMessageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return fallback;
}
