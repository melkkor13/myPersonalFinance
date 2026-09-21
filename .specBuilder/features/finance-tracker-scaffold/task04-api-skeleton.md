# Task: API Skeleton — config, server, entrypoint

## Status
COMPLETED

## Description
`apps/api` package with Zod-validated fail-fast config and a pure `buildServer()` factory.

## Inputs
- requirements.md § FR12, FR8 boot-failure policy, C8, C15; ADR 0003

## Steps
1. `apps/api/package.json` — `"type": "module"` (C3), deps per the pinned set.
2. `src/config.ts` — Zod schema over `process.env` for every FR12 var. `JWT_SECRET` required,
   min 32 chars. **Throws on invalid config**; the message must name the offending variable.
   Defaults as specified. Constants for defaults, no inline literals.
3. `src/server.ts` — `buildServer()`: pure factory, **no side effects on import**, binds no
   port. Sets Zod `validatorCompiler`/`serializerCompiler` at root (C8). Registers plugins and
   module routes. Pino logger configured from `LOG_LEVEL`.
4. `src/index.ts` — the only file that calls `.listen()`. Reads config (so bad config exits
   non-zero before any port is bound) and starts the server.
5. **No CORS plugin** (C15).

## Expected Output
`buildServer()` importable and injectable without binding a port.

## Verification
Importing `server.ts` starts no listener; `index.ts` with a bad `JWT_SECRET` exits non-zero.

## Dependencies
task03

## Execution Notes
- Files: `apps/api/package.json` (`@finance/api@0.1.0`, `type: module`), `tsconfig.json`,
  `src/config.ts`, `src/server.ts`, `src/index.ts`.
- `npm install`: 103 packages, exit 0, **no native compile** — `better-sqlite3` used
  `prebuilds/darwin-arm64.node`, `@node-rs/argon2-darwin-arm64` via optionalDependencies.
- typecheck / eslint / prettier all clean.
- **Design decision: no module-level config singleton.** `loadConfig()` is called only by
  `index.ts`. A singleton would throw at import time and break ADR 0003's purity constraint.
  `server.ts` imports the config **type-only**, so it has zero runtime env dependency.
- `buildServer()` decorates the instance with `config`, so tasks 07-09 need not import `config.ts`.
- `readAppVersion()` reads `apps/api/package.json` via `new URL('../package.json',
  import.meta.url)` — correct from both `src/` and `dist/`.
- Empty-string env vars treated as unset, so `JWT_SECRET=` reports "required" not "too short".

### Proof: buildServer() binds no port (ADR 0003)
`getActiveResourcesInfo()` → no TCP/Server handle; `server.address()` → `null`;
`server.listening` → `false`; `inject()` still returns real 404 responses; `lsof` on :3000 empty
before and after. Positive control: valid config on PORT=3999 did bind and serve.

### Proof: config fail-fast (acceptance case 29)
- `JWT_SECRET` unset → exit 1 in **0.263s**, stderr `JWT_SECRET: is required but was not set`
- `JWT_SECRET` 10 chars → exit 1 in **0.166s**, stderr `JWT_SECRET: Too small: expected string to have >=32 characters`
- `lsof -iTCP:3000 -sTCP:LISTEN` empty in both cases — no port bound.
