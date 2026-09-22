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
import { randomBytes } from 'node:crypto';

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

/**
 * Bytes of CSPRNG entropy behind an unusable password (see
 * {@link unusablePassword}). 32 bytes is the same budget as a refresh token.
 */
export const UNUSABLE_PASSWORD_BYTES = 32;
/** Encoding of the discarded plaintext. Never persisted; only its hash is. */
const UNUSABLE_PASSWORD_ENCODING = 'base64url';

/**
 * A password nobody holds, for an account that authenticates **only** through
 * Cloudflare Access (ADR 0010): random bytes, returned once so the caller can
 * hash them, and never stored or transmitted anywhere.
 *
 * ## Why not a sentinel string
 * `users.password_hash` is `NOT NULL`, so a passwordless account needs *some*
 * value, and the obvious choice is a marker like `'!cloudflare-access'`. That is
 * a trap. {@link verifyPassword} answers `false` for a malformed hash in
 * microseconds, whereas a genuine Argon2id verify costs tens of milliseconds —
 * so a marker makes "this address is an Access account" measurable from response
 * time alone. That is a *better* account oracle than the one
 * `TIMING_DECOY_PASSWORD_HASH` in `auth.service.ts` was added to destroy.
 *
 * Making the column nullable is no better: `string | null` propagates into
 * `AuthUser` and into `login`, and someone eventually writes
 * `if (hash === null) throw` — reintroducing the same branch and the same oracle.
 *
 * Hashing real entropy instead means `login` needs **no branch at all**. It runs
 * a full-cost verify that always fails, so the byte-identical body and the
 * equal wall-clock cost are inherited from the existing wrong-password path
 * rather than argued for again.
 *
 * Consequence, accepted deliberately: the `users` table does not record which
 * accounts are passwordless. If that is ever needed, add a separate
 * `auth_provider` column — and **never branch `login` on it**.
 */
export function unusablePassword(): string {
  return randomBytes(UNUSABLE_PASSWORD_BYTES).toString(UNUSABLE_PASSWORD_ENCODING);
}

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
