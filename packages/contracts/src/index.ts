/**
 * `@finance/contracts` — the single source of truth for every API
 * request/response shape, as Zod v4 schemas plus their inferred types.
 *
 * All wire field names are snake_case (requirements.md Q1). Zod v4 is required:
 * its native `z.toJSONSchema` emits JSON Schema draft 2020-12, which OpenAPI
 * 3.1 mandates (C5) — no `zod-to-json-schema`, no `@anatine/zod-openapi`.
 */
export * from './constants.js';
export * from './errors.js';
export * from './health.js';
export * from './auth.js';
