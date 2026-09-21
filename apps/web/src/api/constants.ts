/**
 * Every literal used by the HTTP layer, named once (project no-magic-strings
 * rule). Route paths are NOT here — they come from `@finance/contracts`
 * (`ROUTES`), which is the single source of truth shared with the API.
 */

/**
 * Base URL prefixed to every request. Empty on purpose: the SPA talks to its
 * own origin and Vite proxies `/api` to the API in dev (C15). Nothing in the
 * app may point at `http://localhost:3000` directly — a broken proxy has to
 * surface as a failed request rather than be routed around.
 */
export const API_BASE_URL = '';

/**
 * `localStorage` key for the refresh token. The access token is never stored —
 * see `tokens.ts`.
 */
export const REFRESH_TOKEN_STORAGE_KEY = 'finance.refresh_token';

/**
 * How many times a request is replayed after a successful token refresh.
 * Exactly one: if the retry also 401s the error propagates, so an endlessly
 * refreshing loop is impossible.
 */
export const RETRY_COUNT_AFTER_REFRESH = 1;

/** Status codes the client reasons about. */
export const HTTP_STATUS_OK = 200;
export const HTTP_STATUS_NO_CONTENT = 204;
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

/** Inclusive bounds of the 2xx range treated as success. */
export const SUCCESS_STATUS_MIN = 200;
export const SUCCESS_STATUS_MAX = 299;

/**
 * `GET /api/v1/health` returns a `HealthResponse` body on **both** 200 and 503
 * (the one documented exception to the error envelope), so 503 is a readable
 * payload here, not an error.
 */
export const HEALTH_ACCEPTED_STATUSES = [HTTP_STATUS_OK, HTTP_STATUS_SERVICE_UNAVAILABLE] as const;

/** Request headers. */
export const HEADER_AUTHORIZATION = 'Authorization';
export const HEADER_CONTENT_TYPE = 'Content-Type';
/** Correlates a browser request with the API's log line for it. */
export const HEADER_REQUEST_ID = 'X-Request-Id';

export const CONTENT_TYPE_JSON = 'application/json';
export const BEARER_SCHEME_PREFIX = 'Bearer ';

/** The HTTP verbs this client issues. */
export const HTTP_METHOD = {
  GET: 'GET',
  POST: 'POST',
} as const;

export type HttpMethod = (typeof HTTP_METHOD)[keyof typeof HTTP_METHOD];

/** Fallback copy when the API answers with something that is not the envelope. */
export const UNEXPECTED_RESPONSE_MESSAGE = 'Unexpected response from the API, status ';
export const NETWORK_ERROR_MESSAGE = 'Could not reach the API. Is it running?';
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';
export const NO_REFRESH_TOKEN_MESSAGE = 'No refresh token is stored; cannot refresh.';
