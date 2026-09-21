# 0006. Money as integer minor units, decimal strings on the wire

Date: 2026-09-20

## Status

Accepted

## Amendments

**2026-09-21 — JSON field convention changed from `camelCase` to `snake_case`.** The field-naming example under Decision originally mapped `opening_balance_minor` to `openingBalance` and described the mapping as an exception to a `snake_case`↔`camelCase` rule. A project-wide API naming convention mandating `snake_case` took precedence, so JSON fields are now `snake_case` (ADR 0004, as amended) and no case conversion occurs at the boundary. The decision itself is **unchanged** — Option A (integer minor units in the database, decimal strings in JSON) remains accepted, and only the field-casing detail was amended.

## Context

This is a finance application, so monetary values are its primary data. Representing them as binary floating point produces rounding errors that accumulate silently: no exception is raised, no test necessarily fails, and balances simply stop reconciling. Of every decision in the scaffold, this is the only one whose failure mode is silent data corruption, and it is effectively impossible to correct after data has accumulated.

There are two boundaries to settle, and they need not use the same representation:

1. How money is stored in the database.
2. How money is carried in JSON request and response bodies.

JSON numbers are IEEE-754 doubles in practice, so a value like `0.1` cannot be represented exactly even if the database is correct.

The scaffold does not yet create the finance tables (ADR 0009), but the convention must be fixed now, because it dictates column types, the shape of `lib/money.ts`, and the repository mapping rules.

## Approaches Considered

### Option A: Integer minor units in the database, decimal strings in JSON

`amount_minor INTEGER` storing cents; JSON carries `"1234.56"` as a string.

**Pros:**
- Exact: integer arithmetic has no representation error.
- Aggregations such as `SUM()` work directly in SQL over integers.
- Strings in JSON bypass IEEE-754 entirely, so no client can silently lose precision parsing the payload.
- The standard approach in financial systems, including Stripe's API.

**Cons:**
- Two representations with a conversion between them, so a boundary that forgets to convert is a bug.
- Requires a dedicated module and real discipline; a raw `amount_minor` leaking into a response would be wrong by a factor of 100.

### Option B: `REAL` / floating point

**Pros:**
- The least code; arithmetic and formatting are direct.

**Cons:**
- Rounding errors accumulate silently and unrecoverably.
- Disqualifying for a ledger.

### Option C: Decimal strings everywhere, with an arbitrary-precision library

Store as `TEXT`, compute with a big-decimal library.

**Pros:**
- Exact, with arbitrary precision.
- Handles instruments needing more than two decimal places, such as unit prices or FX rates.
- One representation throughout, so no conversion layer.

**Cons:**
- Cannot `SUM()` in SQLite without casting, which defeats indexes and makes reporting queries awkward.
- Slower arithmetic and an additional dependency.
- Overkill for cash accounts denominated in whole cents.

## Decision

Adopt **Option A**.

- **Database:** monetary columns are `INTEGER`, storing minor units, and their names always end in `_minor` — for example `amount_minor`, `opening_balance_minor`, `limit_minor`. No column in any table may have type `REAL`.
- **JSON:** monetary values are decimal strings, never numbers — for example `"1234.56"`.
- **Field naming:** the `_minor` suffix is dropped when mapping to JSON, because the JSON value is not in minor units. `opening_balance_minor: 123456` maps to `opening_balance: "1234.56"`. Database and JSON share `snake_case` (ADR 0004, as amended), so this mapping involves no case conversion; it is a deliberate exception to plain passthrough on two other counts — the `_minor` suffix is stripped, and the value changes representation from an integer in minor units to a decimal string. Both are documented as such.
- **Ownership:** `apps/api/src/lib/money.ts` owns all parsing, formatting, and arithmetic in both directions. The repository layer is the only place the conversion is applied.
- **Validation:** input with more than two decimal places, or non-numeric text, is rejected rather than rounded.
- **Fixed exponent of 2.** `lib/money.ts` hard-codes hundredths as the minor unit, which is what makes the two-decimal-place rejection correct. Zero-decimal currencies (JPY) and three-decimal ones (KWD, BHD) are consequently **unsupported**, and `default_currency` is validated for length only, not against this assumption.
- **Enforcement:** a test inspects every column of every table after migration and asserts that no column is `REAL` and that every `_minor` column is `INTEGER`. This assertion is vacuous while only the auth tables exist, and is wired now so that it begins enforcing the moment the finance tables land.
- **Currency:** a single currency for the whole dataset, held once as `users.default_currency`. No per-account or per-transaction currency column until multi-currency is genuinely required.

## Consequences

- **Positive:** Monetary arithmetic is exact end to end. Totals and aggregations run as plain integer SQL. No client can lose precision parsing a response. The convention is machine-checked rather than relying on memory.
- **Negative:** Every boundary crossing needs a conversion, and omitting one produces a hundred-fold error. Two decimal places are assumed, so an instrument needing more precision would require revisiting this decision. The convention is asserted by a currently vacuous test, so the first finance feature must confirm the assertion actually fires.
- **Negative (scope):** The fixed exponent of 2 means a user whose currency is JPY, KWD, or BHD cannot be served correctly. Supporting one requires a per-currency exponent in `lib/money.ts` and a new ADR superseding this one. The limitation is acceptable only because A2 fixes a single currency for the whole dataset, chosen by the single user.
- **Neutral:** Formatting for display — currency symbols, thousands separators, locale — is a frontend concern handled via `Intl.NumberFormat`, not part of this decision. Should multi-currency arrive, per-row currency columns and an FX strategy would need a new ADR; this decision does not preclude that, but deliberately does not pay for it now.
