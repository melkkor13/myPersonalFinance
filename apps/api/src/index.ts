/**
 * Process entrypoint — the ONLY file in `apps/api` that binds a port.
 *
 * Boot order is load-bearing (FR8, edge case "missing/short JWT_SECRET"):
 *   1. `loadConfig()` first. If configuration is invalid we log a message naming
 *      the offending variable and `process.exit(1)` — **no port is ever bound**,
 *      no server is constructed, and the exit happens well inside the 2s budget.
 *   2. Only then build the server and listen.
 *
 * An unreachable database is explicitly NOT fatal here: nothing below connects to
 * the DB, so the process binds its port and `/api/v1/health` reports
 * `db: "unavailable"` with 503.
 */
import { loadConfig, type AppConfig } from './config.js';
import { buildServer } from './server.js';

/** Exit code for any fatal boot failure. */
const EXIT_FAILURE = 1;
/** Bind address. `0.0.0.0` so a container/VM port map works; localhost-only per A4. */
const LISTEN_HOST = '0.0.0.0';

let config: AppConfig;

try {
  config = loadConfig();
} catch (error) {
  // The logger is not up yet (its level comes from the config that just failed),
  // so write straight to stderr. `message` names the offending variable.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT_FAILURE);
}

const app = buildServer(config);

try {
  await app.listen({ port: config.port, host: LISTEN_HOST });
} catch (error) {
  app.log.fatal({ err: error }, 'Failed to start the API server');
  process.exit(EXIT_FAILURE);
}
