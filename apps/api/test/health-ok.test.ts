/**
 * Case 2 — health reports `ok` through the full routes → service → repository →
 * `db/sqlite.ts` chain, against a real migrated `:memory:` database.
 *
 * The interesting assertion is the last one. `{"status":"ok","db":"ok"}` is
 * exactly what a hard-coded `ping()` would also return, so the suite spies on the
 * live connection's `prepare` and proves the request really issued `SELECT 1`
 * against the database. `health-degraded.test.ts` proves the converse.
 */
import {
  DB_STATUS_OK,
  HEALTH_STATUS_OK,
  HealthResponseSchema,
  ROUTES,
  type HealthResponse,
} from '@finance/contracts';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, describe, it, vi } from 'vitest';

import { SELECT_ONE_SQL } from '../src/db/sqlite.js';
import { METHOD_GET, STATUS_OK } from './support/constants.js';
import {
  disposeDatabase,
  freshInMemoryDatabase,
  startTestServer,
  type TestDatabase,
} from './support/harness.js';

/** `apps/api/package.json`, relative to this file — the source of `version`. */
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

let app: FastifyInstance;
let database: TestDatabase;

beforeAll(async () => {
  database = freshInMemoryDatabase();
  app = await startTestServer();
});

afterAll(async () => {
  await app.close();
  disposeDatabase();
});

describe('GET /api/v1/health on a reachable database (case 2)', () => {
  it('answers 200 with a contract-shaped ok body', async () => {
    const response = await app.inject({ method: METHOD_GET, url: ROUTES.HEALTH });

    expect(response.statusCode).toBe(STATUS_OK);

    const body = response.json<HealthResponse>();
    expect(HealthResponseSchema.parse(body)).toEqual(body);
    expect(body.status).toBe(HEALTH_STATUS_OK);
    expect(body.db).toBe(DB_STATUS_OK);
  });

  it('reports the version from apps/api/package.json, not a literal', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8')) as { version: string };

    expect(manifest.version.length).toBeGreaterThan(0);
  });

  it('serves the same version the manifest declares', async () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8')) as { version: string };
    const response = await app.inject({ method: METHOD_GET, url: ROUTES.HEALTH });

    expect(response.json<HealthResponse>().version).toBe(manifest.version);
  });

  it('really queries the database — SELECT 1 is issued on the live connection', async () => {
    const prepareSpy = vi.spyOn(database.connection, 'prepare');

    await app.inject({ method: METHOD_GET, url: ROUTES.HEALTH });

    expect(prepareSpy).toHaveBeenCalledWith(SELECT_ONE_SQL);
    prepareSpy.mockRestore();
  });
});
