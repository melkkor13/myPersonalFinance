/**
 * Case 21 — the Swagger UI is development-only.
 *
 * `registerOpenApi` registers `@fastify/swagger-ui` only when
 * `NODE_ENV === 'development'`, so the two assertions are made against two
 * separately built instances. In production the route falls through to the
 * project's own not-found handler, which means the 404 body is the `ErrorResponse`
 * envelope rather than Fastify's default shape — asserted here too, because a
 * plain 404 would also be satisfied by a typo in the route constant.
 *
 * No database is involved: this file never primes a connection.
 */
import { ERROR_CODE, ROUTES, type ErrorResponse } from '@finance/contracts';
import { describe, expect, it } from 'vitest';

import { NODE_ENV_DEVELOPMENT, NODE_ENV_PRODUCTION, NODE_ENV_TEST } from '../src/config.js';
import { METHOD_GET, STATUS_NOT_FOUND, STATUS_OK } from './support/constants.js';
import { startTestServer } from './support/harness.js';

/** `@fastify/swagger-ui` serves its shell from the prefix with a trailing slash. */
const DOCS_INDEX_URL = `${ROUTES.DOCS}/`;

describe('GET /api/v1/docs (case 21)', () => {
  it('serves the Swagger UI in development', async () => {
    const app = await startTestServer({ nodeEnv: NODE_ENV_DEVELOPMENT });

    try {
      const response = await app.inject({ method: METHOD_GET, url: DOCS_INDEX_URL });

      expect(response.statusCode).toBe(STATUS_OK);
    } finally {
      await app.close();
    }
  });

  it('answers 404 with the ErrorResponse envelope in production', async () => {
    const app = await startTestServer({ nodeEnv: NODE_ENV_PRODUCTION });

    try {
      const response = await app.inject({ method: METHOD_GET, url: DOCS_INDEX_URL });

      expect(response.statusCode).toBe(STATUS_NOT_FOUND);
      expect(response.json<ErrorResponse>().error.code).toBe(ERROR_CODE.NOT_FOUND);
    } finally {
      await app.close();
    }
  });

  it('is absent under NODE_ENV=test as well — development is the only opt-in', async () => {
    const app = await startTestServer({ nodeEnv: NODE_ENV_TEST });

    try {
      const response = await app.inject({ method: METHOD_GET, url: DOCS_INDEX_URL });

      expect(response.statusCode).toBe(STATUS_NOT_FOUND);
    } finally {
      await app.close();
    }
  });
});
