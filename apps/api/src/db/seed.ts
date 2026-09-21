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

/** Known email for the single seeded user. */
export const SEED_USER_EMAIL = 'owner@example.com';

/** Known password. Localhost-only scaffold (A4); never used outside seeding. */
export const SEED_USER_PASSWORD = 'change-me-please-123';

/**
 * Whole-dataset currency (A2). ISO-4217 alpha-3, matching the schema's
 * `CHECK(length(default_currency) = CURRENCY_CODE_LENGTH)`.
 */
export const SEED_USER_DEFAULT_CURRENCY = 'USD';

/** CLI output. */
const SEED_CREATED_MESSAGE = 'Seeded user';
const SEED_EXISTS_MESSAGE = 'Seed user already exists, nothing to do';
const MESSAGE_SEPARATOR = ': ';

/** Result of a seed run, so callers/tests can tell creation from a no-op. */
export interface SeedResult {
  readonly email: string;
  readonly created: boolean;
}

/**
 * Create the seed user if absent.
 *
 * @returns `created: false` when a user with `SEED_USER_EMAIL` already existed.
 */
export async function seed(dbPath: string = resolveDbPath()): Promise<SeedResult> {
  const owned = createOwnedDb(dbPath);
  const { db } = owned;

  try {
    const existing = db.select().from(users).where(eq(users.email, SEED_USER_EMAIL)).all();

    if (existing.length > 0) {
      return { email: SEED_USER_EMAIL, created: false };
    }

    const passwordHash = await hashPassword(SEED_USER_PASSWORD);

    db.insert(users)
      .values({
        id: uuidv7(),
        email: SEED_USER_EMAIL,
        passwordHash,
        defaultCurrency: SEED_USER_DEFAULT_CURRENCY,
        createdAt: isoTimestamp(),
      })
      // Belt and braces against a concurrent seed; the check above is the
      // primary guard for the "repeatable" requirement (case 9).
      .onConflictDoNothing({ target: users.email })
      .run();

    return { email: SEED_USER_EMAIL, created: true };
  } finally {
    owned.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  const result = await seed();
  printLine(
    `${result.created ? SEED_CREATED_MESSAGE : SEED_EXISTS_MESSAGE}${MESSAGE_SEPARATOR}${result.email}`,
  );
}
