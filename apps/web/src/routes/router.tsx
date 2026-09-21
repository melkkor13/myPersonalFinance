import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';

import { hasSession } from '../api/tokens';
import { LoginPage } from './LoginPage';
import { MePage } from './MePage';
import { ROUTE_PATHS } from './paths';
import { RootLayout } from './RootLayout';

/**
 * TanStack Router, code-based route tree (ADR 0007).
 *
 * Two screens only (FR11): `/login` and `/me`. `/` just forwards to whichever
 * of the two the current session calls for. The guards read the token store, so
 * a cleared session cannot leave `/me` mounted.
 *
 * `beforeLoad` **returns** the redirect rather than throwing it: in this router
 * version `redirect()` produces a `Response`, and a returned one is recognised
 * exactly like a thrown one.
 */

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.INDEX,
  beforeLoad: () => {
    if (hasSession()) {
      return redirect({ to: ROUTE_PATHS.ME });
    }
    return redirect({ to: ROUTE_PATHS.LOGIN });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.LOGIN,
  beforeLoad: () => {
    if (hasSession()) {
      return redirect({ to: ROUTE_PATHS.ME });
    }
    return undefined;
  },
  component: LoginPage,
});

const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.ME,
  beforeLoad: () => {
    if (!hasSession()) {
      return redirect({ to: ROUTE_PATHS.LOGIN });
    }
    return undefined;
  },
  component: MePage,
});

export const routeTree = rootRoute.addChildren([indexRoute, loginRoute, meRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
