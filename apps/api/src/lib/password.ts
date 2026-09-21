/**
 * Password hashing — the single entry point for Argon2id (FR7).
 *
 * Argon2id via `@node-rs/argon2`, exclusively. No other hashing scheme appears
 * anywhere in this repository, and acceptance case 20 greps every manifest and
 * source file to prove it.
 *
 * Framework-agnostic: no Fastify, no Drizzle, no config. `auth.service.ts` and
 * `db/seed.ts` both call in here so there is exactly one place that decides how a
 * password becomes a hash.
 */
import { hash, verify } from '@node-rs/argon2';

/* ------------------------------------------------------------------ *
 * Named constants
 * ------------------------------------------------------------------ */

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2`, pinned as its numeric value.
 *
 * Two reasons it is a literal rather than an import:
 *   - the package ships `Algorithm` as an **ambient const enum**, which
 *     `isolatedModules` forbids importing as a value, and whose runtime export is
 *     an empty object — `Algorithm.Argon2id` fails typecheck here;
 *   - Argon2id is **already the default** in 2.2.1 (C1 — verified: a bare
 *     `hash("pw")` returns `$argon2id$…`). Passing it explicitly is defensive
 *     documentation that pins the variant against a future default change. It is
 *     not fixing a wrong-variant bug; there is no such bug.
 */
const ARGON2ID_ALGORITHM = 2;

/** Every Argon2id encoded hash begins with this. Asserted by acceptance case 20. */
export const ARGON2ID_HASH_PREFIX = '$argon2id$';

/** Options handed to every `hash()` call, so no two call sites can drift. */
const ARGON2ID_HASH_OPTIONS = { algorithm: ARGON2ID_ALGORITHM } as const;

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/**
 * Hash a plaintext password for storage in `users.password_hash`.
 *
 * The salt is generated internally by `@node-rs/argon2` and embedded in the
 * returned PHC string, so two calls with the same password return different
 * hashes. The result always starts with {@link ARGON2ID_HASH_PREFIX}.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID_HASH_OPTIONS);
}

/**
 * Check a plaintext password against a stored hash.
 *
 * Argument order mirrors the underlying library: the **stored hash first**, the
 * user-supplied secret second.
 *
 * A malformed or truncated stored hash resolves `false` rather than throwing:
 * to the caller it is an authentication failure like any other, and login must
 * stay indistinguishable across every failure reason (acceptance case 32).
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** True when `value` looks like an Argon2id PHC string. Used by seeds and tests. */
export function isArgon2idHash(value: string): boolean {
  return value.startsWith(ARGON2ID_HASH_PREFIX);
}
