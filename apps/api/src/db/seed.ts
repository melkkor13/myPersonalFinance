/**
 * `npm run db:seed` — creates the scaffold's single user (FR16).
 *
 * Registration is a seed/CLI operation, not a public endpoint (A5). This script
 * is **repeatable**: if the seed user already exists it changes nothing and exits
 * 0 (acceptance case 9), so it is safe to chain after `db:migrate` or `db:reset`.
 *
 * ## Two traps this file exists to avoid
 *   - **C2:** `crypto.randomUUID({ version: 7 })` silently returns a **v4** — the
 *     option is ignored and nothing throws, so non-time-ordered ids would ship
 *     undetected. Ids come from `uuid`'s `v7()`, always.
 *   - **Argon2id:** it is already the default in `@node-rs/argon2@2.2.1` (C1),
 *     but the algorithm is passed explicitly to pin the behaviour against a future
 *     default change. The stored hash must start with `$argon2id$` (case 20).
 *
 * Hashing itself lives in `src/lib/password.ts`, the single Argon2id entry point
 * shared with the auth service — this script owns the seed identity, not the
 * hashing policy, so the algorithm constant lives there and only there.
 */
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { hashPassword } from '../lib/password.js';
import { createOwnedDb } from './client.js';
import { isEntryPoint, printLine } from './cli.js';
import { isoTimestamp, users } from './schema.js';
import { resolveDbPath } from './sqlite.js';

/* ------------------------------------------------------------------ *
 * Named constants — the seed identity (FR16)
 * ------------------------------------------------------------------ */

/** Default email for the single seeded user. Overridable via `SEED_USER_EMAIL`. */
export const SEED_USER_EMAIL = 'owner@example.com';

/**
 * Default password. Overridable via `SEED_USER_PASSWORD`.
 *
 * It is a **known, published** value, which was acceptable while assumption A4
 * (localhost-only) held. Any deployment reachable from another machine must set
 * `SEED_USER_PASSWORD` before seeding: there is no rate limiting on `/auth/*`
 * (docs/deferred.md), so a known credential is a known way in.
 */
export const SEED_USER_PASSWORD = 'change-me-please-123';

/** Env vars that override the seed identity. Read by this script and nothing else. */
export const SEED_USER_EMAIL_ENV_VAR = 'SEED_USER_EMAIL';
export const SEED_USER_PASSWORD_ENV_VAR = 'SEED_USER_PASSWORD';

/**
 * Whole-dataset currency (A2). ISO-4217 alpha-3, matching the schema's
 * `CHECK(length(default_currency) = CURRENCY_CODE_LENGTH)`.
 */
export const SEED_USER_DEFAULT_CURRENCY = 'USD';

/** CLI output. */
const SEED_CREATED_MESSAGE = 'Seeded user';
const SEED_EXISTS_MESSAGE = 'Seed user already exists, nothing to do';
const MESSAGE_SEPARATOR = ': ';

/** The identity the seed script will create, after applying env overrides. */
export interface SeedIdentity {
  readonly email: string;
  readonly password: string;
}

/**
 * The hardcoded pair, as a `SeedIdentity`. This — not the environment — is
 * `seed()`'s default, which keeps the test suite hermetic: a stray
 * `SEED_USER_PASSWORD` exported in a developer's shell must not change what
 * `npm test` seeds. Only the CLI entry point at the bottom of this file consults
 * the environment.
 */
export const DEFAULT_SEED_IDENTITY: SeedIdentity = {
  email: SEED_USER_EMAIL,
  password: SEED_USER_PASSWORD,
};

/**
 * Resolve the seed identity from the environment, falling back to
 * {@link DEFAULT_SEED_IDENTITY}.
 *
 * Follows `resolveDbPath()` in `sqlite.ts`: read the one or two variables this
 * script needs rather than going through `loadConfig()`, which would make a
 * valid `JWT_SECRET` a prerequisite for seeding. An empty string is treated as
 * unset, matching `config.ts`, so `SEED_USER_PASSWORD=` in a `.env` falls back
 * to the default instead of creating a user with a blank password.
 */
export function resolveSeedIdentity(env: NodeJS.ProcessEnv = process.env): SeedIdentity {
  const email = env[SEED_USER_EMAIL_ENV_VAR];
  const password = env[SEED_USER_PASSWORD_ENV_VAR];

  return {
    email: email === undefined || email === '' ? SEED_USER_EMAIL : email,
    password: password === undefined || password === '' ? SEED_USER_PASSWORD : password,
  };
}

/** Result of a seed run, so callers/tests can tell creation from a no-op. */
export interface SeedResult {
  readonly email: string;
  readonly created: boolean;
}

/**
 * Create the seed user if absent.
 *
 * @param identity whom to create; defaults to {@link DEFAULT_SEED_IDENTITY}.
 * The CLI entry point passes `resolveSeedIdentity()` so that `SEED_USER_EMAIL` /
 * `SEED_USER_PASSWORD` apply to `db:seed` and to the container, and nowhere else.
 * @returns `created: false` when a user with that email already existed.
 */
export async function seed(
  dbPath: string = resolveDbPath(),
  identity: SeedIdentity = DEFAULT_SEED_IDENTITY,
): Promise<SeedResult> {
  const owned = createOwnedDb(dbPath);
  const { db } = owned;

  try {
    const existing = db.select().from(users).where(eq(users.email, identity.email)).all();

    if (existing.length > 0) {
      return { email: identity.email, created: false };
    }

    const passwordHash = await hashPassword(identity.password);

    db.insert(users)
      .values({
        id: uuidv7(),
        email: identity.email,
        passwordHash,
        defaultCurrency: SEED_USER_DEFAULT_CURRENCY,
        createdAt: isoTimestamp(),
      })
      // Belt and braces against a concurrent seed; the check above is the
      // primary guard for the "repeatable" requirement (case 9).
      .onConflictDoNothing({ target: users.email })
      .run();

    return { email: identity.email, created: true };
  } finally {
    owned.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  const result = await seed(resolveDbPath(), resolveSeedIdentity());
  printLine(
    `${result.created ? SEED_CREATED_MESSAGE : SEED_EXISTS_MESSAGE}${MESSAGE_SEPARATOR}${result.email}`,
  );
}
