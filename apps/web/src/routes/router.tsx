import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';

import { meQueryOptions, queryClient } from '../api/queries';
import { hasSession } from '../api/tokens';
import { LoginPage } from './LoginPage';
import { MePage } from './MePage';
import { ROUTE_PATHS } from './paths';
import { RootLayout } from './RootLayout';

/**
 * TanStack Router, code-based route tree (ADR 0007).
 *
 * Two screens only (FR11): `/login` and `/me`. `/` just forwards to whichever
 * of the two the current session calls for.
 *
 * ## Why the guards probe the server
 * They used to read the token store synchronously. That cannot answer the
 * question under Cloudflare Access (ADR 0010), where the browser holds **no
 * token** — the credential is Cloudflare's `HttpOnly` cookie, which this code
 * cannot see. A storage-only check would send an authenticated Access user to a
 * login form they have no way to use.
 *
 * So the guards ask `GET /api/v1/me` instead, which is the one request that can
 * answer both "is there a session" and "what kind". `ensureQueryData` caches it
 * in TanStack Query, so navigating between routes does not re-request it, and
 * `hasSession()` is kept as a **synchronous fast path**: when a refresh token is
 * already stored there is no need to wait for the network to know the answer.
 *
 * `beforeLoad` **returns** the redirect rather than throwing it: in this router
 * version `redirect()` produces a `Response`, and a returned one is recognised
 * exactly like a thrown one.
 */

/** Serve from cache if present; a guard must not trigger a refetch. */
const STATIC_STALE_TIME = 'static';

/** What the guards need from the app. Supplied by `createRouter({ context })`. */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

/**
 * Does this browser have a usable session?
 *
 * Resolves without throwing: a 401 — or an unreachable API — is an answer
 * ("no"), not an error to surface. The login screen is the correct destination
 * in both cases, which is also the behaviour on a cold start today.
 */
async function resolveSignedIn(context: RouterContext): Promise<boolean> {
  if (hasSession()) {
    return true;
  }
  try {
    // `staleTime: 'static'` is the replacement for the deprecated
    // `ensureQueryData`: serve a cached `/me` if there is one, and never
    // refetch it just because a guard ran. Navigating between routes therefore
    // costs no extra request.
    await context.queryClient.query({ ...meQueryOptions, staleTime: STATIC_STALE_TIME });
    return true;
  } catch {
    return false;
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.INDEX,
  beforeLoad: async ({ context }) => {
    if (await resolveSignedIn(context)) {
      return redirect({ to: ROUTE_PATHS.ME });
    }
    return redirect({ to: ROUTE_PATHS.LOGIN });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.LOGIN,
  beforeLoad: async ({ context }) => {
    if (await resolveSignedIn(context)) {
      return redirect({ to: ROUTE_PATHS.ME });
    }
    return undefined;
  },
  component: LoginPage,
});

const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.ME,
  beforeLoad: async ({ context }) => {
    if (!(await resolveSignedIn(context))) {
      return redirect({ to: ROUTE_PATHS.LOGIN });
    }
    return undefined;
  },
  component: MePage,
});

export const routeTree = rootRoute.addChildren([indexRoute, loginRoute, meRoute]);

export const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
