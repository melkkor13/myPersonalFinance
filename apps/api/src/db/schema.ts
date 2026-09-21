/**
 * Drizzle table definitions — **exactly** the two tables FR9 specifies, and
 * nothing more.
 *
 * `accounts`, `categories`, `transactions` and `budgets` are deliberately NOT
 * here (FR10): the scaffold proves the plumbing, not the domain. Acceptance
 * case 4 asserts the table list is exactly `users`, `refresh_tokens` and
 * drizzle-kit's `__drizzle_migrations`.
 *
 * Conventions this file locks in:
 *   - column names are `snake_case` (FR4);
 *   - ids are UUIDv7 strings stored as `TEXT` (see `seed.ts` / C2 — `v7()` from
 *     the `uuid` package, never `crypto.randomUUID`);
 *   - timestamps are `TEXT`, ISO-8601 UTC;
 *   - **no column is ever `REAL`** (money rule, ADR 0006). Money, when finance
 *     tables land, is `INTEGER` minor units with a `_minor` suffix.
 *
 * This file is engine-agnostic apart from importing `drizzle-orm/sqlite-core`,
 * which is the portable Drizzle dialect module and not one of the driver-specific
 * specifiers B2 confines to `sqlite.ts` and `client.ts`.
 *
 * The `sql` template below is used only to express a `CHECK` constraint, which
 * Drizzle has no declarative form for. It is DDL that drizzle-kit compiles into
 * `migrations/**`, not a query, so it does not breach FR8's "no raw SQL outside
 * `sqlite.ts` and `migrations/**`" rule for data access.
 */
import { CURRENCY_CODE_LENGTH } from '@finance/contracts';
import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/* ------------------------------------------------------------------ *
 * Named constants — table and constraint names
 * ------------------------------------------------------------------ */

/** Physical table names, referenced by tests and the reset/seed scripts. */
export const USERS_TABLE = 'users';
export const REFRESH_TOKENS_TABLE = 'refresh_tokens';

/** drizzle-kit's own bookkeeping table. Created by the migrator, not by us. */
export const DRIZZLE_MIGRATIONS_TABLE = '__drizzle_migrations';

/** Every table the scaffold's database is allowed to contain (FR9, case 4). */
export const EXPECTED_TABLES = [
  USERS_TABLE,
  REFRESH_TOKENS_TABLE,
  DRIZZLE_MIGRATIONS_TABLE,
] as const;

/** Name of the ISO-4217 length check on `users.default_currency`. */
const DEFAULT_CURRENCY_LENGTH_CHECK = 'default_currency_length_check';

/** `ON DELETE CASCADE` on `refresh_tokens.user_id` (FR9). */
const CASCADE_ON_DELETE = 'cascade';

/** How every timestamp column in this schema is encoded. */
export const TIMESTAMP_FORMAT = 'ISO-8601 UTC';

/** Render a timestamp in the one format this schema stores (`TIMESTAMP_FORMAT`). */
export function isoTimestamp(at: Date = new Date()): string {
  return at.toISOString();
}

/* ------------------------------------------------------------------ *
 * Tables (FR9)
 * ------------------------------------------------------------------ */

/**
 * The single user of the scaffold (FR16 — registration is a seed/CLI operation,
 * not a public endpoint). `default_currency` is the whole dataset's currency
 * (A2): one code, no per-account currency, no FX.
 */
export const users = sqliteTable(
  USERS_TABLE,
  {
    // Column keys are camelCase in TypeScript, snake_case in the DB (FR4). The
    // explicit second argument is the physical name; this is the declaration
    // site, so the strings are definitions rather than magic literals.
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    defaultCurrency: text('default_currency').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check(
      DEFAULT_CURRENCY_LENGTH_CHECK,
      sql`length(${table.defaultCurrency}) = ${sql.raw(String(CURRENCY_CODE_LENGTH))}`,
    ),
  ],
);

/**
 * DB-backed, revocable refresh tokens (FR7). Only the SHA-256 hash of a token is
 * ever stored; `revoked_at` is null while the token is live. Rows cascade away
 * with their user.
 */
export const refreshTokens = sqliteTable(REFRESH_TOKENS_TABLE, {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: CASCADE_ON_DELETE }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

/** Row types inferred from the schema, for the repository layer. */
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type NewRefreshTokenRow = typeof refreshTokens.$inferInsert;
