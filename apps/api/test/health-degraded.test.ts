/**
 * Case 13 — an unreachable database degrades the service instead of blocking boot.
 *
 * Two things are proved here, and they pull in opposite directions from case 29:
 *
 *   1. Bad **configuration** is fatal (case 29, `boot-config.test.ts`), but an
 *      unreachable **database** is not: `buildServer()` still succeeds and the
 *      instance is fully usable, it just reports itself degraded.
 *   2. The 503 body is a `HealthResponse`, **not** an `ErrorResponse`. Health is
 *      the one documented exemption from the error envelope, so the body must have
 *      no `error` key at all.
 *
 * This file never primes the shared `:memory:` connection — it must not, because
 * `db/sqlite.ts` caches process-wide and a primed connection would make `ping()`
 * succeed regardless of `DB_PATH`. That is why it is a separate file from
 * `health-ok.test.ts` (see `vitest.config.ts`).
 *
 * The second test is the decisive proof that `ping()` executes a query: a
 * **readable file containing non-SQLite bytes** opens without error, so only
 * running `SELECT 1` can fail on it. A constant-returning `ping()` could not tell
 * that case apart from a healthy database.
 */
import {
  DB_STATUS_UNAVAILABLE,
  HEALTH_STATUS_DEGRADED,
  HealthResponseSchema,
  ROUTES,
  type HealthResponse,
} from '@finance/contracts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { METHOD_GET, STATUS_SERVICE_UNAVAILABLE, TEMP_DIR_PREFIX } from './support/constants.js';
import { startTestServer } from './support/harness.js';

/** A path under a directory that does not exist and cannot be created. */
const UNREACHABLE_DB_PATH = '/proc/definitely/not/writable/finance.db';

/** Bytes that are emphatically not a SQLite header. */
const NON_SQLITE_FILE_CONTENTS = 'this file is readable but is not a database';

/** Name for the garbage probe file. Not a `.db`, and in the OS temp dir. */
const NON_SQLITE_FILE_NAME = 'not-a-database.bin';

let garbageDirectory: string;
let garbageFilePath: string;

beforeAll(() => {
  garbageDirectory = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));
  garbageFilePath = join(garbageDirectory, NON_SQLITE_FILE_NAME);
  writeFileSync(garbageFilePath, NON_SQLITE_FILE_CONTENTS);
});

afterAll(() => {
  rmSync(garbageDirectory, { force: true, recursive: true });
});

describe('GET /api/v1/health on an unreachable database (case 13)', () => {
  it('still builds a usable server and answers 503 with a HealthResponse', async () => {
    const app = await startTestServer({ dbPath: UNREACHABLE_DB_PATH });

    try {
      const response = await app.inject({ method: METHOD_GET, url: ROUTES.HEALTH });

      expect(response.statusCode).toBe(STATUS_SERVICE_UNAVAILABLE);

      const body = response.json<HealthResponse>();
      expect(HealthResponseSchema.parse(body)).toEqual(body);
      expect(body.status).toBe(HEALTH_STATUS_DEGRADED);
      expect(body.db).toBe(DB_STATUS_UNAVAILABLE);
      // The envelope exemption: a degraded health check is NOT an ErrorResponse.
      expect(Object.keys(body).sort()).toEqual(['db', 'status', 'version']);
    } finally {
      await app.close();
    }
  });

  it('binds no port even though it reported itself degraded', async () => {
    const app = await startTestServer({ dbPath: UNREACHABLE_DB_PATH });

    try {
      await app.inject({ method: METHOD_GET, url: ROUTES.HEALTH });

      expect(app.server.listening).toBe(false);
      expect(app.server.address()).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('reports unavailable for a readable non-SQLite file, proving ping() queries', async () => {
    const app = await startTestServer({ dbPath: garbageFilePath });

    try {
      const response = await app.inject({ method: METHOD_GET, url: ROUTES.HEALTH });

      expect(response.statusCode).toBe(STATUS_SERVICE_UNAVAILABLE);
      expect(response.json<HealthResponse>().db).toBe(DB_STATUS_UNAVAILABLE);
    } finally {
      await app.close();
    }
  });
});
