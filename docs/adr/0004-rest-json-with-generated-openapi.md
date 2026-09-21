# 0004. REST/JSON API with generated OpenAPI

Date: 2026-09-20

## Status

Accepted

## Amendments

**2026-09-21 — JSON field convention changed from `camelCase` to `snake_case`.** The supporting convention under Decision originally fixed `camelCase` for JSON request and response field names; it now reads `snake_case`. A project-wide API naming convention mandating `snake_case` took precedence over this ADR's incidental choice. The decision itself is **unchanged** — Option A (REST/JSON under `/api/v1/*` with a generated OpenAPI 3.1 document) remains accepted, and only the field-casing detail was amended.

## Context

The Node backend is a standalone API. Today its only client is a React SPA, but the API is expected to become internet-reachable so the application can be used from a phone. Whether a native mobile client is ever written is explicitly undecided and may never happen.

That last point materially changed this decision. The original argument for a language-neutral API was a planned native mobile client; with mobile undecided, a TypeScript-only approach such as tRPC becomes genuinely viable and would be less work for a React-only frontend. The choice was therefore re-examined rather than inherited.

The data is CRUD-shaped: accounts, transactions, categories, budgets. There are no deeply nested or highly variable read patterns that would reward a query language.

## Approaches Considered

### Option A: REST/JSON under a versioned prefix, with a generated OpenAPI 3.1 document

**Pros:**
- Language-neutral: any future client — native app, CLI, script, another service — can consume the API without a TypeScript toolchain.
- Debuggable with `curl` and readable in browser devtools, which matters a great deal when working alone.
- The generated OpenAPI document is living documentation and a codegen source for other languages.
- Standard HTTP caching and status-code semantics.
- Versioned path prefix makes breaking changes manageable once a mobile client exists that cannot be updated in lockstep.

**Cons:**
- Over- and under-fetching on composite screens.
- Endpoints and their schemas are written by hand.

### Option B: GraphQL

**Pros:**
- A single endpoint; clients select exactly the fields they need, which suits varied mobile screens.
- Strong introspection and tooling.

**Cons:**
- Meaningful server-side complexity: resolvers, N+1 avoidance, query depth and cost limiting.
- HTTP-level caching is largely forfeited.
- Disproportionate for CRUD-shaped data with one known client.

### Option C: tRPC

**Pros:**
- Best-in-class end-to-end type safety for a TypeScript SPA, with no schema duplication and no codegen step.
- The least boilerplate of the three for the frontend that actually exists today.

**Cons:**
- TypeScript-only by construction. A native iOS or Android client, a shell script, or a non-TS service cannot consume it without a bespoke compatibility layer.
- The API is effectively unusable without its generated TS client, which conflicts with the standalone-API goal.
- Procedures are not meaningfully inspectable with ordinary HTTP tooling.

## Decision

Adopt **Option A**: REST/JSON under `/api/v1/*`, with an OpenAPI 3.1 document generated from the shared Zod schemas and served at `/api/v1/openapi.json` (plus Swagger UI at `/api/v1/docs` in development only).

Supporting conventions:

- Every API route's request and response bodies have a Zod schema in `@finance/contracts`. Two exemptions: the OpenAPI meta routes, which describe the contract rather than participate in it; and `204 No Content` responses, which have no body to schematise (`POST /api/v1/auth/logout` is the only one in the scaffold).
- A uniform error envelope, `ErrorResponse`. Of its codes, only `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), and `INTERNAL` (500) are reachable from the scaffold's five routes and covered by tests; `NOT_FOUND` (404), `CONFLICT` (409), and `SERVICE_UNAVAILABLE` (503) are declared now so the envelope does not change shape when the first finance routes need them.
- One documented exception: `GET /api/v1/health` returns the `HealthResponse` schema on both 200 and 503, because a monitoring probe needs the per-component breakdown rather than an error code.
- JSON fields are `snake_case`; monetary values are decimal strings, never numbers (ADR 0006).

## Consequences

- **Positive:** Any future client works without constraint on its language. The API is inspectable and debuggable with ordinary tools. The OpenAPI document keeps documentation from rotting. Path versioning gives a route out of breaking changes once clients exist that cannot be updated together.
- **Negative:** More hand-written endpoint and schema code than tRPC would need. Composite screens may require multiple requests or purpose-built endpoints. Frontend type safety depends on the discipline of importing from `@finance/contracts` rather than being structurally unavoidable.
- **Neutral:** tRPC was rejected on optionality grounds, not on merit; had the frontend been certain to remain the only client, it would have been the lighter choice. This is recorded so the reasoning is not re-litigated from scratch later.
