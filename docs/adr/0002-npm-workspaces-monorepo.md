# 0002. npm workspaces monorepo

Date: 2026-09-20

## Status

Accepted

## Context

The finance tracker consists of a Node/TypeScript HTTP API, a browser frontend, and a body of request/response type definitions that both must agree on. The API is intended to be deployable on its own later, since cloud hosting is a stated goal.

The dominant failure mode in a split frontend/backend project is contract drift: the server changes a field name and the client finds out at runtime, in production. Preventing that class of bug is one of the scaffold's explicit purposes, which makes the placement of shared code a structural decision rather than a packaging preference.

This is a single-developer project, so ceremony that exists to coordinate multiple teams is a cost with no corresponding benefit.

## Approaches Considered

### Option A: Single Git repository using npm workspaces

Root `package.json` declaring `apps/api`, `apps/web`, and `packages/contracts` as workspaces.

**Pros:**
- A shared `contracts` workspace gives genuine compile-time type safety across the frontend/backend boundary.
- One `npm install`, one lockfile, one CI pipeline.
- A change spanning API and web lands in a single atomic commit, so the two never disagree at any commit.
- Each workspace keeps its own dependency list, so `apps/api` still builds and deploys alone.

**Cons:**
- More configuration than a single flat package (root scripts, path aliases, project references).
- Occasional friction between workspace symlinks and bundler resolution.

### Option B: Two sibling Git repositories

Separate repositories for API and web, with shared types published as a package or duplicated.

**Pros:**
- Hard deploy boundaries and independent version histories.
- Each repository stays small and focused.

**Cons:**
- Shared types must be published and version-bumped to be consumed, or they drift — reintroducing exactly the bug class being designed out.
- Tooling, linting, and CI configuration duplicated and kept in sync by hand.
- A cross-cutting change becomes two PRs with an ordering dependency; significant friction for one developer.

### Option C: Single flat package with `src/server` and `src/client`

One `package.json` and one dependency tree for everything.

**Pros:**
- Simplest possible configuration; nothing to learn.
- Type sharing is trivial — just an import.

**Cons:**
- No dependency isolation: React and Vite sit in the same manifest as the API, so a server deployment installs frontend build tooling.
- No enforceable boundary preventing frontend code from importing the database layer directly, which would break the standalone-API goal.
- Cannot build or ship the API independently without custom tooling.

## Decision

Adopt **Option A**: one Git repository using npm workspaces, with `apps/api`, `apps/web`, and `packages/contracts`.

`packages/contracts` (`@finance/contracts`) holds Zod schemas and the types inferred from them, and is the sole source of request/response shapes for both applications. Root scripts (`dev`, `build`, `typecheck`, `lint`, `test`) delegate to the workspaces. CI runs once over the whole repository.

## Consequences

- **Positive:** Renaming a contract field fails typechecking in both applications immediately, which is the primary outcome sought. One install and one CI pipeline. Cross-cutting changes are atomic. The API remains independently buildable for later cloud deployment.
- **Negative:** Root-level workspace, TypeScript path, and build configuration to maintain. Workspace symlinks occasionally need bundler-specific handling.
- **Neutral:** A future mobile client could be added as a fourth workspace, or live in its own repository and consume the generated OpenAPI document instead. This decision does not force either path.
