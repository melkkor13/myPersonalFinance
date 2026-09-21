/**
 * Cases 6, 30 and 32 — login, the protected `/me` route, and the two ways login
 * can fail.
 *
 * Case 32 is the one with teeth: an unknown email and a wrong password must
 * produce **byte-identical** responses, so the endpoint cannot be used to
 * enumerate accounts. The assertion compares the raw body strings and the
 * `content-length` headers, not parsed objects, because equality of parsed
 * objects would tolerate a difference in key order or whitespace that a client
 * could still measure.
 */
import {
  ERROR_CODE,
  ErrorResponseSchema,
  LoginResponseSchema,
  MeResponseSchema,
  ROUTES,
  type ErrorResponse,
  type LoginResponse,
  type MeResponse,
} from '@finance/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { UNAUTHENTICATED_MESSAGE } from '../src/lib/errors.js';
import { VALIDATION_ERROR_MESSAGE } from '../src/plugins/errorHandler.js';
import {
  HEADER_CONTENT_LENGTH,
  METHOD_GET,
  METHOD_POST,
  STATUS_BAD_REQUEST,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
  TEST_UNREGISTERED_EMAIL,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
  TEST_WRONG_PASSWORD,
} from './support/constants.js';
import {
  bearer,
  createTestUser,
  disposeDatabase,
  freshInMemoryDatabase,
  login,
  startTestServer,
  type TestUser,
} from './support/harness.js';

/** The snake_case token fields the contract mandates (Q1). */
const EXPECTED_LOGIN_KEYS = ['access_token', 'refresh_token'] as const;

/** camelCase spellings that must NOT appear anywhere in a response. */
const FORBIDDEN_CAMEL_CASE_KEYS = ['accessToken', 'refreshToken', 'defaultCurrency'] as const;

/** The column that must never be serialised to a client. */
const FORBIDDEN_USER_FIELD = 'password_hash';

/** Case 30's exact request: a malformed email and no password at all. */
const INVALID_LOGIN_PAYLOAD = { email: 'not-an-email' };

/** Both offending fields, in the order the envelope reports them. */
const EXPECTED_VALIDATION_FIELDS = ['email', 'password'] as const;

let app: FastifyInstance;
let user: TestUser;

beforeAll(async () => {
  app = await startTestServer();
});

beforeEach(async () => {
  const database = freshInMemoryDatabase();
  user = await createTestUser(database.db);
});

afterAll(async () => {
  await app.close();
  disposeDatabase();
});

describe('happy-path login and access (case 6)', () => {
  it('returns snake_case access and refresh tokens', async () => {
    const response = await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGIN,
      payload: { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD },
    });

    expect(response.statusCode).toBe(STATUS_OK);

    const body = response.json<LoginResponse>();
    expect(LoginResponseSchema.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual([...EXPECTED_LOGIN_KEYS].sort());
    for (const forbidden of FORBIDDEN_CAMEL_CASE_KEYS) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it('serves the authenticated user from /me with the right id and email', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await app.inject({
      method: METHOD_GET,
      url: ROUTES.ME,
      headers: bearer(tokens.access_token),
    });

    expect(response.statusCode).toBe(STATUS_OK);

    const body = response.json<MeResponse>();
    expect(MeResponseSchema.parse(body)).toEqual(body);
    expect(body.id).toBe(user.id);
    expect(body.email).toBe(TEST_USER_EMAIL);
  });

  it('never includes password_hash in the /me response', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await app.inject({
      method: METHOD_GET,
      url: ROUTES.ME,
      headers: bearer(tokens.access_token),
    });

    expect(response.body).not.toContain(FORBIDDEN_USER_FIELD);
    expect(response.body).not.toContain(user.passwordHash);
    expect(Object.keys(response.json<MeResponse>())).not.toContain(FORBIDDEN_USER_FIELD);
  });
});

describe('request validation rejects bad input (case 30)', () => {
  it('maps a schema failure to the VALIDATION_ERROR envelope, not FST_ERR_VALIDATION', async () => {
    const response = await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGIN,
      payload: INVALID_LOGIN_PAYLOAD,
    });

    expect(response.statusCode).toBe(STATUS_BAD_REQUEST);

    const body = response.json<ErrorResponse>();
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body.error.code).toBe(ERROR_CODE.VALIDATION_ERROR);
    expect(body.error.message).toBe(VALIDATION_ERROR_MESSAGE);
    expect(body.error.fields).toEqual([...EXPECTED_VALIDATION_FIELDS]);
    expect(response.body).not.toContain('FST_ERR_VALIDATION');
  });
});

describe('login failures are indistinguishable (case 32)', () => {
  it('answers 401 with byte-identical bodies for a wrong password and an unknown email', async () => {
    const wrongPassword = await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGIN,
      payload: { email: TEST_USER_EMAIL, password: TEST_WRONG_PASSWORD },
    });
    const unknownEmail = await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGIN,
      payload: { email: TEST_UNREGISTERED_EMAIL, password: TEST_USER_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(unknownEmail.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(wrongPassword.body).toBe(unknownEmail.body);
    expect(wrongPassword.headers[HEADER_CONTENT_LENGTH]).toBe(
      unknownEmail.headers[HEADER_CONTENT_LENGTH],
    );
  });

  it('carries no fields array, which would leak which half of the credential failed', async () => {
    const response = await app.inject({
      method: METHOD_POST,
      url: ROUTES.AUTH_LOGIN,
      payload: { email: TEST_USER_EMAIL, password: TEST_WRONG_PASSWORD },
    });

    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe(ERROR_CODE.UNAUTHENTICATED);
    expect(body.error.message).toBe(UNAUTHENTICATED_MESSAGE);
    expect(body.error).not.toHaveProperty('fields');
  });
});
