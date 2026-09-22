# Deferred work and outstanding manual verification

Two separate things live here: scope that was consciously not built, and verification steps that
could not be executed in this environment and are still owed.

---

## Deferred scope

All of the following is deferred by
[ADR 0009](adr/0009-scaffold-slice-health-check-and-auth-only.md) — recorded, not forgotten, and
not tested because it does not exist.

### Security / operations

| Item                                     | Note                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TLS**                                  | The app itself still speaks plain HTTP. In the deployed setup Cloudflare terminates TLS at the edge and `cloudflared` encrypts edge→origin, so there is no certificate to manage on the Pi.                                                                                                                                                                                            |
| **Secret management**                    | `JWT_SECRET` comes from the environment. No KMS, no vault, no rotation.                                                                                                                                                                                                                                                                                                                |
| **Rate limiting on `/auth/*`**           | **Resolved at the edge** by [ADR 0010](adr/0010-cloudflare-access-as-primary-authentication.md) for external callers: Cloudflare Access refuses unauthenticated requests before they reach Fastify, so the unthrottled Argon2id endpoint is not externally reachable. Still unthrottled for anything that can reach the Pi's loopback directly.                                        |
| **Refresh-token storage in the browser** | **Resolved by [ADR 0010](adr/0010-cloudflare-access-as-primary-authentication.md).** Behind Cloudflare Access the browser holds no token at all — the credential is Cloudflare's `HttpOnly` `CF_Authorization` cookie, and `setTokens()` is never called. `localStorage` is still used by a _password_ login, which remains the path for local `npm run dev` and non-browser clients.  |
| **CORS**                                 | Deliberately absent: Vite proxies `/api` in dev, so requests are same-origin. Adding CORS would mask a broken proxy.                                                                                                                                                                                                                                                                   |
| **Public registration**                  | **Partly reversed by [ADR 0010](adr/0010-cloudflare-access-as-primary-authentication.md).** There is still no signup endpoint, but a first Cloudflare Access login auto-provisions a user row — registration is now gated by the Cloudflare Access policy rather than by a seed script. The Access policy is therefore the entire authorization boundary; see that ADR's Consequences. |

### Features

| Item                                                | Note                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Finance tables**                                  | `accounts`, `categories`, `transactions`, `budgets`. None exist.                                                                                        |
| **Transfers**                                       | The paired-row invariant is an open design question, not deferred implementation.                                                                       |
| **Idempotency rule for client-supplied UUIDv7 ids** | Deliberately undecided.                                                                                                                                 |
| **Multi-currency / FX**                             | One currency per dataset, stored once as `users.default_currency`. `lib/money.ts` fixes the exponent at 2, so JPY and KWD are unsupported by design.    |
| **CSV import**                                      | Manual entry first; bank aggregation (Plaid/Yodlee) is explicitly out of scope forever (assumption A3).                                                 |
| **Charts**                                          | Deferred by [ADR 0007](adr/0007-react-vite-spa-frontend.md).                                                                                            |
| **Postgres**                                        | SQLite today. The B1/B2 boundary rules exist so this stays a migration rather than a rewrite ([ADR 0005](adr/0005-drizzle-orm-over-better-sqlite3.md)). |

### `lib/money.ts` is unused

`apps/api/src/lib/money.ts` is fully implemented and unit-tested but **no scaffold route calls
it**, because no route handles money. ADR 0009 accepted this explicitly. It exists so the
integer-minor-units convention ([ADR 0006](adr/0006-money-as-integer-minor-units.md)) was settled
and proven before the first money column was written, rather than being invented under pressure
alongside the first transaction endpoint.

### The money-column test is vacuous until finance tables land

`apps/api/test/db-schema-conventions.test.ts` asserts two things: no column anywhere is `REAL`,
and every column whose name ends `_minor` is `INTEGER`. The first bites today. The second cannot
— the two auth tables hold no money, so the `_minor` column set is empty and the loop runs zero
times.

This is wired now, not skipped, so it starts enforcing automatically the moment a money column
appears. The vacuity is documented in the test itself with a final assertion:

```ts
// Documents the vacuity explicitly rather than hiding it: the scaffold's two
// auth tables hold no money. This expectation must be DELETED, not relaxed,
// when the finance tables land.
expect(moneyColumns).toEqual([]);
```

**When you add the first `_minor` column, delete that `expect(moneyColumns).toEqual([])` line**
(the last assertion in the `types every _minor column as INTEGER` test). Do not relax it to
`toHaveLength(n)` or similar — the surrounding `for` loop is the real assertion and becomes live
on its own. The test above it (`enumerates real columns, so the assertions below are not vacuous
by accident`) stays as is.

---

## Outstanding manual verification

### Case 33 / D1 — the CI gate (DEFERRED)

`.github/workflows/ci.yml` is written, YAML-validated, and its steps have all been run locally in
the FR15 order (`npm ci` → `typecheck` → `lint` → `test` → `build`, all exit 0, 150/150 from a
cold `rsync`'d copy). **But the workflow has never actually executed**, because per ruling Q2 this
repository is local-only: `git init` on branch `main`, no GitHub remote, nothing pushed. GitHub
Actions cannot run, so the gate itself is unverifiable here. This is deferred, not passed, and not
dropped.

To complete it once a remote exists:

1. Add a remote and push the default branch:
   `git remote add origin <url>` then `git push -u origin main`. Confirm a CI run is triggered by
   the push and goes green.
2. Create a branch and introduce a deliberate TypeScript type error somewhere in
   `apps/api/src` — for example assign a string to a number-typed field, such as setting
   `config.port` to `"3000"`. Anything `tsc` will reject is fine.
3. Push that branch and open a pull request.
4. Confirm the run **fails at the `Typecheck` step**, and that `Lint`, `Test` and `Build` are
   shown as skipped — never reached. Confirm the check is reported as failing on the PR. There is
   no `continue-on-error` anywhere in the workflow, so this is what should happen; the only
   occurrence of that string in the file is a header comment explaining its deliberate absence.
5. Remove the deliberate error, push again, and confirm the run goes green.

Same steps are recorded in the header comment of `.github/workflows/ci.yml`.

### Case 28 — a contract rename must fail typecheck in BOTH apps

Automated tests cannot assert "this does not compile", so this is a manual procedure. It proves
the shared-contracts arrangement ([ADR 0008](adr/0008-zod-first-shared-contracts-package.md)) is
actually load-bearing and not just a convention.

1. Start from a clean tree with `npm run typecheck` passing.
2. Rename a field in a `@finance/contracts` schema. `access_token` in `LoginResponseSchema`
   (`packages/contracts/src/auth.ts`) is the best choice, because both apps read it — rename it to
   `access_token_renamed`.
3. Run `npm run typecheck` from the repo root.
4. Confirm it **fails in both workspaces**:
   - `apps/api` — `auth.service.ts` / `auth.routes.ts` no longer satisfy `LoginResponse`.
   - `apps/web` — `apps/web/src/api/*` and the MSW handlers under `apps/web/test/support/` no
     longer compile. The web `typecheck` script runs both `tsconfig.json` and
     `test/tsconfig.json`, so the mock handlers are covered too.
     A failure in only one workspace means the other has drifted away from the shared contracts and
     is duplicating types locally — that is the real defect this case exists to catch.
5. Revert the rename (`git checkout -- packages/contracts/src/auth.ts`) and confirm
   `npm run typecheck` is clean again.

### Case 38 — boundary tests must actually bite

Covered permanently by the synthetic known-bad fixtures inside each B1–B4 test file, so no manual
step is normally needed. If you want to re-prove it against real files: add
`import { eq } from 'drizzle-orm'` to `apps/api/src/modules/health/health.service.ts`, run
`npm run test:api`, confirm the B1 test fails, then revert. B4 cannot be violated with a real file
today, which is why its teeth rest on the synthetic fixtures.

### Cases 11 and 37 — browser verification

`/me` renders the user's email and API health; wrong credentials render a visible error rather
than a blank screen or an unhandled rejection. Both were verified at the API and component level
(the web suite asserts the `role="alert"` path, the real `Authentication failed` text, that the
form stays mounted, and that there are zero unhandled rejections after a macrotask flush), but the
Playwright MCP server failed to connect during the build. If it is still unavailable, report these
two as **blocked, not passed**.

Case 22's single-flight assertion is _not_ at risk — it is independently and fully covered by the
web suite via MSW request counting.

### Before any browser verification

Re-run `npm run db:migrate && npm run db:seed`. The development database is deliberately deleted
after use, because case 23 scans the whole repository tree for `.db`, `.db-wal` and `.db-shm`
artifacts and `apps/api/data/` must not survive a test run.

---

## Still open after ADR 0010

[ADR 0010](adr/0010-cloudflare-access-as-primary-authentication.md) moved browser authentication to
Cloudflare Access. These related items are **not** closed by it:

| Item                                   | Note                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rate limiting for loopback callers** | Access protects the hostname, not `127.0.0.1:10000`. Anything already on the Pi can still hammer `POST /api/v1/auth/login` and pay Argon2id costs. A Cloudflare edge rate-limiting rule is belt-and-braces, not the load-bearing control. Note a rule written `/auth/*` matches nothing — the path is `/api/v1/auth/*`.                                 |
| **Access session revocation latency**  | `identity_nonce` is deliberately not checked, so Cloudflare's "revoke user sessions" takes effect only when the current assertion expires. Keep the Zero Trust application session duration short. A user-initiated logout is immediate.                                                                                                               |
| **Identity joined on `email`**         | An email change upstream silently yields a new, empty account. The fix is a nullable `users.access_subject` column with a unique index, matched ahead of email. `identity.subject` is already carried to the service layer so this needs no re-plumbing.                                                                                               |
| **`trustProxy`**                       | Still off, so all client IPs log as the proxy's. Required only when per-IP rate limiting arrives — and then it must be a specific hop list, because `web` is reachable on loopback and any local process could forge `X-Forwarded-For`. Behind the tunnel the authoritative client IP is `CF-Connecting-IP`, not the leftmost `X-Forwarded-For` entry. |
| **Which accounts are passwordless**    | Not recorded, by design — a provisioned account holds a real Argon2id hash of discarded entropy rather than a marker, so that `login` needs no branch. Adding an `auth_provider` column is fine; branching `login` on it is not.                                                                                                                       |
