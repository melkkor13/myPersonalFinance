# 0008. Zod-first shared contracts package

Date: 2026-09-20

## Status

Accepted

## Context

The API and the web client must agree on the shape of every request and response. When they disagree, the failure appears at runtime in the client, often as an undefined field rendered into the UI rather than as an exception. Eliminating that class of bug is one of the scaffold's stated purposes.

Three separate needs touch the same definitions:

1. **Runtime validation** on the server — untrusted input must be rejected before reaching business logic.
2. **Compile-time types** in both the API and the web client.
3. **A published, language-neutral contract** — an OpenAPI 3.1 document, per ADR 0004, so any future non-TypeScript client can be generated or verified against it.

Satisfying these from separate definitions guarantees they will diverge. The question is which artefact is the source of truth and which are derived.

## Approaches Considered

### Option A: Zod schemas in a shared workspace package, OpenAPI generated from them

`packages/contracts` (`@finance/contracts`) exports Zod schemas; TypeScript types are inferred with `z.infer`; the OpenAPI document is generated from the same schemas.

**Pros:**
- One source of truth serving all three needs.
- Runtime validation and static types cannot disagree, because the types are inferred from the validator.
- The OpenAPI document is a build product, so it cannot drift from the implementation.
- No codegen step in the inner development loop; editing a schema immediately reshapes both applications' types.
- Fastify consumes these schemas natively for validation and serialization (ADR 0003).

**Cons:**
- Zod-to-JSON-Schema conversion has edge cases — certain refinements, transforms, and unions do not translate cleanly and need manual annotation.
- TypeScript is the source of truth, so a non-TS consumer depends on the generated document being correct.

### Option B: OpenAPI specification first, generating both sides

**Pros:**
- A genuinely language-neutral source of truth, which is the right choice when many clients in many languages exist.
- The contract can be reviewed and versioned independently of any implementation.

**Cons:**
- Adds a codegen step to every change, slowing the development loop.
- Generated TypeScript types from OpenAPI are markedly clumsier than inferred Zod types.
- Provides no runtime validation, so a validation layer must be written or generated separately, reintroducing a second definition.
- Substantial ceremony for a project with one known client.

### Option C: No sharing — each application declares its own types

**Pros:**
- Zero setup.

**Cons:**
- Guaranteed drift, which is precisely the bug class this scaffold exists to prevent.

## Decision

Adopt **Option A**.

- `packages/contracts` exports Zod schemas for every API request and response body, with TypeScript types inferred from them.
- Every API route attaches its schemas from this package; there are no unschematised API routes. The two OpenAPI meta routes (`/api/v1/openapi.json` and `/api/v1/docs`) are exempt, since they describe the contract rather than participate in it.
- Errors are covered too: `ErrorResponse` is defined in this package, and every non-2xx response references it — except `GET /api/v1/health`, which returns `HealthResponse` on both 200 and 503 so a probe receives the component breakdown.
- An OpenAPI 3.1 document is generated from these schemas and served at `/api/v1/openapi.json`, with Swagger UI at `/api/v1/docs` in development only.
- The web client's API layer and its MSW test handlers are typed from the same package.
- **Enforcement:** renaming a field in a contract schema must fail `npm run typecheck` in both `apps/api` and `apps/web`. This is an acceptance test for the scaffold.

## Consequences

- **Positive:** A contract change surfaces as a compile error in both applications at once, before any code runs. Server-side validation and static types are the same definition, so they cannot disagree. The OpenAPI document is generated rather than maintained, so documentation cannot rot. Test mocks are typed from the real contract, so mocks cannot drift from the API either.
- **Negative:** Awkward Zod constructs may need manual JSON-Schema annotation to emit correct OpenAPI, and this can be discovered late. The contracts package becomes a coupling point that both applications must upgrade together — acceptable inside a monorepo (ADR 0002), and one reason that layout was chosen.
- **Neutral:** A future non-TypeScript client consumes the generated OpenAPI document rather than the Zod schemas directly, which keeps ADR 0004's language-neutrality intact at one remove. Should many such clients ever appear, revisiting Option B would be reasonable and would warrant a new ADR.
