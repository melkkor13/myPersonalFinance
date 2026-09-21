/**
 * Typed domain errors (FR2, FR5).
 *
 * ## The rule this file enforces
 * Services throw these and **know nothing about HTTP**. Not one thrown error
 * carries a status code, a header, or a response body. `plugins/errorHandler.ts`
 * is the only place that turns a domain error into an HTTP response, and it does
 * so by looking the error's `code` up in {@link ERROR_CODE_HTTP_STATUS}.
 *
 * The mapping table lives here rather than in the plugin on purpose: it is the
 * one place that knows every code, so keeping it beside the error classes means a
 * new code cannot be added without its status. The *instances* stay status-free —
 * the table is data the HTTP layer reads, not state the service layer sets.
 *
 * Codes are imported from `@finance/contracts` and never redefined; the wire
 * envelope and the thrown error are therefore incapable of disagreeing.
 *
 * Framework-agnostic: no Fastify, no Drizzle (B1/B3).
 */
import { ERROR_CODE, type ErrorCode } from '@finance/contracts';

/* ------------------------------------------------------------------ *
 * Named constants — HTTP statuses, read only by the error handler
 * ------------------------------------------------------------------ */

export const HTTP_STATUS_BAD_REQUEST = 400;
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_NOT_FOUND = 404;
export const HTTP_STATUS_CONFLICT = 409;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

/**
 * Code → HTTP status. Exhaustive over `ErrorCode` by type, so adding a code to
 * the contracts package fails to compile until its status is decided here.
 */
export const ERROR_CODE_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  [ERROR_CODE.VALIDATION_ERROR]: HTTP_STATUS_BAD_REQUEST,
  [ERROR_CODE.UNAUTHENTICATED]: HTTP_STATUS_UNAUTHORIZED,
  [ERROR_CODE.NOT_FOUND]: HTTP_STATUS_NOT_FOUND,
  [ERROR_CODE.CONFLICT]: HTTP_STATUS_CONFLICT,
  [ERROR_CODE.INTERNAL]: HTTP_STATUS_INTERNAL_SERVER_ERROR,
  [ERROR_CODE.SERVICE_UNAVAILABLE]: HTTP_STATUS_SERVICE_UNAVAILABLE,
};

/** Status for anything that is not a domain error — an unexpected throw (case 35). */
export const UNEXPECTED_ERROR_HTTP_STATUS = HTTP_STATUS_INTERNAL_SERVER_ERROR;

/** Code for anything that is not a domain error. Its message is never echoed. */
export const UNEXPECTED_ERROR_CODE: ErrorCode = ERROR_CODE.INTERNAL;

/**
 * The single message every authentication failure carries.
 *
 * One constant, one message: a wrong password and an unknown email must produce
 * byte-identical responses so neither reveals whether the account exists
 * (acceptance case 32). Reasons go to the server log, never to the client.
 */
export const UNAUTHENTICATED_MESSAGE = 'Authentication failed';

/* ------------------------------------------------------------------ *
 * Hierarchy
 * ------------------------------------------------------------------ */

/**
 * Base class for every expected, *modelled* failure.
 *
 * Subclasses exist for the codes the application actually throws. Adding
 * `NotFoundError` or `ConflictError` later is a five-line subclass with no change
 * to this class, to the handler, or to the mapping's shape — their codes and
 * statuses are already declared (they are unreachable in the scaffold only
 * because no route can currently produce them).
 */
export abstract class DomainError extends Error {
  /** The contract-defined code. The HTTP layer maps it; the thrower does not. */
  abstract readonly code: ErrorCode;

  /**
   * Offending request field names. Populated only for `VALIDATION_ERROR`;
   * every other code leaves it `undefined` so the envelope omits the key
   * entirely rather than sending an empty array (FR5).
   */
  readonly fields: readonly string[] | undefined;

  constructor(
    message: string,
    options?: { readonly fields?: readonly string[]; readonly cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.fields = options?.fields;
  }
}

/**
 * Credentials missing, malformed, expired, or wrong.
 *
 * Deliberately undifferentiated: login failures, a missing `Authorization`
 * header, a bad signature, an expired access token, and refresh-token replay all
 * throw this same error with the same message (cases 31, 32, 33).
 */
export class UnauthenticatedError extends DomainError {
  override readonly code = ERROR_CODE.UNAUTHENTICATED;

  constructor(options?: { readonly cause?: unknown }) {
    super(UNAUTHENTICATED_MESSAGE, options);
  }
}

/* ------------------------------------------------------------------ *
 * Guards and lookup — the error handler's whole interface to this module
 * ------------------------------------------------------------------ */

/** True when `value` is one of our modelled failures, safe to surface verbatim. */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/**
 * HTTP status for a thrown value. Anything that is not a `DomainError` is an
 * unexpected throw and becomes a 500 whose message is never echoed to the client.
 */
export function httpStatusForError(value: unknown): number {
  return isDomainError(value) ? ERROR_CODE_HTTP_STATUS[value.code] : UNEXPECTED_ERROR_HTTP_STATUS;
}
