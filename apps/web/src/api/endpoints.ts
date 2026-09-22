import {
  CF_ACCESS_LOGOUT_PATH,
  ROUTES,
  type HealthResponse,
  type LoginRequest,
  type LoginResponse,
  type LogoutRequest,
  type MeResponse,
} from '@finance/contracts';

import { apiRequest } from './client';
import { HEALTH_ACCEPTED_STATUSES, HTTP_METHOD } from './constants';
import { rawRequest } from './http';
import {
  clearTokens,
  getRefreshToken,
  isCloudflareAccessMode,
  setAuthMode,
  setTokens,
} from './tokens';

/**
 * One function per API route the scaffold exposes. Paths come from `ROUTES` in
 * `@finance/contracts` and request/response types are the contract types, so
 * the compiler enforces the snake_case wire format (Q1): `access_token`,
 * `refresh_token`, `default_currency`, `created_at`.
 */

/**
 * `POST /api/v1/auth/login` — stores the returned pair on success.
 *
 * Uses `rawRequest`: a 401 here means wrong credentials, which must surface as
 * an error message, not trigger a refresh.
 */
export async function login(credentials: LoginRequest): Promise<void> {
  const tokens = await rawRequest<LoginResponse>(ROUTES.AUTH_LOGIN, {
    method: HTTP_METHOD.POST,
    body: credentials,
  });
  setTokens(tokens);
}

/**
 * `POST /api/v1/auth/logout` — revokes the stored refresh token server-side.
 * The local session is dropped either way: a failed call must not strand the
 * user in a half-signed-in state.
 */
export async function logout(): Promise<void> {
  // Under Cloudflare Access the session IS the edge's `CF_Authorization`
  // cookie, which this origin cannot clear. Ending it means a full-page
  // navigation to Cloudflare's own logout endpoint, which is terminated at the
  // edge and never reaches our nginx. A `fetch` here would appear to succeed
  // while leaving the user signed in.
  if (isCloudflareAccessMode()) {
    clearTokens();
    window.location.assign(CF_ACCESS_LOGOUT_PATH);
    return;
  }

  const refreshToken = getRefreshToken();

  try {
    if (refreshToken !== null) {
      const request: LogoutRequest = { refresh_token: refreshToken };
      await rawRequest<undefined>(ROUTES.AUTH_LOGOUT, {
        method: HTTP_METHOD.POST,
        body: request,
      });
    }
  } catch {
    // Already revoked or unreachable — the local session is cleared regardless.
  } finally {
    clearTokens();
  }
}

/**
 * `GET /api/v1/me` — the one protected route, so it may refresh.
 *
 * This is also where the app learns which credential the server accepted. It is
 * the only response carrying `auth_mode`, and recording it here means every
 * caller — the route guards, `useIsAuthenticated`, `logout` — sees a consistent
 * answer without a second request.
 */
export async function fetchMe(): Promise<MeResponse> {
  const me = await apiRequest<MeResponse>(ROUTES.ME, {
    method: HTTP_METHOD.GET,
    withAuth: true,
  });
  setAuthMode(me.auth_mode);
  return me;
}

/** `GET /api/v1/health` — unauthenticated; 503 carries a body, not an error. */
export function fetchHealth(): Promise<HealthResponse> {
  return rawRequest<HealthResponse>(ROUTES.HEALTH, {
    method: HTTP_METHOD.GET,
    acceptStatuses: HEALTH_ACCEPTED_STATUSES,
  });
}
