import { QueryClient, queryOptions } from '@tanstack/react-query';

import { fetchHealth, fetchMe } from './endpoints';

/**
 * TanStack Query wiring (ADR 0007): server state lives here, not in component
 * state or a second store.
 */

/** Query keys, named so a refetch/invalidate can never mistype one. */
export const QUERY_KEYS = {
  ME: ['me'],
  HEALTH: ['health'],
} as const;

/**
 * Retries are disabled on purpose. The only retry this app performs is the
 * single replay after a successful token refresh (`client.ts`); letting Query
 * retry on top of that would fire extra requests at the rotating refresh
 * endpoint and make case 22's request count unpredictable.
 */
const RETRY_QUERIES = false;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: RETRY_QUERIES },
    mutations: { retry: RETRY_QUERIES },
  },
});

export const meQueryOptions = queryOptions({
  queryKey: QUERY_KEYS.ME,
  queryFn: fetchMe,
});

export const healthQueryOptions = queryOptions({
  queryKey: QUERY_KEYS.HEALTH,
  queryFn: fetchHealth,
});
