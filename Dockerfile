# syntax=docker/dockerfile:1
#
# Two images, one file:
#   --target api  -> Node 22 + Fastify, serves /api/v1/* on :3000
#   --target web  -> nginx, serves the built SPA and proxies /api to the api container
#
# ## Why `node:22-bookworm-slim` and not Alpine
# Both native dependencies ship glibc AND musl prebuilds for arm64
# (`better-sqlite3` carries `prebuilds/linux-arm64.node` inside its tarball;
# `@node-rs/argon2` resolves `@node-rs/argon2-linux-arm64-gnu` from the lockfile),
# so Alpine would also work. Debian slim removes the question entirely, and there
# is no compiler toolchain in any stage — if a build ever starts invoking node-gyp,
# that is the signal that a prebuild is missing, not a reason to add build-essential.
#
# ## Raspberry Pi: 64-bit OS required
# `better-sqlite3@13` has NO `linux-arm` (armv7l) prebuild. On 32-bit Raspberry Pi
# OS this image fails to install. `uname -m` must print `aarch64`.
#
#
# ## Why every `npm ci` passes `--ignore-scripts`
# `better-sqlite3` is `hasInstallScript: true` in the lockfile because it ships a
# `binding.gyp`, so npm invokes node-gyp on install. That build is a **no-op** —
# `binding.gyp` shells out to `lib/binding.js`, which reports that a prebuild
# exists, and nothing is compiled (on a dev machine you get only `.stamp` files in
# `build/Release`, no `.node`). But node-gyp still has to *run*, and it needs
# python3, which this image does not ship. So the install script fails on a
# package that had nothing to do. Skipping scripts is correct rather than merely
# expedient: at run time `lib/binding.js` resolves
# `prebuilds/linux-arm64.node` directly, and no other dependency in the runtime
# or build closure needs an install hook (`@node-rs/argon2` and `rolldown`
# distribute their binaries as platform optionalDependencies). The alternative —
# adding python3 and build-essential — would add a toolchain to every layer to
# service a build that does nothing.
#
# ## `.npmrc` is copied deliberately
# It pins `registry=https://registry.npmjs.org`, which is what lets `npm ci` run in
# a container with no AWS CodeArtifact token. Do not remove it from the COPY lines
# or add it to `.dockerignore`.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine

# ------------------------------------------------------------------ #
# deps — manifests only, so this layer caches across every source edit
# ------------------------------------------------------------------ #
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --ignore-scripts

# ------------------------------------------------------------------ #
# build — contracts first: both apps import it, and `apps/web`'s own
# `prebuild` hook would otherwise rebuild it redundantly.
# `apps/api`'s build script also copies `src/db/migrations` into
# `dist/db/migrations`; without that, `node dist/db/migrate.js` would apply
# nothing, because tsc does not emit `.sql`.
# ------------------------------------------------------------------ #
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build --workspace @finance/contracts \
 && npm run build --workspace @finance/api \
 && npm run build --workspace @finance/web

# ------------------------------------------------------------------ #
# api — runtime image
# ------------------------------------------------------------------ #
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production

WORKDIR /app

# All three workspace manifests are copied even though only the API runs here:
# `npm ci` validates the lockfile against every workspace it declares and fails
# if one is missing. `--omit=dev` then drops the whole build toolchain, and the
# few extra prod deps belonging to `apps/web` (react et al.) are inert weight in
# exchange for an `npm ci` invocation with no workspace flags to get wrong.
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --omit=dev --ignore-scripts

# Compiled output only. `packages/contracts` is consumed through the workspace
# symlink npm ci just created, whose `import` condition resolves to ./dist.
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/dist apps/api/dist

# The mount point for the SQLite volume. Creating it here with `node` ownership
# is what makes a *fresh named volume* writable by the unprivileged user: Docker
# seeds a new volume from the image directory, ownership included. Skip this and
# the volume arrives root-owned and /api/v1/health reports db "unavailable".
RUN mkdir -p /data && chown node:node /data

USER node
WORKDIR /app/apps/api
EXPOSE 3000

# `node dist/index.js` directly — NOT via npm. The npm scripts pass
# `--env-file-if-exists=../../.env`, which does not apply here: configuration
# comes from the container environment (compose `env_file` / `environment`).
# See docs/gotchas.md, "invoking the entry point directly".
CMD ["node", "dist/index.js"]

# ------------------------------------------------------------------ #
# web — nginx serving the SPA bundle
# ------------------------------------------------------------------ #
FROM ${NGINX_IMAGE} AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
