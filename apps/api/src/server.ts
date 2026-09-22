/**
 * `buildServer()` — the Fastify application factory (ADR 0003).
 *
 * ## Hard constraints
 *
 * 1. **Pure factory, no side effects on import.** Importing this module must not
 *    read `process.env`, open a database, or bind a socket. It never calls
 *    `.listen()` — `index.ts` is the only file that does. The API test suite
 *    (FR14) drives this instance with `fastify.inject()`, which needs no port,
 *    and ADR 0003 makes that a non-negotiable property.
 *
 * 2. **Configuration is injected, not imported.** Only the *type* is imported from
 *    `./config.js` (erased at compile time under `verbatimModuleSyntax`), so a
 *    missing `JWT_SECRET` can never be discovered lazily here — it is already
 *    fatal in `index.ts` before this function is reached (FR8).
 *
 * 3. **An unreachable database must not prevent boot** (FR8). Nothing here opens a
 *    DB connection. The db layer (task05) is lazily reached by the health
 *    repository, which reports `db: "unavailable"` with 503 rather than throwing.
 */
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { type CfAccessVerifier, createCfAccessVerifier } from './lib/cloudflare-access.js';
import { authModule } from './modules/auth/auth.routes.js';
import { healthModule } from './modules/health/health.routes.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { registerOpenApi } from './plugins/openapi.js';

/**
 * Make the validated config reachable from plugins and module routes without any
 * of them importing `config.ts`, which keeps them injectable in tests.
 */
declare module 'fastify' {
  interface FastifyInstance {
    readonly config: AppConfig;
    /**
     * Verifies a `Cf-Access-Jwt-Assertion` header, or `undefined` when
     * Cloudflare Access is disabled — in which case `plugins/authenticate.ts`
     * ignores the header entirely rather than merely failing to verify it.
     */
    readonly cfAccessVerifier: CfAccessVerifier | undefined;
  }
}

/**
 * The real Access verifier, or `undefined` when Access is disabled.
 *
 * `config.ts` guarantees that `cfAccessEnabled` implies both other values are
 * present, so the assertion below cannot fire for a config that came from
 * `loadConfig`. It is a genuine check rather than a cast because `testConfig`
 * builds an `AppConfig` directly and could otherwise enable Access with no
 * audience, silently producing a verifier that accepts nothing.
 */
function buildCfAccessVerifier(config: AppConfig): CfAccessVerifier | undefined {
  if (!config.cfAccessEnabled) {
    return undefined;
  }
  const { cfAccessTeamDomain, cfAccessAud } = config;
  if (cfAccessTeamDomain === undefined || cfAccessAud === undefined) {
    throw new Error(CF_ACCESS_MISCONFIGURED_MESSAGE);
  }
  return createCfAccessVerifier({ cfAccessTeamDomain, cfAccessAud });
}

/** Decorator keys for injected dependencies. Named constants per the no-literals rule. */
const CONFIG_DECORATOR = 'config';
const CF_ACCESS_VERIFIER_DECORATOR = 'cfAccessVerifier';

/** Raised only for an `AppConfig` built by hand with Access half-configured. */
const CF_ACCESS_MISCONFIGURED_MESSAGE =
  'CF_ACCESS_ENABLED is set but CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD is missing';

/**
 * Collaborators a caller may substitute. Everything here has a real
 * implementation derived from {@link AppConfig}; the parameter exists so tests
 * can replace one without reaching for a module mock.
 */
export interface ServerDependencies {
  /**
   * Overrides the verifier built from `config`. The API test suite injects one
   * backed by `jose.createLocalJWKSet` over a locally generated key pair, which
   * is what keeps those tests hermetic and offline.
   */
  readonly cfAccessVerifier?: CfAccessVerifier | undefined;
}

/**
 * Build a fully configured but **unstarted** Fastify instance.
 *
 * @param config validated configuration from `loadConfig()`.
 * @returns an instance ready for `.inject()` (tests) or `.listen()` (`index.ts`).
 */
export function buildServer(config: AppConfig, deps: ServerDependencies = {}): FastifyInstance {
  const app = Fastify({
    // Pino, configured solely from LOG_LEVEL (FR12; ADR 0003 consequences).
    logger: { level: config.logLevel },
  });

  // Zod type provider: the validator/serializer compilers are set ONCE, here at the
  // root, so every descendant route validates and serializes against the
  // `@finance/contracts` schemas.
  //
  // C8: `withTypeProvider<ZodTypeProvider>()` does NOT propagate its *types* into
  // `fastify-plugin` children. The compilers below are inherited at runtime, but
  // each module plugin (tasks 08-09) must re-apply
  // `.withTypeProvider<ZodTypeProvider>()` in its own signature to get typed
  // handlers. That is why this file sets compilers only and does not try to hand a
  // type-provided instance down to the plugins.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate(CONFIG_DECORATOR, config);

  // Built ONCE per instance, never per request: the object returned by
  // `createRemoteJWKSet` owns the key cache, the rotation handling for an
  // unknown `kid`, and the coalescing of concurrent fetches, so rebuilding it
  // per request would refetch the JWKS every time and defeat all three.
  // Construction itself is lazy and does no network I/O, so `buildServer` stays
  // a side-effect-free factory (ADR 0003).
  app.decorate(
    CF_ACCESS_VERIFIER_DECORATOR,
    deps.cfAccessVerifier ?? buildCfAccessVerifier(config),
  );

  // DELIBERATELY NO CORS PLUGIN (C15). Vite proxies `/api` to this server in dev
  // (ADR 0007), so requests are same-origin and CORS headers are not needed.
  // Adding `@fastify/cors` would mask a misconfigured proxy by making a broken
  // setup appear to work. Do not add it without revisiting C15.

  // ------------------------------------------------------------------
  // Cross-cutting plugins (task07), applied BEFORE any module registers a route:
  //   - the error handler must be in place for every later throw, and
  //   - `@fastify/swagger` collects routes through an `onRoute` hook, which only
  //     sees routes added after it.
  //
  // They are applied as plain functions rather than `app.register(...)` on
  // purpose. `setErrorHandler`/`setNotFoundHandler` bind to the encapsulation
  // context they are called in, so wrapping them in an ordinary plugin would
  // cover only that plugin's children and miss the sibling module routes. The
  // usual fix, `fastify-plugin`, is not a declared dependency of `apps/api`, so
  // the plugins expose functions that take the ROOT instance instead. Everything
  // that genuinely needs encapsulation (`@fastify/swagger`, `@fastify/swagger-ui`)
  // is still registered with `app.register` inside `registerOpenApi`.
  registerErrorHandler(app);
  registerOpenApi(app);

  // `authenticate` is not applied here: it is an opt-in `onRequest` hook, and
  // only `GET /api/v1/me` uses it (task09). A default-on auth hook would need a
  // public-route allowlist, which is a thing to forget to update.

  // ------------------------------------------------------------------
  // Module routes. Registered AFTER `registerOpenApi(app)` above — that is
  // load-bearing, not stylistic: `@fastify/swagger` collects the route table
  // through an `onRoute` hook, so a module registered earlier would be silently
  // missing from the OpenAPI document with no error anywhere.
  app.register(healthModule); // GET  /api/v1/health
  app.register(authModule); // POST /api/v1/auth/{login,refresh,logout}, GET /api/v1/me
  //
  // Route paths come from `ROUTES` in `@finance/contracts` - never hardcoded here
  // or in the modules. C8: each module plugin re-applies
  // `.withTypeProvider<ZodTypeProvider>()` in its own signature; the compilers set
  // above are inherited at runtime but their TYPES do not propagate into children.
  // ------------------------------------------------------------------

  return app;
}
