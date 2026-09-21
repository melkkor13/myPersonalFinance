/**
 * Health repository — the **only** layer in this module allowed to know a
 * database exists (FR2).
 *
 * It is a thin wrapper around `ping()` from `db/sqlite.ts` and deliberately
 * contains **no raw SQL**: the single `SELECT 1` in the codebase lives inside
 * `ping()` (FR8), and duplicating it here would put engine-specific SQL outside
 * the B2 allowlist. There is no Drizzle import either — a liveness probe needs a
 * statement, not a query builder — which is fine under B1 (`drizzle-orm` is
 * *permitted* in a `*.repository.ts`, not required).
 *
 * The return value is a plain domain value (a boolean), not an HTTP concept and
 * not a contract enum: translating "the database answered" into
 * `db: "ok" | "unavailable"` is the service's job, and choosing 200 vs 503 is the
 * route's.
 */
import { ping } from '../../db/sqlite.js';

/**
 * Is the database reachable *right now*?
 *
 * @param dbPath the validated `config.dbPath`, passed down from the route so the
 * connection target comes from the injected config rather than a second,
 * independent read of `process.env` inside the db layer.
 * @returns `true` when `SELECT 1` answered, `false` for every failure mode.
 *
 * Never throws. `ping()` already converts an unreachable, unwritable or corrupt
 * database into `false` (FR8: an unreachable DB must not take the request down),
 * and the `catch` here is the belt-and-braces guarantee that the boot-failure
 * policy cannot be broken by a future change to `ping()` — 503 with a component
 * breakdown is strictly more useful to a monitoring probe than a 500.
 */
export function isDatabaseReachable(dbPath: string): boolean {
  try {
    return ping(dbPath);
  } catch {
    return false;
  }
}
