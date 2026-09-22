# Deploy to Raspberry Pi 5 via GitHub Actions

> Status: **Iteration 2.** Three decisions **Accepted** (7, 9, 10). Eight still **Proposed**. **No ADRs written yet** — they are held until Decision 1 (how the deploy is triggered) is settled, since it is the decision the rest hang off.
> Continues from [`finance-tracker-scaffold.md`](./finance-tracker-scaffold.md) (ADRs 0001–0009).

**Label convention:** this document's own assumptions are **P1–P6** (P for "production"). Where the scaffold's assumptions are cited they are written *scaffold A4* etc., because both documents number from A1 and the two sets mean different things.

## Problem Statement

The scaffold assumes `localhost` over plain HTTP (*scaffold A4*). We now want the real thing: the application running continuously on a **Raspberry Pi 5** at home, reachable from a phone over the internet through an existing **Cloudflare Tunnel**, with deployment driven by **GitHub Actions** on merge to `main`.

Three constraints shape every decision below:

1. **No inbound ports.** The Pi sits behind a home router with no port forwarding. Its only outbound path to the world is the `cloudflared` daemon. So GitHub Actions cannot "push to" the Pi in the conventional SSH sense unless we deliberately build a path in — and building one partly defeats the reason the tunnel exists.
2. **The Pi is arm64 and the app has native modules.** `better-sqlite3` and `@node-rs/argon2` are both compiled. Any artifact we ship must contain **linux/arm64** binaries, and how we obtain them is a real decision, not a detail.
3. **State lives on the Pi and cannot be recreated.** A single SQLite file *is* the product. Deployment must never be able to lose or corrupt it, which makes migrations and backups part of the deploy path rather than an afterthought.

### This deployment forces three deferred items to be resolved now

The scaffold explicitly deferred these, and going internet-facing makes them live. They are **not** optional extras:

| # | Deferred item | Why it becomes mandatory | Resolution |
|---|---|---|---|
| D1 | **Replacing `localStorage` refresh-token storage** | The scaffold states plainly that keeping a refresh token in `localStorage` "is acceptable only while the app is localhost-only", and replacing it is "a prerequisite for any non-localhost deployment". The token's lifetime is `REFRESH_TOKEN_TTL`, 30 days by default. | ~~**Decision 9 (Accepted):** `HttpOnly; Secure; SameSite=Strict` cookie…~~ **SUPERSEDED by [ADR 0010](../docs/adr/0010-cloudflare-access-as-primary-authentication.md).** Behind Cloudflare Access the browser holds **no token at all**, so there is nothing to move to a cookie. **Do not also implement Decision 9.** |
| D2 | **Rate limiting on `/api/v1/auth/*`** | `POST /api/v1/auth/login` becomes reachable from the internet. Argon2id makes each attempt expensive for the *server*, so an unthrottled login endpoint on a Pi is also a cheap CPU-exhaustion target. | **Decision 7 (Accepted):** Cloudflare rate limiting at the edge — no app change. |
| D3 | **TLS/HTTPS** | Obvious. | Solved for free: Cloudflare terminates TLS at the edge, *Always Use HTTPS* is enabled on the zone, and `cloudflared` encrypts edge→origin. The app keeps speaking plain HTTP on loopback, so **no certificate management on the Pi**. |

### Assumptions

| # | Assumption | Status |
|---|---|---|
| P1 | The repository is **private**. Decision 1 puts a self-hosted runner on the Pi, and a self-hosted runner on a public repo is a remote-code-execution vector via fork pull requests. | **Confirmed** |
| P2 | A Cloudflare Tunnel already exists on the Pi as a **named tunnel** with a credentials file (not a `trycloudflare.com` quick tunnel), and a hostname like `finance.example.com` is already routed to it. | Assumed |
| P3 | The Pi runs 64-bit Raspberry Pi OS (or Ubuntu) with Docker, the Compose plugin, **and the `sqlite3` CLI** installed on the host. The CLI is needed for backups (deploy step 3) and is the one host tool besides Docker that this design requires. | Assumed |
| P4 | Deployment is **single-instance, with downtime of up to about two minutes acceptable** — including the worst case where a health probe fails and the previous image is restarted. This is one person's finance app, not a service with an SLO, and it is what lets us skip blue/green entirely. | Assumed |
| P5 | There is exactly one environment (`production`). No staging Pi. | Assumed |
| P6 | The Pi's storage is the only copy of the data unless we say otherwise — so "backup" means **off-Pi**, not just a second file on the same disk. | Assumed |

## Solution

### Shape

```
┌─────────────────┐   push to main    ┌──────────────────────────────┐
│  GitHub repo    │──────────────────>│ ci.yml  (ubuntu-24.04-arm)   │
│   (private)     │                   │ typecheck · lint · test ·    │
└─────────────────┘                   │ build · docker build (arm64) │
                                      └──────────────┬───────────────┘
                                                     │ push image
                                                     v
                                          ┌──────────────────────┐
                                          │ GHCR                 │
                                          │ sha-<short7> · latest│
                                          └──────────┬───────────┘
   Raspberry Pi 5 (no inbound ports)                 │ pull
  ┌────────────────────────────────────────────────── │ ───────────────┐
  │  ┌──────────────────────┐                         │               │
  │  │ actions-runner       │<── long-poll GitHub ────┘               │
  │  │ (systemd, deploy.yml)│  backup → migrate → up -d → probe       │
  │  └──────────┬───────────┘                                         │
  │             v                                                     │
  │  ┌────────────────────────┐      ┌──────────────────────────┐     │
  │  │ app          :3000     │<─────│ cloudflared              │─────┼──> Cloudflare edge
  │  │ Fastify + static SPA   │      │ (named tunnel, outbound) │     │
  │  └──────────┬─────────────┘      └──────────────────────────┘     │
  │             v                                                     │
  │      /srv/finance/data/finance.db  (bind mount, WAL)              │
  │      /srv/finance/backups/*.db     → off-Pi nightly (rclone)      │
  └───────────────────────────────────────────────────────────────────┘
```

Nothing in this diagram requires an inbound connection to the Pi. Both the runner and `cloudflared` dial out and hold the connection open. That is the central property of the design.

### Tag and commit identity — defined once

`SHORT_SHA` is the **first 7 characters** of the commit SHA. From it:

- the image tag is `sha-$SHORT_SHA` (e.g. `sha-abc1234`),
- `IMAGE_TAG` in `/srv/finance/.env` holds that same string,
- the `commit` field in `HealthResponse` holds `$SHORT_SHA` (not the full SHA).

Every reference below uses exactly these. `latest` is also pushed for human convenience but **nothing deploys from it** — deploying by immutable short-SHA tag is what makes rollback meaningful.

### Delivery path (Decision 1: self-hosted runner)

A GitHub Actions self-hosted runner runs on the Pi as a systemd service (`actions.runner.*`) under a dedicated unprivileged `deploy` user that is a member of the `docker` group. Labels: `self-hosted, linux, ARM64, finance-pi`. It long-polls GitHub, so GitHub never initiates a connection to the Pi.

Two workflows, deliberately split:

| Workflow | Runs on | Trigger | Does |
|---|---|---|---|
| `ci.yml` | `ubuntu-24.04-arm` (GitHub-hosted) | `push`, `pull_request` | `npm ci` → `typecheck` → `lint` → `test` → `build`; then on `push` to `main` only, build and push the arm64 image to GHCR. **This extends the scaffold's CI workflow** — it is not unchanged: the runner label changes and the image steps are new. |
| `deploy.yml` | `self-hosted` on the Pi | `workflow_run` of `ci.yml` **completed successfully on `main`**, plus `workflow_dispatch` | Pull the image by tag, back up the DB, migrate, restart, health-probe, roll back on failure. |

`workflow_dispatch` inputs, required by Decision 8:

| Input | Type | Default | Purpose |
|---|---|---|---|
| `image_tag` | string | the current `IMAGE_TAG` | Which `sha-` tag to deploy. This is the manual rollback path. |
| `skip_migrate` | boolean | `false` | Set `true` for a rollback to an older tag, so the job does not re-run migrations against an already-migrated DB. |

**What `workflow_run` does and does not protect.** It means the Pi runner only ever executes a workflow definition taken from `main`, so a **fork** pull request cannot introduce a job that runs on the Pi. Combined with the repo setting *"Require approval for all external contributors"*, untrusted code cannot reach the Pi. It does **not** stop anyone with push access to the repository from committing a `runs-on: self-hosted` job — on a private single-collaborator repo that residual is acceptable, but it is a real limit and not a sandbox.

`deploy.yml` uses `concurrency: { group: deploy-production, cancel-in-progress: false }` so two merges in quick succession queue rather than interleave two migrations against one SQLite file.

### The artifact (Decision 2: one Docker image)

A single multi-stage image containing **both** the API and the built SPA:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci
COPY . .
RUN npm run build          # contracts, api (tsc), web (vite → apps/web/dist)

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/          # lockfile references this workspace;
COPY packages/contracts/package.json packages/contracts/   # npm ci fails without it
RUN npm ci --omit=dev --workspace apps/api --include-workspace-root

FROM node:22-bookworm-slim
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps  /app/node_modules      ./node_modules
COPY --from=build /app/apps/api/dist     ./apps/api/dist
COPY --from=build /app/apps/api/src/db/migrations ./apps/api/dist/db/migrations
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/web/dist     ./apps/web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
```

`ci.yml` passes `--build-arg GIT_SHA=$SHORT_SHA`; `config.ts` reads `GIT_SHA` and `health.service.ts` returns it as `HealthResponse.commit`.

Consequences worth naming:

- **Same-origin, so still no CORS.** The scaffold avoided CORS config because Vite proxied `/api` in dev. Serving the SPA from the API in production preserves that: one hostname, one origin. This is both the main reason for one image and a precondition for Decision 9's cookie.
- **`@fastify/static` is a new API dependency**, registered to serve `apps/web/dist` with an SPA fallback that rewrites unknown non-`/api` paths to `index.html`. The fallback must **not** swallow `/api/*` — a 404 on an API path must stay JSON, never HTML.
- **Migrations ship inside the image**, so the migration that runs is always the one built from the same commit as the code.
- **The Pi needs Docker and the `sqlite3` CLI** — no Node, no npm, no build toolchain (*P3*).

### Where the arm64 build happens (Decision 3)

`docker build` on a GitHub-hosted `ubuntu-24.04-arm` runner — natively arm64, so no `buildx --platform` and no QEMU. `npm ci` resolves the arm64 optional dependencies normally: `better-sqlite3`'s prebuilt `linux-arm64` binary and `@node-rs/argon2-linux-arm64-gnu`, neither of which compiles from source. GitHub-hosted arm64 runners are generally available; on private repos they are billed, but a Node build of this size is a few minutes.

GHCR is the registry (`ghcr.io/<owner>/finance-app`), authenticated with the workflow's built-in `GITHUB_TOKEN` and `packages: write`. On the Pi the same ephemeral token authenticates the pull, so **no long-lived registry credential is stored on the Pi**.

### Runtime on the Pi (Decision 4: Docker Compose)

`deploy/compose.yaml` is version-controlled in the repo and copied by the deploy job to `/srv/finance/compose.yaml`, which is the copy Compose actually runs.

| Service | Image | Notes |
|---|---|---|
| `app` | `ghcr.io/<owner>/finance-app:${IMAGE_TAG}` | `restart: unless-stopped`; published as `127.0.0.1:3000:3000` — bound to loopback, never `0.0.0.0`; `env_file: /srv/finance/app.env`; mounts `/srv/finance/data:/app/data`; healthcheck below |
| `cloudflared` | `cloudflare/cloudflared:latest` | `restart: unless-stopped`; `command: tunnel run`; credentials from `/srv/finance/cloudflared.env`; ingress maps the public hostname to `http://app:3000` over the Compose network |

The healthcheck cannot use `curl` — the final image is `node:22-bookworm-slim` and adding `curl` would violate the "no extra tooling" property test 5 asserts. It uses Node's own fetch:

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
```

`IMAGE_TAG` is read by Compose from `/srv/finance/.env`, which the deploy job **writes** before every `up -d`. That file is therefore the single source of truth for "what is deployed", which is what makes step 2 of the deploy job (recording the previous tag) well-defined.

If the tunnel currently runs as a host systemd service rather than a container, it can stay there with ingress pointing at `http://127.0.0.1:3000`; only the `cloudflared` row above changes. See Open Question 1.

**Fastify needs `trustProxy: true`.** Two distinct facts matter here: the **host** port is published only on `127.0.0.1`, so no other machine on the LAN can reach the app; and on the **Compose network** only `cloudflared` can reach container port 3000. Because `cloudflared` is the sole source of traffic, its `X-Forwarded-For` is trustworthy and `trustProxy` yields real client IPs. Without it every client IP is the tunnel's, which makes logs useless and would silently break any future app-level rate limiting.

### Deploy job steps (Decision 5 sequencing, Decision 10 failure policy)

```
 1. TAG=sha-$SHORT_SHA  (or inputs.image_tag on workflow_dispatch)
    docker login ghcr.io; docker pull ghcr.io/<owner>/finance-app:$TAG
 2. PREVIOUS_TAG=$(sed -n 's/^IMAGE_TAG=//p' /srv/finance/.env)
 3. Back up SQLite while the app is still running:
      sqlite3 /srv/finance/data/finance.db \
        ".backup '/srv/finance/backups/pre-$TAG-$(date -u +%Y%m%dT%H%M%SZ).db'"
    Prune backups older than 30 days.
    Backup failure ABORTS the deploy — the old container is still running and
    untouched, so the site stays up on the old commit.
 4. docker compose stop app          (cloudflared keeps running → brief 502s)
 5. unless inputs.skip_migrate:
      docker compose run --rm app node apps/api/dist/db/migrate.js
      On non-zero exit (Decision 10): DO NOT touch the database. Write
      IMAGE_TAG=$PREVIOUS_TAG, `up -d app`, probe it, then fail the job so the
      Actions failure notification fires. The DB may be partially migrated and
      only a human decides what happens next.
 6. Write IMAGE_TAG=$TAG to /srv/finance/.env; docker compose up -d app
 7. Poll http://127.0.0.1:3000/api/v1/health for up to 60s, requiring 200 with
      {"status":"ok","db":"ok","version":"<pkg version>","commit":"$SHORT_SHA"}
    The commit check is what proves the new image is live rather than a stale
    container answering.
 8. On probe failure: write IMAGE_TAG=$PREVIOUS_TAG, `up -d app`, re-probe,
    fail the job. The job never exits leaving nothing running.
 9. docker image prune, retaining the current and previous two tags.
```

Every exit path from steps 3–8 ends with a **running** container — either the new tag or `PREVIOUS_TAG`. Nothing is left in `stopped` state, which is what lets `restart: unless-stopped` guarantee the app returns after a reboot.

`.backup` is used rather than `cp` because the database runs in WAL mode — copying the `.db` file alone while a writer is active yields a torn snapshot missing the `-wal` contents. (`VACUUM INTO` is equally correct and also compacts.)

### Off-Pi backups (Decision 11)

*P6* means an on-disk backup does not survive the failure mode that actually kills Raspberry Pis, which is storage death. A nightly systemd timer runs `rclone copy /srv/finance/backups <remote>`, **independent of deploys** — it is the one piece of this design that is not GitHub Actions and not triggered by a deploy. The destination is Decision 11.

### Secrets (Decision 6: on the Pi, not in GitHub)

| Value | Lives in | Notes |
|---|---|---|
| `JWT_SECRET` (secret), `DB_PATH`, `PORT`, `LOG_LEVEL`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | `/srv/finance/app.env`, owned `deploy:deploy`, mode `0600` | `NODE_ENV` is deliberately **absent** — it is fixed to `production` in the Dockerfile, and duplicating it in the env file would give test 19's guarantee two sources of truth. |
| Cloudflare tunnel credentials (secret) | `/srv/finance/cloudflared.env`, mode `0600` | Same ownership. |
| GHCR pull credential | Not stored — the job's ephemeral `GITHUB_TOKEN` | Nothing long-lived on disk. |
| Runner registration token | Consumed once at install; the runner keeps `.credentials` | Standard. |

There are exactly **two secret values** here: `JWT_SECRET` and the tunnel credentials. Neither is held in GitHub, so there is no SSH key, no Cloudflare service token and no registry PAT in GitHub to steal.

**Honest scoping of the claim.** The env file is owned by the `deploy` user because Compose — running as that user — must read `env_file` to start the container. So the deploy job's user *can* read `JWT_SECRET`; what it never does is transport it. The secret is never in GitHub, never in a job log, never in the image, and never in a workflow input. Rotation is a manual edit plus `docker compose up -d app`, which is appropriate for a value that invalidates every session. The env file needs its own offline copy, since it is the one piece of state `rclone` does not cover.

### Ingress and access control (Decision 7: **Accepted**, browser-first)

- Cloudflare DNS → tunnel → `app:3000`. TLS terminated at the edge and **Always Use HTTPS enabled on the zone**, so plain-HTTP requests are redirected before Access sees them (D3 resolved).
- **Cloudflare Access** (Zero Trust) policy on the hostname, allowing only your own email, with `/api/v1/health` bypassed so external probes work. This is defence in depth, not a replacement for the app's JWT auth — but an attacker must pass Access *before* reaching `/api/v1/auth/login` at all.
- **Cloudflare rate limiting** on the path `/api/v1/auth/*` — e.g. 10 requests/minute per IP — resolving D2 at the edge with no app change. Note the full path prefix: a rule written as `/auth/*` would match nothing, since every route is under `/api/v1`.
- `/api/v1/docs` stays 404 because `NODE_ENV=production` (scaffold test case 9 already covers this).

**Accepted as browser-first, with the exit documented.** Mobile is "maybe" — so Access is right now, and the migration path if a native client arrives is: drop the Access policy for `/api/v1/*`, and move rate limiting from the Cloudflare edge into the app (`@fastify/rate-limit`) so D2 stays resolved once the edge is no longer gating auth. Recorded here rather than in an ADR, so that a successor decision inherits the reasoning and not just the outcome.

### Refresh-token transport (Decision 9: **Accepted**)

Resolving D1. The refresh token moves out of `localStorage`:

- **Browser (default).** `POST /api/v1/auth/login` sets the refresh token as a cookie: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. `Secure` is correct even though the app speaks plain HTTP on loopback, because the browser only ever sees the HTTPS origin. `refresh` and `logout` read the cookie; `logout` clears it. The access token stays in memory only, exactly as the scaffold specifies. `SameSite=Strict` plus POST-only auth routes covers CSRF without a token-pairing scheme.
- **Non-browser (opt-in).** A client sending `X-Refresh-Transport: body` gets `refreshToken` in the JSON response body and may present it in the request body instead. This is what keeps the scaffold's stated requirement — *"the backend must not assume a browser (no cookie-only auth path…)"* — true. Decision 9 makes the cookie the **default**, not the only path, and that distinction is the whole reason the scaffold's design goal survives.
- Rotation, replay detection and the mandatory single-flight refresh lock are all unchanged. The lock still matters: rotation is what makes concurrent refreshes dangerous, and that is independent of how the token travels.

This revisits **ADR 0001** and touches the scaffold's problem-statement item 1. If approved it would supersede the refresh-token *storage* portion of 0001 only — the two-token design, 15-minute access TTL, rotation and replay detection all stand.

### Scaffold-touching changes (collected)

Deploying requires these app changes. Listing them together so none is smuggled in as a deployment detail:

| # | Change | Touches |
|---|---|---|
| 1 | `HealthResponse` gains `commit: string` (from `GIT_SHA`) | `@finance/contracts`, `config.ts`, `health.service.ts` — contract change |
| 2 | `@fastify/static` serving `apps/web/dist` with an SPA fallback that excludes `/api/*` | `apps/api` deps, new plugin |
| 3 | `trustProxy: true` in `buildServer()` | `server.ts` |
| 4 | Refresh token via `HttpOnly` cookie by default, body transport opt-in; `LoginResponse.refreshToken` becomes optional | `@finance/contracts`, `auth.routes.ts`, `apps/web/src/api/*` — revisits ADR 0001 |
| 5 | *Optional:* map Fastify's default not-found response onto the `ErrorResponse` envelope with `NOT_FOUND`, which the scaffold defines but leaves unreachable | `plugins/errorHandler.ts`. Test 20 asserts only "JSON, not HTML", so this is not required by this spec. |
| 6 | `ci.yml` extended: `ubuntu-24.04-arm` label, image build and push | `.github/workflows/ci.yml` |

### What this spec does *not* do

No staging environment · no blue/green or zero-downtime deploy (*P4*) · no Postgres migration · no automated restore drill · no monitoring or alerting beyond the health endpoint and GitHub's own job-failure notification · no log shipping off the Pi · no Pi OS patching automation.

## Tradeoffs

### Decision 1: How does GitHub Actions reach the Pi? — **Proposed** (gate *P1* satisfied)

| Approach | Pros | Cons |
|---|---|---|
| **Self-hosted runner on the Pi (proposed)** | No inbound ports and no SSH anywhere; no deploy credentials in GitHub at all; full shell on the Pi, so backup/migrate/rollback are ordinary script steps | A GitHub-controlled agent runs on your home network; unsafe on a public repo, so *P1* must hold; the runner is another daemon to keep updated; consumes Pi CPU/RAM; does not sandbox collaborators with push access |
| SSH over the Cloudflare Tunnel (`cloudflared access ssh`) | Keeps the Pi free of GitHub agents; reuses the tunnel you already have; conventional `ssh` deploy scripts | Needs an SSH route through the tunnel plus a Cloudflare service token *and* an SSH key in GitHub secrets — two long-lived credentials created specifically to let the internet in; Access-for-SSH setup is fiddly |
| Pull-based poller on the Pi (systemd timer checking GHCR for a new digest) | Simplest security story — nothing from GitHub executes on the Pi; trivially auditable; survives GitHub outages | Deploy is invisible in Actions (no logs, no pass/fail, no rollback reporting); backup-before-migrate ordering must be duplicated in a shell script on the Pi; "deployed via GitHub Actions" becomes half true |
| Tailscale (or WireGuard) + SSH from a hosted runner | Well-trodden; `tailscale/github-action` is mature; keeps the Cloudflare tunnel purely for app traffic | A second overlay network to run when one already solves connectivity; still needs an SSH key and a Tailscale auth key in GitHub secrets |

**Proposed:** self-hosted runner — the only option needing **zero** long-lived credentials in GitHub and zero new inbound paths, while keeping deploy logs, exit codes and rollback visible in Actions.

### Decision 2: Artifact format — **Proposed**

| Approach | Pros | Cons |
|---|---|---|
| **Single Docker image, API serves the SPA (proposed)** | Immutable and content-addressed, so rollback is a tag change; native-module binaries resolved once at build time, never on the Pi; same-origin keeps the no-CORS property *and* enables Decision 9's cookie; the Pi needs only Docker and `sqlite3` | Docker costs ~50–100 MB RAM and a layer of indirection; couples API and SPA release cadence; larger pulls over a home connection |
| Two images (API + nginx/Caddy for the SPA) | Independent cadence; a purpose-built static server | Two artifacts, two tags, two rollbacks; reintroduces the cross-origin question the scaffold avoided, which would also break `SameSite=Strict`; no benefit at this scale |
| `git pull` + `npm ci` + `npm run build` on the Pi | No registry, no Docker; smallest conceptual footprint | Builds on the Pi are slow and can fail *after* the old version is stopped; `npm ci` needs network mid-deploy; no atomic rollback; a full dev toolchain accumulates on the production host |
| Tarball of build output + `rsync`, run under systemd | Lightweight; no Docker; fast transfers | `node_modules` with arm64 native binaries must still come from somewhere; no isolation; rollback means hand-rolled release directories and symlink swapping |
| SPA to Cloudflare Pages, API only on the Pi | Static assets from the edge; Pi serves only JSON | Two deploy targets and two origins → CORS returns and the cookie gets harder; the SPA can ship a version the API does not match; edge-cached HTML plus a rolled-back API is a real skew hazard |

**Proposed:** single image — atomic rollback plus the same-origin property (which Decision 9 now depends on) outweigh independent cadence.

### Decision 3: Where the arm64 image is built — **Proposed**

| Approach | Pros | Cons |
|---|---|---|
| **GitHub-hosted arm64 runner (`ubuntu-24.04-arm`) (proposed)** | Native arm64, so no QEMU and no emulated native-module compiles; fast; build load stays off the Pi; prebuilt `better-sqlite3`/`@node-rs/argon2` arm64 binaries resolve normally | Billed minutes on private repos; one more runner label to keep straight |
| `buildx` + QEMU on `ubuntu-latest` (x86) | Works on any runner; multi-arch in one job | Emulation is slow, and very slow if a native module falls back to source compilation; a class of QEMU-specific build failures that are painful to debug |
| Build natively on the Pi's self-hosted runner | Truly native; no extra cost | Pi 5 build times are minutes; thrashes storage; competes with the running app for RAM; a failed build now happens on the production host |
| Cross-build x86 → arm64 without emulation | Fastest; the JS build is architecture-independent anyway | Fragile: works only while *every* native dep ships an arm64 prebuild, and that approach breaks silently the day one does not |

**Proposed:** GitHub-hosted arm64 runner — the simplest thing that is also correct, and it keeps build failures away from the production host.

### Decision 4: Runtime supervision on the Pi — **Proposed**

| Approach | Pros | Cons |
|---|---|---|
| **Docker Compose, `restart: unless-stopped` (proposed)** | App and `cloudflared` in one version-controlled file; tag swap + `up -d` is the whole deploy; restart-on-boot and healthchecks built in; isolated from the host's Node version | Docker overhead on the Pi (acceptable, not free); bind-mount UID friction with the SQLite file; another subsystem to update |
| systemd unit running `node` directly | Lowest overhead; journald logs; no Docker | Needs the right Node and arm64 native modules on the host; no isolation; manual rollback; host Node upgrades can break `better-sqlite3` silently |
| Kubernetes (k3s) | Declarative; real rollout/rollback primitives | Wildly disproportionate for one container and one SQLite file on one host |
| PM2 | Simple process management, restarts, log rotation | Another supervisor alongside systemd; weaker isolation than Docker; largely redundant once Compose is present |

**Proposed:** Docker Compose — it pairs naturally with the image from Decision 2 and puts `cloudflared` under the same lifecycle.

### Decision 5: Migration sequencing — **Proposed**

| Approach | Pros | Cons |
|---|---|---|
| **Backup → stop app → one-shot migrate → start new → health-gate (proposed)** | No writer is active during the migration, so no lock contention or partial-write risk; a recoverable snapshot exists before any schema change; the health gate means a broken deploy does not sit silently broken | Deliberate downtime of up to ~2 minutes (fine under *P4*); the failed-migration case still needs a policy, which is Decision 10 |
| Migrate on app startup (inside `index.ts`) | One fewer step; schema never out of sync with code | A migration failure becomes a crash loop; concurrent starts could race; muddies the scaffold's deliberate split between fatal config errors and non-fatal DB unavailability |
| Migrate without stopping the app | Near-zero downtime | Old code runs against a new schema for the overlap window; with one SQLite file and a WAL writer this invites `SQLITE_BUSY` and subtle breakage for no real benefit |
| Manual migration over SSH, deploy code only | Maximum control over risky migrations | Defeats automation; guarantees the day you forget; the schema/code skew window becomes human-sized |

**Proposed:** backup → stop → migrate → start → probe. Under *P4*, a couple of minutes of downtime is the cheapest correctness available.

### Decision 6: Secret management — **Proposed**

| Approach | Pros | Cons |
|---|---|---|
| **Env file on the Pi, mode 0600, never transported by CI (proposed)** | CI never carries production secrets, so they cannot leak via logs, inputs or the image; trivial to reason about | Rotation is a manual step; no audit trail; the deploy user can read the file (Compose requires it); the file needs its own offline copy since `rclone` does not cover it |
| GitHub Secrets → written to the Pi by the deploy job | Rotation is a UI edit plus a redeploy; one place to look | Every deploy handles live secrets; a buggy or malicious workflow can exfiltrate them; strictly worse given the runner is already on the Pi |
| A real secret manager (Infisical, Vault, 1Password Connect) | Audit trail, rotation, versioning | Substantial operational weight and a new network dependency at app boot, for two secret values |
| SOPS/age-encrypted secrets in the repo | Version-controlled, reviewable diffs, decrypt on the Pi | The age private key still lives on the Pi unencrypted, so the trust boundary is unchanged while the machinery grows |

**Proposed:** env file on the Pi. Putting secrets *through* GitHub adds exposure and buys nothing once the runner is on the box.

### Decision 7: Ingress and access control — **Accepted** (browser-first)

| Approach | Pros | Cons |
|---|---|---|
| **Cloudflare Access + edge rate limiting on `/api/v1/auth/*` (accepted)** | Anonymous internet traffic cannot reach the login endpoint at all; resolves D2 with no app change; the Argon2 CPU-exhaustion risk largely disappears | Access is browser-oriented, so a future native client needs the documented exit path; an extra login hop on each new device; a Cloudflare outage locks you out too |
| Public hostname, app JWT auth only | Simplest; any client works; no second identity system | `/api/v1/auth/login` internet-exposed with no rate limit until app-level limiting is built |
| Access with a service-token bypass for `/api/*` | Browser gets Access; programmatic clients get a token | The bypass is exactly the surface Access was protecting; a leaked service token reopens the login endpoint |
| VPN-only (Tailscale/WireGuard), no tunnel exposure | Smallest attack surface by a wide margin; no public hostname | Every device needs the VPN client, which is real friction on a phone; discards the existing tunnel; "reachable from my phone" gets meaningfully worse |

**Accepted:** Cloudflare Access + edge rate limiting, chosen as the browser-first answer given mobile is undecided. Exit path if a native client arrives is specified above.

### Decision 8: Rollback strategy — **Proposed**

| Approach | Pros | Cons |
|---|---|---|
| **Redeploy the previous tag automatically on failed health probe, plus `workflow_dispatch` with `image_tag`/`skip_migrate` (proposed)** | Fast and scripted for the common "new build is broken" case; the previous two tags stay on the Pi so rollback needs no network; the manual path handles arbitrary tags | Does **not** roll back the database — a forward-incompatible migration can leave the old image unable to read the new schema, so code rollback alone is sometimes insufficient |
| Manual rollback only | Deliberate; a human assesses data implications first | The app is down while you notice, find the tag and trigger the job |
| Roll back code *and* restore the pre-deploy DB backup | Truly returns to the last known-good state | Silently discards every write after the backup — for a ledger, losing transactions is worse than being down, so this must never be automatic |
| Fix forward only | Simplest; no rollback path to keep working | Unacceptable when the failure mode is "the only instance of the only app is down" |

**Proposed:** automatic code-only rollback on probe failure, plus the manual dispatch path. DB restore stays strictly manual, always.

### Decision 9: Refresh-token transport (resolves D1) — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **`HttpOnly; Secure; SameSite=Strict` cookie by default, body transport opt-in via header (accepted)** | XSS can no longer read the refresh token, which is the actual D1 risk; same-origin (Decision 2) makes it work with no CORS or CSRF-token machinery; preserves the scaffold's "no cookie-only auth path" requirement because body transport still exists | Revisits ADR 0001; two transports to implement and test; `SameSite=Strict` now depends on the SPA and API sharing an origin, coupling Decision 9 to Decision 2 |
| Keep `localStorage`, rely on Cloudflare Access | No code change | Leaves D1 unresolved against the scaffold's explicit prerequisite; any XSS in the SPA yields a token valid for `REFRESH_TOKEN_TTL` |
| In-memory only, no persistence | Simplest and safest; nothing to steal at rest | Re-login on every page load and every new tab — unusable on a phone |
| Cookie-only, no body transport | Least code | Breaks the scaffold's problem-statement item 1 and forecloses a native client, which is exactly the option mobile-being-undecided says to keep |

**Accepted:** cookie by default, body transport opt-in — superseding the storage portion of ADR 0001.

### Decision 10: Failed-migration policy — **Accepted**

| Approach | Pros | Cons |
|---|---|---|
| **Leave the DB untouched, restart the previous image, fail the job loudly (accepted)** | Zero data loss; the DB state at the moment of failure is preserved for diagnosis; the site comes back up rather than staying dark | The app may be **up but broken** if the partial migration is incompatible with the old code — an unhealthy state that looks healthy from outside |
| Fail closed — stop everything and refuse to serve | No chance of old code writing against a half-migrated schema | The app is simply down until a human intervenes, with no read access to your own data |
| Auto-restore the pre-deploy backup | Returns to a known-good DB automatically | Silently discards writes between backup and failure — unacceptable for a ledger |
| Leave the new image running and retry the migration | Might self-heal on a transient failure | Retrying a failed migration against a partially migrated DB is how a recoverable problem becomes an unrecoverable one |

**Accepted:** leave the DB untouched, restart `PREVIOUS_TAG`, fail the job. The "up but broken" risk is accepted deliberately, on the grounds that reaching your own data matters more than failing closed.

### Decision 11: Off-Pi backup destination — **Proposed**

| Approach | Pros | Cons |
|---|---|---|
| **Cloudflare R2 via `rclone` (proposed)** | No egress fees; you already have a Cloudflare account, so no new vendor; S3-compatible, so `rclone` config is standard | A new API token to create and store on the Pi; concentrates app ingress *and* backups with one provider |
| Any S3-compatible bucket (AWS, Backblaze B2) | Mature, cheap, well-understood; provider diversity from Cloudflare | Another account and bill; AWS egress costs money on restore |
| A NAS or second machine on the LAN | No cloud, no cost, fast restores | Does not survive fire/theft/flood — the correlated failures that matter most for a single-site backup |
| Nightly `restic` to a cloud remote instead of raw `.db` copies | Deduplicated, encrypted, versioned, with pruning built in | More machinery than copying a file that is already a consistent snapshot; restore requires `restic` to be available |

**Proposed:** R2 via `rclone`. Confirm or redirect — see Open Question 3.

## Open Questions

1. **Existing `cloudflared`.** Host systemd service or already containerised? Decides whether Decision 4 touches your tunnel setup at all.
2. **Alerting.** Decision 10 relies on "fail the job loudly", which today means GitHub's default job-failure email. Is that enough, or do you want a push notification (ntfy, Pushover) from the failure path?
3. **Backup destination.** Confirm R2, or name a different target (Decision 11).
4. **Scaffold change 5.** Do you want Fastify's default 404 normalised into the `ErrorResponse` envelope with `NOT_FOUND`? Not required by this spec; it would make the scaffold's defined-but-unreachable `NOT_FOUND` code reachable.

## Decisions

**No ADRs have been written for this spec.** Decisions 7, 9 and 10 are Accepted in the Tradeoffs above, but recording them is held until **Decision 1** is settled — Decision 1 determines whether this is a GitHub Actions deployment at all, and Decisions 2–6 and 8 largely follow from it. Writing ADRs before that risks recording decisions that a different trigger mechanism would reopen.

Decision 9 (refresh-token transport) is the exception in principle: it is an application-level decision that holds regardless of how the deploy is triggered, so it could be recorded on its own once you want it written down.

When ADRs are written they will be numbered in **approval order**, deliberately offset from the Tradeoffs numbering above — match by subject, not number (the same convention the scaffold uses).

| Decision | Subject | Status |
|-----|----------|--------|
| 7 | Ingress and access control | Accepted — not yet recorded |
| 9 | Refresh-token transport | Accepted — not yet recorded |
| 10 | Failed-migration policy | Accepted — not yet recorded |
| 1, 2, 3, 4, 5, 6, 8, 11 | Trigger, artifact, build host, supervision, migration sequencing, secrets, rollback, backup target | Proposed |

## Test Cases

Acceptance criteria for the deployment, not the app.

| # | Scenario | Input / Precondition | Expected Outcome |
|---|---|---|---|
| 1 | Merge to `main` deploys automatically | Push a commit changing a visible string; `ci.yml` passes | `deploy.yml` starts on the Pi runner within a minute of `ci.yml` completing; job succeeds; `https://finance.example.com` serves the new string with no manual step |
| 2 | Failing CI does not deploy | Push a commit that breaks a unit test | `ci.yml` fails; no image is pushed to GHCR; `deploy.yml` never triggers; the previously deployed container is still running and healthy |
| 3 | Untrusted workflow code cannot reach the Pi | Open a pull request from a fork that adds a `runs-on: self-hosted` job | The job requires approval and never runs; the Pi runner's journal shows no jobs for that PR. **Documented residual:** a collaborator with push access *can* target the Pi; `workflow_run` is not a sandbox against trusted authors |
| 4 | The image really is arm64 | `docker image inspect ghcr.io/<owner>/finance-app:sha-<short7>` on the Pi | `Architecture: arm64`, `Os: linux`; the container starts without `exec format error` |
| 5 | Native modules work, with no toolchain shipped | In the running container, `require('better-sqlite3')` and hash a password via `@node-rs/argon2` | Both succeed; `gcc`, `python3`, `node-gyp` and `curl` are all absent from the final image |
| 6 | Health endpoint reports the deployed commit | Deploy `sha-abc1234`, then `GET /api/v1/health` | 200 with `{"status":"ok","db":"ok","version":"<apps/api package version>","commit":"abc1234"}` — `commit` is the 7-char short SHA and matches the tag deployed |
| 7 | Deploy is gated on a real health check | Deploy an image built from a commit that throws during `buildServer()` (`app.env` left valid and unchanged) | The probe never sees 200; the job fails; `IMAGE_TAG` is rewritten to the previous tag; that container starts and passes its own probe; the site serves the old commit within 2 minutes |
| 8 | Manual rollback restores the previous commit | `workflow_dispatch` with `image_tag=<prior sha- tag>` and `skip_migrate=true` | Job succeeds; `/api/v1/health` reports the prior commit; **no migration runs**; `__drizzle_migrations` is unchanged and the `users` and `refresh_tokens` row counts are unchanged |
| 9 | A pre-deploy backup exists and is valid | Deploy any commit | A new `/srv/finance/backups/pre-sha-<short7>-<ts>.db` exists; `sqlite3 <file> "PRAGMA integrity_check"` returns `ok`; its `users` row count equals the live DB's count before the deploy |
| 10 | Backup failure aborts the deploy | Make `/srv/finance/backups` unwritable, then merge | The job fails at step 3; **no migration runs and the app is never stopped**; `/api/v1/health` still reports the old commit throughout |
| 11 | Migrations are applied exactly once | Deploy a commit adding a new table, then re-run `deploy.yml` on the same SHA with `skip_migrate=false` | First deploy creates the table; the second applies nothing and exits 0; `__drizzle_migrations` gains exactly one row across both runs |
| 12 | Data survives deployment | Create a user and obtain a refresh cookie; deploy a new commit | After the deploy the user row is unchanged, `GET /api/v1/me` with an unexpired access token still works, and `POST /api/v1/auth/refresh` with the existing cookie still rotates successfully |
| 13 | Failed migration leaves the DB untouched and the app running | Deploy a commit whose migration SQL is deliberately invalid | The job fails; the previous tag is running and healthy; `__drizzle_migrations` and all table contents are identical to their pre-deploy values; a GitHub job-failure notification is received |
| 14 | The app survives a Pi reboot | `sudo reboot` after a successful deploy | Within 2 minutes and with no human action, `app` and `cloudflared` are `running`, `/api/v1/health` is 200, and the public hostname serves the SPA |
| 15 | No inbound port is open on the Pi | `nmap` the Pi's LAN IP from another host; check the router's port-forward table | Port 3000 is not reachable (published on `127.0.0.1` only); no forwarding rules exist for the Pi |
| 16 | Traffic only arrives via the tunnel | Stop the `cloudflared` container | The public hostname returns a Cloudflare 1033/error page; the app container is still healthy on loopback — the tunnel is the sole ingress |
| 17 | TLS is enforced end to end | `curl -v http://finance.example.com` | A 301 to `https://` from Cloudflare's *Always Use HTTPS* (before Access is evaluated); the certificate is Cloudflare's and valid; no certificate material exists anywhere on the Pi |
| 18 | Cloudflare Access blocks anonymous access | In a clean browser profile with no session, request the hostname and `POST /api/v1/auth/login` | Both are intercepted by the Access login screen; the login request never reaches Fastify (no entry in the app log). `GET /api/v1/health` is the one bypassed path and still returns 200 |
| 19 | Auth rate limiting bites | 30 `POST /api/v1/auth/login` requests in 60s from one IP, with Access satisfied | Requests past the threshold get a Cloudflare 429; the app's CPU does not saturate; requests from a different IP still succeed |
| 20 | Swagger UI stays off in production | `GET /api/v1/docs` against the deployed instance | 404, because `NODE_ENV=production` comes from the image and is not overridable via `app.env` — the same guarantee as scaffold test case 9, now verified against the real deployment |
| 21 | SPA deep links work without swallowing API paths | Load `https://finance.example.com/accounts/123`, then `GET /api/v1/nope` | The first returns `index.html` with 200 and the SPA routes client-side; the second returns a **JSON** 404, never `index.html` |
| 22 | Refresh token is not reachable from JavaScript | After login in the browser, read `document.cookie` and `localStorage` | Neither contains the refresh token; the `Set-Cookie` response carries `HttpOnly`, `Secure`, `SameSite=Strict` and `Path=/api/v1/auth`; `POST /api/v1/auth/refresh` still succeeds with no body |
| 23 | The non-browser transport still works | `POST /api/v1/auth/login` with `X-Refresh-Transport: body`, then refresh using the body value | Login returns `refreshToken` in the JSON body; refresh with it in the request body rotates normally — proving the API has no cookie-only auth path |
| 24 | Secrets are not in CI | Grep the full `deploy.yml` job log; list repository secrets | `JWT_SECRET` and the tunnel credentials appear nowhere in the logs; no repository secret holds either value; `app.env` and `cloudflared.env` are `0600` owned by `deploy` |
| 25 | Concurrent merges do not interleave | Merge two commits within seconds | Two `deploy.yml` runs execute strictly in sequence; only one migration process ever touches the DB; `IMAGE_TAG` and the live `commit` both end at the later SHA |
| 26 | Client IPs are real | Make a request through the tunnel, then inspect the app log | The logged client IP is the actual client, not the `cloudflared` container's address — confirming `trustProxy` |
| 27 | Backups leave the Pi | Trigger the nightly timer | The latest backup appears in the off-Pi destination; restoring it into a scratch file gives `integrity_check = ok` and the expected tables |
