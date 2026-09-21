import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { logout } from '../api/endpoints';
import { errorMessageOf } from '../api/errors';
import { healthQueryOptions, meQueryOptions } from '../api/queries';
import { useIsAuthenticated } from '../auth/useSession';
import { ROUTE_PATHS } from './paths';

/**
 * Screen 2 of 2 (FR11): the signed-in page. It shows the authenticated user's
 * email from `GET /api/v1/me` and the API health status from
 * `GET /api/v1/health` (case 11). Nothing else — no dashboard, no placeholder
 * finance pages.
 */

const SIGN_OUT_LABEL = 'Sign out';
const LOADING_LABEL = 'Loading…';
const ME_ERROR_MESSAGE = 'Could not load your account.';
const HEALTH_ERROR_MESSAGE = 'Could not load API health.';
const SIGNED_IN_AS_LABEL = 'Signed in as';
const API_HEALTH_LABEL = 'API health';

export function MePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAuthenticated = useIsAuthenticated();
  const me = useQuery(meQueryOptions);
  const health = useQuery(healthQueryOptions);

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
    },
  });

  // Covers both an explicit sign-out and a failed refresh (which clears the
  // tokens): either way the session is gone, so the login screen is the only
  // sensible destination.
  useEffect(() => {
    if (!isAuthenticated) {
      void navigate({ to: ROUTE_PATHS.LOGIN });
    }
  }, [isAuthenticated, navigate]);

  return (
    <section className="w-full max-w-sm space-y-6 rounded-xl bg-panel p-8 shadow-sm">
      <div className="space-y-1">
        <h1 className="text-sm text-muted">{SIGNED_IN_AS_LABEL}</h1>
        {me.isPending ? <p>{LOADING_LABEL}</p> : null}
        {me.isError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {errorMessageOf(me.error, ME_ERROR_MESSAGE)}
          </p>
        ) : null}
        {me.data === undefined ? null : <p className="text-lg font-semibold">{me.data.email}</p>}
      </div>

      <div className="space-y-1">
        <h2 className="text-sm text-muted">{API_HEALTH_LABEL}</h2>
        {health.isPending ? <p>{LOADING_LABEL}</p> : null}
        {health.isError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {errorMessageOf(health.error, HEALTH_ERROR_MESSAGE)}
          </p>
        ) : null}
        {health.data === undefined ? null : (
          <p className="font-medium">
            {health.data.status} · db {health.data.db} · v{health.data.version}
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={signOut.isPending}
        onClick={() => {
          signOut.mutate();
        }}
        className="w-full rounded-md border border-muted/40 px-3 py-2 font-medium hover:bg-surface disabled:opacity-60"
      >
        {SIGN_OUT_LABEL}
      </button>
    </section>
  );
}
