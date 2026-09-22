/**
 * Every literal the API test suite needs, as a named constant (project
 * convention: no inline magic values, in tests too).
 */

/** Long enough to satisfy `JWT_SECRET_MIN_LENGTH`; deliberately not a real secret. */
export const TEST_JWT_SECRET = 'test-jwt-secret-value-0123456789abcdef';

/** A second, different valid secret — used to forge a wrongly-signed token. */
export const TEST_WRONG_JWT_SECRET = 'other-jwt-secret-value-0123456789abcdef';

/** The user the integration suites log in as. */
export const TEST_USER_EMAIL = 'tester@example.com';
export const TEST_USER_PASSWORD = 'correct-horse-battery-staple';
export const TEST_USER_CURRENCY = 'USD';

/** A password that is valid per the contract but wrong for `TEST_USER_EMAIL`. */
export const TEST_WRONG_PASSWORD = 'wrong-horse-battery-staple';

/** An email that is well-formed but has no row in `users`. */
export const TEST_UNREGISTERED_EMAIL = 'nobody@example.com';

/** Access-token TTL used by the expiry suites. */
export const SHORT_ACCESS_TOKEN_TTL = '1s';

/** Slightly more than `SHORT_ACCESS_TOKEN_TTL` — JWT `exp` is second-granular. */
export const SHORT_ACCESS_TOKEN_WAIT_MS = 1_250;

/** Refresh-token TTL for the "already expired" suite. */
export const EXPIRED_REFRESH_TOKEN_TTL = '1s';

/** How far in the past an intentionally expired refresh token sits. */
export const PAST_OFFSET_MS = 60_000;

/** HTTP status codes asserted by the suites. */
export const STATUS_OK = 200;
export const STATUS_NO_CONTENT = 204;
export const STATUS_BAD_REQUEST = 400;
export const STATUS_UNAUTHORIZED = 401;
export const STATUS_NOT_FOUND = 404;
export const STATUS_INTERNAL_SERVER_ERROR = 500;
export const STATUS_SERVICE_UNAVAILABLE = 503;

/** HTTP verbs. */
export const METHOD_GET = 'GET';
export const METHOD_POST = 'POST';

/** Header names / values used when injecting. */
export const HEADER_AUTHORIZATION = 'authorization';
export const HEADER_CONTENT_TYPE = 'content-type';
export const HEADER_CONTENT_LENGTH = 'content-length';

/** A syntactically impossible Bearer token (case 31b). */
export const GARBAGE_ACCESS_TOKEN = 'garbage';

/** Port the config-fail-fast child process is told to use. Never actually bound. */
export const UNBOUND_TEST_PORT = 39_517;

/** Case 29's budget: the process must be dead well inside this. */
export const BOOT_FAILURE_BUDGET_MS = 2_000;

/** A `JWT_SECRET` that is present but shorter than the 32-char minimum. */
export const TOO_SHORT_JWT_SECRET = 'short-key1';

/** Exit code the entrypoint uses for a fatal boot failure. */
export const EXIT_CODE_SUCCESS = 0;

/** Prefix for the OS-temp directories the file-backed suites create. */
export const TEMP_DIR_PREFIX = 'finance-api-test-';

/** File name for a temp-dir SQLite database. Never inside the repo tree. */
export const TEMP_DB_FILE_NAME = 'scratch.db';

/** SQLite's own `journal_mode` reply for an in-memory database. */
export const JOURNAL_MODE_MEMORY = 'memory';

/** A file-backed path used only to drive `applyPragmas()` against a stub. */
export const STUB_FILE_DB_PATH = '/nonexistent/stub/finance.db';

/** SQLite column type names the schema convention cares about (case 14). */
export const COLUMN_TYPE_REAL = 'REAL';
export const COLUMN_TYPE_INTEGER = 'INTEGER';

/** Suffix marking an integer minor-units money column (ADR 0006). */
export const MONEY_COLUMN_SUFFIX = '_minor';

/** Substrings that must never appear in a 500 response body (case 35). */
export const LEAK_MARKER_STACK_FRAME = ' at ';
export const LEAK_MARKER_SELECT = 'select';
export const LEAK_MARKER_ABSOLUTE_PATH = '/Users/';
export const LEAK_MARKER_FILE_EXTENSION = '.ts';
export const LEAK_MARKER_NODE_MODULES = 'node_modules';

/** Finance tables that must NOT exist in the scaffold (case 4, FR10). */
export const FORBIDDEN_FINANCE_TABLES = [
  'accounts',
  'categories',
  'transactions',
  'budgets',
] as const;

/** `PRAGMA` statements the suites issue directly (`test/**` is exempt from B2). */
export const PRAGMA_TABLE_LIST_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
export const PRAGMA_FOREIGN_KEYS_QUERY = 'foreign_keys';
export const PRAGMA_JOURNAL_MODE_QUERY = 'journal_mode';

/** Media type every documented JSON response uses. */
export const MEDIA_TYPE_JSON = 'application/json';

/** OpenAPI document keys. */
export const OPENAPI_COMPONENT_REF_PREFIX = '#/components/schemas/';
/** `fastify-type-provider-zod@7` emits an input projection of every component. */
export const OPENAPI_INPUT_PROJECTION_SUFFIX = 'Input';

/* ------------------------------------------------------------------ *
 * Cloudflare Access (ADR 0010)
 * ------------------------------------------------------------------ */

/** The header Cloudflare Access injects. Twin of `HEADER_AUTHORIZATION`. */
export const HEADER_CF_ACCESS_ASSERTION = 'cf-access-jwt-assertion';
/** Header the SPA always sends; doubles as the CSRF defence in Access mode. */
export const HEADER_REQUEST_ID = 'x-request-id';

/** A plausible team domain. Never resolved — the suite injects a local JWKS. */
export const TEST_CF_ACCESS_TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
/** A different account, for the wrong-issuer case. */
export const TEST_CF_ACCESS_WRONG_ISSUER = 'https://other-team.cloudflareaccess.com';

/** This application's AUD tag: 64 lowercase hex, as `config.ts` demands. */
export const TEST_CF_ACCESS_AUD = 'a'.repeat(64);
/** A *different* Access application in the same account — must still be refused. */
export const TEST_CF_ACCESS_OTHER_AUD = 'b'.repeat(64);

/** The human Cloudflare reports. Distinct from `TEST_USER_EMAIL`. */
export const TEST_CF_ACCESS_EMAIL = 'access-user@example.com';
/** Same address as `TEST_CF_ACCESS_EMAIL`, differently cased (normalisation case). */
export const TEST_CF_ACCESS_EMAIL_MIXED_CASE = 'Access-User@Example.COM';
/** Cloudflare's opaque identity id for the test human. */
export const TEST_CF_ACCESS_SUBJECT = 'cf-identity-0123456789';
/** A service token carries this instead of `email`, and must be refused. */
export const TEST_CF_ACCESS_COMMON_NAME = 'ci-robot.example.com';

/** Not a JWT at all. */
export const GARBAGE_CF_ACCESS_ASSERTION = 'garbage-assertion';
/** Lifetime for the assertion-expiry case. */
export const SHORT_CF_ACCESS_TTL = '1s';
