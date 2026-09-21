# Task: Boundary Tests (B1–B4)

## Status
COMPLETED

## Description
Static source analysis asserting the four import rules. One test file per rule so a failure
names the violated rule directly.

## Inputs
- requirements.md § FR3, boundary-test approach, C16

## Steps
1. Glob source files with `fs` and regex-match import specifiers — **static analysis, not
   runtime**, since executing a forbidden import is exactly what must not happen.
2. B1 (case 23): `drizzle-orm` only in `*.repository.ts` and `src/db/**`; zero matches in
   `*.routes.ts`, `*.service.ts`, `plugins/**`.
3. B2 (case 24): `better-sqlite3`, `drizzle-orm/better-sqlite3`, `PRAGMA` only in
   `src/db/sqlite.ts`, `src/db/client.ts`, `src/db/migrations/**`, `drizzle.config.ts`,
   `package.json`. **`apps/api/test/**` explicitly excluded from the scan** (C16) — without this
   the rule would fail on the test files that legitimately assert schema facts via PRAGMA.
4. B3 (case 25): zero `src/db/` imports in any `*.service.ts`, `health.service.ts` included.
5. B4 (case 26): zero `drizzle-orm`, `better-sqlite3`, or `apps/api/src` references in
   `apps/web/src`.
6. **Allowlists as named constants**, never inline literals.

## Expected Output
Four test files, all green.

## Verification
Deliberately adding a violating import makes the corresponding test fail.

## Dependencies
task09

## Execution Notes
Files: `test/support/imports.ts` + `test/boundary-b{1,2,3,4}-*.test.ts` (40 new tests).
**Suite now 20 files / 136 tests, up from 96. Passing twice. No source changes.**

### AST, not regex — and it mattered
Used `typescript@6.0.3` parse-only (`ts.createSourceFile`; no program, no type checker), already
a root devDependency. Collects four import forms: `ImportDeclaration`, `ExportDeclaration`
(re-export), `ImportEqualsDeclaration`, and `CallExpression` for `require()` / dynamic
`import()`. Structurally immune to the comment false-positives that forced tasks 05/06 to reword
prose, and to string-concatenation evasion.

B2's `PRAGMA` **SQL text** rule is the one non-import check — implemented as a string/template
literal scan, so `PRAGMA` in a comment stays legal while `PRAGMA` in executable SQL is caught.
`apps/api/test/**` excluded per C16, with a test asserting the exclusion.

B3/B4 **resolve** relative specifiers to repo-relative paths (extension-stripped, unifying
NodeNext's `.js`-for-`.ts`), so `../../db/nested/deeper/x.js` is caught as surely as
`../../db/client.js`.

### Absent `apps/web` — not skipped
`directoryExists('apps/web/src')` is measured at load time and interpolated into the describe
title (today: `apps/web/src ABSENT — created by task12`). A dedicated test asserts the state
explicitly — empty scan when absent, `files.length > 0` when present — so an empty scan can
never be misread as a genuine pass. When task12 lands it scans for real with no edit needed.

### Permanent self-check (better than a one-time mutation check)
Each rule file has a `case 38` block feeding **synthetic known-bad source strings** (named
constants, never real files) through the same extractor/matcher as the real scan, asserting each
is flagged: bare import, subpath import, dynamic `import()`, `require()`, deep relative path.
Each ALSO asserts an *innocent* fixture (prose comment + a string merely naming the package) is
**not** flagged — anti-regression for the tasks 05/06 lesson. Plus non-vacuity guards: every
rule asserts it scanned a non-empty file set and does find the package where legitimately allowed.

### Case 38 mutation evidence (real failures, then reverted)
- **B1**: `import { eq } from 'drizzle-orm'` in `health.service.ts` → 2 failed / 7 passed
- **B2**: `better-sqlite3` import + `'PRAGMA journal_mode = WAL'` string in `config.ts` →
  **both halves fired**, 2 failed / 9 passed
- **B3**: `import { ping } from '../../db/sqlite.js'` in `health.service.ts` → 1 failed / 10 passed
- **B4**: cannot be violated with a real file today; teeth proven by the five synthetic fixtures
All reverted; mutant markers grep clean; both post-revert runs green.

### Pre-existing violations: NONE
Every `drizzle-orm`/`better-sqlite3`/`PRAGMA` occurrence outside permitted locations is a doc
comment or identifier name. Deliberately permitted and worth recording:
`health.repository.ts` imports `../../db/sqlite.js` for `ping()` — legal, because B3 constrains
**services** only and B2 constrains the `better-sqlite3` **package specifier**, not the local
`db/sqlite.ts` module.

### Near-miss worth remembering
`support/imports.ts` sits one level deeper than the suites, so `REPO_ROOT` needed `../../../../`
not `../../../`. Initially it resolved to `apps/`, the scans found zero files, and everything
passed vacuously. **The non-vacuity guards caught it** — the exact always-passes failure mode
case 38 exists to prevent, encountered for real.
