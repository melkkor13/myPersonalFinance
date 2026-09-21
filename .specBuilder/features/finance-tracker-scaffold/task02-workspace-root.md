# Task: Workspace Root Scaffold

## Status
COMPLETED

## Description
Create the npm-workspaces root: manifest, shared TypeScript config, lint/format config,
gitignore, and initialise the git repository.

## Inputs
- requirements.md § FR1, FR13, FR15, Q2, Q3, Q5, pinned dependency set

## Steps
1. `package.json` at root: `private: true`, `"type": "module"`,
   `workspaces: ["apps/*", "packages/*"]`, `"engines": { "node": ">=22.13.0" }`.
   Scripts per FR13: `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:api`,
   `test:web`, `db:generate`, `db:migrate`, `db:seed`, `db:reset`. `dev` uses `concurrently`.
2. Root devDependencies: `typescript@6.0.3`, `typescript-eslint@8.70.0`, `eslint@10.11.0`,
   `prettier@3.9.8`, `concurrently@10.0.5`, `vitest@5.0.1`, `@types/node@26.6.2`.
3. `tsconfig.base.json`: `strict: true`, `module`/`moduleResolution` for ESM (`nodenext`),
   `target` ES2023+, `noUncheckedIndexedAccess`, `isolatedModules`, no `allowJs`.
4. `eslint.config.js` (flat config) wiring `typescript-eslint` type-aware rules.
5. `.prettierrc`.
6. `.gitignore` — MUST include `node_modules`, `dist`, `.env`, `data/`, `*.db`, `*.db-wal`,
   `*.db-shm`. MUST NOT exclude `src/db/migrations/meta/` (C9).
7. `.env.example` documenting every FR12 variable.
8. `git init`; do NOT add a remote (Q2).

## Expected Output
Root files present; `git status` works.

## Verification
`node -e "require('fs')"`-level sanity only — full install happens here: `npm install` at root
succeeds with no peer-conflict errors (validates Q5).

## Dependencies
task01

## Execution Notes
- `npm install` succeeded exit 0, 151 packages, **no peer conflicts** — validates Q5
  (typescript@6.0.3 + typescript-eslint@8.70.0 + eslint@10.11.0) with no `overrides`,
  no `--force`, no `--legacy-peer-deps`. `package-lock.json` written and tracked.
- Slow install (~6m) purely from cold-cache packument fetches on the CodeArtifact proxy.
- `git init` on branch `main`; **no remote** (Q2); no commit made.
- Verified `apps/api/src/db/migrations/meta/*` is NOT gitignored (C9) via `git check-ignore`.
- **Deviation:** `eslint.config.js` omits `@eslint/js`, so ESLint core `recommended` rules are
  absent and the rule set comes solely from typescript-eslint's `strictTypeChecked` +
  `stylisticTypeChecked`. Reason: `@eslint/js@10.11.0` 404s on the proxy (stale metadata, lists
  only to 10.0.1). Revisit by adding `@eslint/js` at a proxy-available version. Recorded for the
  documentation task.
- Extra files beyond the task spec: `.prettierignore`, `package-lock.json` (both appropriate).
