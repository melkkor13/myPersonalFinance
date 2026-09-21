/**
 * Health routes — HTTP and nothing else (FR2).
 *
 * The file's whole job: attach the contract schema, call the service, and choose
 * the status code. No business logic, no SQL, no database import.
 *
 * ## FR5's single envelope exception
 * `HealthResponse` is declared for **both** `200` and `503`, so the OpenAPI
 * document `$ref`s `HealthResponse` on this route's 503 while every other
 * non-2xx response `$ref`s `ErrorResponse`. That is intentional: a monitoring
 * probe needs the per-component breakdown (`db: "unavailable"`) rather than an
 * error code, and it is the reason the degraded case is a *returned value* here
 * instead of a thrown `ServiceUnavailableError` — a throw would be rewritten
 * into the `ErrorResponse` envelope by `plugins/errorHandler.ts`.
 *
 * ## An unreachable database must not throw out of here (FR8)
 * `ping()` signals failure by returning `false`, never by throwing, and the
 * repository re-guarantees that. So the degraded path is an ordinary 503
 * response, the server still binds its port with a dead database, and health is
 * what tells you it is dead.
 *
 * ## C8
 * `withTypeProvider<ZodTypeProvider>()` set at the root in `server.ts` does not
 * propagate its *types* into plugin children — the compilers are inherited at
 * runtime, the type provider is not. It is therefore re-applied in this module's
 * own scope below.
 */
import { DB_STATUS_OK, HealthResponseSchema, ROUTES } from '@finance/contracts';
import type { FastifyPluginCallback } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { HTTP_STATUS_SERVICE_UNAVAILABLE } from '../../lib/errors.js';

import { getHealth } from './health.service.js';

/* ------------------------------------------------------------------ *
 * Named constants — no inline status codes (project no-magic-literals rule)
 * ------------------------------------------------------------------ */

/**
 * Success status. `lib/errors.ts` declares only the *error* codes (it maps
 * `ErrorCode` → status), so the one success code this module needs is named here.
 */
export const HTTP_STATUS_OK = 200;

/** OpenAPI `summary`/`description` for the route. */
const ROUTE_SUMMARY = 'Liveness and database reachability';
const ROUTE_DESCRIPTION =
  'Returns HealthResponse on both 200 (database reachable) and 503 (database unreachable). ' +
  'This is the single documented exception to the ErrorResponse envelope.';

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * Register `GET /api/v1/health`.
 *
 * Registered by `buildServer()` with `app.register(healthModule)` **after**
 * `registerOpenApi(app)`: `@fastify/swagger` collects routes through an
 * `onRoute` hook, which only sees routes added after it.
 *
 * Declared as a callback-style plugin rather than an `async` one because it has
 * nothing to await — an `async` plugin with no `await` is a `require-await` lint
 * failure, and `done()` states the same thing without the empty promise.
 */
export const healthModule: FastifyPluginCallback = (app, _options, done) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    // Path from the contracts constant — never a hardcoded string.
    ROUTES.HEALTH,
    {
      schema: {
        summary: ROUTE_SUMMARY,
        description: ROUTE_DESCRIPTION,
        response: {
          [HTTP_STATUS_OK]: HealthResponseSchema,
          // NOT ErrorResponseSchema. See the FR5 note above.
          [HTTP_STATUS_SERVICE_UNAVAILABLE]: HealthResponseSchema,
        },
      },
    },
    (_request, reply) => {
      // `app.config.dbPath` — the validated, injected config (server.ts decorator),
      // so the route target cannot diverge from what the rest of the app booted with.
      const health = getHealth(app.config.dbPath);

      // The status code is derived from the db leg, which is the component the
      // probe actually cares about. Status literals come from the contracts.
      const statusCode =
        health.db === DB_STATUS_OK ? HTTP_STATUS_OK : HTTP_STATUS_SERVICE_UNAVAILABLE;

      // Status set on the reply, body *returned* — returning `reply.send(...)`
      // instead would hand Fastify the reply object, which its handler return
      // type (the schema-derived body, or void) does not accept.
      reply.status(statusCode);
      return health;
    },
  );

  done();
};
