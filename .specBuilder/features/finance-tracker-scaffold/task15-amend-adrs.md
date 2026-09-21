# Task: Amend ADRs and Spec for the snake_case Ruling

## Status
COMPLETED

## Description
Q1 overrode the written record. Amend it so the docs match the code rather than leaving three
files asserting camelCase.

## Inputs
- requirements.md § Q1; recon line references

## Steps
1. `docs/adr/0004-rest-json-with-generated-openapi.md` **line 63** — the only normative
   camelCase statement in any ADR: change `JSON fields are \`camelCase\`` → `snake_case`.
2. `docs/adr/0006-money-as-integer-minor-units.md` **line 67** — example becomes
   `opening_balance_minor: 123456` → `opening_balance: "1234.56"`, and reword the "deliberate
   exception to the snake_case↔camelCase rule" clause: with snake_case on the wire there is no
   case conversion, so the exception is now **suffix-stripping plus representation change** only.
3. `think/finance-tracker-scaffold.md` **line 98** — drop "owns the snake_case↔camelCase
   mapping" from the repository layer description.
4. `think/finance-tracker-scaffold.md` **line 114** — naming table row becomes
   `snake_case` / `opening_balance`.
5. Add a short "Amended" note to ADRs 0004 and 0006 recording the override and its date
   (2026-09-20), so the change is traceable rather than silent.
6. Do **not** alter ADRs 0001/0002/0003/0005/0007/0008/0009 — verified to contain no casing
   statement. In particular ADR 0008 does **not** mention camelCase.

## Expected Output
Zero `camelCase` occurrences remaining in `docs/adr/**` and `think/finance-tracker-scaffold.md`
except where deliberately describing the superseded decision.

## Verification
`grep -ri camelcase docs/adr think/finance-tracker-scaffold.md` returns only amendment notes.

## Dependencies
task03

## Execution Notes
Six edits in three files. **No code, test, or config file touched.**

| File | Before → After |
|---|---|
| `docs/adr/0004` L63 | ``JSON fields are `camelCase` `` → ``snake_case`` (the only normative camelCase statement in any ADR) |
| `docs/adr/0006` L67 | ``openingBalance: "1234.56"`` → ``opening_balance: "1234.56"``; exception clause reworded — DB and JSON now share snake_case so there is **no case conversion**, leaving suffix-stripping + representation change |
| `think/…scaffold.md` L98 | repository owns "snake_case↔camelCase mapping and…" → "the minor-unit↔decimal-string conversion and the `_minor` suffix stripping" |
| `think/…scaffold.md` L114 | `` `camelCase` / `openingBalance` `` → `` `snake_case` / `opening_balance` `` |
| `think/…scaffold.md` L120 | "exception to plain case conversion" → "exception to plain passthrough"; example updated with INTEGER / decimal-string annotations |
| `think/…scaffold.md` L364 | case 12 row: `accessToken`/`refreshToken`/`passwordHash` → `access_token`/`refresh_token`/`password_hash` (now also consistent with the actual DB column name) |

Two of these (L120, L364) were **not** in the original task list — found by grepping live rather
than trusting the recorded line numbers.

### Amendment notes
`## Amendments` section added to ADR 0004 and ADR 0006, immediately after `## Status` (no prior
amendment format existed in any ADR). Each records: date 2026-09-21, the camelCase→snake_case
change, one line of rationale, and that **the decision itself is unchanged** — Option A remains
accepted in both; only the field-casing detail was amended.

### Verification
`grep -rn "camelCase\|openingBalance\|accessToken\|refreshToken\|passwordHash" docs/ think/`
returns only (a) the two new amendment notes describing the superseded convention, and (b) three
hits in an unrelated file — see below. Code agrees: `access_token` present in
`packages/contracts/src/auth.ts`. `npm run test:api` → 136/136 (documentation edits correctly
have no effect). Prettier nonconformance in all three files is **pre-existing** (missing blank
line after `**Pros:**`/`**Cons:**`, unpadded table cells); first reported diff in both ADRs is
below the new amendment blocks, so nothing was made worse.

## Follow-up flagged (out of scope, NOT fixed)
`think/deploy-to-raspberry-pi-via-github-actions.md` L249 / L263 / L445 reference `refreshToken`
where the shipped contract is `refresh_token`. That is a **different, unbuilt feature's** think
doc, outside this task's three-file scope, so it was deliberately left alone. Genuinely stale and
worth a one-line fix when that feature is built — note it also assumes a refresh token in a JSON
body, which matches, so only the casing is wrong.
