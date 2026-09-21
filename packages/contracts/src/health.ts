import { z } from 'zod';

import { DB_STATUS, HEALTH_STATUS } from './constants.js';

/**
 * `GET /api/v1/health` (FR6).
 *
 * The single documented exception to the error envelope: this body is returned
 * on both `200` (db reachable) and `503` (db unreachable), never wrapped in
 * `ErrorResponse`.
 *
 * `version` is read from `apps/api/package.json` at boot, not from an env var.
 */
export const HealthStatusSchema = z.enum(HEALTH_STATUS);

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const DbStatusSchema = z.enum(DB_STATUS);

export type DbStatus = z.infer<typeof DbStatusSchema>;

export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  version: z.string(),
  db: DbStatusSchema,
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
