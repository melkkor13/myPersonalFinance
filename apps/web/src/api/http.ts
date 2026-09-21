import { ErrorResponseSchema } from '@finance/contracts';
import { v7 as uuidv7 } from 'uuid';

import {
  API_BASE_URL,
  BEARER_SCHEME_PREFIX,
  CONTENT_TYPE_JSON,
  HEADER_AUTHORIZATION,
  HEADER_CONTENT_TYPE,
  HEADER_REQUEST_ID,
  HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_UNAUTHORIZED,
  SUCCESS_STATUS_MAX,
  SUCCESS_STATUS_MIN,
  UNEXPECTED_RESPONSE_MESSAGE,
  type HttpMethod,
} from './constants';
import { ApiError } from './errors';
import { getAccessToken } from './tokens';

/**
 * The single low-level transport: one `fetch`, no retry, no refresh.
 *
 * `refresh.ts` is built on this (so refreshing can never recurse into itself)
 * and `client.ts` layers the 401 → refresh → retry-once behaviour on top.
 */

export interface RequestOptions {
  readonly method: HttpMethod;
  /** JSON-serialised when present. */
  readonly body?: unknown;
  /** Attach `Authorization: Bearer <access token>` when one is held. */
  readonly withAuth?: boolean;
  /**
   * Non-2xx statuses whose body is still a valid success payload. Only
   * `/api/v1/health` needs this (503 carries a `HealthResponse`).
   */
  readonly acceptStatuses?: readonly number[];
}

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

function isSuccessStatus(status: number, acceptStatuses: readonly number[]): boolean {
  if (status >= SUCCESS_STATUS_MIN && status <= SUCCESS_STATUS_MAX) {
    return true;
  }
  return acceptStatuses.includes(status);
}

function buildHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { [HEADER_REQUEST_ID]: uuidv7() };

  if (options.body !== undefined) {
    headers[HEADER_CONTENT_TYPE] = CONTENT_TYPE_JSON;
  }

  if (options.withAuth === true) {
    const token = getAccessToken();
    if (token !== null) {
      headers[HEADER_AUTHORIZATION] = `${BEARER_SCHEME_PREFIX}${token}`;
    }
  }

  return headers;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Turns a failed response into an `ApiError`, using the FR5 envelope if present. */
async function toApiError(response: Response): Promise<ApiError> {
  const payload = await readJsonBody(response);
  const parsed = ErrorResponseSchema.safeParse(payload);

  if (parsed.success) {
    return new ApiError(response.status, parsed.data.error.message, parsed.data.error);
  }

  return new ApiError(response.status, `${UNEXPECTED_RESPONSE_MESSAGE}${String(response.status)}`);
}

/**
 * Issues exactly one request.
 *
 * @throws ApiError on any status that is neither 2xx nor explicitly accepted.
 */
export async function rawRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const init: RequestInit = { method: options.method, headers: buildHeaders(options) };

  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(apiUrl(path), init);

  if (!isSuccessStatus(response.status, options.acceptStatuses ?? [])) {
    throw await toApiError(response);
  }

  if (response.status === HTTP_STATUS_NO_CONTENT) {
    // The logout route answers 204 with no body (an FR5 contract exemption).
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** True for the one status that should trigger the single-flight refresh. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === HTTP_STATUS_UNAUTHORIZED;
}
