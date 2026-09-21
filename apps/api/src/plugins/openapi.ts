/**
 * OpenAPI 3.1 document + development-only Swagger UI (FR5, FR6, Q6).
 *
 * ## Named components, not inlined schemas (Q6)
 * `createJsonSchemaTransformObject()` emits every schema in {@link schemaRegistry}
 * under `components/schemas`, and the matching `createJsonSchemaTransform()` makes
 * each route's request/response schemas emit a `$ref` to those components instead
 * of a copy. Both transforms take the same registry — the default
 * `jsonSchemaTransform` export reads Zod's *global* registry and would inline
 * every schema instead of referencing it.
 * That is what makes "every non-2xx response references `ErrorResponse`"
 * assertable in the strict sense of the word *reference*.
 *
 * In `fastify-type-provider-zod@7` the component set is supplied as a **Zod
 * registry** (`{ id }` metadata per schema) rather than the `{ schemas: {...} }`
 * map of earlier majors; `zodRegistryToJson` walks the registry to build
 * `components/schemas`. The registry is built here, from `@finance/contracts`
 * schemas only, so a component name cannot drift from the contract it documents.
 * Input and output projections of a schema are emitted separately (the input one
 * suffixed `Input`), which is how a request body and a response body that differ
 * only in defaults stay distinguishable.
 *
 * ## The document route
 * `@fastify/swagger@9` serves no routes of its own; it decorates the instance
 * with `swagger()`. The document is therefore exposed by an ordinary route at
 * `ROUTES.OPENAPI`, marked `hide: true` so the meta route does not document
 * itself (it is contracts-exempt under FR5).
 *
 * ## Dev-only Swagger UI
 * The `@fastify/swagger-ui` registration is inside the `NODE_ENV === 'development'`
 * branch — the plugin is never registered in production, so `ROUTES.DOCS` has no
 * matching route there and falls through to the `NOT_FOUND` envelope. Registering
 * it unconditionally and guarding inside a hook would still leak its existence
 * (and its static assets) into the production route table.
 *
 * ## Ordering
 * Call this before the module plugins register their routes: `@fastify/swagger`
 * collects routes through an `onRoute` hook, which only sees routes added after it.
 */
import {
  ErrorResponseSchema,
  HealthResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  MeResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  ROUTES,
} from '@finance/contracts';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import {
  createJsonSchemaTransform,
  createJsonSchemaTransformObject,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { NODE_ENV_DEVELOPMENT } from '../config.js';
import { BEARER_SCHEME } from '../lib/tokens.js';

/* ------------------------------------------------------------------ *
 * Named constants — document metadata, component names, scheme names
 * ------------------------------------------------------------------ */

/** OpenAPI specification version. 3.1 is mandated by C5 (Zod v4 emits 2020-12). */
export const OPENAPI_SPEC_VERSION = '3.1.0';

/** `info.title` of the generated document. */
export const OPENAPI_TITLE = 'Personal Finance Tracker API';

/** `info.description`. */
export const OPENAPI_DESCRIPTION =
  'Localhost-only personal finance tracker. All request and response fields are snake_case.';

/**
 * `info.version` when the instance carries no version. Normally the document
 * version is `config.version`, read from `apps/api/package.json` at boot (FR12),
 * so the document and the `/health` payload always report the same build.
 */
export const OPENAPI_FALLBACK_VERSION = '0.0.0';

/** Component names under `components/schemas`. Referenced by routes via `$ref`. */
export const COMPONENT_ERROR_RESPONSE = 'ErrorResponse';
export const COMPONENT_HEALTH_RESPONSE = 'HealthResponse';
export const COMPONENT_LOGIN_REQUEST = 'LoginRequest';
export const COMPONENT_LOGIN_RESPONSE = 'LoginResponse';
export const COMPONENT_REFRESH_REQUEST = 'RefreshRequest';
export const COMPONENT_REFRESH_RESPONSE = 'RefreshResponse';
export const COMPONENT_LOGOUT_REQUEST = 'LogoutRequest';
export const COMPONENT_ME_RESPONSE = 'MeResponse';

/** `components/securitySchemes` entry the protected route references. */
export const SECURITY_SCHEME_BEARER_AUTH = 'bearerAuth';
const SECURITY_SCHEME_TYPE_HTTP = 'http';
/** Lower-cased from `lib/tokens.ts` so the header scheme is declared in one place. */
const SECURITY_SCHEME_BEARER = BEARER_SCHEME.toLowerCase();
const SECURITY_SCHEME_BEARER_FORMAT = 'JWT';

/* ------------------------------------------------------------------ *
 * Component registry
 * ------------------------------------------------------------------ */

/**
 * Metadata shape `fastify-type-provider-zod` reads off the registry. `id` becomes
 * the `components/schemas` key and therefore the `$ref` target.
 */
interface SchemaComponentMeta {
  id?: string | undefined;
  [key: string]: unknown;
}

/**
 * The named components (Q6). Exported so a contract test can assert that every
 * schema the API serves has a component, without re-deriving the list.
 */
export const schemaRegistry = z.registry<SchemaComponentMeta>();

schemaRegistry.add(ErrorResponseSchema, { id: COMPONENT_ERROR_RESPONSE });
schemaRegistry.add(HealthResponseSchema, { id: COMPONENT_HEALTH_RESPONSE });
schemaRegistry.add(LoginRequestSchema, { id: COMPONENT_LOGIN_REQUEST });
schemaRegistry.add(LoginResponseSchema, { id: COMPONENT_LOGIN_RESPONSE });
schemaRegistry.add(RefreshRequestSchema, { id: COMPONENT_REFRESH_REQUEST });
schemaRegistry.add(RefreshResponseSchema, { id: COMPONENT_REFRESH_RESPONSE });
schemaRegistry.add(LogoutRequestSchema, { id: COMPONENT_LOGOUT_REQUEST });
schemaRegistry.add(MeResponseSchema, { id: COMPONENT_ME_RESPONSE });

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Register OpenAPI generation, the document route, and — in development only —
 * Swagger UI.
 *
 * Applied to the root instance by `buildServer()` before the module plugins, so
 * their routes are captured. Like the error handler this is a plain function
 * rather than an encapsulated plugin, because `ROUTES.OPENAPI` must live in the
 * root route table beside the API routes.
 */
export function registerOpenApi(app: FastifyInstance): void {
  app.register(fastifySwagger, {
    openapi: {
      openapi: OPENAPI_SPEC_VERSION,
      info: {
        title: OPENAPI_TITLE,
        description: OPENAPI_DESCRIPTION,
        version: app.config.version.length > 0 ? app.config.version : OPENAPI_FALLBACK_VERSION,
      },
      components: {
        securitySchemes: {
          [SECURITY_SCHEME_BEARER_AUTH]: {
            type: SECURITY_SCHEME_TYPE_HTTP,
            scheme: SECURITY_SCHEME_BEARER,
            bearerFormat: SECURITY_SCHEME_BEARER_FORMAT,
          },
        },
      },
    },
    // Per-route: Zod schemas → JSON Schema, emitting `$ref`s into the components
    // below. It must be built from the SAME registry as `transformObject`: the
    // ready-made `jsonSchemaTransform` export is bound to Zod's global registry,
    // finds none of our ids there, and silently inlines a full copy of every
    // schema into each route — which is exactly what Q6 rules out.
    transform: createJsonSchemaTransform({ schemaRegistry }),
    // Whole-document: the named components themselves (Q6).
    transformObject: createJsonSchemaTransformObject({ schemaRegistry }),
  });

  // The document itself. `hide: true` keeps this meta route out of the document.
  app.get(ROUTES.OPENAPI, { schema: { hide: true } }, () => app.swagger());

  if (app.config.nodeEnv === NODE_ENV_DEVELOPMENT) {
    app.register(fastifySwaggerUi, { routePrefix: ROUTES.DOCS });
  }
}
