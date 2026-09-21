import { z } from 'zod';

/**
 * The uniform error envelope (FR5).
 *
 * Reachable in the scaffold — these three are actually produced by the code
 * that exists today:
 *   - `VALIDATION_ERROR`  → 400
 *   - `UNAUTHENTICATED`   → 401
 *   - `INTERNAL`          → 500
 *
 * Declared but unreachable in the scaffold — no route can currently emit them.
 * They are enumerated now, deliberately, so that the envelope shape and the
 * generated OpenAPI document do not have to change (a breaking contract change
 * for every existing client) when the first finance routes need them:
 *   - `NOT_FOUND`           → 404
 *   - `CONFLICT`            → 409
 *   - `SERVICE_UNAVAILABLE` → 503
 */
export const ERROR_CODE = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INTERNAL: 'INTERNAL',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

/** Codes a scaffold route can actually return. */
export const REACHABLE_ERROR_CODES = [
  ERROR_CODE.VALIDATION_ERROR,
  ERROR_CODE.UNAUTHENTICATED,
  ERROR_CODE.INTERNAL,
] as const;

/** Codes reserved for the finance routes that do not exist yet. */
export const UNREACHABLE_ERROR_CODES = [
  ERROR_CODE.NOT_FOUND,
  ERROR_CODE.CONFLICT,
  ERROR_CODE.SERVICE_UNAVAILABLE,
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODE);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * `fields` lists the offending request field names and is present **only** for
 * `VALIDATION_ERROR`; every other code omits the key entirely rather than
 * sending an empty array.
 */
export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  fields: z.array(z.string()).optional(),
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const ErrorResponseSchema = z.object({
  error: ErrorBodySchema,
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
