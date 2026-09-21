# Learning 003: Parallel Agents Manufactured a Phantom 1-in-8 Bug

**Date:** 2026-09-21
**Category:** Process & Workflow
**Tags:** #orchestration #subagents #false-positive #debugging

## Problem Statement
An agent reported `hermetic-no-db-files.test.ts` (acceptance case 23: no DB file may be written
to the tree during a test run) failing **~1 run in 8**, with a real `apps/api/data/finance.db`
present. It traced the cause to a teardown race reaching no-argument fallbacks at
`client.ts:39`/`:58` → `DEFAULT_DB_PATH`, and isolated two "culprit" test files at 2/6 and 1/6.

The diagnosis was precise, plausible, internally consistent — and **wrong**. So was my relay of
it to the user.

## Root Cause
**I ran two agents concurrently.** The documentation agent's quickstart verification
(`npm run dev`, `npm run db:migrate`) wrote `apps/api/data/finance.db` — `.env` sets
`DB_PATH=./data/finance.db` and those scripts load it — while the timing agent's test loops were
scanning the tree for DB artifacts. The artifact was real; its author was a sibling agent, not
the test suite.

The follow-up agent disproved the mechanism properly: `openConnection()` is the sole
`new Database()` call site, so it instrumented it to log path + stack on any non-`:memory:` open,
then ran 16 full suites + 10 isolated runs — **zero hits**, where the reported rates gave ~88%
and ~98% odds of catching one. The `dbPath === undefined` branches turned out to be **dead code**:
every repository signature already required `dbPath: string`.

## Solution
Process fix: **never run an agent that boots the app concurrently with one that asserts on
repo-tree cleanliness.** The final verification task was explicitly sequenced into four phases —
suites and hygiene with nothing running, then tamper tests, then live API and browser, then
teardown and re-scan.

The footgun was still closed on its merits: `dbPath` made required (dead branches deleted), plus
a test-time tripwire that throws if a file-backed DB is opened inside the repo tree while
`VITEST` is set. 2 new tests; 26 consecutive clean runs.

## Key Learnings
- **Shared mutable state between parallel agents is the filesystem.** Agents that only read are
  safe to parallelise; agents that boot servers, write databases, or assert on tree state are not.
- A confident, well-evidenced diagnosis from a subagent can still be wrong. The tell here was
  that the reported failure rate never reproduced under instrumentation — **when a claimed rate
  doesn't reproduce at high odds, doubt the diagnosis, not the sample.**
- Instrumenting the single chokepoint (one `new Database()` call site) beat reasoning about
  races. Find the narrow waist and log it.
- I relayed the wrong diagnosis to the user before it was disproved. Prefer "an agent reports X,
  unverified" over adopting a subagent's conclusion as established fact.

## Applicability
Any multi-agent orchestration where agents share a working tree. Especially: test-hygiene
assertions, port binding, build output, and anything reading `.env`.

## References
- `apps/api/src/db/sqlite.ts` (tripwire, `isInRepositoryTree()`), `apps/api/src/db/client.ts`
- `.specBuilder/features/finance-tracker-scaffold/task10-api-tests.md` ("Post-hoc fix 2 — DIAGNOSIS CORRECTED")
