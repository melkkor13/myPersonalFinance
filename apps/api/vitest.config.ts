/**
 * Vitest configuration for `apps/api` (FR14, C12).
 *
 * ## Why `pool: 'forks'` + `isolate: true` are load-bearing, not stylistic
 *
 * `src/db/sqlite.ts` caches a **process-wide** connection (`sharedConnection`),
 * and `src/db/client.ts` caches the Drizzle handle over it. A test therefore
 * cannot obtain a different database just by changing `DB_PATH`. Two mechanisms
 * keep that safe here:
 *
 *   1. **One process per test FILE** — `pool: 'forks'` with `isolate: true`, so
 *      no file can inherit another file's cached connection. Files that need a
 *      genuinely broken or closed connection (`health-degraded`,
 *      `error-envelope-internal`) rely on this.
 *   2. **Within a file**, `freshInMemoryDatabase()` in `test/support/harness.ts`
 *      calls `closeDb()` first, which drops both caches, then re-opens and
 *      re-migrates a private `:memory:` database. That is the only supported way
 *      to get a clean database mid-file.
 *
 * Do not switch to `pool: 'threads'` or `isolate: false`: both share one module
 * registry across files and would leak the cached connection between them.
 *
 * ## Why `boot-config.test.ts` runs in its own, later project group
 * That file is the only one whose assertions are **wall-clock budgets**: case 29
 * requires `node dist/index.js` to exit inside 2s. Run alongside the other 19
 * files it competed with ~20 forks all starting at once, and the measured spawn
 * drifted from ~0.3s to as much as ~1.5s — 73% of the budget — purely from CPU
 * contention that has nothing to do with the behaviour under test.
 *
 * So the suite is split into two projects with `sequence.groupOrder`: group 0 is
 * every other file, running in parallel exactly as before; group 1 is
 * `boot-config.test.ts` alone, which Vitest starts only once group 0 has finished.
 * The budget itself is untouched — this removes the measurement noise, not the
 * assertion's teeth.
 *
 * ## No database file is ever written (case 23)
 * Every database is `:memory:`. The three tests that genuinely need a file-backed
 * database (migration idempotence, repeatable seed) create it under the OS temp
 * directory via `createTempDatabasePath()` and delete it afterwards — never inside
 * the repository tree.
 */
import { defineConfig } from 'vitest/config';

/** `apps/api` is a Node service: no DOM, no jsdom (FR14). */
const TEST_ENVIRONMENT = 'node';

/** Only `test/**` holds tests; `src/**` has none. */
const TEST_INCLUDE = ['test/**/*.test.ts'];

/** Child processes, not worker threads — see the module comment. */
const TEST_POOL = 'forks';

/** One module registry per test file. Never turn this off. */
const TEST_ISOLATE = true;

/**
 * Generous because two suites deliberately cross a wall-clock second boundary
 * (access-token TTL expiry) and one spawns `node dist/...` child processes.
 */
const TEST_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 30_000;

/** The one file whose assertions are wall-clock budgets — see the module comment. */
const TIMING_SENSITIVE_INCLUDE = ['test/boot-config.test.ts'];

/** Project names, surfaced in reporter output. */
const PROJECT_NAME_SUITE = 'api';
const PROJECT_NAME_TIMING = 'api-timing';

/** Group 0 runs first, in parallel; group 1 runs afterwards, on an idle machine. */
const GROUP_ORDER_PARALLEL = 0;
const GROUP_ORDER_TIMING = 1;

/** Shared settings both projects must agree on. */
const sharedProjectOptions = {
  environment: TEST_ENVIRONMENT,
  pool: TEST_POOL,
  isolate: TEST_ISOLATE,
  testTimeout: TEST_TIMEOUT_MS,
  hookTimeout: HOOK_TIMEOUT_MS,
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...sharedProjectOptions,
          name: PROJECT_NAME_SUITE,
          include: TEST_INCLUDE,
          exclude: TIMING_SENSITIVE_INCLUDE,
          sequence: { groupOrder: GROUP_ORDER_PARALLEL },
        },
      },
      {
        test: {
          ...sharedProjectOptions,
          name: PROJECT_NAME_TIMING,
          include: TIMING_SENSITIVE_INCLUDE,
          sequence: { groupOrder: GROUP_ORDER_TIMING },
        },
      },
    ],
  },
});
