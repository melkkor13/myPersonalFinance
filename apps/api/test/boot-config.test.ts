/**
 * Case 29 — bad configuration is a **fatal** boot error.
 *
 * ## Why this spawns a real child process
 * The assertion is "exits non-zero within 2s with no port bound". `loadConfig()`
 * throwing is necessary but not sufficient: only `dist/index.js` running as a
 * process can demonstrate the exit code, the elapsed time, and the absence of a
 * listener. So each case runs `node dist/index.js` with a deliberately broken
 * environment. **This depends on `apps/api` having been built** — the `pretest`
 * script guarantees that.
 *
 * Contrast case 13 (`health-degraded.test.ts`): an unreachable **database** is
 * explicitly not fatal and the server still binds. Bad **config** is fatal and it
 * does not. Those two tests exist to keep that asymmetry honest.
 *
 * The child is given a `:memory:` `DB_PATH`, and in any case never gets far enough
 * to open a database, so nothing is written to disk (case 23).
 *
 * ## Why there is an unmeasured warm-up spawn
 * The 2s budget exists to prove the process *fails fast rather than hanging* — it
 * was never meant to measure Node's interpreter startup or how warm the OS page
 * cache happens to be. On a genuinely cold filesystem cache (CI's single run, or
 * the first run after `npm install && npm run build`) paging in the `node` binary
 * and the whole `dist` module graph can consume most of the budget before
 * `config.ts` even executes, so the *first* timed spawn was flaky at ~2.1s while
 * every subsequent one finished in ~0.2-0.3s.
 *
 * `beforeAll` therefore performs ONE throwaway spawn of the same entrypoint with
 * the same invalid configuration and discards the result. That pays the cold-start
 * cost outside the assertion, so the timed spawn measures what the spec actually
 * cares about: how quickly the process *decides* to die. The budget itself is
 * unchanged, and it still fails if the failure path is made slow or hangs.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { IN_MEMORY_DB_PATH, loadConfig, ConfigValidationError } from '../src/config.js';
import { DB_PATH_ENV_VAR } from '../src/db/sqlite.js';
import {
  BOOT_FAILURE_BUDGET_MS,
  EXIT_CODE_SUCCESS,
  TEST_JWT_SECRET,
  TOO_SHORT_JWT_SECRET,
  UNBOUND_TEST_PORT,
} from './support/constants.js';

/** The compiled entrypoint — the only file in `apps/api` that binds a port. */
const ENTRYPOINT_SCRIPT = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** Environment variable names the child's environment is built from. */
const ENV_JWT_SECRET = 'JWT_SECRET';
const ENV_PORT = 'PORT';
const ENV_PATH = 'PATH';

/** The variable every fatal config message must name. */
const EXPECTED_MESSAGE_VARIABLE = ENV_JWT_SECRET;

/** Loopback host used to prove nothing is listening. */
const LOOPBACK_HOST = '127.0.0.1';

/** How long to wait for a connection attempt before calling it inconclusive. */
const CONNECT_TIMEOUT_MS = 500;

/** Hard stop, so a hung child fails the test rather than the whole run. */
const CHILD_KILL_AFTER_MS = 5_000;

interface BootAttempt {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly elapsedMs: number;
}

/** Start `dist/index.js` with a minimal, deliberately broken environment. */
async function attemptBoot(jwtSecret: string | undefined): Promise<BootAttempt> {
  const env: Record<string, string> = {
    [ENV_PATH]: process.env[ENV_PATH] ?? '',
    [ENV_PORT]: String(UNBOUND_TEST_PORT),
    [DB_PATH_ENV_VAR]: IN_MEMORY_DB_PATH,
  };
  if (jwtSecret !== undefined) {
    env[ENV_JWT_SECRET] = jwtSecret;
  }

  const startedAt = Date.now();
  const child = spawn(process.execPath, [ENTRYPOINT_SCRIPT], { env, stdio: 'pipe' });

  const stderrChunks: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

  const killTimer = setTimeout(() => {
    child.kill();
  }, CHILD_KILL_AFTER_MS);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });
  clearTimeout(killTimer);

  return { exitCode, stderr: stderrChunks.join(''), elapsedMs: Date.now() - startedAt };
}

/** True when something accepts a TCP connection on `UNBOUND_TEST_PORT`. */
async function isPortBound(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: LOOPBACK_HOST, port: UNBOUND_TEST_PORT });
    const finish = (bound: boolean): void => {
      socket.destroy();
      resolve(bound);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      finish(true);
    });
    socket.on('timeout', () => {
      finish(false);
    });
    socket.on('error', () => {
      finish(false);
    });
  });
}

/**
 * Pay the cold-start cost — the `node` binary, the OS page cache and the whole
 * `dist` module graph — ONCE, unmeasured, before anything below is timed. The
 * result is deliberately discarded: every assertion re-spawns, and it is that
 * later spawn which is measured. File-level (not per-case) so the two
 * `describe.each` variants share the single warm-up.
 */
beforeAll(async () => {
  await attemptBoot(TOO_SHORT_JWT_SECRET);
});

describe.each([
  { label: 'JWT_SECRET unset', secret: undefined },
  { label: 'JWT_SECRET shorter than the 32-character minimum', secret: TOO_SHORT_JWT_SECRET },
])('boot fails loudly with $label (case 29)', ({ secret }) => {
  it('exits non-zero, inside the 2s budget, naming the offending variable', async () => {
    const attempt = await attemptBoot(secret);

    expect(attempt.exitCode).not.toBe(EXIT_CODE_SUCCESS);
    expect(attempt.exitCode).not.toBeNull();
    expect(attempt.elapsedMs).toBeLessThan(BOOT_FAILURE_BUDGET_MS);
    expect(attempt.stderr).toContain(EXPECTED_MESSAGE_VARIABLE);
  });

  it('binds no port', async () => {
    await attemptBoot(secret);

    expect(await isPortBound()).toBe(false);
  });

  it('is rejected by loadConfig itself, naming the variable', () => {
    const env: NodeJS.ProcessEnv = secret === undefined ? {} : { [ENV_JWT_SECRET]: secret };

    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as ConfigValidationError).variables).toContain(EXPECTED_MESSAGE_VARIABLE);
    expect((thrown as ConfigValidationError).message).toContain(EXPECTED_MESSAGE_VARIABLE);
  });
});

describe('a valid configuration is accepted (control for case 29)', () => {
  it('loads when JWT_SECRET meets the minimum length', () => {
    const config = loadConfig({ [ENV_JWT_SECRET]: TEST_JWT_SECRET });

    expect(config.jwtSecret).toBe(TEST_JWT_SECRET);
  });
});

/**
 * Cloudflare Access configuration (ADR 0010).
 *
 * These are `loadConfig`-level rather than spawn-level cases: the failure mode
 * being defended against is not a crash, it is a **silent downgrade**. A box
 * that believes Access is on but in fact fell back to password-only looks
 * identical from the outside to a working one — right up until someone notices
 * `POST /auth/login` is still reachable on the public internet.
 */
describe('Cloudflare Access configuration', () => {
  const VALID_TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
  const VALID_AUD = 'a'.repeat(64);

  /** A config that is otherwise valid, so only the Access vars are under test. */
  function envWith(overrides: Record<string, string>): Record<string, string> {
    return { [ENV_JWT_SECRET]: TEST_JWT_SECRET, ...overrides };
  }

  function expectRejected(env: Record<string, string>, variable: string): void {
    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as ConfigValidationError).variables).toContain(variable);
  }

  it('is disabled by default, so nothing else is required', () => {
    const config = loadConfig(envWith({}));

    expect(config.cfAccessEnabled).toBe(false);
    expect(config.cfAccessTeamDomain).toBeUndefined();
    expect(config.cfAccessAud).toBeUndefined();
  });

  it('accepts a complete configuration', () => {
    const config = loadConfig(
      envWith({
        CF_ACCESS_ENABLED: 'true',
        CF_ACCESS_TEAM_DOMAIN: VALID_TEAM_DOMAIN,
        CF_ACCESS_AUD: VALID_AUD,
      }),
    );

    expect(config.cfAccessEnabled).toBe(true);
    expect(config.cfAccessTeamDomain).toBe(VALID_TEAM_DOMAIN);
    expect(config.cfAccessAud).toBe(VALID_AUD);
  });

  it('refuses to boot when enabled without a team domain', () => {
    expectRejected(
      envWith({ CF_ACCESS_ENABLED: 'true', CF_ACCESS_AUD: VALID_AUD }),
      'CF_ACCESS_TEAM_DOMAIN',
    );
  });

  it('refuses to boot when enabled without an audience', () => {
    expectRejected(
      envWith({ CF_ACCESS_ENABLED: 'true', CF_ACCESS_TEAM_DOMAIN: VALID_TEAM_DOMAIN }),
      'CF_ACCESS_AUD',
    );
  });

  it('rejects an audience that is not the 64-hex AUD tag', () => {
    // A truncated or mistyped tag would otherwise fail only at the first real
    // request, as an unexplained 401 loop with a correct-looking config.
    expectRejected(
      envWith({
        CF_ACCESS_ENABLED: 'true',
        CF_ACCESS_TEAM_DOMAIN: VALID_TEAM_DOMAIN,
        CF_ACCESS_AUD: 'not-a-hex-aud-tag',
      }),
      'CF_ACCESS_AUD',
    );
  });

  it('rejects a team domain carrying a scheme', () => {
    // The issuer string is derived by prefixing `https://`, so a scheme here
    // would produce an issuer that can never match a token's `iss`.
    expectRejected(
      envWith({
        CF_ACCESS_ENABLED: 'true',
        CF_ACCESS_TEAM_DOMAIN: `https://${VALID_TEAM_DOMAIN}`,
        CF_ACCESS_AUD: VALID_AUD,
      }),
      'CF_ACCESS_TEAM_DOMAIN',
    );
  });

  it('rejects a non-boolean CF_ACCESS_ENABLED rather than treating it as false', () => {
    expectRejected(envWith({ CF_ACCESS_ENABLED: 'yes' }), 'CF_ACCESS_ENABLED');
  });
});
