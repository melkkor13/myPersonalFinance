# Gotchas

Every item here was found the hard way while building the scaffold. They are written down so
nobody rediscovers them, and so nobody "fixes" a deliberate decision.

---

## Money is never a float, and never more than 2 decimal places

`apps/api/src/lib/money.ts` hard-codes `MONEY_EXPONENT = 2`.

- `"1.005"` is **rejected, not rounded**. The error says so explicitly: _"has more than 2 decimal
  places; amounts are never rounded, so this value cannot be represented"_. Same for `"abc"`,
  `""`, `"1.2.3"`, `"."`, `".5"`, `"5."`, `" 1.00 "`, `"1,234.56"`, `"1e2"`, `"Infinity"`,
  `"NaN"`, `"-"`, non-string input, and out-of-range values.
- **JPY (0 decimal places) and KWD/BHD (3) are therefore unsupported.** This is an accepted
  limitation (assumption A2: one currency for the whole dataset, no FX), asserted by a test
  rather than hidden.

**Parsing reassembles digit strings; it never multiplies.** The input is matched against
`^[+-]?\d+(?:\.\d{1,2})?$`, then the capture groups are concatenated into an integer digit string
(`"1234"` + `"56"` → `"123456"`) and parsed once. The concatenation _is_ the ×10² shift. This is
the whole point: `parseFloat("1.15") * 100 === 114.99999999999999`. Formatting mirrors it with
`padStart`. The sign is carried separately from the digits, so `-0.07` → `-7` → `"-0.07"` and a
zero magnitude never becomes `-0`.

`number`, not `bigint`, justified: the exact-integer range of a double is ±9,007,199,254,740,991,
and the largest value in the spec (`"999999999.99"` → `99,999,999,999`) is five orders of
magnitude inside it — and `better-sqlite3` returns `number` for INTEGER columns, so `bigint` would
add a conversion at every repository boundary. Both directions check `Number.isSafeInteger`, and
digit count is checked _before_ parsing.

**`money.ts` is deliberately unused by any scaffold route.** No finance tables exist, so nothing
converts money yet. [ADR 0009](adr/0009-scaffold-slice-health-check-and-auth-only.md) accepted
this: the convention needed to be settled and tested before the first money column was written.

Related: the money-column convention test is **vacuous today**. See
[deferred.md](deferred.md#the-money-column-test-is-vacuous-until-finance-tables-land) for the
exact line a future developer must delete.

---

## `crypto.randomUUID({ version: 7 })` silently returns a v4

It does **not** throw. The option is ignored, and you get a perfectly valid, perfectly
non-time-ordered UUIDv4 — undetectably, unless you inspect the version nibble.

Use `v7()` from the `uuid` package (pinned at `uuid@14.0.2`). `uuid@14` is ESM-only, which is one
of the reasons every package here is `"type": "module"`.

---

## The single-flight refresh lock is mandatory, not an optimisation

`apps/web/src/api/refresh.ts`.

The API rotates refresh tokens and treats a **replayed** (already-rotated) token as evidence of
compromise, revoking **every** refresh token for that user. So if N requests 401 at the same
moment — the normal case when an access token expires while a page is fetching several resources
— and each performed its own refresh, the first would win and the losers would each present the
token the winner had just rotated away. The API would correctly read that as replay and log the
user out of everything. A self-inflicted logout caused purely by client concurrency.

```ts
let inFlight: Promise<void> | null = null;

export function refreshAccessToken(): Promise<void> {
  inFlight ??= performRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
```

Two details that are load-bearing:

- **The check-and-set is synchronous.** There is no `await` between reading and writing
  `inFlight`, so the assignment completes before control can return to the event loop and a
  same-tick second caller sees a non-null value and joins.
- **It must clear on failure as well as success — `.finally`, not `.then`.** The promise stored
  in `inFlight` is the one produced by `.finally()`, so the lock resets either way, before waiters
  resume. Clearing only on success poisons every later request with a permanently stale rejected
  promise; a dedicated test fails in 2 ms without issuing a single request when this regresses.

Also: `performRefresh` uses `rawRequest`, never `apiRequest`, so a 401 from the refresh route
cannot trigger another refresh. And it catches → `clearTokens()` → rethrows `SessionExpiredError`,
so all N waiters observe the same logged-out state.

**Any future client that holds a refresh token needs the equivalent.** This is a property of the
API's replay policy, not of this particular SPA.

---

## Tailwind v4 has no `tailwind.config.js` and no `postcss.config.js`

Integration is the first-party `@tailwindcss/vite` plugin, registered in
`apps/web/vite.config.ts`. CSS is a single `@import "tailwindcss"` plus `@theme` blocks in
`apps/web/src/index.css`. There is no autoprefixer and no `postcss-import`.

`npx tailwindcss init` no longer applies — do not run it, and do not add
`@tailwindcss/postcss` (that package is for non-Vite bundlers).

shadcn/ui is deliberately **not** used: it would add `components.json`, CVA, `clsx`,
`tailwind-merge` and Radix to render one form and one read-only panel.

---

## `PRAGMA journal_mode=WAL` on `:memory:` silently no-ops

It returns `[{"journal_mode":"memory"}]` and throws nothing. So the conditional in
`db/sqlite.ts` (WAL only for file-backed databases) is about correctness and testability, not
crash avoidance.

The consequence for the test: **asserting on DB state would pass vacuously**, because SQLite
happily reports `memory` whether or not you issued the pragma. `db-pragmas.test.ts` therefore
spies on `.pragma()` and asserts the call is **not issued**. `foreign_keys` and `busy_timeout`
stay unconditional.

`applyPragma()` exists as a single choke point purely so that spy is possible.

---

## `@finance/contracts` resolves types from source but runtime from `dist/`

`packages/contracts/package.json`:

```json
"exports": { ".": { "types": "./src/index.ts", "import": "./dist/index.js" } }
```

Types come from source, so `typecheck` has no build-order dependency. Runtime comes from
`dist/`, which is gitignored and **absent on a fresh clone**. So the package must be **built
before anything imports it at runtime**.

`pretest` / `prebuild` / `predev` hooks in `apps/api` and `apps/web` handle this. That is also
why the CI order `typecheck → lint → test → build` is safe even though `test` comes before
`build` — verified from a genuinely cold clone.

If you see a module-not-found for `@finance/contracts/dist/index.js`, run
`npm run build -w @finance/contracts`.

---

## `fastify-type-provider-zod@7` has no `createJsonSchemaTransformObject({ schemas })`

The original plan (requirements.md Q6) recorded that API. It does not exist in v7 — that was
wrong. Components are supplied via a **Zod registry** (`z.registry()` plus `{ id }` metadata per
schema), which is the v7 equivalent, and `plugins/openapi.ts` builds one.

Two traps around it:

- The ready-made `jsonSchemaTransform` export is bound to Zod's **global** registry, finds no
  ids, and **silently inlines a full copy of every schema into every route** — the exact outcome
  the named-components decision was meant to avoid. You need
  `createJsonSchemaTransform({ schemaRegistry })` and the matching
  `createJsonSchemaTransformObject({ schemaRegistry })`.
- v7 emits **both an output and an input projection** of each component, so the document has 16
  component schemas for 8 contracts: `ErrorResponse` _and_ `ErrorResponseInput`, etc. **Request
  bodies `$ref` the `...Input` variant** —
  `POST /api/v1/auth/login` → `{"$ref":"#/components/schemas/LoginRequestInput"}`. Any test that
  expects the bare name for a request body will fail spuriously.

Also: `@fastify/swagger@9` serves no routes of its own; it only decorates the instance with
`swagger()`. `GET /api/v1/openapi.json` is an ordinary route, marked `hide: true` so the meta
route does not document itself.

---

## The logout 204 must be `response: { 204: z.null() }`

A narrow path between three failure modes:

- An entry with an empty `content: {}` map **crashes `@fastify/swagger`** — it reads the first
  media type of `content` unguarded.
- Omitting 204 entirely drops the status from the document.
- Any ordinary object schema declares an `application/json` body, which is exactly what the FR5
  exemption forbids.

`z.null()` transforms to `{"type":"null"}`, and `@fastify/swagger` deliberately skips content
generation for a `null`-typed response, so the document gets `204` with a description and no
`content`. The handler does `await reply.status(204).send(null)` and Fastify strips the payload,
so the wire body is genuinely zero-length with no content-type. Note it is awaited and _not_
returned — returning the reply object would make the handler's return type the reply, which
Fastify's typing does not accept.

---

## JWT `iat` / `exp` are second-granular

A refresh issued within the same wall-clock second as the login re-mints a **byte-identical**
access token. Any assertion that "the refreshed access token differs" is flaky unless the test
crosses a second boundary.

**Assert refresh-token rotation, not access-token difference.** The refresh token is 32 CSPRNG
bytes and always differs — and it is the security-relevant part anyway.

---

## `db/sqlite.ts` caches a process-wide connection

`sharedConnection` in `db/sqlite.ts`, and `db/client.ts` caches the Drizzle handle over it. You
cannot get a different database just by changing `DB_PATH` mid-process.

This is why Vitest per-file process isolation (`pool: 'forks'`, `isolate: true`) is **mandatory**
for the API suite, not a preference. Within a file, the only supported way to get a clean
database is `freshInMemoryDatabase()` in `test/support/harness.ts`, which calls `closeDb()` (which
drops both caches) before re-opening and re-migrating.

During the build, proving the health-degraded path required running each `DB_PATH` case in a
**separate child process** for the same reason.

---

## `db/seed.ts` uses `createOwnedDb()`, so `seed()` cannot target a shared in-memory DB

`createOwnedDb()` opens its own connection. For `:memory:` that means a **second, completely
separate and unmigrated** database — every `new Database(':memory:')` is private. So calling
`seed()` against "the" in-memory database silently operates on a different, empty one and then
fails on a missing table.

`db-seed.test.ts` therefore uses a temp-directory file database; every other suite inserts users
through a harness fixture instead of calling `seed()`. Fine in production, where seed targets a
file DB — but a trap for anyone writing a future in-memory seed test.

Related: do not try `file::memory:?cache=shared` to work around it. Keep the per-file
`createTestDb()` shape.

---

## `.env` is loaded by the npm scripts, not by the application

There is no `dotenv` dependency. `config.ts` reads `process.env` directly and knows nothing about
files. The loading is done by Node's own flag in `apps/api/package.json`:

```
--env-file-if-exists=../../.env
```

applied to `dev`, `start`, `db:migrate`, `db:seed` and `db:reset`. The path is relative because
those scripts run with cwd `apps/api`, and the `.env` lives at the repo root next to
`.env.example`.

Three things follow, and all three have bitten:

- **Use `-if-exists`, not plain `--env-file`.** `node --env-file=.env` **exits 9** when the file
  is missing (`node: ./nope.env: not found`), which would break CI, where `JWT_SECRET` comes from
  the workflow env and no `.env` file exists. The `-if-exists` variant prints
  `../../.env not found. Continuing without it.` and carries on.
- **`NODE_OPTIONS="--env-file=.env"` does not work at all** — Node rejects it:
  `--env-file= is not allowed in NODE_OPTIONS`. Don't reach for that shortcut.
- **Invoking the entry point directly gets you nothing.** `node dist/index.js` bypasses the npm
  script and therefore the flag, and exits with
  `JWT_SECRET: is required but was not set`. Supply the environment yourself in that case.

**The test scripts deliberately omit the flag.** `pretest` / `test` must stay hermetic:
`boot-config.test.ts` builds a minimal child env explicitly and several suites override
`DB_PATH` to `:memory:` or a temp path. Leaking a developer's `.env` into a test run would
undermine those and could reintroduce DB-file artifacts in the tree (case 23). Verified: with a
deliberately poisoned `.env` (`JWT_SECRET=x`, `DB_PATH=/proc/definitely/not/writable/poison.db`)
both suites still pass 138/138 and 12/12.

`db:migrate` / `db:seed` / `db:reset` do not need `JWT_SECRET` regardless: the CLI scripts call
`resolveDbPath()` and read `DB_PATH` directly rather than going through `loadConfig()`, precisely
so a migration does not require a valid signing key.

---

## Smaller ones, still worth knowing

- **`@node-rs/argon2` ships `Algorithm` as an ambient const enum** (its runtime export is `{}`),
  which `isolatedModules` forbids importing as a value. `lib/password.ts` uses a named constant
  `ARGON2ID_ALGORITHM = 2` instead of `Algorithm.Argon2id`. Argon2id is already the package
  default, so passing it explicitly is documentation and future-proofing, not a bug fix.
- **`migrationsFolder` resolves against `process.cwd()`**, which differs between running from the
  repo root and from `apps/api`. `migrate.ts` derives an absolute path via
  `new URL('./migrations/', import.meta.url)` so it works from both `src/` (Vitest) and `dist/`
  (CLI). The `build` script copies `src/db/migrations` into `dist/` for the same reason.
- **`migrate()` from `drizzle-orm/better-sqlite3/migrator` is synchronous** and reads migrations
  from disk but writes nothing there — usable directly in `beforeEach` with no `await`.
- **Zod response serialization emits `additionalProperties: false` and silently strips unknown
  keys.** Good — `password_hash` cannot leak. But a repository returning an extra field fails
  _silently_ rather than loudly.
- **Raw Fastify validation errors are `FST_ERR_VALIDATION`, not the envelope.**
  `plugins/errorHandler.ts` must call `hasZodFastifySchemaValidationErrors(err)` to map them.
- **`fields` extraction** splits each `instancePath` (`/email`, `/items/0/amount`) on `/`, drops
  empty and numeric-index segments, and takes the last remaining segment. Collected in a `Set`,
  so duplicate issues per field collapse and order is preserved.
- **`request.user` is typed optional** because it is absent on every route that does not use the
  `authenticate` hook. The narrowing in the `/me` handler is unreachable in practice; it exists so
  the handler cannot compile into treating an unauthenticated request as authenticated.
- **No CORS plugin, on purpose.** Vite proxies `/api` in dev, so requests are same-origin.
  Adding CORS would mask a misconfigured proxy. Vite uses `strictPort: true` so a port clash fails
  loudly instead of quietly moving to 5174 and breaking the proxy story.
- **`eslint.config.js` omits `@eslint/js`**, so ESLint core `recommended` rules are absent and
  linting comes solely from typescript-eslint's presets. The reason was environmental (the
  registry proxy 404'd on that version), not principled. Worth revisiting.
- **`npm ci` had never been run** until late in the build, only `npm install`. It failed with
  `EUSAGE ... lock file's esbuild@0.25.12 does not satisfy esbuild@0.28.2` — a stale lockfile, not
  a genuine conflict (three nested esbuild copies are legitimately required by
  `@esbuild-kit/core-utils`, `drizzle-kit`, `tsx` and `vite`). Regenerating the lockfile fixed it;
  no `overrides` were needed. If you hit it again, regenerate rather than pinning.
- **Static analysis over source text is fragile.** Two tasks had to reword _comments_ that merely
  mentioned `PRAGMA` or `better-sqlite3` to keep a regex-based scan green. The boundary tests were
  rewritten to parse the AST and match real import statements for this reason. Don't reintroduce a
  text grep.
