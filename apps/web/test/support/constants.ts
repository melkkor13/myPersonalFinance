/**
 * Every literal the web test suite needs, as a named constant (project
 * convention: no inline magic values, in tests too).
 *
 * Route paths are deliberately NOT declared here — they come from `ROUTES` in
 * `@finance/contracts`, which is the same source the app and the API use
 * (ADR 0008). A renamed route therefore breaks the mocks too.
 */

/**
 * Case 22's concurrency: how many protected requests are fired simultaneously
 * with an already-expired access token.
 */
export const CONCURRENT_REQUEST_COUNT = 5;

/**
 * Artificial latency on the mocked refresh route.
 *
 * Load-bearing: it guarantees the refresh cannot settle before the last of the
 * `CONCURRENT_REQUEST_COUNT` callers has observed its 401 and reached
 * `refreshAccessToken()`. Without it the test could pass simply because the
 * first refresh finished early, rather than because the lock works.
 */
export const REFRESH_HANDLER_DELAY_MS = 20;

/** Exactly one refresh may ever be in flight (FR7). */
export const EXPECTED_REFRESH_CALLS = 1;
/** A failed refresh, then a later attempt: proves the lock was released. */
export const EXPECTED_REFRESH_CALLS_AFTER_RELEASE = 2;
/** No refresh at all. */
export const NO_REFRESH_CALLS = 0;

/** One original attempt plus the single replay (`RETRY_COUNT_AFTER_REFRESH`). */
export const ATTEMPTS_PER_REQUEST_WITH_RETRY = 2;

/** Nothing was stored / nothing was rejected. */
export const EMPTY_COUNT = 0;

/**
 * Tokens. Opaque strings, never parsed as JWTs by the client — the mock decides
 * which one is accepted, exactly as the real API's signature check would.
 */
export const EXPIRED_ACCESS_TOKEN = 'access-token-expired';
export const FRESH_ACCESS_TOKEN = 'access-token-fresh';
export const STORED_REFRESH_TOKEN = 'refresh-token-stored';
export const ROTATED_REFRESH_TOKEN = 'refresh-token-rotated';

/** The user the mocked API knows about. */
export const TEST_USER_ID = '019402f2-7b6f-7000-8000-0000000000aa';
export const TEST_USER_EMAIL = 'tester@example.com';
export const TEST_USER_PASSWORD = 'correct-horse-battery-staple';
export const TEST_USER_CURRENCY = 'USD';
export const TEST_USER_CREATED_AT = '2026-01-01T00:00:00.000Z';

/** Valid per the contract (>= `PASSWORD_MIN_LENGTH`) but wrong for that user. */
export const TEST_WRONG_PASSWORD = 'wrong-horse-battery-staple';

/** The API's real 401 copy, reproduced verbatim so case 37 asserts real text. */
export const AUTHENTICATION_FAILED_MESSAGE = 'Authentication failed';

/** Health payload the mock reports; `version` mirrors `apps/api/package.json`. */
export const TEST_API_VERSION = '0.1.0';

/** HTTP statuses the handlers return. */
export const STATUS_OK = 200;
export const STATUS_NO_CONTENT = 204;
export const STATUS_UNAUTHORIZED = 401;
export const STATUS_INTERNAL_SERVER_ERROR = 500;

/**
 * The `localStorage` key, pinned as a literal on purpose.
 *
 * The suite asserts this equals `REFRESH_TOKEN_STORAGE_KEY` from `src`, so a
 * rename shows up as a failing assertion instead of silently moving the
 * security-relevant storage location (FR7).
 */
export const EXPECTED_REFRESH_TOKEN_STORAGE_KEY = 'finance.refresh_token';

/** Bearer scheme prefix, for reading the mock's `Authorization` header. */
export const BEARER_PREFIX = 'Bearer ';
export const HEADER_AUTHORIZATION = 'authorization';

/** Fallback copy passed to `errorMessageOf` in its unit test. */
export const TEST_FALLBACK_MESSAGE = 'Something went wrong.';

/** Accessible labels and copy the login screen renders. */
export const EMAIL_LABEL = 'Email';
export const PASSWORD_LABEL = 'Password';
export const SIGN_IN_BUTTON_NAME = 'Sign in';
export const SIGNED_IN_AS_TEXT = 'Signed in as';
export const ALERT_ROLE = 'alert';

/** What `MePage` renders for `HEALTH_BODY`: `status · db <db> · v<version>`. */
export const EXPECTED_HEALTH_TEXT = `ok · db ok · v${TEST_API_VERSION}`;

/**
 * One macrotask turn, long enough for Node/jsdom to report a rejection that
 * nothing handled. Asserting immediately would pass even with a floating
 * promise, because the report happens after the current microtask queue drains.
 */
export const UNHANDLED_REJECTION_FLUSH_MS = 20;
