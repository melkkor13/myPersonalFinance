/**
 * Boot configuration (FR12) — Zod-validated, **fail-fast**.
 *
 * Contract with the rest of the app:
 *   - Invalid configuration is a **fatal** boot error. `loadConfig()` throws, and
 *     `index.ts` exits non-zero *before any port is bound* (FR8, edge case:
 *     missing/short `JWT_SECRET`). The thrown message always names the offending
 *     variable so the operator can fix it without reading source.
 *   - An unreachable **database** is deliberately NOT fatal (FR8). Nothing in this
 *     module opens, touches, or validates the DB; `DB_PATH` is carried as an opaque
 *     string. The server must still bind and report `db: "unavailable"` with 503.
 *
 * There is intentionally **no module-level singleton** here: importing this file has
 * no side effects, so `server.ts` can stay a pure factory (ADR 0003) and tests can
 * build a config explicitly. `index.ts` owns the one process-wide instance and hands
 * it to `buildServer()`.
 *
 * Every default, bound, and enum member below is a NAMED CONSTANT — the project's
 * no-magic-literals rule. Nothing in the schema is an inline literal.
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Named constants — defaults, bounds, and allowed values (FR12)
 * ------------------------------------------------------------------ */

/** `PORT` — HTTP listen port for the API. Web dev server uses Vite's 5173. */
export const DEFAULT_PORT = 3000;
/** Lowest bindable non-privileged-agnostic port we accept. */
export const PORT_MIN = 1;
/** Highest valid TCP port. */
export const PORT_MAX = 65_535;

/** `NODE_ENV` — the only three environments the scaffold recognises. */
export const NODE_ENV_DEVELOPMENT = 'development';
export const NODE_ENV_TEST = 'test';
export const NODE_ENV_PRODUCTION = 'production';
export const NODE_ENV_VALUES = [NODE_ENV_DEVELOPMENT, NODE_ENV_TEST, NODE_ENV_PRODUCTION] as const;
export const DEFAULT_NODE_ENV = NODE_ENV_DEVELOPMENT;

/** `DB_PATH` — SQLite file path. Tests override with `IN_MEMORY_DB_PATH`. */
export const DEFAULT_DB_PATH = './data/finance.db';
/** The sentinel SQLite treats as a private in-memory database (FR14). */
export const IN_MEMORY_DB_PATH = ':memory:';

/**
 * `JWT_SECRET` — HS256 signing key. **Required, no default.** A key shorter than
 * this is a fatal boot error (FR7, FR12).
 */
export const JWT_SECRET_MIN_LENGTH = 32;

/** `ACCESS_TOKEN_TTL` — access-token lifetime, `jose` duration syntax. */
export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
/** `REFRESH_TOKEN_TTL` — refresh-token lifetime, `jose` duration syntax. */
export const DEFAULT_REFRESH_TOKEN_TTL = '30d';

/** `LOG_LEVEL` — Pino levels, in descending severity. */
export const LOG_LEVEL_FATAL = 'fatal';
export const LOG_LEVEL_ERROR = 'error';
export const LOG_LEVEL_WARN = 'warn';
export const LOG_LEVEL_INFO = 'info';
export const LOG_LEVEL_DEBUG = 'debug';
export const LOG_LEVEL_TRACE = 'trace';
export const LOG_LEVEL_SILENT = 'silent';
export const LOG_LEVEL_VALUES = [
  LOG_LEVEL_FATAL,
  LOG_LEVEL_ERROR,
  LOG_LEVEL_WARN,
  LOG_LEVEL_INFO,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_TRACE,
  LOG_LEVEL_SILENT,
] as const;
export const DEFAULT_LOG_LEVEL = LOG_LEVEL_INFO;

/** Prefix on every fatal config error. Asserted by the boot-failure test. */
export const INVALID_CONFIG_MESSAGE_PREFIX = 'Invalid environment configuration';
/** Separator between the variable name and its failure reason. */
const ISSUE_NAME_SEPARATOR = ': ';
/** Bullet prefix for each offending variable. */
const ISSUE_BULLET = '\n  - ';
/** Shown when Zod reports an issue with no resolvable variable name. */
const UNKNOWN_VARIABLE_NAME = '<unknown>';
/** Clearer than Zod's default `expected string, received undefined`. */
const MISSING_VARIABLE_MESSAGE = 'is required but was not set';
/** Zod issue code for a value of the wrong type — including a wholly absent one. */
const INVALID_TYPE_ISSUE_CODE = 'invalid_type';

/** `package.json` relative to this module — FR12: `version` is not an env var. */
const PACKAGE_JSON_URL_PATH = '../package.json';
/** Used only if `package.json` somehow has no `version`; never fatal. */
const FALLBACK_APP_VERSION = '0.0.0';

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

const envSchema = z.object({
  PORT: z.coerce.number().int().min(PORT_MIN).max(PORT_MAX).default(DEFAULT_PORT),
  NODE_ENV: z.enum(NODE_ENV_VALUES).default(DEFAULT_NODE_ENV),
  DB_PATH: z.string().min(1).default(DEFAULT_DB_PATH),
  JWT_SECRET: z.string().min(JWT_SECRET_MIN_LENGTH),
  ACCESS_TOKEN_TTL: z.string().min(1).default(DEFAULT_ACCESS_TOKEN_TTL),
  REFRESH_TOKEN_TTL: z.string().min(1).default(DEFAULT_REFRESH_TOKEN_TTL),
  LOG_LEVEL: z.enum(LOG_LEVEL_VALUES).default(DEFAULT_LOG_LEVEL),
});

/** The validated, camelCase-keyed configuration object handed to `buildServer()`. */
export interface AppConfig {
  readonly port: number;
  readonly nodeEnv: (typeof NODE_ENV_VALUES)[number];
  readonly dbPath: string;
  readonly jwtSecret: string;
  readonly accessTokenTtl: string;
  readonly refreshTokenTtl: string;
  readonly logLevel: (typeof LOG_LEVEL_VALUES)[number];
  /** Read from `apps/api/package.json` at boot, for `HealthResponse.version`. */
  readonly version: string;
}

/** Raised for any configuration failure. `message` always names the variable(s). */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';

  constructor(
    message: string,
    /** Every offending variable name, e.g. `['JWT_SECRET']`. */
    readonly variables: readonly string[],
  ) {
    super(message);
  }
}

/**
 * `version` for `HealthResponse` (FR12). Resolved from `apps/api/package.json`
 * relative to this module, so it is correct whether running from `src/` or `dist/`.
 */
export function readAppVersion(): string {
  const raw = readFileSync(new URL(PACKAGE_JSON_URL_PATH, import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const version = z.object({ version: z.string().min(1) }).safeParse(parsed);
  return version.success ? version.data.version : FALLBACK_APP_VERSION;
}

/**
 * Validate `source` (defaults to `process.env`) and return the typed config.
 *
 * @throws ConfigValidationError naming every offending variable. Callers must NOT
 * recover — `index.ts` logs and exits non-zero before binding a port.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat `FOO=` (empty string) as "not set" so declared-but-blank vars fall back
  // to their defaults instead of failing a `min(1)` check with a confusing reason —
  // and so a blank JWT_SECRET reports "required", not "too short".
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') {
      present[key] = value;
    }
  }

  const result = envSchema.safeParse(present);

  if (!result.success) {
    const variables = result.error.issues.map(
      (issue) => issue.path.join('.') || UNKNOWN_VARIABLE_NAME,
    );
    const details = result.error.issues
      .map((issue, index) => {
        const name = variables[index] ?? UNKNOWN_VARIABLE_NAME;
        const reason =
          issue.code === INVALID_TYPE_ISSUE_CODE && !(name in present)
            ? MISSING_VARIABLE_MESSAGE
            : issue.message;
        return `${ISSUE_BULLET}${name}${ISSUE_NAME_SEPARATOR}${reason}`;
      })
      .join('');
    throw new ConfigValidationError(`${INVALID_CONFIG_MESSAGE_PREFIX}:${details}`, variables);
  }

  const env = result.data;

  return {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    dbPath: env.DB_PATH,
    jwtSecret: env.JWT_SECRET,
    accessTokenTtl: env.ACCESS_TOKEN_TTL,
    refreshTokenTtl: env.REFRESH_TOKEN_TTL,
    logLevel: env.LOG_LEVEL,
    version: readAppVersion(),
  };
}
