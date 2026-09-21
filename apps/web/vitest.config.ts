import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Web test runner config (FR14): Vitest + Testing Library in jsdom, with every
 * network call mocked by MSW.
 *
 * `passWithNoTests` is deliberately **absent**. It was set while task13's test
 * files did not exist yet; leaving it on now would let an empty or
 * accidentally-excluded suite exit 0 and masquerade as success.
 *
 * `restoreMocks` is on because the suite calls `vi.resetModules()` per test (see
 * `test/support/harness.tsx`) and must not also carry mock state over.
 */

const TEST_ENVIRONMENT = 'jsdom';
const TEST_INCLUDE = ['test/**/*.test.ts', 'test/**/*.test.tsx'];
const TEST_SETUP_FILES = ['./test/support/setup.ts'];
const RESTORE_MOCKS = true;

export default defineConfig({
  plugins: [react()],
  test: {
    environment: TEST_ENVIRONMENT,
    include: TEST_INCLUDE,
    setupFiles: TEST_SETUP_FILES,
    restoreMocks: RESTORE_MOCKS,
  },
});
