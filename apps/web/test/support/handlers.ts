import {
  DB_STATUS,
  ERROR_CODE,
  HEALTH_STATUS,
  ROUTES,
  type ErrorResponse,
  type HealthResponse,
  type LoginRequest,
  type LoginResponse,
  type LogoutRequest,
  AUTH_MODE,
  type MeResponse,
  type RefreshRequest,
  type RefreshResponse,
} from '@finance/contracts';
import { delay, http, HttpResponse } from 'msw';

import {
  AUTHENTICATION_FAILED_MESSAGE,
  BEARER_PREFIX,
  EXPIRED_ACCESS_TOKEN,
  FRESH_ACCESS_TOKEN,
  HEADER_AUTHORIZATION,
  REFRESH_HANDLER_DELAY_MS,
  ROTATED_REFRESH_TOKEN,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NO_CONTENT,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
  TEST_API_VERSION,
  TEST_USER_CREATED_AT,
  TEST_USER_CURRENCY,
  TEST_USER_EMAIL,
  TEST_USER_ID,
  TEST_USER_PASSWORD,
} from './constants';

/**
 * MSW handlers for every route the SPA calls.
 *
 * **ADR 0008 is the reason these are typed the way they are.** Each handler's
 * path comes from `ROUTES` and each request/response body is annotated with the
 * corresponding `@finance/contracts` type, so the mocks are bound to the same
 * single source of truth as the API and the client. Renaming a contract field
 * (case 28) fails `typecheck` here as well as in both apps — hand-written
 * duplicate shapes would have silently kept compiling and made the suite lie.
 *
 * The wire format is snake_case (Q1): `access_token`, `refresh_token`,
 * `default_currency`, `created_at`. There is no casing conversion anywhere.
 */

/** None of the scaffold's routes are parameterised. */
type NoPathParams = Record<string, never>;

/** The user `GET /api/v1/me` reports for a password session. */
export const ME_BODY: MeResponse = {
  id: TEST_USER_ID,
  email: TEST_USER_EMAIL,
  default_currency: TEST_USER_CURRENCY,
  created_at: TEST_USER_CREATED_AT,
  auth_mode: AUTH_MODE.PASSWORD,
};

/** The same user, authenticated by Cloudflare Access instead (ADR 0010). */
export const ME_BODY_CLOUDFLARE_ACCESS: MeResponse = {
  ...ME_BODY,
  auth_mode: AUTH_MODE.CLOUDFLARE_ACCESS,
};

/** A healthy API. */
export const HEALTH_BODY: HealthResponse = {
  status: HEALTH_STATUS.OK,
  version: TEST_API_VERSION,
  db: DB_STATUS.OK,
};

/**
 * The real API's 401 body, byte-for-byte (case 32 keeps it identical for a
 * wrong password and an unknown email, so there is only one envelope to mock).
 */
export const UNAUTHENTICATED_BODY: ErrorResponse = {
  error: { code: ERROR_CODE.UNAUTHENTICATED, message: AUTHENTICATION_FAILED_MESSAGE },
};

/** A freshly rotated pair, as the refresh route returns. */
export const ROTATED_TOKEN_BODY: RefreshResponse = {
  access_token: FRESH_ACCESS_TOKEN,
  refresh_token: ROTATED_REFRESH_TOKEN,
};

/**
 * Deliberately not an `ErrorResponse` — it is what a proxy or an unmapped
 * framework error might return, and `ErrorResponseSchema.safeParse` must reject
 * it.
 */
interface MalformedErrorBody {
  readonly detail: string;
}

export const MALFORMED_ERROR_BODY: MalformedErrorBody = { detail: 'gateway exploded' };

function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get(HEADER_AUTHORIZATION);

  if (header?.startsWith(BEARER_PREFIX) !== true) {
    return null;
  }

  return header.slice(BEARER_PREFIX.length);
}

function unauthorized(): HttpResponse<ErrorResponse> {
  return HttpResponse.json<ErrorResponse>(UNAUTHENTICATED_BODY, {
    status: STATUS_UNAUTHORIZED,
  });
}

/** `GET /api/v1/health` — unauthenticated, 200 with a `HealthResponse`. */
export function healthHandler() {
  return http.get<NoPathParams, never, HealthResponse>(ROUTES.HEALTH, () =>
    HttpResponse.json<HealthResponse>(HEALTH_BODY, { status: STATUS_OK }),
  );
}

/**
 * `POST /api/v1/auth/login` — 200 with a token pair for the seeded password,
 * 401 with the `UNAUTHENTICATED` envelope for anything else (case 37).
 */
export function loginHandler() {
  return http.post<NoPathParams, LoginRequest, LoginResponse | ErrorResponse>(
    ROUTES.AUTH_LOGIN,
    async ({ request }) => {
      const credentials = await request.json();

      if (credentials.password !== TEST_USER_PASSWORD) {
        return unauthorized();
      }

      const body: LoginResponse = {
        access_token: FRESH_ACCESS_TOKEN,
        refresh_token: ROTATED_REFRESH_TOKEN,
      };

      return HttpResponse.json<LoginResponse>(body, { status: STATUS_OK });
    },
  );
}

/**
 * `GET /api/v1/me` — the one access-token-protected route.
 *
 * Only `FRESH_ACCESS_TOKEN` is accepted; `EXPIRED_ACCESS_TOKEN` (and anything
 * else) gets the same 401 the real API returns for an expired JWT, which is
 * what drives the single-flight refresh.
 */
export function meHandler() {
  return http.get<NoPathParams, never, MeResponse | ErrorResponse>(ROUTES.ME, ({ request }) => {
    if (bearerTokenOf(request) !== FRESH_ACCESS_TOKEN) {
      return unauthorized();
    }

    return HttpResponse.json<MeResponse>(ME_BODY, { status: STATUS_OK });
  });
}

/**
 * `GET /api/v1/me` as it behaves behind Cloudflare Access: authenticated with
 * **no** `Authorization` header at all.
 *
 * In production the credential is the edge-injected `Cf-Access-Jwt-Assertion`
 * header, which neither the browser nor MSW can see — from the client's point of
 * view the request simply carries no token and succeeds anyway. Asserting the
 * absence of the header is the point: it proves the web app is not secretly
 * relying on a stored token in Access mode.
 */
export function cloudflareAccessMeHandler() {
  return http.get<NoPathParams, never, MeResponse | ErrorResponse>(ROUTES.ME, ({ request }) => {
    // `null` means no `Authorization` header at all, which is the ONLY shape
    // this handler accepts: under Access the browser has no token to send.
    if (bearerTokenOf(request) !== null) {
      return unauthorized();
    }
    return HttpResponse.json<MeResponse>(ME_BODY_CLOUDFLARE_ACCESS, { status: STATUS_OK });
  });
}

/**
 * `GET /api/v1/me` that rejects every token, including a freshly refreshed one.
 * Used to prove the retry happens exactly once and does not loop.
 */
export function meAlwaysUnauthorizedHandler() {
  return http.get<NoPathParams, never, ErrorResponse>(ROUTES.ME, () => unauthorized());
}

/**
 * `POST /api/v1/auth/refresh` — rotates the pair, as the real route does.
 *
 * Deliberately slow (`REFRESH_HANDLER_DELAY_MS`) so that the refresh cannot
 * complete before every concurrent caller has joined the lock.
 */
export function refreshHandler() {
  return http.post<NoPathParams, RefreshRequest, RefreshResponse | ErrorResponse>(
    ROUTES.AUTH_REFRESH,
    async ({ request }) => {
      const body = await request.json();
      await delay(REFRESH_HANDLER_DELAY_MS);

      if (body.refresh_token !== EXPIRED_ACCESS_TOKEN) {
        return HttpResponse.json<RefreshResponse>(ROTATED_TOKEN_BODY, { status: STATUS_OK });
      }

      return unauthorized();
    },
  );
}

/**
 * `POST /api/v1/auth/refresh` that fails — the spent/replayed-token case. Every
 * waiter on the lock must observe the same `SessionExpiredError`.
 */
export function refreshFailureHandler() {
  return http.post<NoPathParams, RefreshRequest, ErrorResponse>(ROUTES.AUTH_REFRESH, async () => {
    await delay(REFRESH_HANDLER_DELAY_MS);
    return unauthorized();
  });
}

/** `POST /api/v1/auth/logout` — 204 with no body (an FR5 contract exemption). */
export function logoutHandler() {
  return http.post<NoPathParams, LogoutRequest, never>(
    ROUTES.AUTH_LOGOUT,
    () => new HttpResponse(null, { status: STATUS_NO_CONTENT }),
  );
}

/**
 * `GET /api/v1/health` answering 500 with a body that is **not** the FR5
 * envelope. Exercises the fallback path in `toApiError()`: the client must
 * still produce a readable `ApiError` rather than throwing on a failed parse.
 */
export function malformedErrorBodyHealthHandler() {
  return http.get<NoPathParams, never, MalformedErrorBody>(ROUTES.HEALTH, () =>
    HttpResponse.json<MalformedErrorBody>(MALFORMED_ERROR_BODY, {
      status: STATUS_INTERNAL_SERVER_ERROR,
    }),
  );
}

/** The happy-path handler set every test file starts from. */
export function defaultHandlers() {
  return [healthHandler(), loginHandler(), meHandler(), refreshHandler(), logoutHandler()];
}
