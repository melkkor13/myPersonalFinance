# Task: lib/ — money, password, tokens, errors

## Status
COMPLETED

## Description
Framework-agnostic primitives. None of these may import Fastify or Drizzle.

## Inputs
- requirements.md § FR4, FR7, C1, C2; ADR 0006, ADR 0001

## Steps
1. `src/lib/money.ts` — exponent **hard-coded to 2** as a named constant. Converts decimal
   string ⇄ integer minor units in both directions. **Rejects** >2dp input (`"1.005"`) and
   non-numeric text with a clear error; never rounds. Owns all money arithmetic.
2. `src/lib/password.ts` — wraps `@node-rs/argon2`. `hash()` passes
   `{ algorithm: Algorithm.Argon2id }` explicitly (C1 — defensive; Argon2id is already the
   default in 2.2.1). Exposes `hashPassword` / `verifyPassword`. **No bcrypt anywhere.**
3. `src/lib/tokens.ts` — uses `jose`, not `@fastify/jwt`, so services need no Fastify import.
   - Access token: HS256 JWT, claims `sub`/`iat`/`exp`, TTL from `ACCESS_TOKEN_TTL`.
   - Refresh token: 32 CSPRNG bytes base64url; exports the value and its SHA-256 hex digest.
   - Verify/decode helpers that surface expiry and bad-signature distinctly.
4. `src/lib/errors.ts` — typed domain error hierarchy (e.g. `UnauthenticatedError`) carrying an
   `ErrorCode` from `@finance/contracts`. **Services throw these and know no HTTP status codes.**
5. All TTLs, byte lengths, algorithm identifiers, and digest encodings as named constants.

## Expected Output
Four modules, each unit-testable in isolation.

## Verification
No import of `fastify` or `drizzle-orm` in any of them.

## Dependencies
task04

## Execution Notes
Files: `src/lib/{money,password,tokens,errors}.ts`. Modified `src/db/seed.ts` (refactor to use
`hashPassword`; its local argon2 constant and direct `@node-rs/argon2` import removed).

### money.ts — no float arithmetic anywhere
Input matched against `^[+-]?\d+(?:\.\d{1,2})?$`, then capture groups **reassembled into an
integer digit string** (`"1234"`+`"56"` → `"123456"`) and parsed once. Concatenation *is* the
x10^2 shift, so `parseFloat(x)*100` and its `1.15*100 === 114.99999999999999` failure mode
cannot occur. Formatting mirrors it via `padStart`. Sign carried separately from digits, so
`-0.07` → `-7` → `"-0.07"` and a zero magnitude never becomes `-0`.

**`number` not `bigint`, justified:** double exact-integer range is ±9,007,199,254,740,991
(~90 trillion major units); the spec's largest value `"999999999.99"` → `99,999,999,999` is five
orders of magnitude inside it, and `better-sqlite3` returns `number` for INTEGER columns so
`bigint` would add a conversion at every repository boundary. Enforced not hoped: both
directions check `Number.isSafeInteger`, digit count is checked against
`MAX_MONEY_MINOR_UNITS` *before* parsing, and every arithmetic step re-checks.

Verified: all five case-10 values round-trip identically; `"1234.56"` → `123456`.
Rejected with distinct messages: `"1.005"` (>2dp, named explicitly), `"abc"`, `""`, `"1.2.3"`,
`"."`, `".5"`, `"5."`, `" 1.00 "`, `"1,234.56"`, `"1e2"`, `"Infinity"`, `"NaN"`, `"-"`,
out-of-range, and non-string input.

### tokens.ts
Returns a **discriminated** `{ok:true,claims} | {ok:false,reason}` with reason
`EXPIRED` | `INVALID_SIGNATURE` | `MALFORMED`, so a caller cannot read claims off a rejected
token. All four case-31 inputs land on the failure branch. Verified: 1s TTL expires after 2s;
wrong secret → `INVALID_SIGNATURE`; `garbage` → `MALFORMED`; refresh token 43 chars, digest
64 hex chars, digest !== token. Config arrives as a `TokenConfig = Pick<AppConfig,...>`
parameter — no `process.env`, no singleton.

### errors.ts
`ERROR_CODE_HTTP_STATUS` typed `Readonly<Record<ErrorCode, number>>`, so adding a code in
contracts **fails to compile** until its status is decided. Thrown errors carry no status
property (verified) — mapping stays in the handler. One shared `UNAUTHENTICATED_MESSAGE`
constant keeps case-32/case-13 bodies byte-identical.

### password.ts
`ARGON2ID_ALGORITHM = 2` named constant (ambient-const-enum workaround). Hash prefix
`$argon2id$` verified; correct password true, wrong false, junk hash false. Seed re-verified
idempotent after refactor: run 1 seeds, run 2 no-ops, user count 1.

## Carry-forward for task10 (IMPORTANT)
**Case 20's bcrypt grep must be scoped to source files and manifests, NOT unscoped.** An
unrestricted `grep -ril bcrypt` matches six planning/spec markdown files (`requirements.md`,
`test-cases.md`, `docs/adr/0001-*.md`, `think/*`, task06/task10 files) — the documents that
*mandate* zero bcrypt. Scope the assertion to `*.ts/tsx/js/mjs/json/yml/yaml` excluding
`node_modules`, where it returns zero matches.

## Carry-forward for task11
Comments that merely *mentioned* `@fastify/jwt` in `tokens.ts` were reworded so a crude
specifier-shaped static scan cannot false-positive. Same lesson as task05: **assert on real
import statements, not raw text.**
