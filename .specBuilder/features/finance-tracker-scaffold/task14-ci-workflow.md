# Task: CI Workflow

## Status
COMPLETED

## Description
One GitHub Actions workflow gating the repo.

## Inputs
- requirements.md § FR15, Q2, Q3, C14

## Steps
1. `.github/workflows/ci.yml` on `push` and `pull_request`.
2. Single Node version (no matrix) per Q3; `actions/setup-node` with Node 22.
3. Steps in order: `npm ci` → `npm run typecheck` → `npm run lint` → `npm run test` →
   `npm run build`. Any failing step fails the build.
4. Provide `JWT_SECRET` as a workflow env var so config validation passes in CI.
5. Note in the file that the registry may need auth if CodeArtifact is the resolved registry.

## Expected Output
A valid workflow file.

## Verification
YAML parses. **Case 33 (a type error failing the typecheck step) is DEFERRED manual
verification — no git remote exists per Q2**, so the workflow is never executed in this feature.

## Dependencies
task13

## Execution Notes
Created `.github/workflows/ci.yml` — the only file touched; `package.json` needed no change.

- `on: push` + `pull_request`; single job `verify` on `ubuntu-latest`.
- `actions/checkout@v7` + `actions/setup-node@v7` (current majors confirmed via the GitHub
  releases API), `node-version: 22`, `cache: npm`.
- Steps in FR15 order: `npm ci` → `typecheck` → `lint` → `test` → `build`.
  **No `continue-on-error` anywhere** (the only occurrence of that string is a header comment
  explaining its deliberate absence). No matrix, no CodeArtifact auth step, no deploy job.
- Env: **only** `JWT_SECRET` (41-char obvious CI fixture). Confirmed by grepping both test trees
  that no test reads ambient `JWT_SECRET`/`DB_PATH`/`NODE_ENV` — `boot-config.test.ts` builds a
  minimal child env explicitly and `db-migrations.test.ts` overrides `DB_PATH` to a temp path.
  `DB_PATH`/`NODE_ENV` deliberately NOT set globally, as that could interfere with the
  `:memory:` and hermetic-no-db-files tests.

### The earlier contracts-build concern is RESOLVED
The plan flagged that `test` before `build` might fail on a cold clone. It does not: the
`pretest`/`prebuild` hooks in `apps/api` and `apps/web` build `@finance/contracts` first.
Verified by `rsync` copy (excluding `node_modules`/`dist`/`.git`) into the scratchpad, then
`npm ci` → full FR15 order → all exit 0, 148/148. **The FR15 order is safe as written.**

### Results
YAML parsed via the repo's own `yaml` package (PyYAML unavailable, pip blocked by PEP 668):
parses cleanly, triggers `['push','pull_request']`, 7 steps in the expected order.
`typecheck` 0 · `lint` 0 · `test` 0 (136 API + 12 web = 148) · `build` 0.
`.github/workflows/ci.yml` not gitignored. Nothing committed, no remote, no push.

### D1 deferral documented in the file header
States case 33 / D1 is deferred manual verification because no remote exists (Q2), with the four
completion steps: add remote and push `main`; branch with a deliberate type error; confirm the
run fails at `typecheck` and that `lint`/`test`/`build` are skipped; revert and confirm green.

## FLAKE FOUND AND ESCALATED
The subagent reported `1 failed | 135 passed` on one cold run without capturing which test.
The orchestrator **reproduced it** (run 1 of 6 failed; runs 2-6 green):

```
× exits non-zero, inside the 2s budget, naming the offending variable  2128ms
FAIL test/boot-config.test.ts > boot fails loudly with JWT_SECRET unset (case 29)
```

Cause: the test spawns a real `node dist/index.js` child and asserts exit inside a 2000ms
budget. On a **cold filesystem cache** Node's own startup plus loading the `dist` module graph
consumes the budget before `config.ts` runs. Warm runs exit in 0.166-0.263s, so the
implementation is correct — the test was measuring disk-cache warmth, not fail-fast behaviour.
**CI performs exactly one cold run, so this would have surfaced as a red build.**
Dispatched as a separate hardening task (fix must not weaken the 2s assertion). See task10 notes.
