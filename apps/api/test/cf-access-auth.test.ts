/**
 * Cloudflare Access authentication (ADR 0010).
 *
 * The property this file exists to defend is that **Access is an additional way
 * to prove an identity, never a way around proving one**. Most cases below are
 * therefore refusals: a correctly signed assertion for the wrong application,
 * the wrong account, a machine rather than a human, or one presented while the
 * feature is switched off.
 *
 * Everything here is offline. `startCfAccessServer` injects a verifier backed by
 * a locally generated key pair (`support/cf-access-tokens.ts`), and one case
 * proves that by breaking `fetch` and asserting authentication still works.
 */
import { AUTH_MODE, type MeResponse, ROUTES } from '@finance/contracts';
import type { FastifyInstance } from 'fastify';
import { count } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { users } from '../src/db/schema.js';
import { UNAUTHENTICATED_MESSAGE } from '../src/lib/errors.js';
import {
  GARBAGE_ACCESS_TOKEN,
  GARBAGE_CF_ACCESS_ASSERTION,
  HEADER_AUTHORIZATION,
  METHOD_GET,
  SHORT_CF_ACCESS_TTL,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
  TEST_CF_ACCESS_AUD,
  TEST_CF_ACCESS_COMMON_NAME,
  TEST_CF_ACCESS_EMAIL,
  TEST_CF_ACCESS_EMAIL_MIXED_CASE,
  TEST_CF_ACCESS_OTHER_AUD,
  TEST_CF_ACCESS_WRONG_ISSUER,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from './support/constants.js';
import {
  type CfAccessTestKeys,
  cfAccessAssertion,
  generateCfAccessKeys,
  mintCfAccessAssertion,
} from './support/cf-access-tokens.js';
import {
  bearer,
  createTestUser,
  disposeDatabase,
  freshInMemoryDatabase,
  login,
  startCfAccessServer,
  startTestServer,
  type TestDatabase,
} from './support/harness.js';

/** Wall-clock wait that outlives a `SHORT_CF_ACCESS_TTL` assertion. */
const EXPIRY_WAIT_MS = 1_250;

let keys: CfAccessTestKeys;
let database: TestDatabase;
let app: FastifyInstance | undefined;

/** Key generation is ~100ms, and no case needs a fresh pair. */
beforeAll(async () => {
  keys = await generateCfAccessKeys();
});

beforeEach(() => {
  database = freshInMemoryDatabase();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
  disposeDatabase();
});

/** How many rows `users` holds — the provisioning assertions turn on this. */
function countUsers(): number {
  return database.db.select({ value: count() }).from(users).get()?.value ?? 0;
}

/** `GET /me` with an Access assertion and nothing else. */
async function getMeWithAssertion(
  instance: FastifyInstance,
  token: string,
  extraHeaders: Record<string, string> = {},
) {
  return instance.inject({
    method: METHOD_GET,
    url: ROUTES.ME,
    headers: { ...cfAccessAssertion(token), ...extraHeaders },
  });
}

describe('Cloudflare Access — accepting a verified identity', () => {
  it('authenticates a valid assertion and provisions exactly one user', async () => {
    app = await startCfAccessServer(keys);
    expect(countUsers()).toBe(0);

    const response = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));

    expect(response.statusCode).toBe(STATUS_OK);
    const body = response.json<MeResponse>();
    expect(body.email).toBe(TEST_CF_ACCESS_EMAIL);
    expect(body.auth_mode).toBe(AUTH_MODE.CLOUDFLARE_ACCESS);
    expect(body.default_currency).toHaveLength(3);
    expect(countUsers()).toBe(1);
  });

  it('never exposes password_hash for a provisioned user', async () => {
    app = await startCfAccessServer(keys);
    const response = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));

    expect(response.payload).not.toContain('password_hash');
    expect(Object.keys(response.json<MeResponse>()).sort()).toEqual([
      'auth_mode',
      'created_at',
      'default_currency',
      'email',
      'id',
    ]);
  });

  it('reuses the row on a second request rather than creating another', async () => {
    app = await startCfAccessServer(keys);

    const first = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));
    const second = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));

    expect(first.json<MeResponse>().id).toBe(second.json<MeResponse>().id);
    expect(countUsers()).toBe(1);
  });

  it('provisions once for two concurrent first requests', async () => {
    // The `onConflictDoNothing` + re-read race in `findOrCreateUserByEmail`. A
    // bare insert would make one of these a 500 on the unique email index.
    app = await startCfAccessServer(keys);
    const assertion = await mintCfAccessAssertion(keys);

    const responses = await Promise.all([
      getMeWithAssertion(app, assertion),
      getMeWithAssertion(app, assertion),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(STATUS_OK);
    }
    const [first, second] = responses;
    expect(first.json<MeResponse>().id).toBe(second.json<MeResponse>().id);
    expect(countUsers()).toBe(1);
  });

  it('matches an existing row regardless of the claim casing', async () => {
    // SQLite's unique index is case-sensitive, so without normalisation this
    // would silently create a parallel account per capitalisation variant.
    app = await startCfAccessServer(keys);

    const lower = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));
    const mixed = await getMeWithAssertion(
      app,
      await mintCfAccessAssertion(keys, { email: TEST_CF_ACCESS_EMAIL_MIXED_CASE }),
    );

    expect(mixed.statusCode).toBe(STATUS_OK);
    expect(mixed.json<MeResponse>().email).toBe(TEST_CF_ACCESS_EMAIL);
    expect(mixed.json<MeResponse>().id).toBe(lower.json<MeResponse>().id);
    expect(countUsers()).toBe(1);
  });

  it('adopts an existing password user with the same email', async () => {
    app = await startCfAccessServer(keys);
    const existing = await createTestUser(database.db, TEST_CF_ACCESS_EMAIL);

    const response = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));

    expect(response.json<MeResponse>().id).toBe(existing.id);
    expect(countUsers()).toBe(1);
  });

  it('verifies without any network access', async () => {
    // Proves the injected local JWKS is genuinely in use. If the verifier ever
    // reached for the remote key set, this would fail rather than silently
    // making the suite depend on Cloudflare being reachable.
    app = await startCfAccessServer(keys);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network access attempted');
      }),
    );

    const response = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));

    expect(response.statusCode).toBe(STATUS_OK);
  });
});

describe('Cloudflare Access — refusals', () => {
  it('refuses an assertion for a different Access application', async () => {
    // The `aud` pin. This token is correctly signed by the right team and is in
    // date; only its audience differs, which is exactly the cross-app case.
    app = await startCfAccessServer(keys);

    const response = await getMeWithAssertion(
      app,
      await mintCfAccessAssertion(keys, { audience: TEST_CF_ACCESS_OTHER_AUD }),
    );

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(countUsers()).toBe(0);
  });

  it('refuses an assertion from a different Zero Trust account', async () => {
    app = await startCfAccessServer(keys);

    const response = await getMeWithAssertion(
      app,
      await mintCfAccessAssertion(keys, { issuer: TEST_CF_ACCESS_WRONG_ISSUER }),
    );

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(countUsers()).toBe(0);
  });

  it('refuses an assertion signed by an unrelated key', async () => {
    app = await startCfAccessServer(keys);
    const forger = await generateCfAccessKeys();

    const response = await getMeWithAssertion(
      app,
      await mintCfAccessAssertion(keys, { signingKey: forger.privateKey }),
    );

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(countUsers()).toBe(0);
  });

  it('refuses an expired assertion', async () => {
    app = await startCfAccessServer(keys);
    const assertion = await mintCfAccessAssertion(keys, { expiresIn: SHORT_CF_ACCESS_TTL });

    await new Promise((resolve) => setTimeout(resolve, EXPIRY_WAIT_MS));
    const response = await getMeWithAssertion(app, assertion);

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(countUsers()).toBe(0);
  });

  it('refuses a service token, which carries common_name and no email', async () => {
    // Service tokens authenticate a machine. They pass signature, issuer and
    // audience checks perfectly, so refusing them is an explicit decision about
    // the claim set, not something JWT validation gives us for free.
    app = await startCfAccessServer(keys);

    const response = await getMeWithAssertion(
      app,
      await mintCfAccessAssertion(keys, {
        email: null,
        commonName: TEST_CF_ACCESS_COMMON_NAME,
      }),
    );

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(countUsers()).toBe(0);
  });

  it('refuses a non-JWT assertion', async () => {
    app = await startCfAccessServer(keys);

    const response = await getMeWithAssertion(app, GARBAGE_CF_ACCESS_ASSERTION);

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
  });

  it('refuses an HS256 token signed with the public AUD tag (alg confusion)', async () => {
    // The AUD tag is not secret — it appears in the Access login redirect. If
    // the verifier accepted HS256 as well as RS256, anyone who could read that
    // redirect could mint their own identity.
    app = await startCfAccessServer(keys);
    const confused = await new SignJWT({ email: TEST_CF_ACCESS_EMAIL })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('attacker')
      .setIssuedAt()
      .setIssuer(`https://test-team.cloudflareaccess.com`)
      .setAudience(TEST_CF_ACCESS_AUD)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_CF_ACCESS_AUD));

    const response = await getMeWithAssertion(app, confused);

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(countUsers()).toBe(0);
  });

  it('ignores the header entirely when Access is disabled', async () => {
    // The most important refusal: the feature is off by default, so a valid
    // assertion against a default-configured server must be worth nothing.
    app = await startTestServer();

    const response = await getMeWithAssertion(app, await mintCfAccessAssertion(keys));

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(countUsers()).toBe(0);
  });

  it('answers every refusal with a byte-identical body', async () => {
    app = await startCfAccessServer(keys);

    const refusals = await Promise.all([
      getMeWithAssertion(app, GARBAGE_CF_ACCESS_ASSERTION),
      getMeWithAssertion(
        app,
        await mintCfAccessAssertion(keys, { audience: TEST_CF_ACCESS_OTHER_AUD }),
      ),
      getMeWithAssertion(app, await mintCfAccessAssertion(keys, { email: null })),
      app.inject({ method: METHOD_GET, url: ROUTES.ME }),
    ]);

    const payloads = new Set(refusals.map((response) => response.payload));
    expect(payloads.size).toBe(1);
    for (const response of refusals) {
      expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
      expect(response.json<{ error: { message: string } }>().error.message).toBe(
        UNAUTHENTICATED_MESSAGE,
      );
      expect(response.payload).not.toContain('fields');
    }
  });
});

describe('Cloudflare Access — precedence against a bearer token', () => {
  it('lets an explicit bearer token decide the principal', async () => {
    // A CLI or mobile client presenting its own token must not have it silently
    // ignored in favour of whatever identity the edge carries.
    app = await startCfAccessServer(keys);
    const passwordUser = await createTestUser(database.db, TEST_USER_EMAIL, TEST_USER_PASSWORD);
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await getMeWithAssertion(app, await mintCfAccessAssertion(keys), {
      ...bearer(tokens.access_token),
    });

    expect(response.statusCode).toBe(STATUS_OK);
    const body = response.json<MeResponse>();
    expect(body.id).toBe(passwordUser.id);
    expect(body.email).toBe(TEST_USER_EMAIL);
    expect(body.auth_mode).toBe(AUTH_MODE.PASSWORD);
  });

  it('refuses a garbage bearer token even when a valid assertion is present', async () => {
    app = await startCfAccessServer(keys);

    const response = await getMeWithAssertion(app, await mintCfAccessAssertion(keys), {
      [HEADER_AUTHORIZATION]: `Bearer ${GARBAGE_ACCESS_TOKEN}`,
    });

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
  });

  it('fails closed on a bad assertion rather than falling back to the bearer path', async () => {
    // A present assertion means the edge asserted an identity, so one that will
    // not verify is an anomaly. Downgrading to a different auth model on an
    // anomaly is how bypasses are built.
    app = await startCfAccessServer(keys);
    await createTestUser(database.db, TEST_USER_EMAIL, TEST_USER_PASSWORD);
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await getMeWithAssertion(app, GARBAGE_CF_ACCESS_ASSERTION, {
      ...bearer(tokens.access_token),
    });

    expect(response.statusCode).toBe(STATUS_UNAUTHORIZED);
  });

  it('still serves the password path when no assertion header is present', async () => {
    // The ordinary local-dev shape: Access enabled server-side, but nothing in
    // front of it injecting headers.
    app = await startCfAccessServer(keys);
    await createTestUser(database.db, TEST_USER_EMAIL, TEST_USER_PASSWORD);
    const tokens = await login(app, ROUTES.AUTH_LOGIN);

    const response = await app.inject({
      method: METHOD_GET,
      url: ROUTES.ME,
      headers: bearer(tokens.access_token),
    });

    expect(response.statusCode).toBe(STATUS_OK);
    expect(response.json<MeResponse>().auth_mode).toBe(AUTH_MODE.PASSWORD);
  });
});

describe('Cloudflare Access — a provisioned account has no usable password', () => {
  it('refuses a password login indistinguishably from an unknown email', async () => {
    // `users.password_hash` for a provisioned account holds an Argon2id hash of
    // discarded CSPRNG bytes, NOT a marker string. That matters: `verifyPassword`
    // answers `false` for a *malformed* hash in microseconds, whereas this runs a
    // full-cost verify that simply never matches. So `login` needs no special
    // branch, and both the body and the wall-clock cost are inherited from the
    // existing wrong-password path rather than re-argued.
    app = await startCfAccessServer(keys);
    await getMeWithAssertion(app, await mintCfAccessAssertion(keys));
    expect(countUsers()).toBe(1);

    const againstProvisioned = await app.inject({
      method: 'POST',
      url: ROUTES.AUTH_LOGIN,
      payload: { email: TEST_CF_ACCESS_EMAIL, password: TEST_USER_PASSWORD },
    });
    const againstUnknown = await app.inject({
      method: 'POST',
      url: ROUTES.AUTH_LOGIN,
      payload: { email: 'nobody-at-all@example.com', password: TEST_USER_PASSWORD },
    });

    expect(againstProvisioned.statusCode).toBe(STATUS_UNAUTHORIZED);
    expect(againstProvisioned.payload).toBe(againstUnknown.payload);
  });

  it('stores a real Argon2id hash, so no code path can special-case it', async () => {
    app = await startCfAccessServer(keys);
    await getMeWithAssertion(app, await mintCfAccessAssertion(keys));

    const row = database.db.select().from(users).get();

    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain('cloudflare');
  });
});
