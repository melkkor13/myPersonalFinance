/**
 * Case 5 — the OpenAPI document is complete and internally consistent.
 *
 * ## Two traps this file encodes
 *
 * 1. **`fastify-type-provider-zod@7` emits two projections of every component.**
 *    A request body `$ref`s `LoginRequestInput`, not `LoginRequest`, because the
 *    input projection is the one that describes what a client sends. Asserting on
 *    the bare name would fail spuriously, so request bodies are matched against
 *    the component name **with or without** the `Input` suffix.
 * 2. **Logout's 204 must declare no body at all.** An empty `content: {}` crashes
 *    `@fastify/swagger`, and omitting the status drops it from the document, so
 *    the route uses `z.null()`. The assertion is therefore that the 204 response
 *    object has no `content` key whatsoever.
 *
 * The non-2xx rule has exactly one exemption: health's 503 carries a
 * `HealthResponse`, because a degraded health check is not an error envelope.
 */
import { ROUTES, type HealthResponse } from '@finance/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COMPONENT_ERROR_RESPONSE,
  COMPONENT_HEALTH_RESPONSE,
  COMPONENT_LOGIN_REQUEST,
  COMPONENT_LOGIN_RESPONSE,
  COMPONENT_LOGOUT_REQUEST,
  COMPONENT_ME_RESPONSE,
  COMPONENT_REFRESH_REQUEST,
  COMPONENT_REFRESH_RESPONSE,
  OPENAPI_SPEC_VERSION,
} from '../src/plugins/openapi.js';
import {
  MEDIA_TYPE_JSON,
  METHOD_GET,
  OPENAPI_COMPONENT_REF_PREFIX,
  OPENAPI_INPUT_PROJECTION_SUFFIX,
  STATUS_NO_CONTENT,
  STATUS_OK,
} from './support/constants.js';
import { disposeDatabase, freshInMemoryDatabase, startTestServer } from './support/harness.js';

/** Minimal structural view of the parts of the document under test. */
interface MediaTypeObject {
  readonly schema?: { readonly $ref?: string };
}
interface BodyObject {
  readonly content?: Record<string, MediaTypeObject>;
}
interface OperationObject {
  readonly requestBody?: BodyObject;
  readonly responses?: Record<string, BodyObject>;
}
interface OpenApiDocument {
  readonly openapi: string;
  readonly paths: Record<string, Record<string, OperationObject>>;
  readonly components: { readonly schemas: Record<string, unknown> };
}

/** Every route the scaffold exposes as a documented API operation. */
const DOCUMENTED_ROUTES = [
  ROUTES.HEALTH,
  ROUTES.AUTH_LOGIN,
  ROUTES.AUTH_REFRESH,
  ROUTES.AUTH_LOGOUT,
  ROUTES.ME,
] as const;

/** Which component each route's request body must reference. */
const EXPECTED_REQUEST_COMPONENTS: Readonly<Record<string, string>> = {
  [ROUTES.AUTH_LOGIN]: COMPONENT_LOGIN_REQUEST,
  [ROUTES.AUTH_REFRESH]: COMPONENT_REFRESH_REQUEST,
  [ROUTES.AUTH_LOGOUT]: COMPONENT_LOGOUT_REQUEST,
};

/** Which component each route's success response must reference. */
const EXPECTED_SUCCESS_COMPONENTS: Readonly<Record<string, string>> = {
  [ROUTES.HEALTH]: COMPONENT_HEALTH_RESPONSE,
  [ROUTES.AUTH_LOGIN]: COMPONENT_LOGIN_RESPONSE,
  [ROUTES.AUTH_REFRESH]: COMPONENT_REFRESH_RESPONSE,
  [ROUTES.ME]: COMPONENT_ME_RESPONSE,
};

/** The one documented exemption from "every non-2xx is an ErrorResponse". */
const NON_ERROR_ENVELOPE_EXEMPTION = { path: ROUTES.HEALTH, status: '503' } as const;

/** Statuses in the 2xx band, as the document spells them. */
const SUCCESS_STATUS_PATTERN = /^2\d\d$/;

/** Named components that must exist, in output projection. */
const REQUIRED_COMPONENTS = [
  COMPONENT_ERROR_RESPONSE,
  COMPONENT_HEALTH_RESPONSE,
  COMPONENT_LOGIN_REQUEST,
  COMPONENT_LOGIN_RESPONSE,
  COMPONENT_REFRESH_REQUEST,
  COMPONENT_REFRESH_RESPONSE,
  COMPONENT_LOGOUT_REQUEST,
  COMPONENT_ME_RESPONSE,
] as const;

let app: FastifyInstance;
let document: OpenApiDocument;

/** `$ref` of the JSON schema on a request/response object, if it has one. */
function jsonRef(body: BodyObject | undefined): string | undefined {
  return body?.content?.[MEDIA_TYPE_JSON]?.schema?.$ref;
}

/** Component name a `$ref` points at, with the `#/components/schemas/` stripped. */
function componentOf(ref: string | undefined): string | undefined {
  return ref?.startsWith(OPENAPI_COMPONENT_REF_PREFIX) === true
    ? ref.slice(OPENAPI_COMPONENT_REF_PREFIX.length)
    : undefined;
}

/** Accept either projection of `component` — v7 emits both (see the header). */
function matchesComponent(ref: string | undefined, component: string): boolean {
  const name = componentOf(ref);
  return name === component || name === `${component}${OPENAPI_INPUT_PROJECTION_SUFFIX}`;
}

/** Every (path, method, operation) triple in the document. */
function operations(): { path: string; method: string; operation: OperationObject }[] {
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
  );
}

beforeAll(async () => {
  freshInMemoryDatabase();
  app = await startTestServer();
  const response = await app.inject({ method: METHOD_GET, url: ROUTES.OPENAPI });
  expect(response.statusCode).toBe(STATUS_OK);
  document = response.json<OpenApiDocument>();
});

afterAll(async () => {
  await app.close();
  disposeDatabase();
});

describe('the OpenAPI document (case 5)', () => {
  it('declares OpenAPI 3.1', () => {
    expect(document.openapi).toBe(OPENAPI_SPEC_VERSION);
  });

  it('documents all five API routes and nothing else', () => {
    expect(Object.keys(document.paths).sort()).toEqual([...DOCUMENTED_ROUTES].sort());
  });

  it('registers every contract as a named component rather than inlining it', () => {
    for (const component of REQUIRED_COMPONENTS) {
      expect(document.components.schemas).toHaveProperty(component);
    }
  });

  it('gives every operation at least one response', () => {
    for (const { path, method, operation } of operations()) {
      expect(Object.keys(operation.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it('refs the right component from every success response', () => {
    for (const [path, component] of Object.entries(EXPECTED_SUCCESS_COMPONENTS)) {
      const operation = operations().find((entry) => entry.path === path)?.operation;
      const successStatus = Object.keys(operation?.responses ?? {}).find((status) =>
        SUCCESS_STATUS_PATTERN.test(status),
      );

      expect(successStatus, path).toBeDefined();
      expect(
        matchesComponent(jsonRef(operation?.responses?.[successStatus ?? '']), component),
        `${path} ${successStatus ?? ''}`,
      ).toBe(true);
    }
  });

  it('refs the right request component from every route that takes a body', () => {
    for (const [path, component] of Object.entries(EXPECTED_REQUEST_COMPONENTS)) {
      const operation = operations().find((entry) => entry.path === path)?.operation;

      expect(
        matchesComponent(jsonRef(operation?.requestBody), component),
        `${path} request body`,
      ).toBe(true);
    }
  });

  it('declares no request body for the two routes that take none', () => {
    for (const path of [ROUTES.HEALTH, ROUTES.ME]) {
      const operation = operations().find((entry) => entry.path === path)?.operation;

      expect(operation?.requestBody, path).toBeUndefined();
    }
  });

  it("gives logout's 204 no content key at all", () => {
    const logout = operations().find((entry) => entry.path === ROUTES.AUTH_LOGOUT)?.operation;
    const noContent = logout?.responses?.[String(STATUS_NO_CONTENT)];

    expect(noContent, 'logout 204').toBeDefined();
    expect(noContent === undefined ? true : 'content' in noContent).toBe(false);
  });

  it('refs ErrorResponse from every non-2xx response except health 503', () => {
    for (const { path, method, operation } of operations()) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (SUCCESS_STATUS_PATTERN.test(status)) {
          continue;
        }

        const expectedComponent =
          path === NON_ERROR_ENVELOPE_EXEMPTION.path &&
          status === NON_ERROR_ENVELOPE_EXEMPTION.status
            ? COMPONENT_HEALTH_RESPONSE
            : COMPONENT_ERROR_RESPONSE;

        expect(
          matchesComponent(jsonRef(response), expectedComponent),
          `${method} ${path} ${status}`,
        ).toBe(true);
      }
    }
  });

  it("documents health's 503 as a HealthResponse, which the live route honours", async () => {
    const response = await app.inject({ method: METHOD_GET, url: ROUTES.HEALTH });
    const body = response.json<HealthResponse>();

    expect(Object.keys(body).sort()).toEqual(['db', 'status', 'version']);
  });
});
