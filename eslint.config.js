import tseslint from 'typescript-eslint';

/**
 * Flat config for ESLint 10 (not a legacy .eslintrc).
 *
 * Only the seven pinned root devDependencies are used here, so `@eslint/js` is
 * deliberately NOT imported; typescript-eslint's `strictTypeChecked` +
 * `stylisticTypeChecked` presets supply the rule set, including the
 * eslint-recommended adjustments for TypeScript.
 *
 * All literals live in named constants per the no-magic-strings convention.
 */

/** Never linted: build output, deps, and drizzle-kit generated migrations. */
const IGNORED_PATHS = [
  'dist',
  '**/dist/**',
  'node_modules',
  '**/node_modules/**',
  'coverage',
  '**/coverage/**',
  '**/src/db/migrations/**',
];

/** Sources that receive full type-aware linting. */
const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

/** Plain-JS files (this config, tooling shims) — type-aware rules disabled. */
const JS_FILES = ['**/*.js', '**/*.mjs', '**/*.cjs'];

const PROJECT_ROOT = import.meta.dirname;

const UNDERSCORE_PREFIX_PATTERN = '^_';

/**
 * Tooling files that sit outside any workspace `tsconfig.json` `include`.
 * `apps/api/drizzle.config.ts` cannot be added to `apps/api/tsconfig.json`
 * because that project sets `rootDir: "src"`, so the project service is told to
 * lint it with an inferred default project instead.
 */
const DEFAULT_PROJECT_FILES = ['apps/api/drizzle.config.ts', 'apps/api/vitest.config.ts'];

const RULE_OFF = 'off';
const RULE_ERROR = 'error';

export default tseslint.config(
  { ignores: IGNORED_PATHS },
  {
    files: TS_FILES,
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: DEFAULT_PROJECT_FILES,
        },
        tsconfigRootDir: PROJECT_ROOT,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        RULE_ERROR,
        {
          argsIgnorePattern: UNDERSCORE_PREFIX_PATTERN,
          varsIgnorePattern: UNDERSCORE_PREFIX_PATTERN,
          caughtErrorsIgnorePattern: UNDERSCORE_PREFIX_PATTERN,
        },
      ],
      '@typescript-eslint/consistent-type-imports': RULE_ERROR,
      '@typescript-eslint/explicit-function-return-type': RULE_OFF,
    },
  },
  {
    files: JS_FILES,
    extends: [tseslint.configs.disableTypeChecked],
  },
);
