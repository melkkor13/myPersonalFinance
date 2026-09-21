import {
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
import { clearTokens, getRefreshToken, setTokens } from './tokens';

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

/** `GET /api/v1/me` — the one access-token-protected route, so it may refresh. */
export function fetchMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>(ROUTES.ME, { method: HTTP_METHOD.GET, withAuth: true });
}

/** `GET /api/v1/health` — unauthenticated; 503 carries a body, not an error. */
export function fetchHealth(): Promise<HealthResponse> {
  return rawRequest<HealthResponse>(ROUTES.HEALTH, {
    method: HTTP_METHOD.GET,
    acceptStatuses: HEALTH_ACCEPTED_STATUSES,
  });
}
