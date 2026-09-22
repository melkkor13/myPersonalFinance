# myPersonalFinance

A personal finance tracker. This repository currently contains the **scaffold only** — the
parts that are expensive to change later, proven end to end, plus nothing else.

## What exists

- A standalone Fastify HTTP API under `/api/v1`, self-describing via OpenAPI 3.1.
- Auth: login, refresh (rotating), logout, and one protected route (`GET /api/v1/me`).
- `GET /api/v1/health`, which really queries the database.
- SQLite via Drizzle ORM, with committed migrations and a seed script.
- A React 19 + Vite SPA that renders exactly two screens: a login form, and a page showing the
  signed-in user plus API health.
- `@finance/contracts`: Zod schemas shared by both apps, so a contract change breaks compilation
  in the API and the web app.
- 150 tests (138 API, 12 web) and a CI workflow.

## What deliberately does NOT exist yet

There are **no finance tables**. `accounts`, `categories`, `transactions` and `budgets` are
deferred by [ADR 0009](docs/adr/0009-scaffold-slice-health-check-and-auth-only.md). The database
holds exactly `users`, `refresh_tokens` and `__drizzle_migrations`.

Also absent, on purpose: TLS, real secret management, rate limiting on `/auth/*`, CSV import,
charts, transfers, multi-currency, Postgres, and any public registration endpoint (registration
is a seed/CLI operation). See [docs/deferred.md](docs/deferred.md).

`apps/api/src/lib/money.ts` exists and is fully tested but is **not used by any route** — it is
here so the integer-minor-units convention ([ADR 0006](docs/adr/0006-money-as-integer-minor-units.md))
is settled before the first money column is written.

## Repo layout

npm workspaces (`apps/*`, `packages/*`), see
[ADR 0002](docs/adr/0002-npm-workspaces-monorepo.md).

```
apps/api            @finance/api        Fastify + TypeScript HTTP API
apps/web            @finance/web        React 19 + Vite SPA
packages/contracts  @finance/contracts  Zod schemas + inferred types, shared by both apps
docs/adr            nine ADRs (0004 and 0006 carry `## Amendments`)
think/              original design notes
.specBuilder/       the spec, task files and test-case matrix for this build
```

## Prerequisites

- **Node >= 22.13.0.** The floor is `22.13.0`, not `22.0.0`: `eslint@10` requires `^22.13.0`.
  Root `engines` declares this.
- npm 10+ (ships with Node 22).
- No compiler toolchain. `better-sqlite3` and `@node-rs/argon2` both ship prebuilt N-API
  binaries for darwin/linux/win, so there is no node-gyp and no Xcode step.

The committed root `.npmrc` pins `registry=https://registry.npmjs.org`. This is deliberate: the
ambient `~/.npmrc` on Momentive machines points at an AWS CodeArtifact proxy whose token expired
twice during this build — once mid-install, producing a `package-lock.json` with mixed `resolved`
URLs, which makes `npm ci` fail with `E401` whenever the token is dead. This project consumes no
internal packages, so pinning the public registry keeps `npm ci` reproducible with no AWS
credentials. See requirements.md Q4. Delete `.npmrc` only if the project ever needs a private
Momentive package.

## Quickstart

From a fresh clone:

```bash
npm ci

# 1. Config. JWT_SECRET is required and must be >= 32 characters.
cp .env.example .env
#    ...then set JWT_SECRET in .env, e.g.:
#    JWT_SECRET=local-dev-jwt-secret-please-change-0000000

# 2. Create the SQLite database at ./apps/api/data/finance.db and apply migrations.
npm run db:migrate

# 3. Create the single seed user.
npm run db:seed

# 4. Start both dev servers.
npm run dev
```

API on <http://localhost:3000>, web on <http://localhost:5173>. Vite proxies `/api` to the API,
so the SPA is same-origin and the API needs no CORS configuration.

### How `.env` gets loaded

The npm scripts that boot the server or touch the database (`dev`, `start`, `db:migrate`,
`db:seed`, `db:reset` in `apps/api/package.json`) pass Node's
`--env-file-if-exists=../../.env`, so the repo-root `.env` is picked up automatically and its
absence is a no-op rather than an error — which is what keeps CI working, where `JWT_SECRET`
comes from the workflow env and no `.env` file exists.

**Consequence worth knowing:** the loading lives in the npm scripts, not in the application. If
you invoke the entry point directly — `node dist/index.js` — you get no `.env` and must supply
the environment yourself, e.g. `node --env-file-if-exists=../../.env dist/index.js` from
`apps/api`, or by exporting the variables. The **test scripts deliberately do not** load `.env`,
so the suites stay hermetic.

`npm run db:migrate` / `db:seed` do not need `JWT_SECRET` at all — the CLI scripts read `DB_PATH`
directly rather than going through `loadConfig()`, precisely so a migration does not require a
valid signing key.

### Seeded credentials

From `apps/api/src/db/seed.ts`:

| Field              | Value                  |
| ------------------ | ---------------------- |
| email              | `owner@example.com`    |
| password           | `change-me-please-123` |
| `default_currency` | `USD`                  |

Re-running `npm run db:seed` is a no-op (`Seed user already exists, nothing to do`), never a
duplicate.

### Verify it works

```bash
curl -s http://localhost:3000/api/v1/health
# {"status":"ok","version":"0.1.0","db":"ok"}

curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"change-me-please-123"}'
# {"access_token":"eyJhbGciOiJIUzI1NiJ9...","refresh_token":"_GGI9hEqkJLbXHvmCLk-jPle3E81weCGddgp3XX9_A4"}
```

Swagger UI (development only) is at <http://localhost:3000/api/v1/docs>; the machine-readable
document is at <http://localhost:3000/api/v1/openapi.json>.

## Running on a Raspberry Pi 5 with Docker

Two containers: `api` (Node 22 + Fastify) and `web` (nginx, serving the built SPA and proxying
`/api` to `api`). nginx is the production stand-in for the Vite dev proxy, so the SPA stays
same-origin — `apps/web/src/api/constants.ts` pins `API_BASE_URL = ''` and the API registers no
CORS plugin, so anything that splits them onto two origins breaks the app.

### Prerequisites

- **A 64-bit OS.** `uname -m` must print `aarch64`. `better-sqlite3@13` ships no `armv7l`
  prebuild, so on 32-bit Raspberry Pi OS the image build falls back to node-gyp and fails.
- Docker Engine with Compose v2 (`docker compose version`).

No compiler toolchain is needed: every native dependency resolves a `linux-arm64` prebuild
(`better-sqlite3` bundles `prebuilds/linux-arm64.node`; `@node-rs/argon2`, `rolldown`,
`@tailwindcss/oxide` and `lightningcss` all have `linux-arm64-gnu` packages in the lockfile).
One wrinkle that follows: both `npm ci` steps in the `Dockerfile` pass `--ignore-scripts`,
because `better-sqlite3` ships a `binding.gyp` and npm therefore invokes node-gyp, which needs a
python3 this image does not have — for a build that compiles nothing, since the prebuild is
already there. The Dockerfile explains it at the call site.

### Run it

```bash
cp .env.example .env
# Required: JWT_SECRET (>= 32 chars) — `openssl rand -base64 48`
# Strongly recommended: SEED_USER_EMAIL and SEED_USER_PASSWORD, so you do not
# deploy the published default credentials.

docker compose build          # several minutes on a Pi; `npm ci` dominates
docker compose up -d

# Once, to create the only user account:
docker compose run --rm migrate node dist/db/seed.js
```

A `Makefile` wraps these: `make up`, `make down`, `make logs`, `make build`, `make seed`,
`make update`.

The app is then on <http://localhost:10000> **on the Pi**. Migrations are applied by a one-shot
`migrate` service that `api` waits on (`service_completed_successfully`); it is idempotent, so it
runs harmlessly on every `up`. Seeding is a separate manual step on purpose — creating the only
account should not be a side effect of starting the app.

### Deploying a new version

On the Pi, in the checkout compose was started from:

```sh
make update      # git pull --ff-only, docker compose build, docker compose up -d
```

Three things about it worth knowing:

- **A failed build leaves the running containers alone.** Build and `up` are separate steps, so a
  commit that does not compile costs you nothing — the old version keeps serving until a new image
  actually exists.
- **It exits 0 only once the new API is healthy.** `web` depends on `api` being
  `service_healthy`, and `/api/v1/health` really queries the database, so a green `make update` is
  a genuine readiness signal rather than "a container started".
- **`--ff-only` means a diverged checkout fails loudly.** If it refuses, someone committed on the
  Pi; fix that deliberately rather than letting a merge commit appear on the box.

It does not seed, and it does not touch the `finance-data` volume. Old images are left dangling —
run `docker image prune -f` when disk gets tight. There is still **no off-Pi backup**; that is
designed but unimplemented in `think/deploy-to-raspberry-pi-via-github-actions.md`, and
`make update` applies migrations to your only copy of the data.

### Two things that are deliberate

- **The database lives in a named volume (`finance-data`), not a bind mount.**
  `apps/api/test/hermetic-no-db-files.test.ts` runs `find` across the working tree and fails if
  any `*.db`, `*.db-wal` or `*.db-shm` exists there, so `./data:/data` would turn a normal deploy
  into a red test suite. `.gitignore` hides such a file from git, not from `find`.
- **`web` publishes `127.0.0.1:10000:80`, not `10000:80`.** The only route in is whatever proxy or
  tunnel runs on the host. Widen it only if you intend to serve plain HTTP to your LAN.

### Exposing it beyond the Pi: Cloudflare Access

The scaffold assumed localhost (A4). The deployed setup puts **Cloudflare Access** in front of the
hostname, and the API verifies the identity Access proves
([ADR 0010](docs/adr/0010-cloudflare-access-as-primary-authentication.md)). That closes the three
gaps that going internet-facing would otherwise open: the browser holds no token, `/auth/login` is
not externally reachable, and `/api/v1/openapi.json` is no longer anonymous.

**Setup, once, on the Cloudflare side:**

1. Zero Trust → Access → Applications → add a self-hosted application for your hostname.
2. Add a policy listing the email addresses allowed in. **Read this twice.** Auto-provisioning
   means any address this policy admits gets a user row with full access to the finance data;
   there is no second app-side allowlist.
3. Copy two values into `.env` on the Pi:
   - `CF_ACCESS_TEAM_DOMAIN` — your team domain, a bare hostname
     (`your-team.cloudflareaccess.com`), no scheme and no trailing slash.
   - `CF_ACCESS_AUD` — the application's **Application Audience (AUD) Tag**, 64 hex characters,
     from the application's Overview tab.
4. Set `CF_ACCESS_ENABLED=true` and restart. Enabling it without the other two is a fatal boot
   error, deliberately: a box that believes Access is on but silently fell back to password-only
   looks identical from outside to a working one.
5. Keep the application's **session duration short** (24h). `identity_nonce` is not checked, so
   Cloudflare's "revoke user sessions" only takes effect when the current assertion expires. A
   user-initiated logout is immediate.

Verify with `curl -sI https://your-host/api/v1/health` — it should `302` to the Access login, not
answer `200`.

**Locally, leave `CF_ACCESS_ENABLED=false`.** The header is then ignored outright and `npm run dev`
keeps using email/password login, which is also the path for any future CLI or mobile client. A
password login still stores its refresh token in `localStorage` (`apps/web/src/api/tokens.ts`);
that path is unreachable in the deployed browser flow, where no token is issued at all.

Still open, and listed in `docs/deferred.md`: `/api/v1/auth/*` is unthrottled for anything that can
already reach the Pi's loopback, since Access protects the hostname and not `127.0.0.1:10000`.

## Scripts (root, FR13)

All delegate to workspaces.

| Script                | What it does                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`         | API and web concurrently via `concurrently` (prefixes `api`, `web`). API = `tsc --watch` + `node --watch dist/index.js`; web = `vite`.                             |
| `npm run build`       | `npm run build --workspaces --if-present`. Contracts → `tsc`; API → `tsc` plus a copy of `src/db/migrations` into `dist/`; web → `tsc --noEmit` then `vite build`. |
| `npm run typecheck`   | `tsc --noEmit` per workspace. Both apps also typecheck their `test/tsconfig.json`, because test files sit outside the `rootDir: "src"` project.                    |
| `npm run lint`        | `eslint .` at the root (one flat config for the whole monorepo).                                                                                                   |
| `npm run format`      | `prettier --write .`                                                                                                                                               |
| `npm run test`        | API suite then web suite (150 tests).                                                                                                                              |
| `npm run test:api`    | `vitest run` in `apps/api` (138 tests, 20 files).                                                                                                                  |
| `npm run test:web`    | `vitest run` in `apps/web` (12 tests, 4 files).                                                                                                                    |
| `npm run db:generate` | `drizzle-kit generate` — writes a new migration `.sql` plus `meta/` files. Commit all of them.                                                                     |
| `npm run db:migrate`  | Builds, then applies pending migrations to `DB_PATH`. Idempotent; a second run applies nothing and exits 0.                                                        |
| `npm run db:seed`     | Builds, then creates the single seed user if absent.                                                                                                               |
| `npm run db:reset`    | Builds, drops and recreates the database, then re-seeds.                                                                                                           |

`pretest` / `prebuild` / `predev` hooks build `@finance/contracts` first — it must exist as
built JS in `packages/contracts/dist/` before anything imports it at runtime.

## Documentation

- [docs/api.md](docs/api.md) — API reference: all seven routes, schemas, error envelope, auth flow.
- [docs/development.md](docs/development.md) — setup, layering, boundary rules, config, testing.
- [docs/gotchas.md](docs/gotchas.md) — the non-obvious things. **Read this before changing anything.**
- [docs/deferred.md](docs/deferred.md) — deferred scope and the manual verification steps still owed.
- [docs/adr/](docs/adr/) — nine ADRs.
