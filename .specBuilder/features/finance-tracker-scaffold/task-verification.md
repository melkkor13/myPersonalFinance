# Task: Verify finance-tracker-scaffold

## Status
COMPLETED

## Description
End-to-end verification that the scaffold works as expected.

## Verification Type
Combined (API + Playwright)

> **Note:** the `playwright` MCP server failed to connect this session
> (`CONNECTION_CLOSED`). If it is still unavailable when this task runs, the browser-based
> checks (cases 31, and the visual half of 16) must be reported as **blocked, not passed**, and
> the API-layer checks completed in full.

## Test Cases
1. **Cold bootstrap (case 1)** — from the repo root: `npm install`, write `.env` with a 32+ char
   `JWT_SECRET`, `npm run db:migrate`, `npm run db:seed`, `npm run dev`. Expect API on `:3000`,
   web on `:5173`, no errors logged.
2. **Health (case 1)** — `curl localhost:3000/api/v1/health` → 200
   `{"status":"ok","version":"<apps/api version>","db":"ok"}`.
3. **Config fatal (case 2)** — start with `JWT_SECRET` unset, then with a 10-char value. Both
   exit non-zero within 2s with a message naming `JWT_SECRET`, and **no port is bound**.
4. **DB degraded (case 3)** — point `DB_PATH` at an unreadable path, start. Server still binds;
   health returns **503** with a `HealthResponse` body (`db: "unavailable"`), **not** an
   `ErrorResponse`.
5. **OpenAPI (case 8)** — `curl localhost:3000/api/v1/openapi.json`. Assert `openapi: "3.1.0"`,
   all five API routes present, named `components/schemas`, every non-2xx `$ref`s
   `ErrorResponse` except health's 503 (`HealthResponse`), and logout's 204 declares no body.
6. **Swagger dev-only (case 9)** — `/api/v1/docs` → 200 with `NODE_ENV=development`, 404 with
   `NODE_ENV=production`.
7. **Validation (case 10)** — `POST /api/v1/auth/login` with `{"email":"not-an-email"}` → 400
   `{"error":{"code":"VALIDATION_ERROR","fields":["email","password"]}}`.
8. **Auth rejection (case 11)** — `GET /api/v1/me` with no header, `Bearer garbage`, a
   wrong-secret token, and an expired token. All four → 401 `UNAUTHENTICATED`.
9. **Happy path (case 12)** — login with seeded credentials, then `/me` with the returned
   `access_token`. Assert 200, correct `id`/`email`, and **no `password_hash` field**.
10. **Indistinguishable failure (case 13)** — valid email + wrong password vs unregistered
    email. Assert the two 401 bodies are **byte-identical**.
11. **Rotation + replay (case 15)** — login, refresh, then refresh again with the rotated token.
    First → 200 with a *different* `refresh_token`; replay → 401 **and** every refresh token for
    that user is `revoked_at`-stamped in the DB.
12. **Logout (case 17)** — login, logout (expect **204, empty body**), then refresh with that
    token → 401; `revoked_at` set.
13. **Hashed storage (case 19)** — read `refresh_tokens`; no `token_hash` equals the returned
    token, and each is a 64-char hex digest.
14. **Argon2id only (case 20)** — `users.password_hash` starts with `$argon2id$`; a repo-wide
    grep for `bcrypt` returns **zero** matches in any manifest or source file.
15. **Internal error (case 32)** — force a non-domain throw on an authenticated `/me`. Assert
    500 `INTERNAL` conforming to `ErrorResponse`, with **no stack trace, SQL text, or file path**
    in the body, and the full error present in the server log.
16. **Hermetic tests (case 28)** — `npm run test:api` twice; all green both times, and **no
    `.db`, `.db-wal`, or `.db-shm` anywhere in the working tree** (`git status` + `find`).
17. **Boundary rules (cases 23–26)** — `npm run test` passes all four; then deliberately add a
    violating import and confirm the matching test fails.
18. **Contract enforcement (case 27)** — rename a field in a `@finance/contracts` schema and
    confirm `npm run typecheck` fails in **both** `apps/api` and `apps/web`. Revert.
19. **Playwright (case 31)** — navigate to `localhost:5173`, submit correct credentials, assert
    the `/me` page renders the user's email and the API health status. Then submit wrong
    credentials and assert an **error message renders** — not a blank screen, not an unhandled
    rejection. Screenshot both.
20. **Single-flight (case 16)** — covered by the web suite; re-confirm `npm run test:web` passes.
21. **Full gate** — `npm run typecheck && npm run lint && npm run test && npm run build` all pass.

## Pass Criteria
- All test cases return expected results
- No errors in logs
- **Case 33 is explicitly reported as deferred** (no git remote, per Q2) rather than passed
- Any Playwright-dependent case is reported as blocked if the MCP server is still down

## Dependencies
All other tasks for this feature

## Execution Notes — ALL 21 ITEMS PASS, 1 DEFERRED
Run in four deliberate phases to avoid the contention that produced an earlier phantom defect:
(1) suites + static hygiene with nothing running, (2) boundary/contract tamper tests still with
nothing running, (3) live API + browser with servers up, (4) teardown and re-scan.

| # | Item | Verdict |
|---|---|---|
| 1 | Cold bootstrap (case 1) | PASS |
| 2 | Health 200 `{"status":"ok","version":"0.1.0","db":"ok"}` | PASS |
| 3 | Config fatal — unset 437ms, 10-char 328ms, both exit 1, port NOT BOUND | PASS |
| 4 | DB degraded — server binds, 503 `HealthResponse` not `ErrorResponse` | PASS |
| 5 | OpenAPI 3.1, 5 paths, 16 components, logout 204 no content, non-2xx audit | PASS |
| 6 | Swagger 200 dev / 404 production | PASS |
| 7 | Validation 400 `fields:["email","password"]` | PASS |
| 8 | All four bad-token inputs 401 (+ positive control) | PASS |
| 9 | Login/`/me` snake_case, `password_hash` occurrences **0** | PASS |
| 10 | **Byte-identical** 401s — `cmp` clean, same SHA-256, same content-length 70 | PASS |
| 11 | Rotation + replay — all rows revoked, `revoked_at NULL: 0` | PASS |
| 12 | Logout 204, `size_download=0`, no content-type, `revoked_at` set | PASS |
| 13 | Hash-only storage — plaintext match count 0, stored == sha256(token), 64-hex | PASS |
| 14 | Argon2id `$argon2id$v=19$m=19456,t=2,p=1`; scoped bcrypt grep **zero** | PASS |
| 15 | `INTERNAL` 500, leak audit 0 for SQL/paths/stack, full error at `"level":50` | PASS |
| 16 | Hermetic — 138/138 twice, no DB artifacts, `git status` unchanged | PASS |
| 17 | Boundary rules 40/40; **all four tampered one at a time and each failed**, reverted | PASS |
| 18 | Contract rename fails typecheck in **BOTH** apps (TS2561 api / TS2339 web) | PASS |
| 19 | **Playwright** — `/me` renders email + `ok · db ok · v0.1.0`; wrong creds render visible alert, no unhandled rejection | PASS |
| 20 | Single-flight — web 12/12 | PASS |
| 21 | Full gate `typecheck=0 lint=0 test=0 build=0`, 150 tests | PASS |
| — | Case 33 / D1 CI gate | **DEFERRED** |

### D2 resolved
Playwright MCP reconnected mid-build, so cases 11 and 37 were executed **for real** rather than
reported blocked. Screenshots captured. Note: the MCP server writes into a workspace-rooted
`.playwright-mcp/` and refuses paths outside the repo, so the agent captured there, copied the
PNGs to the scratchpad, and deleted the directory to keep the tree clean.

### Only defect found: stale test counts in docs (FIXED by orchestrator)
Docs said 148 (136+12); actual is 150 (138+12) after the case-23 guard added 2 tests.
Corrected in 7 places: `README.md:16,144,145`, `docs/development.md:211,212`,
`docs/deferred.md:75`, `docs/gotchas.md:260`. Prettier re-checked clean.
**No functional defect was found in any of the 21 items.** Every documented command worked as
written.

### Case 33 / D1 — DEFERRED, not passed, not failed
`git remote -v` empty; `git log` reports no commits on `main`. Per Q2 there is no remote, so
Actions cannot run. `.github/workflows/ci.yml` exists and is YAML-valid, but the gate is
unverifiable here. To close: add a remote, push a branch with a deliberate type error, confirm
the run fails at `typecheck` and never reaches `build`.

### Cleanup verified
Servers stopped (:3000, :5173 free). All five tampers reverted and byte-verified against backups;
`dist` rebuilt so no probe remains in build output. `apps/api/data/` and `.playwright-mcp/`
removed. No `*.db`/`-wal`/`-shm` and no `data/` anywhere. `git status` shows the same 16 untracked
entries as at session start.
