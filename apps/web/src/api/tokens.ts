import type { LoginResponse, RefreshResponse } from '@finance/contracts';

import { REFRESH_TOKEN_STORAGE_KEY } from './constants';

/**
 * Token storage (FR7).
 *
 * - **Access token: in memory only.** It is never written to `localStorage` or
 *   `sessionStorage`, so it dies with the tab and cannot be read by another
 *   script after the fact.
 * - **Refresh token: `localStorage`**, so a reload can recover the session.
 *
 * A tiny observable store is attached so React can react to login/logout
 * without a second copy of the auth state.
 */

/** Both login and refresh return the same snake_case pair (Q1). */
export type TokenPair = LoginResponse | RefreshResponse;

/** In-memory only — intentionally not persisted anywhere. */
let accessToken: string | null = null;

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

/** True when a refresh token is stored, i.e. a session can be (re)established. */
export function hasSession(): boolean {
  return getRefreshToken() !== null;
}

/** Stores a freshly issued pair. Called by login and by the refresh lock. */
export function setTokens(tokens: TokenPair): void {
  accessToken = tokens.access_token;
  // SECURITY (FR7): the refresh token is persisted in localStorage, which is
  // readable by any script running on this origin. This is acceptable ONLY
  // because the app is localhost-only. Replacing this storage — e.g. with an
  // HttpOnly, Secure, SameSite cookie set by the API — is a documented
  // prerequisite for any non-localhost deployment.
  window.localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, tokens.refresh_token);
  notifyAuthChanged();
}

/** Drops the session locally. Idempotent. */
export function clearTokens(): void {
  accessToken = null;
  window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  notifyAuthChanged();
}
