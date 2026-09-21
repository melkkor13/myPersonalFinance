/**
 * Case 8 — logout revokes the presented refresh token.
 *
 * Three separate claims, each asserted on its own:
 *   - the response is 204 with a genuinely **empty** body and no content type
 *     (the documented contract exemption — logout declares no response schema);
 *   - `revoked_at` is set on the row, not merely on some in-memory copy;
 *   - a later refresh with the same token is refused.
 *
 * Rows are read with raw SQL: `test/**` is exempt from rule B2 (C16).
 */
import { ERROR_CODE, ROUTES, type ErrorResponse } from '@finance/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { REFRESH_TOKENS_TABLE } from '../src/db/schema.js';
import { hashRefreshToken } from '../src/lib/tokens.js';
import {
  HEADER_CONTENT_TYPE,
  METHOD_POST,
  STATUS_NO_CONTENT,
  STATUS_UNAUTHORIZED,
} from './support/constants.js';
import {
  createTestUser,
  disposeDatabase,
  freshInMemoryDatabase,
  login,
  required,
  startTestServer,
  type TestDatabase,
  type TestUser,
} from './support/harness.js';

const SELECT_TOKEN_BY_HASH_SQL = `SELECT token_hash, revoked_at FROM ${REFRESH_TOKENS_TABLE} WHERE token_hash = ?`;

/** An empty HTTP payload. */
const EMPTY_BODY = '';

interface StoredTokenRow {
  readonly token_hash: string;
  readonly revoked_at: string | null;
}

let app: FastifyInstance;
let database: TestDatabase;

function storedRow(token: string): StoredTokenRow {
  const row = database.connection.prepare(SELECT_TOKEN_BY_HASH_SQL).get(hashRefreshToken(token));
  return required(row as StoredTokenRow | undefined, SELECT_TOKEN_BY_HASH_SQL);
}

beforeAll(async () => {
  app = await startTestServer();
});

beforeEach(async () => {
  database = freshInMemoryDatabase();
  const user: TestUser = await createTestUser(database.db);
  expect(user.id.length).toBeGreaterThan(0);
});

afterAll(async () => {
  await app.close();
  disposeDatabase();
});

describe('POST /api/v1/auth/logout (case 8)', () => {
  it('answers 204 with an empty body and no content type', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGOUT,
      payload: { refresh_token: tokens.refresh_token },
    });

    expect(response.statusCode).toBe(STATUS_NO_CONTENT);
    expect(response.body).toBe(EMPTY_BODY);
    expect(response.headers[HEADER_CONTENT_TYPE]).toBeUndefined();
  });

  it('sets revoked_at on the stored row', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);
    expect(storedRow(tokens.refresh_token).revoked_at).toBeNull();

    await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGOUT,
      payload: { refresh_token: tokens.refresh_token },
    });

    expect(storedRow(tokens.refresh_token).revoked_at).not.toBeNull();
  });

  it('refuses a later refresh with the revoked token', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);
    await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGOUT,
      payload: { refresh_token: tokens.refresh_token },
    });

    const response = await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_REFRESH,
      payload: { refresh_token: tokens.refresh_token },
    });

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(response.json<ErrorResponse>().error.code).toBe(ERROR_CODE.UNAUTHENTICATED);
  });

  it('is idempotent — logging out twice still answers 204', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);
    const payload = { refresh_token: tokens.refresh_token };

    const first = await app.inject({ method: METHOD_POST, url: ROUTES.AUTH_LOGOUT, payload });
    const second = await app.inject({ method: METHOD_POST, url: ROUTES.AUTH_LOGOUT, payload });

    expect(first.statusCode).toBe(STATUS_NO_CONTENT);
    expect(second.statusCode).toBe(STATUS_NO_CONTENT);
  });
});
