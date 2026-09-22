import { z } from 'zod';

import {
  AUTH_MODE_VALUES,
  CURRENCY_CODE_LENGTH,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REFRESH_TOKEN_MIN_LENGTH,
} from './constants.js';

/**
 * Auth contracts (FR6, FR7). Every field name is snake_case per Q1 —
 * `access_token`/`refresh_token`, never `accessToken`/`refreshToken`.
 */

/** Shared field definitions so login and refresh cannot drift apart. */
const emailField = z.email().max(EMAIL_MAX_LENGTH);
const passwordField = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const accessTokenField = z.string().min(REFRESH_TOKEN_MIN_LENGTH);
const refreshTokenField = z.string().min(REFRESH_TOKEN_MIN_LENGTH);

/** `POST /api/v1/auth/login` request. */
export const LoginRequestSchema = z.object({
  email: emailField,
  password: passwordField,
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** `POST /api/v1/auth/login` response. */
export const LoginResponseSchema = z.object({
  access_token: accessTokenField,
  refresh_token: refreshTokenField,
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** `POST /api/v1/auth/refresh` request. */
export const RefreshRequestSchema = z.object({
  refresh_token: refreshTokenField,
});

export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** `POST /api/v1/auth/refresh` response — the presented token is revoked. */
export const RefreshResponseSchema = z.object({
  access_token: accessTokenField,
  refresh_token: refreshTokenField,
});

export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

/**
 * `POST /api/v1/auth/logout` request. There is deliberately no response schema:
 * the route answers `204 No Content` with no body, one of the two documented
 * contract exemptions in FR5.
 */
export const LogoutRequestSchema = z.object({
  refresh_token: refreshTokenField,
});

export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

/**
 * `GET /api/v1/me` response — the module's one protected route.
 *
 * `password_hash` MUST NEVER appear here. The `users` row carries it (FR9) but
 * it is stripped at the repository boundary, and Zod response serialization
 * emits `additionalProperties: false`, so an accidental extra key is dropped
 * rather than leaked. A test asserts the field never appears in any response.
 */
export const MeResponseSchema = z.object({
  id: z.uuid(),
  email: emailField,
  default_currency: z.string().length(CURRENCY_CODE_LENGTH),
  created_at: z.iso.datetime(),
  /**
   * How *this* request was authenticated — a property of the credential, not of
   * the stored user, so it is not a `users` column. The web app needs it because
   * logging out of a Cloudflare Access session is a navigation to
   * `CF_ACCESS_LOGOUT_PATH`, whereas logging out of a password session is a call
   * to `POST /auth/logout`. Returning it here rather than from a separate
   * endpoint keeps the SPA's first paint at one request.
   */
  auth_mode: z.enum(AUTH_MODE_VALUES),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
