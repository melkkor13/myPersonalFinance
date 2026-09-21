# 0003. Fastify as the backend framework

Date: 2026-09-20

## Status

Accepted

## Context

The backend is a standalone JSON API that will eventually be internet-facing and may serve non-browser clients. Two capabilities therefore matter more than they would for a web-app backend: every endpoint must validate its input against a declared schema, and the API must publish a machine-readable description of itself so any client can be generated or verified against it.

The project has decided that Zod schemas in a shared workspace package are the single source of truth for request and response shapes (ADR 0008), and that an OpenAPI 3.1 document is served from the API. The framework choice is largely a question of how much of that machinery is native versus assembled by hand.

The project is single-developer, so framework weight and boilerplate are real costs.

## Approaches Considered

### Option A: Fastify

**Pros:**
- Schema-based validation and response serialization are core framework features, not add-ons.
- OpenAPI generation is a first-party plugin (`@fastify/swagger`), so the published contract stays in step with the routes.
- Plugin encapsulation maps naturally onto the intended `modules/<domain>` structure, with scoped hooks for things like authentication.
- Strong TypeScript support, including type providers that infer handler types from route schemas.
- Fast, with low per-request overhead.

**Cons:**
- Smaller ecosystem than Express; fewer copy-paste answers available.
- The plugin/encapsulation lifecycle is a genuine learning curve and a common source of early mistakes.

### Option B: Express 5

**Pros:**
- The most widely used Node framework; essentially every question has a published answer.
- Minimal and unopinionated.

**Cons:**
- No built-in validation or serialization; needs several glue libraries assembled and maintained by hand.
- No first-party OpenAPI story, so the published contract is at risk of drifting from the routes.
- Weaker TypeScript ergonomics; request/response typing is largely manual.

### Option C: NestJS

**Pros:**
- Opinionated structure, dependency injection, and a strong OpenAPI integration out of the box.
- Scales well to large teams and large codebases.

**Cons:**
- Substantially heavier than the problem warrants for a single-user application.
- Decorator-driven metaprogramming adds indirection that is hard to debug.
- Considerable boilerplate per module; slower startup.

### Option D: Hono

**Pros:**
- Very small and fast; runs on Node, workers, and edge runtimes.
- Excellent TypeScript inference.

**Cons:**
- Younger ecosystem, with fewer mature plugins for authentication and OpenAPI.
- Runtime portability is not a requirement here, so its main differentiator goes unused.

## Decision

Adopt **Option A**, Fastify, with:

- One Fastify plugin per domain module under `src/modules/<domain>`, each structured as `routes → service → repository`.
- Cross-cutting plugins under `src/plugins`: `authenticate.ts`, `errorHandler.ts`, `openapi.ts`.
- Route schemas sourced from `@finance/contracts`, with the OpenAPI 3.1 document generated from those same schemas and served at `/api/v1/openapi.json`.
- `buildServer()` exported from `server.ts` as a pure factory with no side effects on import, so tests can use `fastify.inject()` without binding a port.

## Consequences

- **Positive:** Validation and the published contract derive from one schema definition, so they cannot drift. `fastify.inject()` makes API tests fast and hermetic with no HTTP server or port. Plugin scoping gives a clean way to apply authentication to some routes and not others.
- **Negative:** Encapsulation semantics must be understood before adding plugins, or hooks silently fail to apply. Fewer off-the-shelf integrations than Express, so some glue may need writing.
- **Neutral:** Fastify's logger (Pino) becomes the logging implementation by default, configured via `LOG_LEVEL`.
