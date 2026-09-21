/**
 * Health service — the business rule of the health check, such as it is (FR2).
 *
 * The rule: the service is `degraded` exactly when its database leg is
 * `unavailable`. Trivial today, but it is the only place that composes component
 * statuses into an overall one, so a second component (a cache, a queue) would
 * be added here and nowhere else.
 *
 * ## Import boundary (B3, statically asserted by task11)
 * This file **must not import from `src/db/**`**, and it does not: the database
 * is reached only through {@link isDatabaseReachable}. It also imports no Fastify
 * and no `drizzle-orm` (B1) — it knows nothing about HTTP status codes, and the
 * 200/503 choice is deliberately left to the route.
 *
 * `version` comes from `readAppVersion()` (`apps/api/package.json`, FR12), not
 * from an env var and not from an inline string.
 */
import {
  DB_STATUS_OK,
  DB_STATUS_UNAVAILABLE,
  HEALTH_STATUS_DEGRADED,
  HEALTH_STATUS_OK,
  type HealthResponse,
} from '@finance/contracts';

import { readAppVersion } from '../../config.js';

import { isDatabaseReachable } from './health.repository.js';

/**
 * Build the `HealthResponse` value for `GET /api/v1/health`.
 *
 * @param dbPath the validated `config.dbPath`, threaded through to the repository.
 * @returns the contract value. Every literal in it comes from
 * `@finance/contracts`, so a status string cannot drift from the schema that
 * validates it.
 *
 * Returns a value for *both* the healthy and the degraded case rather than
 * throwing a `ServiceUnavailableError`: a throw would be mapped by
 * `plugins/errorHandler.ts` into the `ErrorResponse` envelope, and FR5's single
 * documented envelope exception requires the component breakdown on 503 too.
 */
export function getHealth(dbPath: string): HealthResponse {
  const databaseReachable = isDatabaseReachable(dbPath);

  return {
    status: databaseReachable ? HEALTH_STATUS_OK : HEALTH_STATUS_DEGRADED,
    version: readAppVersion(),
    db: databaseReachable ? DB_STATUS_OK : DB_STATUS_UNAVAILABLE,
  };
}
