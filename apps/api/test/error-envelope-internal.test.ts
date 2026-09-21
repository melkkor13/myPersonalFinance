/**
 * Case 35 — an unexpected, non-domain error becomes `INTERNAL` and leaks nothing.
 *
 * ## How the failure is forced
 * After a successful login, the suite closes the process-wide SQLite connection
 * while leaving the cached Drizzle handle in `db/client.ts` pointing at it. The
 * next authenticated `GET /api/v1/me` therefore throws a driver error from deep
 * inside the repository — a real, unplanned failure rather than a hand-thrown
 * `Error`, which is the only way to be sure the fallback branch of the error
 * handler is what runs.
 *
 * Because that deliberately breaks the shared connection for the rest of the
 * process, this is its own test file (see `vitest.config.ts`).
 *
 * ## Both halves of the case are asserted
 *   - the **response** is an `ErrorResponse` with code `INTERNAL` and carries no
 *     stack frame, no SQL text and no filesystem path;
 *   - the **server log** does receive the full error. The suite captures
 *     `request.log.error` through a root `onRequest` hook, which is the same
 *     logger object the error handler writes to.
 */
import { ERROR_CODE, ErrorResponseSchema, ROUTES, type ErrorResponse } from '@finance/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeConnection } from '../src/db/sqlite.js';
import { INTERNAL_ERROR_MESSAGE } from '../src/plugins/errorHandler.js';
import { buildServer } from '../src/server.js';
import {
  LEAK_MARKER_ABSOLUTE_PATH,
  LEAK_MARKER_FILE_EXTENSION,
  LEAK_MARKER_NODE_MODULES,
  LEAK_MARKER_SELECT,
  LEAK_MARKER_STACK_FRAME,
  METHOD_GET,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_OK,
} from './support/constants.js';
import {
  bearer,
  createTestUser,
  disposeDatabase,
  freshInMemoryDatabase,
  login,
  required,
  testConfig,
} from './support/harness.js';

/** Everything `request.log.error` was called with, across all requests. */
const loggedErrorCalls: unknown[][] = [];

/** Substrings that must not appear anywhere in a 500 body. */
const LEAK_MARKERS = [
  LEAK_MARKER_STACK_FRAME,
  LEAK_MARKER_SELECT,
  LEAK_MARKER_ABSOLUTE_PATH,
  LEAK_MARKER_FILE_EXTENSION,
  LEAK_MARKER_NODE_MODULES,
] as const;

/** Shape the error handler logs: `{ err }` plus a message. */
interface LoggedErrorPayload {
  readonly err?: { readonly message?: string; readonly stack?: string };
}

let app: FastifyInstance;
let accessToken: string;

beforeAll(async () => {
  const database = freshInMemoryDatabase();
  await createTestUser(database.db);

  app = buildServer(testConfig());
  app.addHook('onRequest', (request, _reply, done) => {
    vi.spyOn(request.log, 'error').mockImplementation((...args: unknown[]) => {
      loggedErrorCalls.push(args);
    });
    done();
  });
  await app.ready();

  accessToken = (await login(app, ROUTES.AUTH_LOGIN)).access_token;
});

afterAll(async () => {
  await app.close();
  disposeDatabase();
});

describe('unexpected errors become INTERNAL (case 35)', () => {
  it('serves /me normally before the database handle is broken', async () => {
    const response = await app.inject({
      method: METHOD_GET,
      url: ROUTES.ME,
      headers: bearer(accessToken),
    });

    expect(response.statusCode).toBe(STATUS_OK);
  });

  it('answers 500 with an ErrorResponse that leaks nothing, and logs the real error', async () => {
    loggedErrorCalls.length = 0;
    // Break the live connection while the cached Drizzle handle still points at
    // it, so the repository throws a genuine driver error.
    closeConnection();

    const response = await app.inject({
      method: METHOD_GET,
      url: ROUTES.ME,
      headers: bearer(accessToken),
    });

    expect(response.statusCode).toBe(STATUS_INTERNAL_SERVER_ERROR);

    const body = response.json<ErrorResponse>();
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body.error.code).toBe(ERROR_CODE.INTERNAL);
    expect(body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(body.error).not.toHaveProperty('fields');

    const lowerCaseBody = response.body.toLowerCase();
    for (const marker of LEAK_MARKERS) {
      expect(lowerCaseBody, marker).not.toContain(marker.toLowerCase());
    }

    // The full error did reach the server log.
    expect(loggedErrorCalls.length).toBeGreaterThan(0);
    const firstCall = required(loggedErrorCalls[0], 'a logged error call');
    const payload = required(firstCall[0], 'the logged error payload') as LoggedErrorPayload;
    expect(payload.err).toBeDefined();
    expect(typeof payload.err?.message).toBe('string');
    expect(payload.err?.stack).toBeDefined();
  });
});
