# Learning 001: Tests That Pass Vacuously Are Worse Than Missing Tests

**Date:** 2026-09-21
**Category:** Testing & Quality
**Tags:** #testing #mutation-testing #false-confidence

## Problem Statement
Several tests in this build would have passed forever while asserting nothing:
- `test/support/imports.ts` sat one directory deeper than the suites, so `REPO_ROOT` resolved to
  `apps/` instead of the repo root. All four boundary scans found **zero files** and passed green.
- `PRAGMA journal_mode=WAL` on `:memory:` **silently no-ops** and returns `journal_mode: 'memory'`
  without throwing, so a test asserting on resulting DB state passes whether or not the
  conditional exists.
- The money-column convention test is genuinely vacuous today (no `_minor` columns exist yet).
- A doc comment was written describing a `beforeAll` warm-up that **was never implemented** — the
  comment would have stopped the next person from investigating.

## Root Cause
A passing test is indistinguishable from a working test unless you check that it can fail. Path
resolution, silent no-op APIs, and not-yet-existing data all produce empty scans, and an empty
scan looks exactly like compliance.

## Solution
Three complementary habits, all used here:
1. **Non-vacuity guards** — every scan asserts it examined a non-empty file set, and that it does
   find the thing where it is legitimately allowed. This is what caught the `REPO_ROOT` bug.
2. **Mutation checks** — introduce the violation, confirm the specific test fails, revert. Used
   on all four boundary rules, the WAL conditional, the bcrypt grep, the single-flight lock, and
   the boot budget. The `.finally`→`.then` mutation caught a real poisoned-promise bug class.
3. **Permanent self-checks** — feed synthetic known-bad *and* known-innocent fixtures through the
   same matcher the real scan uses, on every run. Ongoing protection rather than a one-time check.

For deliberately vacuous tests, name the vacuity in a comment and record the exact line to delete
when it should start biting (`expect(moneyColumns).toEqual([])`).

## Key Learnings
- Ask of every new test: **"if the thing I'm testing were broken right now, would this fail?"**
- Assert on **structure, not text**. AST parsing of real import statements is immune to the
  comment false-positives and string-concatenation evasion that broke a grep approach — two
  tasks had to reword innocent prose before this was adopted.
- Prefer asserting the **call was not made** over asserting resulting state, when the API under
  test fails silently.
- A comment describing a fix is not a fix. Verify code exists, not just its rationale.

## Applicability
Any boundary/architecture test, any test that scans a file set, any assertion against an API that
no-ops instead of erroring, and any test written before the data it targets exists.

## References
- `apps/api/test/boundary-b{1,2,3,4}-*.test.ts`, `apps/api/test/support/imports.ts`
- `apps/api/test/db-pragmas.test.ts`, `db-schema-conventions.test.ts`
- `apps/web/test/api/refresh-single-flight.test.ts`
- `.specBuilder/features/finance-tracker-scaffold/task11-boundary-tests.md` ("Near-miss worth remembering")
