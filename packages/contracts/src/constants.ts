/**
 * Named constants for every literal that crosses the wire.
 *
 * Project convention (hard rule): no magic strings. Route paths, status values,
 * error codes and validation bounds are declared once here and imported
 * everywhere else — `apps/api` route registration imports these rather than
 * hardcoding path strings, so a path can never drift between the router, the
 * OpenAPI document and the web client.
 *
 * Wire casing convention (requirements.md Q1): every request/response field
 * name is snake_case. This overrides the original spec and ADR 0004 L63, which
 * said camelCase.
 */

/** Version prefix shared by every API and meta route. */
export const API_VERSION_PREFIX = '/api/v1';

/** `GET` — liveness plus DB reachability. Unauthenticated. */
export const HEALTH_ROUTE = `${API_VERSION_PREFIX}/health`;

/** `POST` — email + password, returns an access/refresh token pair. */
export const AUTH_LOGIN_ROUTE = `${API_VERSION_PREFIX}/auth/login`;

/** `POST` — rotates a refresh token, revoking the presented one. */
export const AUTH_REFRESH_ROUTE = `${API_VERSION_PREFIX}/auth/refresh`;

/** `POST` — revokes the presented refresh token. Responds `204` with no body. */
export const AUTH_LOGOUT_ROUTE = `${API_VERSION_PREFIX}/auth/logout`;

/** `GET` — the authenticated user. The one access-token-protected route. */
export const ME_ROUTE = `${API_VERSION_PREFIX}/me`;

/** `GET` — meta route, OpenAPI 3.1 document. Contracts-exempt (FR5). */
export const OPENAPI_ROUTE = `${API_VERSION_PREFIX}/openapi.json`;

/** `GET` — meta route, Swagger UI. Development only; 404 in production. */
export const DOCS_ROUTE = `${API_VERSION_PREFIX}/docs`;

/** Every route the scaffold serves, keyed for iteration in tests and plugins. */
export const ROUTES = {
  HEALTH: HEALTH_ROUTE,
  AUTH_LOGIN: AUTH_LOGIN_ROUTE,
  AUTH_REFRESH: AUTH_REFRESH_ROUTE,
  AUTH_LOGOUT: AUTH_LOGOUT_ROUTE,
  ME: ME_ROUTE,
  OPENAPI: OPENAPI_ROUTE,
  DOCS: DOCS_ROUTE,
} as const;

/** Overall service health: `ok` when the DB answered, `degraded` when it did not. */
export const HEALTH_STATUS_OK = 'ok';
export const HEALTH_STATUS_DEGRADED = 'degraded';

/** DB leg of the health report. */
export const DB_STATUS_OK = 'ok';
export const DB_STATUS_UNAVAILABLE = 'unavailable';

export const HEALTH_STATUS = {
  OK: HEALTH_STATUS_OK,
  DEGRADED: HEALTH_STATUS_DEGRADED,
} as const;

export const DB_STATUS = {
  OK: DB_STATUS_OK,
  UNAVAILABLE: DB_STATUS_UNAVAILABLE,
} as const;

/**
 * Validation bounds. Declared as constants so the schema, the seed script and
 * the web form can never disagree about the limit.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 512;
export const EMAIL_MAX_LENGTH = 254;
/** ISO 4217 alpha-3, matching the `CHECK(length(default_currency)=3)` column. */
export const CURRENCY_CODE_LENGTH = 3;
/** Refresh token is 32 CSPRNG bytes, base64url — 43 chars unpadded. */
export const REFRESH_TOKEN_MIN_LENGTH = 1;

/**
 * Default ISO 4217 code for a newly created user. Lives here, not in
 * `apps/api/src/db/seed.ts`, because both the seed script and the Cloudflare
 * Access auto-provisioning path in `auth.service.ts` need it — and a service may
 * not import from `src/db/**` (boundary rule B2).
 */
export const DEFAULT_CURRENCY_CODE = 'USD';

/**
 * How the caller of an authenticated request proved who they are.
 *
 * `password` — an `Authorization: Bearer <jwt>` minted by `POST /auth/login`.
 * `cloudflare_access` — a `Cf-Access-Jwt-Assertion` header verified against the
 * Cloudflare Access team JWKS, injected at the edge.
 *
 * The web app reads this off `GET /api/v1/me` to decide what "log out" means:
 * clearing its token store is meaningless when the session lives in Cloudflare's
 * `CF_Authorization` cookie. See {@link CF_ACCESS_LOGOUT_PATH}.
 */
export const AUTH_MODE_PASSWORD = 'password';
export const AUTH_MODE_CLOUDFLARE_ACCESS = 'cloudflare_access';
export const AUTH_MODE_VALUES = [AUTH_MODE_PASSWORD, AUTH_MODE_CLOUDFLARE_ACCESS] as const;

export const AUTH_MODE = {
  PASSWORD: AUTH_MODE_PASSWORD,
  CLOUDFLARE_ACCESS: AUTH_MODE_CLOUDFLARE_ACCESS,
} as const;

export type AuthMode = (typeof AUTH_MODE_VALUES)[number];

/**
 * Cloudflare's own logout endpoint, served on the application hostname by the
 * edge — it never reaches this origin. Ending a Cloudflare Access session means
 * a full-page navigation here, not a `fetch`.
 */
export const CF_ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';
