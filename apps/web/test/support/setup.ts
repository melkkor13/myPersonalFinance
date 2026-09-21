import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './server';

/**
 * Global test setup (referenced from `vitest.config.ts`).
 *
 * Per-test isolation has three parts, all of them necessary:
 *   1. **MSW** — handler overrides and request-event listeners are reset, so a
 *      test cannot inherit another test's mock or request counter.
 *   2. **React** — `cleanup()` unmounts anything still rendered.
 *   3. **`localStorage`** — the refresh token lives there (FR7), so a leftover
 *      token would change the next test's auth state.
 *
 * The fourth piece of shared state — the module-level `inFlight` lock in
 * `src/api/refresh.ts` — cannot be reset from here, because resetting it means
 * re-evaluating the module. That is handled per test by `loadWebApp()` in
 * `harness.tsx`.
 */

/** Any request outside the mocked contract routes is a test failure. */
const UNHANDLED_REQUEST_BEHAVIOUR = 'error';

/** jsdom implements no layout, so scrolling is a no-op rather than an error. */
const NO_OP_SCROLL = (): void => undefined;

beforeAll(() => {
  server.listen({ onUnhandledRequest: UNHANDLED_REQUEST_BEHAVIOUR });

  // TanStack Router restores scroll position on navigation and jsdom has no
  // layout, so it logs "Not implemented: Window's scrollTo()". Stubbing it keeps
  // a real failure visible in the output instead of buried in that noise.
  window.scrollTo = NO_OP_SCROLL;
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterAll(() => {
  server.close();
});
