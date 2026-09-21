/**
 * Cases 7, 19, 33 and 34 — refresh-token rotation, storage, replay detection and
 * expiry.
 *
 * ## Why no assertion that the ACCESS token changed
 * JWT `iat`/`exp` are second-granular, so a refresh issued in the same wall-clock
 * second as the login re-mints a **byte-identical** access token. Asserting that
 * it differs would be flaky unless the test slept across a second boundary, which
 * would buy nothing: the security-relevant property is that the **refresh** token
 * rotated and the presented one was revoked. That is what these tests assert.
 *
 * Refresh-token rows are read with raw SQL — `test/**` is exempt from rule B2
 * (C16), and keeping the ORM out of the test files means B1's static scan can
 * never trip over a fixture.
 */
import {
  ERROR_CODE,
  RefreshResponseSchema,
  ROUTES,
  type ErrorResponse,
  type RefreshResponse,
} from '@finance/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { REFRESH_TOKENS_TABLE } from '../src/db/schema.js';
import { hashRefreshToken, REFRESH_TOKEN_DIGEST_LENGTH } from '../src/lib/tokens.js';
import {
  METHOD_POST,
  PAST_OFFSET_MS,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
} from './support/constants.js';
import {
  createTestUser,
  disposeDatabase,
  freshInMemoryDatabase,
  insertExpiredRefreshToken,
  login,
  required,
  startTestServer,
  type TestDatabase,
  type TestUser,
} from './support/harness.js';

/** All stored rows for one user, newest last. */
const SELECT_TOKENS_FOR_USER_SQL =
  `SELECT token_hash, revoked_at, expires_at FROM ${REFRESH_TOKENS_TABLE} ` +
  `WHERE user_id = ? ORDER BY created_at, id`;

/** Every stored digest, regardless of owner. */
const SELECT_ALL_HASHES_SQL = `SELECT token_hash FROM ${REFRESH_TOKENS_TABLE}`;

/** 64 lower-case hex characters — a SHA-256 digest and nothing else. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** A refresh token value that was never issued. */
const UNISSUED_REFRESH_TOKEN = 'this-token-was-never-issued';

interface StoredTokenRow {
  readonly token_hash: string;
  readonly revoked_at: string | null;
  readonly expires_at: string;
}

interface HashRow {
  readonly token_hash: string;
}

let app: FastifyInstance;
let database: TestDatabase;
let user: TestUser;

function storedTokensFor(userId: string): StoredTokenRow[] {
  return database.connection.prepare(SELECT_TOKENS_FOR_USER_SQL).all(userId) as StoredTokenRow[];
}

function storedRow(userId: string, token: string): StoredTokenRow {
  const digest = hashRefreshToken(token);
  const row = storedTokensFor(userId).find((candidate) => candidate.token_hash === digest);
  return required(row, `stored row for the refresh token issued to ${userId}`);
}

async function postRefresh(refreshToken: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: METHOD_POST,
    url: ROUTES.AUTH_REFRESH,
    payload: { refresh_token: refreshToken },
  });
}

beforeAll(async () => {
  app = await startTestServer();
});

beforeEach(async () => {
  database = freshInMemoryDatabase();
  user = await createTestUser(database.db);
});

afterAll(async () => {
  await app.close();
  disposeDatabase();
});

describe('refresh rotates the refresh token (case 7)', () => {
  it('issues a different refresh token and revokes the presented one', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await postRefresh(tokens.refresh_token);

    expect(response.statusCode).toBe(STATUS_OK);

    const body = response.json<RefreshResponse>();
    expect(RefreshResponseSchema.parse(body)).toEqual(body);
    expect(body.refresh_token).not.toBe(tokens.refresh_token);
    expect(body.access_token.length).toBeGreaterThan(0);

    expect(storedRow(user.id, tokens.refresh_token).revoked_at).not.toBeNull();
    expect(storedRow(user.id, body.refresh_token).revoked_at).toBeNull();
  });

  it('rejects a refresh token that was never issued', async () => {
    const response = await postRefresh(UNISSUED_REFRESH_TOKEN);

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(response.json<ErrorResponse>().error.code).toBe(ERROR_CODE.UNAUTHENTICATED);
  });
});

describe('refresh tokens are never stored in plaintext (case 19)', () => {
  it('stores only 64-char hex SHA-256 digests, never the token value', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const hashes = (database.connection.prepare(SELECT_ALL_HASHES_SQL).all() as HashRow[]).map(
      (row) => row.token_hash,
    );

    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) {
      expect(hash).not.toBe(tokens.refresh_token);
      expect(hash).toHaveLength(REFRESH_TOKEN_DIGEST_LENGTH);
      expect(SHA256_HEX_PATTERN.test(hash)).toBe(true);
    }
    // The digest of the token the client holds IS present — proving the stored
    // value is that token's hash and not an unrelated random string.
    expect(hashes).toContain(hashRefreshToken(tokens.refresh_token));
  });
});

describe('replaying a rotated refresh token is treated as compromise (case 33)', () => {
  it('answers 401 and revokes every refresh token the user holds', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);
    const rotated = (await postRefresh(tokens.refresh_token)).json<RefreshResponse>();

    const replay = await postRefresh(tokens.refresh_token);

    expect(replay.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(replay.json<ErrorResponse>().error.code).toBe(ERROR_CODE.UNAUTHENTICATED);

    const rows = storedTokensFor(user.id);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.revoked_at).not.toBeNull();
    }
    // Including the one that was still live a moment ago.
    expect(storedRow(user.id, rotated.refresh_token).revoked_at).not.toBeNull();
  });
});

describe('an expired refresh token is rejected (case 34)', () => {
  it('answers 401 and issues no new tokens', async () => {
    insertExpiredRefreshToken(database.db, user.id, UNISSUED_REFRESH_TOKEN, PAST_OFFSET_MS);
    const before = storedTokensFor(user.id);

    const response = await postRefresh(UNISSUED_REFRESH_TOKEN);

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(response.json<ErrorResponse>().error.code).toBe(ERROR_CODE.UNAUTHENTICATED);
    expect(storedTokensFor(user.id)).toHaveLength(before.length);
  });

  it('leaves the expired row unrevoked — it failed on expiry, not revocation', async () => {
    insertExpiredRefreshToken(database.db, user.id, UNISSUED_REFRESH_TOKEN, PAST_OFFSET_MS);

    await postRefresh(UNISSUED_REFRESH_TOKEN);

    expect(storedRow(user.id, UNISSUED_REFRESH_TOKEN).revoked_at).toBeNull();
  });
});
