# 0007. React + Vite SPA for the frontend

Date: 2026-09-20

## Status

Accepted

## Context

The frontend is a private, authenticated finance dashboard. It has no public pages, so search-engine optimisation and server-side rendering have no value here. First-paint performance matters only mildly, since it is a tool used by one person.

The constraint that actually shapes this decision is structural. The Node backend is meant to be a standalone API, and the intent is that the web client consumes exactly the same public HTTP surface any other client would. A framework that makes it easy and idiomatic to reach the database directly from server-side code would quietly erode that property: the API would stop being the single source of truth, and the web app would exercise code paths no other client could.

Whether a native mobile client is ever built is undecided, so affinity with React Native is no longer part of the argument — a consideration that would otherwise have favoured React.

## Approaches Considered

### Option A: React + Vite single-page application

**Pros:**
- A pure HTTP client with no server-side runtime, so the public API is structurally the only data path.
- Very fast dev server and HMR.
- The largest ecosystem for the component and charting work a finance dashboard needs.
- Composes cleanly with the shared `@finance/contracts` package.

**Cons:**
- No SSR (irrelevant for this application).
- Routing, data fetching, and caching must be assembled from libraries rather than provided.

### Option B: Next.js

**Pros:**
- Batteries included: file-based routing, server components, image handling, a mature deployment story.
- Server-side rendering and streaming available if ever needed.

**Cons:**
- Server components and route handlers make direct database access the path of least resistance, which would undermine the standalone-API goal.
- Substantially heavier, with a more complex mental model for a single-user dashboard.
- Much of its value lies in SSR and SEO, neither of which applies here.

### Option C: SvelteKit

**Pros:**
- Less boilerplate and smaller bundles than React.
- Pleasant developer experience.

**Cons:**
- Smaller component and charting ecosystem.
- Server `load` functions present the same API-bypass temptation as Next.js.

### Option D: Vue 3 + Vite

**Pros:**
- Gentle learning curve and good first-party tooling.

**Cons:**
- Smaller selection of finance-oriented and charting components.
- Offers no advantage over React here now that React Native code sharing is off the table.

## Decision

Adopt **Option A**: React 19 + Vite + TypeScript, as a client-rendered SPA.

- **Server state:** TanStack Query.
- **Routing:** TanStack Router.
- **Components and styling:** Tailwind CSS with shadcn/ui.
- **Charting:** deferred until there is data to chart, so the library is chosen against a real requirement.
- **API client:** `src/api`, typed exclusively from `@finance/contracts`, including `src/api/refresh.ts`, which implements the single-flight refresh lock required by ADR 0001.
- **Dev proxy:** Vite proxies `/api` to the API, so no CORS configuration is needed on localhost.
- **Enforced boundary:** a test asserts that `apps/web/src` never imports `drizzle-orm`, `better-sqlite3`, or `apps/api/src`.
- **Scaffold scope:** the web app renders exactly two things — a login form, and a page showing `GET /api/v1/me` plus API health status.

## Consequences

- **Positive:** The API is provably the web app's only data path, enforced by a test rather than by convention. The web client exercises the same endpoints any other client would, so the API cannot develop browser-only shortcuts. Fast dev loop and deep ecosystem access.
- **Negative:** Routing, data fetching, and auth-token handling are assembled by hand rather than supplied by the framework. No SSR, so initial load ships and boots JavaScript before rendering — acceptable for a private tool. The frontend stack is now a set of independently versioned libraries to keep current.
- **Neutral:** The build output is static assets, which can be served by any static host or by the API itself. The charting choice is explicitly deferred rather than decided here.
