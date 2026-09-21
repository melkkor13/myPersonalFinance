import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { server } from './server';

/**
 * Shared web test harness.
 *
 * ## Why every test loads the app through `loadWebApp()`
 *
 * Two modules under test hold **module-level** state:
 *   - `src/api/refresh.ts` — `let inFlight: Promise<void> | null`, the
 *     single-flight lock itself (case 22).
 *   - `src/api/tokens.ts` — `let accessToken: string | null`, the in-memory
 *     access token (FR7).
 *
 * A statically imported module is evaluated once per test **file**, so those two
 * variables carry over between tests. With a *correct* implementation the lock
 * always settles back to `null`, so the bleed is invisible — which is exactly
 * why it is dangerous: it becomes visible only once the lock misbehaves, i.e.
 * in the regression these tests exist to catch. Verified by mutation: making
 * the lock clear only on success (`.then` instead of `.finally`) leaves a
 * rejected promise in `inFlight`, and without the reset below the next test
 * inherits it and fails without issuing a single request.
 *
 * `loadWebApp()` therefore calls `vi.resetModules()` and re-imports the graph
 * dynamically, giving each test a genuinely fresh `inFlight` and a fresh access
 * token. Test files must obtain these modules from here and must not import them
 * statically, or they would be talking to a different module instance than the
 * components are.
 */

/** Query/mutation retries off: the only replay under test is the app's own. */
const RETRY_QUERIES = false;

/**
 * Re-imports the app with all module-level state reset.
 *
 * The return type is inferred and re-exported as `LoadedWebApp`, so the shape
 * is derived from the real modules rather than restated here.
 */
export async function loadWebApp() {
  vi.resetModules();

  const [tokens, endpoints, refresh, errors, constants, router] = await Promise.all([
    import('../../src/api/tokens'),
    import('../../src/api/endpoints'),
    import('../../src/api/refresh'),
    import('../../src/api/errors'),
    import('../../src/api/constants'),
    import('../../src/routes/router'),
  ]);

  return { tokens, endpoints, refresh, errors, constants, routeTree: router.routeTree };
}

/** Everything a test needs from one freshly evaluated copy of the app. */
export type LoadedWebApp = Awaited<ReturnType<typeof loadWebApp>>;

/**
 * Renders the real route tree at `initialPath` over a memory history, with a
 * per-test `QueryClient` so no cached `/me` or `/health` result leaks between
 * tests. The router, guards and providers are the app's own — only the history
 * and the cache are test-local.
 */
export function renderAppAt(app: LoadedWebApp, initialPath: string): RenderResult {
  const router = createRouter({
    routeTree: app.routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: RETRY_QUERIES },
      mutations: { retry: RETRY_QUERIES },
    },
  });

  const tree: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );

  return render(tree);
}

export interface ApiRequestCounter {
  /** How many requests MSW has seen for `pathname` so far. */
  countOf: (pathname: string) => number;
}

/**
 * Counts requests via MSW's own `request:start` event rather than by
 * incrementing inside a handler, so the count covers every request the app
 * makes — including ones no handler matched. Listeners are removed after each
 * test by `setup.ts`.
 */
export function countApiRequests(): ApiRequestCounter {
  const counts = new Map<string, number>();

  server.events.on('request:start', ({ request }) => {
    const { pathname } = new URL(request.url);
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
  });

  return {
    countOf: (pathname: string) => counts.get(pathname) ?? 0,
  };
}

export interface UnhandledRejectionTracker {
  /** Every rejection reason that escaped, in order. Must stay empty. */
  readonly reasons: readonly unknown[];
  /** Removes the listeners. Always call this before asserting. */
  stop: () => void;
}

/**
 * Catches floating promises (case 37's "no unhandled rejection" half).
 *
 * `LoginPage` uses TanStack Query's `mutate`, not `mutateAsync`, so the failed
 * login is captured in `mutation.error` and nothing floats. If someone switched
 * it to `mutateAsync` without a `.catch()`, the rejection would land here and
 * the assertion would fail — which is the whole point of tracking it rather
 * than trusting the implementation.
 *
 * Both channels are watched: jsdom dispatches `unhandledrejection` on `window`,
 * while Node reports `unhandledRejection` on `process`.
 */
export function trackUnhandledRejections(): UnhandledRejectionTracker {
  const reasons: unknown[] = [];

  const onWindowRejection = (event: PromiseRejectionEvent): void => {
    reasons.push(event.reason);
  };
  const onProcessRejection = (reason: unknown): void => {
    reasons.push(reason);
  };

  window.addEventListener('unhandledrejection', onWindowRejection);
  process.on('unhandledRejection', onProcessRejection);

  return {
    reasons,
    stop: () => {
      window.removeEventListener('unhandledrejection', onWindowRejection);
      process.off('unhandledRejection', onProcessRejection);
    },
  };
}
