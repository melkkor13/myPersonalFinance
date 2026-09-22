/**
 * The shared API test harness (FR14).
 *
 * Rules this file enforces so individual suites do not have to:
 *
 *   - **Real SQLite, never mocked.** Every database is a real `:memory:`
 *     `better-sqlite3` connection with the committed migrations applied through
 *     `runMigrations()` from `db/client.ts` — the suites never import the driver
 *     or the migrator themselves.
 *   - **Nothing on disk.** `:memory:` everywhere. The two suites that genuinely
 *     need a file-backed database use `createTempDatabasePath()`, which lives in
 *     the OS temp directory, and `removeTempDatabase()` to clean it up. No
 *     `.db`/`.db-wal`/`.db-shm` file is ever created inside the repository (case 23).
 *   - **The process-wide connection cache is reset explicitly.**
 *     `src/db/sqlite.ts` caches one connection per process, so
 *     `freshInMemoryDatabase()` calls `closeDb()` before opening, which drops both
 *     that cache and the Drizzle handle in `src/db/client.ts`. Combined with
 *     `pool: 'forks'` + `isolate: true` (see `vitest.config.ts`) this is what makes
 *     a per-test clean database possible at all.
 *
 * `test/**` is exempt from rule B2 (C16), so importing `db/sqlite.js` and issuing
 * `PRAGMA` from here is deliberate and allowed.
 */
import { LoginRequestSchema, type LoginResponse } from '@finance/contracts';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import {
  DEFAULT_ACCESS_TOKEN_TTL,
  DEFAULT_REFRESH_TOKEN_TTL,
  IN_MEMORY_DB_PATH,
  LOG_LEVEL_SILENT,
  NODE_ENV_TEST,
  readAppVersion,
  type AppConfig,
} from '../../src/config.js';
import { closeDb, createDb, getDb, runMigrations, type Db } from '../../src/db/client.js';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate.js';
import { isoTimestamp, refreshTokens, users } from '../../src/db/schema.js';
import {
  getConnection,
  openConnection,
  SHM_FILE_SUFFIX,
  WAL_FILE_SUFFIX,
  type SqliteConnection,
} from '../../src/db/sqlite.js';
import { hashPassword } from '../../src/lib/password.js';
import { hashRefreshToken } from '../../src/lib/tokens.js';
import { createCfAccessVerifier } from '../../src/lib/cloudflare-access.js';
import { buildServer, type ServerDependencies } from '../../src/server.js';
import { type CfAccessTestKeys } from './cf-access-tokens.js';
import {
  HEADER_AUTHORIZATION,
  METHOD_POST,
  TEMP_DB_FILE_NAME,
  TEMP_DIR_PREFIX,
  TEST_JWT_SECRET,
  TEST_USER_CURRENCY,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
  UNBOUND_TEST_PORT,
  TEST_CF_ACCESS_AUD,
  TEST_CF_ACCESS_TEAM_DOMAIN,
} from './constants.js';

/** Message prefix used when a value a test depends on is unexpectedly absent. */
const MISSING_VALUE_MESSAGE = 'is required by this test but was missing';

/** Bearer prefix used when injecting an `Authorization` header. */
const BEARER_PREFIX = 'Bearer ';

/* ------------------------------------------------------------------ *
 * Assertions that narrow types without `!`
 * ------------------------------------------------------------------ */

/** Narrow away `null`/`undefined`, failing the test loudly if present. */
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} ${MISSING_VALUE_MESSAGE}`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * A complete, valid `AppConfig` pointed at `:memory:`.
 *
 * `logLevel` is silent by default so a green run is quiet; the suite that asserts
 * on the server log overrides it.
 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: UNBOUND_TEST_PORT,
    nodeEnv: NODE_ENV_TEST,
    dbPath: IN_MEMORY_DB_PATH,
    jwtSecret: TEST_JWT_SECRET,
    accessTokenTtl: DEFAULT_ACCESS_TOKEN_TTL,
    refreshTokenTtl: DEFAULT_REFRESH_TOKEN_TTL,
    logLevel: LOG_LEVEL_SILENT,
    // Access is OFF by default, which is what keeps every pre-existing suite
    // unchanged: the `Cf-Access-Jwt-Assertion` header is ignored outright unless
    // a test opts in via `startCfAccessServer`.
    cfAccessEnabled: false,
    version: readAppVersion(),
  };
  return { ...base, ...overrides };
}

/**
 * Build and `ready()` a server for `inject()`. Never binds a port — `buildServer`
 * has no `.listen()` call, which is exactly why `inject()` is the harness.
 */
export async function startTestServer(
  overrides: Partial<AppConfig> = {},
  deps: ServerDependencies = {},
): Promise<FastifyInstance> {
  const app = buildServer(testConfig(overrides), deps);
  await app.ready();
  return app;
}

/**
 * A server with Cloudflare Access enabled and its verifier pointed at a
 * **locally generated** key pair, so nothing touches the network.
 *
 * The injected verifier is the reason `buildServer` takes `ServerDependencies`:
 * the real one resolves keys from `https://<team>/cdn-cgi/access/certs`.
 */
export async function startCfAccessServer(
  keys: CfAccessTestKeys,
  overrides: Partial<AppConfig> = {},
): Promise<FastifyInstance> {
  const config = testConfig({
    cfAccessEnabled: true,
    cfAccessTeamDomain: TEST_CF_ACCESS_TEAM_DOMAIN,
    cfAccessAud: TEST_CF_ACCESS_AUD,
    ...overrides,
  });
  const app = buildServer(config, {
    cfAccessVerifier: createCfAccessVerifier(
      { cfAccessTeamDomain: TEST_CF_ACCESS_TEAM_DOMAIN, cfAccessAud: TEST_CF_ACCESS_AUD },
      keys.jwks,
    ),
  });
  await app.ready();
  return app;
}

/* ------------------------------------------------------------------ *
 * In-memory databases
 * ------------------------------------------------------------------ */

/** A freshly migrated database plus the live connection behind it. */
export interface TestDatabase {
  readonly connection: SqliteConnection;
  readonly db: Db;
}

/**
 * Drop the process-wide caches, open a brand-new private `:memory:` database and
 * apply every committed migration to it.
 *
 * The returned handle is the same one the repositories will reach through
 * `getDb(config.dbPath)`, because `config.dbPath` is `:memory:` and the cache is
 * now primed with it. Nothing touches the filesystem.
 */
export function freshInMemoryDatabase(): TestDatabase {
  closeDb();
  const connection = getConnection(IN_MEMORY_DB_PATH);
  const db = getDb(IN_MEMORY_DB_PATH);
  runMigrations(db, MIGRATIONS_FOLDER);
  return { connection, db };
}

/** Release the process-wide connection. Safe to call when none is open. */
export function disposeDatabase(): void {
  closeDb();
}

/**
 * An independent, migrated `:memory:` database that is NOT the shared one.
 *
 * Used by the schema/migration suites, which assert facts about a database
 * without any server attached.
 */
export function independentInMemoryDatabase(): TestDatabase {
  const connection = openConnection(IN_MEMORY_DB_PATH);
  const db = createDb(connection);
  runMigrations(db, MIGRATIONS_FOLDER);
  return { connection, db };
}

/**
 * Wrap an already-existing database at `dbPath` without migrating it.
 *
 * Used by the migration and seed suites to inspect a temp-dir file database
 * between CLI runs. Goes through `openConnection()` so the suites never import
 * `better-sqlite3` themselves.
 */
export function openExistingDatabase(dbPath: string): TestDatabase {
  const connection = openConnection(dbPath);
  return { connection, db: createDb(connection) };
}

/* ------------------------------------------------------------------ *
 * File-backed databases — OS temp directory only
 * ------------------------------------------------------------------ */

/** A temp-dir database path. NEVER inside the repository tree (case 23). */
export function createTempDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX)), TEMP_DB_FILE_NAME);
}

/** Delete a temp database and its WAL/SHM sidecars, then its directory. */
export function removeTempDatabase(dbPath: string): void {
  for (const suffix of ['', WAL_FILE_SUFFIX, SHM_FILE_SUFFIX]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  rmSync(join(dbPath, '..'), { force: true, recursive: true });
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The row shape tests assert against, in DB (camelCase key) terms. */
export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
}

/**
 * Insert one user with a real Argon2id hash.
 *
 * Deliberately NOT `db/seed.ts`: `seed()` opens its own connection via
 * `createOwnedDb()`, and for `:memory:` that is a second, unmigrated database.
 * `db-seed.test.ts` exercises `seed()` properly, against a temp-dir file.
 */
export async function createTestUser(
  db: Db,
  email: string = TEST_USER_EMAIL,
  password: string = TEST_USER_PASSWORD,
): Promise<TestUser> {
  const user: TestUser = { id: uuidv7(), email, passwordHash: await hashPassword(password) };
  db.insert(users)
    .values({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      defaultCurrency: TEST_USER_CURRENCY,
      createdAt: isoTimestamp(),
    })
    .run();
  return user;
}

/**
 * Store a refresh token whose `expires_at` is already in the past, so the service
 * must reject it on the expiry branch rather than the revoked branch (case 34).
 */
export function insertExpiredRefreshToken(
  db: Db,
  userId: string,
  token: string,
  pastMs: number,
): void {
  db.insert(refreshTokens)
    .values({
      id: uuidv7(),
      userId,
      tokenHash: hashRefreshToken(token),
      expiresAt: isoTimestamp(new Date(Date.now() - pastMs)),
      revokedAt: null,
      createdAt: isoTimestamp(),
    })
    .run();
}

/* ------------------------------------------------------------------ *
 * Injection helpers
 * ------------------------------------------------------------------ */

/** `Authorization: Bearer <token>` header object. */
export function bearer(token: string): Record<string, string> {
  return { [HEADER_AUTHORIZATION]: `${BEARER_PREFIX}${token}` };
}

/** Log in over HTTP and return the parsed, contract-shaped token pair. */
export async function login(
  app: FastifyInstance,
  url: string,
  email: string = TEST_USER_EMAIL,
  password: string = TEST_USER_PASSWORD,
): Promise<LoginResponse> {
  const response = await app.inject({
    method: METHOD_POST,
    url,
    payload: LoginRequestSchema.parse({ email, password }),
  });
  return response.json<LoginResponse>();
}
