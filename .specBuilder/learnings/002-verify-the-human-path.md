# Learning 002: 150 Green Tests Missed the First Thing a Human Would Do

**Date:** 2026-09-21
**Category:** Process & Workflow
**Tags:** #testing #developer-experience #acceptance-criteria

## Problem Statement
The scaffold's acceptance case 1 specifies: *write `.env` with a 32+ char `JWT_SECRET`, then
`npm run dev`*. The repo shipped `.env.example`, reinforcing that this works. **It did not.**
Nothing loaded `.env` — no `dotenv`, no `--env-file` in any script; `config.ts` read
`process.env` directly. A fully populated `.env` still produced
`JWT_SECRET: is required but was not set`.

All 150 tests passed the entire time.

## Root Cause
Every test supplied environment explicitly — `boot-config.test.ts` builds a minimal child env,
others override `DB_PATH`. That is correct for hermeticity, but it means **no test ever walked
the path a human walks on a fresh clone**. The gap was invisible to a suite designed to be
independent of ambient configuration.

It surfaced only because the documentation task was required to *actually execute* the quickstart
it was documenting, rather than transcribe it from the spec.

## Solution
`--env-file-if-exists=../../.env` (Node 22) added to the five scripts a developer runs directly:
`dev`, `start`, `db:migrate`, `db:seed`, `db:reset`. Deliberately **not** added to `pretest`/
`test`, preserving hermeticity — proven by poisoning `.env` with `JWT_SECRET=x` and an unwritable
`DB_PATH` and confirming both suites still pass.

`-if-exists` over plain `--env-file` because the latter exits **9** when the file is absent,
which would break CI where no `.env` exists.

## Key Learnings
- **Make the documentation task run its own instructions.** Writing docs from the spec would have
  reproduced the broken steps verbatim. Executing them found a defect 150 tests could not.
- Hermetic tests and a working developer path are **different properties**. Neither implies the
  other, and a suite deliberately isolated from ambient config is structurally blind to this bug.
- Shipping `.env.example` is a promise. Check the promise is kept.
- Consequence worth documenting: loading lives in npm scripts, so anyone invoking
  `node dist/index.js` directly must still supply env themselves.

## Applicability
Any project with a documented quickstart, any `.env.example`, and any acceptance criterion phrased
as a sequence of human commands. Treat "the README works from a fresh clone" as a test case.

## References
- `apps/api/package.json` (five scripts), `README.md`, `docs/gotchas.md`
- `.specBuilder/features/finance-tracker-scaffold/task-documentation.md` ("DEFECT FOUND AND FIXED")
