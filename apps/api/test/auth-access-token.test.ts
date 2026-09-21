/**
 * Cases 31 and 16 — the protected route rejects every kind of bad access token,
 * and the access-token TTL is both enforced and configurable.
 *
 * ## "never reach the handler" is asserted, not assumed
 * `authenticate` is an `onRequest` hook, so a rejected request must be over
 * before any `preHandler` runs. The suite registers a root-level `preHandler`
 * counter; if it is still zero after all four bad tokens, the handler chain was
 * never entered. Four 401s alone would not prove that — a handler could return
 * 401 itself.
 *
 * ## Case 16 crosses a real second boundary
 * JWT `exp` has one-second granularity, so the only honest way to test expiry is
 * to build a server with a 1s TTL and wait slightly longer. That costs about
 * 1.3s of wall-clock time here, deliberately, rather than faking the clock.
 */
import { ERROR_CODE, ErrorResponseSchema, ROUTES, type ErrorResponse } from '@finance/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_REFRESH_TOKEN_TTL } from '../src/config.js';
import { UNAUTHENTICATED_MESSAGE } from '../src/lib/errors.js';
import { signAccessToken } from '../src/lib/tokens.js';
import { buildServer } from '../src/server.js';
import {
  GARBAGE_ACCESS_TOKEN,
  HEADER_CONTENT_LENGTH,
  METHOD_GET,
  SHORT_ACCESS_TOKEN_TTL,
  SHORT_ACCESS_TOKEN_WAIT_MS,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
  TEST_JWT_SECRET,
  TEST_WRONG_JWT_SECRET,
} from './support/constants.js';
import {
  bearer,
  createTestUser,
  disposeDatabase,
  freshInMemoryDatabase,
  login,
  testConfig,
  type TestUser,
} from './support/harness.js';

/** Token config for forging a validly shaped but wrongly signed token. */
const WRONG_SECRET_TOKEN_CONFIG = {
  jwtSecret: TEST_WRONG_JWT_SECRET,
  accessTokenTtl: SHORT_ACCESS_TOKEN_TTL,
  refreshTokenTtl: DEFAULT_REFRESH_TOKEN_TTL,
} as const;

/** Case 31's labels, so a failure names which of the four inputs broke. */
const MISSING_HEADER_LABEL = 'no Authorization header';
const GARBAGE_LABEL = 'Bearer garbage';
const WRONG_SECRET_LABEL = 'a token signed with the wrong secret';
const EXPIRED_LABEL = 'an expired token';

/** Counter start value. */
const NO_HANDLER_INVOCATIONS = 0;

let app: FastifyInstance;
let user: TestUser;
let handlerChainEntries: number;

beforeAll(async () => {
  const database = freshInMemoryDatabase();
  user = await createTestUser(database.db);

  // Built by hand rather than via `startTestServer` so a counter hook can be
  // installed before `ready()`.
  app = buildServer(testConfig({ accessTokenTtl: SHORT_ACCESS_TOKEN_TTL }));
  handlerChainEntries = NO_HANDLER_INVOCATIONS;
  app.addHook('preHandler', (_request, _reply, done) => {
    handlerChainEntries += 1;
    done();
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  disposeDatabase();
});

/** `GET /api/v1/me` with whatever headers are given. */
async function getMe(headers: Record<string, string>): Promise<LightMyRequestResponse> {
  return app.inject({ method: METHOD_GET, url: ROUTES.ME, headers });
}

describe('protected route rejects missing and bad tokens (case 31)', () => {
  it('answers 401 UNAUTHENTICATED for all four inputs, without entering the handler', async () => {
    const expired = await login(app, ROUTES.AUTH_LOGIN);
    await delay(SHORT_ACCESS_TOKEN_WAIT_MS);

    const attempts = [
      { label: MISSING_HEADER_LABEL, headers: {} },
      { label: GARBAGE_LABEL, headers: bearer(GARBAGE_ACCESS_TOKEN) },
      {
        label: WRONG_SECRET_LABEL,
        headers: bearer(await signAccessToken(user.id, WRONG_SECRET_TOKEN_CONFIG)),
      },
      { label: EXPIRED_LABEL, headers: bearer(expired.access_token) },
    ];

    handlerChainEntries = NO_HANDLER_INVOCATIONS;
    const bodies: string[] = [];
    const contentLengths: (string | undefined)[] = [];

    for (const attempt of attempts) {
      const response = await getMe(attempt.headers);

      expect(response.statusCode, attempt.label).toBe(STATUS_UNAUTHORIZED);

      const body = response.json<ErrorResponse>();
      expect(ErrorResponseSchema.parse(body), attempt.label).toEqual(body);
      expect(body.error.code, attempt.label).toBe(ERROR_CODE.UNAUTHENTICATED);
      expect(body.error.message, attempt.label).toBe(UNAUTHENTICATED_MESSAGE);
      expect(body.error, attempt.label).not.toHaveProperty('fields');

      bodies.push(response.body);
      const contentLength = response.headers[HEADER_CONTENT_LENGTH];
      contentLengths.push(typeof contentLength === 'string' ? contentLength : undefined);
    }

    // No preHandler ran, so no request got past the onRequest auth hook.
    expect(handlerChainEntries).toBe(NO_HANDLER_INVOCATIONS);
    // All four are byte-identical, so none of them hints at why it failed.
    expect(new Set(bodies).size).toBe(1);
    expect(new Set(contentLengths).size).toBe(1);
  });
});

describe('access token expires on schedule (case 16)', () => {
  it('accepts a freshly minted token from a 1s-TTL server', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await getMe(bearer(tokens.access_token));

    expect(response.statusCode).toBe(STATUS_OK);
  });

  it('rejects the same token once the configured TTL has elapsed', async () => {
    const tokens = await login(app, ROUTES.AUTH_LOGIN);
    expect((await getMe(bearer(tokens.access_token))).statusCode).toBe(STATUS_OK);

    await delay(SHORT_ACCESS_TOKEN_WAIT_MS);

    const response = await getMe(bearer(tokens.access_token));

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(response.json<ErrorResponse>().error.code).toBe(ERROR_CODE.UNAUTHENTICATED);
  });

  it('is driven by configuration — the default TTL keeps the same token valid', async () => {
    const longLived = buildServer(testConfig({ jwtSecret: TEST_JWT_SECRET }));
    await longLived.ready();

    try {
      const tokens = await login(longLived, ROUTES.AUTH_LOGIN);
      await delay(SHORT_ACCESS_TOKEN_WAIT_MS);

      const response = await longLived.inject({
        method: METHOD_GET,
        url: ROUTES.ME,
        headers: bearer(tokens.access_token),
      });

      expect(response.statusCode).toBe(STATUS_OK);
    } finally {
      await longLived.close();
    }
  });
});
