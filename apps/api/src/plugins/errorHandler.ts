/**
 * The single error → HTTP mapping point (FR5, C6, "Error-envelope architecture").
 *
 * Every failure the API can produce leaves through this file, and every response
 * it writes is an `ErrorResponse` envelope from `@finance/contracts`. Nothing
 * else in the codebase is allowed to invent an error body.
 *
 * ## Mapping order (load-bearing)
 * 1. **Zod schema validation** — Fastify raises `FST_ERR_VALIDATION` whose own
 *    message is a flat string like `body/email Invalid email address, ...`. That
 *    is *not* our envelope (C6), so it is recognised with
 *    `hasZodFastifySchemaValidationErrors()` and rewritten into
 *    400 `VALIDATION_ERROR` with `fields` — **bare** field names (`email`), never
 *    the `body/email` instance path.
 * 2. **Domain errors** from `lib/errors.ts` — their `code` is the contract code
 *    and `httpStatusForError()` supplies the status. Services never know either.
 * 3. **Anything else** — 500 `INTERNAL` with a fixed generic message. The thrown
 *    value's own `message` is deliberately NOT echoed: an unexpected throw can
 *    carry SQL text, a file path, or a stack. The full error goes to the Pino log
 *    at `error` level instead (case 32).
 *
 * `fields` is present ONLY for `VALIDATION_ERROR`; every other code omits the key
 * entirely rather than sending `null` or `[]` (FR5).
 *
 * ## Why a plain function and not a Fastify plugin
 * `setErrorHandler()` / `setNotFoundHandler()` apply to the *encapsulation
 * context* they are called in. Registered as an ordinary (non-`fastify-plugin`)
 * plugin, this handler would cover only its own child context and would not see
 * sibling module routes. `fastify-plugin` is not a declared dependency of
 * `apps/api`, so the plugin exposes a function that `buildServer()` applies to
 * the root instance directly — one handler, whole application, no wrapper
 * dependency.
 */
import { ERROR_CODE, type ErrorBody, type ErrorCode, type ErrorResponse } from '@finance/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  type ZodFastifySchemaValidationError,
} from 'fastify-type-provider-zod';

import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_NOT_FOUND,
  httpStatusForError,
  isDomainError,
  UNEXPECTED_ERROR_CODE,
  UNEXPECTED_ERROR_HTTP_STATUS,
} from '../lib/errors.js';

/* ------------------------------------------------------------------ *
 * Named constants — messages, separators, log lines (no inline literals)
 * ------------------------------------------------------------------ */

/**
 * The only message a validation failure carries. Fastify's own
 * `body/email Invalid email address` string is discarded: it leaks the framework's
 * instance-path syntax into the contract, and `fields` already names the offenders.
 */
export const VALIDATION_ERROR_MESSAGE = 'Request validation failed';

/** The generic 500 message. Never derived from the thrown error (case 32). */
export const INTERNAL_ERROR_MESSAGE = 'An internal error occurred';

/** Body for a route that matched nothing. */
export const NOT_FOUND_MESSAGE = 'Resource not found';

/** Separator inside `instancePath`, e.g. `/body/email` → `['body','email']`. */
const INSTANCE_PATH_SEPARATOR = '/';

/** An `instancePath` segment that is an array index, not a field name. */
const ARRAY_INDEX_PATTERN = /^\d+$/;

/** Log lines. Constants so a log-assertion test can import rather than retype them. */
const LOG_MESSAGE_VALIDATION_FAILED = 'Request failed schema validation';
const LOG_MESSAGE_DOMAIN_ERROR = 'Request failed with a domain error';
const LOG_MESSAGE_UNEXPECTED_ERROR = 'Unhandled error while serving a request';
const LOG_MESSAGE_ROUTE_NOT_FOUND = 'No route matched the request';

/* ------------------------------------------------------------------ *
 * Envelope construction
 * ------------------------------------------------------------------ */

/**
 * Build an `ErrorResponse`.
 *
 * `fields` is spread in only when supplied, so under `exactOptionalPropertyTypes`
 * the key is genuinely absent from the serialized body — not `undefined`, not `[]`.
 */
function errorEnvelope(
  code: ErrorCode,
  message: string,
  fields?: readonly string[],
): ErrorResponse {
  const body: ErrorBody =
    fields === undefined ? { code, message } : { code, message, fields: [...fields] };
  return { error: body };
}

/**
 * Bare field names for the offending inputs, e.g. `['email','password']`.
 *
 * `ZodFastifySchemaValidationError.instancePath` is `/` + the Zod issue path, so a
 * body field arrives as `/email` and a nested one as `/address/city`. The contract
 * wants the field name only, so the last non-index segment is taken; array indices
 * (`/items/0/amount` → `amount`) are skipped rather than reported as `0`. Order is
 * preserved and duplicates collapse, because one field can raise several issues.
 */
export function validationFieldNames(
  validation: readonly ZodFastifySchemaValidationError[],
): string[] {
  const fields = new Set<string>();
  for (const issue of validation) {
    const segments = issue.instancePath
      .split(INSTANCE_PATH_SEPARATOR)
      .filter((segment) => segment.length > 0 && !ARRAY_INDEX_PATTERN.test(segment));
    const field = segments.at(-1);
    if (field !== undefined) {
      fields.add(field);
    }
  }
  return [...fields];
}

/* ------------------------------------------------------------------ *
 * Installation
 * ------------------------------------------------------------------ */

/**
 * Install the error and not-found handlers on `app`.
 *
 * Call this on the ROOT instance, before any module registers routes, so that a
 * throw from any route, hook, or serializer is mapped here.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    // 1. Zod validation (C6) — rewrite Fastify's FST_ERR_VALIDATION into the envelope.
    if (hasZodFastifySchemaValidationErrors(error)) {
      const fields = validationFieldNames(error.validation);
      request.log.info({ err: error, fields }, LOG_MESSAGE_VALIDATION_FAILED);
      return reply
        .code(HTTP_STATUS_BAD_REQUEST)
        .send(errorEnvelope(ERROR_CODE.VALIDATION_ERROR, VALIDATION_ERROR_MESSAGE, fields));
    }

    // 2. Modelled domain failure — its own code, message, and mapped status. A
    //    domain error's message is written by us and safe to surface verbatim.
    if (isDomainError(error)) {
      request.log.warn({ err: error }, LOG_MESSAGE_DOMAIN_ERROR);
      const fields = error.code === ERROR_CODE.VALIDATION_ERROR ? error.fields : undefined;
      return reply
        .code(httpStatusForError(error))
        .send(errorEnvelope(error.code, error.message, fields));
    }

    // 3. Unexpected throw — the body says nothing, the log says everything (case 32).
    //    `error.message` is not echoed: it may itself be SQL text or a file path.
    request.log.error({ err: error }, LOG_MESSAGE_UNEXPECTED_ERROR);
    return reply
      .code(UNEXPECTED_ERROR_HTTP_STATUS)
      .send(errorEnvelope(UNEXPECTED_ERROR_CODE, INTERNAL_ERROR_MESSAGE));
  });

  // Fastify's default 404 body (`{ message, error, statusCode }`) is not our
  // envelope, so unmatched routes are answered here instead. `NOT_FOUND` is
  // declared-but-unreachable only in the sense that no *scaffold route* emits it;
  // a genuinely unmatched URL is exactly what the code is for.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    request.log.info(LOG_MESSAGE_ROUTE_NOT_FOUND);
    return reply
      .code(HTTP_STATUS_NOT_FOUND)
      .send(errorEnvelope(ERROR_CODE.NOT_FOUND, NOT_FOUND_MESSAGE));
  });
}
