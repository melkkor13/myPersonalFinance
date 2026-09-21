# Task: Fastify Plugins — errorHandler, authenticate, openapi

## Status
COMPLETED

## Description
The three cross-cutting plugins named by ADR 0003.

## Inputs
- requirements.md § FR5, FR6, FR7, error-envelope architecture, C6, C8, Q6

## Steps
1. `src/plugins/errorHandler.ts` — the single mapping point, in this order:
   a. `hasZodFastifySchemaValidationErrors(err)` → 400 `VALIDATION_ERROR` with a `fields` array
      of the offending field names (C6 — the raw `FST_ERR_VALIDATION` shape is NOT the envelope).
   b. known domain error from `lib/errors.ts` → its mapped code and status.
   c. anything else → 500 `INTERNAL` with a generic message. **Full error to the Pino log;
      no stack trace, SQL text, or file path in the response body.**
2. `src/plugins/authenticate.ts` — verifies the `Authorization: Bearer` access token via
   `lib/tokens.ts`, populates `request.user`. Missing, malformed, wrongly-signed, and expired
   tokens all → 401 `UNAUTHENTICATED`, **without reaching the route handler**.
3. `src/plugins/openapi.ts` — `@fastify/swagger` with `openapi: '3.1.0'` and
   `createJsonSchemaTransformObject({ schemas: {...} })` registering named components (Q6).
   `@fastify/swagger-ui` at `/api/v1/docs` **only when `NODE_ENV === 'development'`**.
   Document served at `/api/v1/openapi.json`.
4. Re-apply `withTypeProvider<ZodTypeProvider>()` in module plugin signatures (C8).
5. Must not import `drizzle-orm` (B1).

## Expected Output
Three registered plugins.

## Verification
Envelope shape matches `ErrorResponse` for every error path.

## Dependencies
task06

## Execution Notes
First attempt stalled (stream watchdog, no files written). Retry succeeded.
Files: `src/plugins/{errorHandler,authenticate,openapi}.ts`. Modified `src/server.ts`.

### Design decisions
- The three plugins are applied as **plain functions taking the root instance**, NOT via
  `app.register(...)`. Reason: `setErrorHandler`/`setNotFoundHandler` bind to their encapsulation
  context, so a non-`fastify-plugin` wrapper would miss sibling module routes — and
  `fastify-plugin` is not a declared `apps/api` dependency. `@fastify/swagger`/`-ui` are still
  `app.register`ed inside `registerOpenApi`.
- **`fields` extraction:** each `ZodFastifySchemaValidationError.instancePath` (`/email`,
  `/address/city`, `/items/0/amount`) is split on `/`, empty and numeric-index segments dropped,
  last remaining segment taken → bare field name. Collected in a `Set`, so order is preserved
  and duplicate issues per field collapse.
- `authenticate` is an opt-in `onRequestAsyncHookHandler` that throws `UnauthenticatedError` and
  writes no status/body itself — the handler does the mapping.

### CORRECTION to the Q6 mechanism recorded in requirements.md
`fastify-type-provider-zod@7` has **no `createJsonSchemaTransformObject({ schemas })` option**;
that was wrong in the Phase 2 plan. Components are supplied via a **Zod registry**
(`z.registry()` + `{ id }`), which is the v7 equivalent. Additionally the ready-made
`jsonSchemaTransform` is bound to Zod's *global* registry, finds no ids, and **silently inlines
a full schema copy per route** — the exact outcome Q6 rejected. The working form is
`createJsonSchemaTransform({ schemaRegistry })`. Proof 5 caught this.

### Proofs (all PASS) — /private/tmp/.../scratchpad/task07-proofs.txt
1. Validation → exact `{"error":{"code":"VALIDATION_ERROR","message":"Request validation failed","fields":["email","password"]}}`
2. `UnauthenticatedError` → 401, **no `fields` key**
3. Error carrying SQL + a file path → 500 `INTERNAL`; **0 matches** for `SELECT`, `/Users/`,
   `at ` in the body; full error + stack present in the captured level-50 Pino line
4. All four case-31 inputs → 401 with **byte-identical bodies**; protected handler counter **0**
5. `openapi: "3.1.0"`, 16 component keys, route body is `{"$ref":"#/components/schemas/LoginRequestInput"}`
6. `/api/v1/docs` → 200 dev, 404 prod
7. Unmatched route → `{"error":{"code":"NOT_FOUND",...}}`, no Fastify default keys
8. `buildServer()` → `listening:false, address:null` before and after `ready()`

## Carry-forward
- **task08 + task09: module plugins MUST be registered AFTER `registerOpenApi`** — swagger's
  `onRoute` collector only sees routes registered after it. Registering earlier silently omits
  them from the document.
- **task10 (case 5):** v7 emits BOTH output and input projections of each component
  (`ErrorResponse` AND `ErrorResponseInput`). A request body `$ref`s `LoginRequestInput`, not
  `LoginRequest`. The case-5 assertion must accept the `...Input` suffix for request bodies
  rather than expecting the bare name, or it will fail spuriously.
