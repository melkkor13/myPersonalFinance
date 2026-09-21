/**
 * Auth routes — HTTP and nothing else (FR2, FR6).
 *
 * Each handler does three things: hand the parsed body to `auth.service.ts`,
 * pick the status code, and return the value. There is no business logic here,
 * no SQL, no `drizzle-orm` import (B1), and no error mapping — a service throw
 * becomes a 401 in `plugins/errorHandler.ts`, which is the only place that
 * writes an error body.
 *
 * ## Paths
 * Every path comes from `ROUTES` in `@finance/contracts`, so the router, the
 * OpenAPI document and the web client cannot drift apart. No path string is
 * written in this file.
 *
 * ## `GET /api/v1/me` is the module's one protected route
 * It opts in to the `authenticate` `onRequest` hook (`plugins/authenticate.ts`);
 * the three `/auth/*` routes are necessarily unauthenticated, since they are how
 * a caller obtains an access token. Opt-in is the point: a default-on global hook
 * would need a public-route allowlist, and an un-updated allowlist is how a route
 * silently becomes public.
 *
 * ## `POST /api/v1/auth/logout` declares no response body
 * It answers `204` with an empty body and **no response schema** — one of FR5's
 * two documented contract exemptions (case 8). See {@link NO_CONTENT_RESPONSE}
 * for how a status with no body at all is expressed.
 *
 * ## Every non-2xx references `ErrorResponse` (case 5)
 * Each route declares `ErrorResponseSchema` for exactly the error statuses it can
 * actually produce, which is what makes those responses `$ref`
 * `#/components/schemas/ErrorResponse` in the document. Statuses no route can
 * emit are not declared; an inaccurate document is worse than a terse one.
 *
 * ## C8
 * `withTypeProvider<ZodTypeProvider>()` is re-applied in this module's own scope:
 * `server.ts` sets the validator and serializer compilers at the root, and those
 * are inherited at runtime, but the type provider's *types* do not propagate into
 * plugin children.
 */
import {
  ErrorResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  MeResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  ROUTES,
} from '@finance/contracts';
import type { FastifyPluginCallback } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_UNAUTHORIZED,
  UnauthenticatedError,
} from '../../lib/errors.js';
import { authenticate } from '../../plugins/authenticate.js';
import { SECURITY_SCHEME_BEARER_AUTH } from '../../plugins/openapi.js';

import { login, logout, me, refresh } from './auth.service.js';

/* ------------------------------------------------------------------ *
 * Named constants — statuses, descriptions (project no-magic-literals rule)
 * ------------------------------------------------------------------ */

/** Success status for the three routes that return a body. */
const HTTP_STATUS_OK = 200;

/** Logout's status. No body accompanies it (case 8). */
const HTTP_STATUS_NO_CONTENT = 204;

/** OpenAPI `summary` per route. */
const LOGIN_SUMMARY = 'Exchange email and password for an access and refresh token';
const REFRESH_SUMMARY = 'Rotate a refresh token';
const LOGOUT_SUMMARY = 'Revoke a refresh token';
const ME_SUMMARY = 'The authenticated user';

/** OpenAPI `description` per route. Each states the behaviour a client must expect. */
const LOGIN_DESCRIPTION =
  'Returns 401 with an identical body for an unknown email and for a wrong password, so neither ' +
  'reveals whether the account exists.';
const REFRESH_DESCRIPTION =
  'Issues a new access token and a new refresh token, and revokes the presented one: a refresh ' +
  'token is single-use. Presenting an already-rotated token is treated as compromise and revokes ' +
  "every one of that user's refresh tokens. Clients must therefore serialise refreshes.";
const LOGOUT_DESCRIPTION =
  'Idempotent. Answers 204 with an empty body, and declares no response schema — one of the two ' +
  'documented contract exemptions. Does not revoke the user’s other sessions.';
const ME_DESCRIPTION =
  'Requires a valid Bearer access token. The response never contains password_hash.';

/**
 * Logout's 204 entry (case 8): a status that declares **no body**.
 *
 * This is the one shape that produces a body-less response in the generated
 * document, and it is a narrow path between two failure modes:
 *   - omitting the 204 entirely leaves the status out of the document;
 *   - an entry with an empty `content` map crashes `@fastify/swagger`, which
 *     reads the first media type of `content` unguarded;
 *   - any ordinary object schema would declare an `application/json` body, which
 *     is exactly what the exemption forbids.
 *
 * `z.null()` transforms to `{"type":"null"}`, and `@fastify/swagger` deliberately
 * skips content generation for a `null`-typed response — so the document gets
 * `204` with a description and no `content`. Nothing is ever serialized through
 * it: the handler sends no payload, and Fastify skips serialization for a 204.
 */
const NO_CONTENT_RESPONSE = z.null();

/** `security` requirement for the one protected route. */
const BEARER_SECURITY = [{ [SECURITY_SCHEME_BEARER_AUTH]: [] }];

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * Register `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` and
 * `GET /me`, all under the `/api/v1` prefix carried by the `ROUTES` constants.
 *
 * Registered by `buildServer()` **after** `registerOpenApi(app)`:
 * `@fastify/swagger` collects the route table through an `onRoute` hook, so a
 * module registered earlier is silently absent from the document.
 *
 * A callback-style plugin (like `healthModule`) because the registration body
 * itself has nothing to await; the handlers are individually `async`.
 */
export const authModule: FastifyPluginCallback = (app, _options, done) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    ROUTES.AUTH_LOGIN,
    {
      schema: {
        summary: LOGIN_SUMMARY,
        description: LOGIN_DESCRIPTION,
        body: LoginRequestSchema,
        response: {
          [HTTP_STATUS_OK]: LoginResponseSchema,
          [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
          [HTTP_STATUS_UNAUTHORIZED]: ErrorResponseSchema,
        },
      },
    },
    async (request) => login(app.config, request.body.email, request.body.password),
  );

  typed.post(
    ROUTES.AUTH_REFRESH,
    {
      schema: {
        summary: REFRESH_SUMMARY,
        description: REFRESH_DESCRIPTION,
        body: RefreshRequestSchema,
        response: {
          [HTTP_STATUS_OK]: RefreshResponseSchema,
          [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
          [HTTP_STATUS_UNAUTHORIZED]: ErrorResponseSchema,
        },
      },
    },
    async (request) => refresh(app.config, request.body.refresh_token),
  );

  typed.post(
    ROUTES.AUTH_LOGOUT,
    {
      schema: {
        summary: LOGOUT_SUMMARY,
        description: LOGOUT_DESCRIPTION,
        body: LogoutRequestSchema,
        response: {
          // No *body* for the 204 — case 8. A malformed request is still a 400.
          [HTTP_STATUS_NO_CONTENT]: NO_CONTENT_RESPONSE,
          [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      logout(app.config, request.body.refresh_token);
      // `.send(null)` matches the declared `z.null()` 204 entry. Fastify strips
      // the payload of a 204 response, so the body on the wire is genuinely
      // empty (asserted: zero-length raw payload, no content-type). Awaited and
      // *not* returned — returning the reply object would make the handler's
      // return type the reply rather than `void`, which Fastify's typing (and
      // the declared `z.null()` entry) does not accept.
      await reply.status(HTTP_STATUS_NO_CONTENT).send(null);
    },
  );

  typed.get(
    ROUTES.ME,
    {
      // The module's only protected route (FR6).
      onRequest: authenticate,
      schema: {
        summary: ME_SUMMARY,
        description: ME_DESCRIPTION,
        security: BEARER_SECURITY,
        response: {
          [HTTP_STATUS_OK]: MeResponseSchema,
          [HTTP_STATUS_UNAUTHORIZED]: ErrorResponseSchema,
        },
      },
    },
    (request) => {
      // `request.user` is declared optional because it is absent on every route
      // that does not use the hook. On this route the hook has already thrown for
      // any unusable token, so this narrowing is unreachable in practice — it is
      // here so the handler cannot compile into treating an unauthenticated
      // request as authenticated.
      const authenticatedUser = request.user;
      if (authenticatedUser === undefined) {
        throw new UnauthenticatedError();
      }
      return me(app.config, authenticatedUser.id);
    },
  );

  done();
};
