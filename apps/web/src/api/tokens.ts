import {
  AUTH_MODE,
  type AuthMode,
  type LoginResponse,
  type RefreshResponse,
} from '@finance/contracts';

import { REFRESH_TOKEN_STORAGE_KEY } from './constants';

/**
 * Session state (FR7) — one observable store, so React and the HTTP layer never
 * hold two copies of "am I signed in".
 *
 * ## Two kinds of session
 * **Password.** `POST /auth/login` returns a pair. The access token is kept in
 * memory only, so it dies with the tab; the refresh token goes to
 * `localStorage` so a reload can recover the session.
 *
 * **Cloudflare Access** (ADR 0010). There is **no token here at all**. The
 * credential is Cloudflare's `HttpOnly` `CF_Authorization` cookie, which this
 * code can neither read nor write, and the edge turns it into a signed header on
 * every request. That is why {@link hasSession} cannot simply test for a stored
 * refresh token: in Access mode there will never be one, and a storage-only
 * check would report a signed-in user as signed out forever.
 *
 * The mode is learned from `auth_mode` on `GET /api/v1/me` and recorded by
 * {@link setAuthMode}. Until that first response lands the mode is `null`,
 * meaning "not yet known" — deliberately distinct from "password", so nothing
 * assumes a password session before the server has said so.
 */

/** Both login and refresh return the same snake_case pair (Q1). */
export type TokenPair = LoginResponse | RefreshResponse;

/** In-memory only — intentionally not persisted anywhere. */
let accessToken: string | null = null;

/** `null` until `GET /api/v1/me` first answers. Never persisted: it is a fact
 *  about the server's configuration, not about this browser. */
let authMode: AuthMode | null = null;

type AuthListener = () => void;

const listeners = new Set<AuthListener>();

function notifyAuthChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** `useSyncExternalStore` subscribe function. */
export function subscribeToAuthChanges(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return window.localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
}

export function getAuthMode(): AuthMode | null {
  return authMode;
}

/** True when Cloudflare Access is authenticating this browser. */
export function isCloudflareAccessMode(): boolean {
  return authMode === AUTH_MODE.CLOUDFLARE_ACCESS;
}

/**
 * Record the mode reported by `GET /api/v1/me`. Called by the `me` query, which
 * is the only response that carries it.
 */
export function setAuthMode(mode: AuthMode): void {
  if (authMode === mode) {
    return;
  }
  authMode = mode;
  notifyAuthChanged();
}

/**
 * True when this browser has a usable session.
 *
 * In Access mode the answer is yes: `auth_mode` is only ever set from a
 * *successful* `/me`, so knowing we are in Access mode is itself proof that the
 * edge authenticated us. In password mode it means a refresh token is stored, so
 * a session can be re-established after a reload.
 */
export function hasSession(): boolean {
  return isCloudflareAccessMode() || getRefreshToken() !== null;
}

/** Stores a freshly issued pair. Called by login and by the refresh lock. */
export function setTokens(tokens: TokenPair): void {
  accessToken = tokens.access_token;
  // SECURITY (FR7): the refresh token is persisted in localStorage, which is
  // readable by any script running on this origin, for the full
  // REFRESH_TOKEN_TTL. This path is reached only by a PASSWORD login, which in
  // production no longer happens: behind Cloudflare Access the browser holds no
  // token and this function is never called (ADR 0010). It remains for local
  // `npm run dev` and for non-browser clients.
  window.localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, tokens.refresh_token);
  notifyAuthChanged();
}

/**
 * Drops the session locally. Idempotent.
 *
 * `authMode` is deliberately **not** reset: it describes how the server is
 * configured, which a logout does not change. Resetting it would make an Access
 * user look like a password user and send them to a login form they cannot use.
 */
export function clearTokens(): void {
  accessToken = null;
  window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  notifyAuthChanged();
}
