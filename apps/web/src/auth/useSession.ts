import { useSyncExternalStore } from 'react';

import { hasSession, subscribeToAuthChanges } from '../api/tokens';

/**
 * Reads the session flag from the token store (`api/tokens.ts`) so React is
 * driven by the same state the HTTP layer mutates — no duplicated auth state.
 *
 * "Signed in" means a refresh token is stored. The access token is held in
 * memory only (FR7), so after a reload the first protected request 401s and the
 * single-flight refresh mints a new one.
 */
export function useIsAuthenticated(): boolean {
  return useSyncExternalStore(subscribeToAuthChanges, hasSession, hasSession);
}
