import { setupServer } from 'msw/node';

import { defaultHandlers } from './handlers';

/**
 * The one MSW server for the whole web suite.
 *
 * Started once in `setup.ts` with `onUnhandledRequest: 'error'`: the SPA must
 * only ever talk to the five contract routes, so an unexpected URL — a typo, a
 * hardcoded `http://localhost:3000` bypassing the Vite proxy (C15) — fails the
 * test instead of quietly hitting the network.
 */
export const server = setupServer(...defaultHandlers());
