/**
 * Case 25 — rule B2: SQLite specifics are confined to five locations.
 *
 * `better-sqlite3`, `drizzle-orm/better-sqlite3` and the `PRAGMA` SQL text may
 * appear only in `src/db/sqlite.ts`, `src/db/client.ts`, `src/db/migrations/**`,
 * `drizzle.config.ts` and `package.json`. That is what makes a later Postgres swap
 * a rewrite of two files rather than an archaeology project.
 *
 * ## `apps/api/test/**` is EXEMPT and excluded from the scan (C16)
 * The suite legitimately issues `PRAGMA table_info` and `PRAGMA foreign_keys` to
 * assert schema facts (cases 14, 17, 15); a rule that forbade them would make
 * those assertions impossible. B2 constrains **shipped code**, not the code that
 * checks it. ADR 0005 lists the five locations *without* this exemption —
 * FR3/C16 governs, and the exemption is deliberate, not an oversight.
 *
 * ## Two different checks, deliberately
 *  - The **package** half is an import-specifier check (AST), so the prose above
 *    naming `better-sqlite3` is free and a concatenated specifier is not.
 *  - The **`PRAGMA`** half is a *string-literal* check, because `PRAGMA` is SQL
 *    text and not an import at all. It scans string and template literals
 *    specifically — never comments, which is the whole point.
 */
import { describe, expect, it } from 'vitest';

import {
  importSpecifiersOf,
  isAllowed,
  isPackageOrSubpath,
  listSourceFiles,
  readSource,
  stringLiteralsOf,
  type BoundaryViolation,
} from './support/imports.js';

/** Package specifiers only the five locations may name. */
const CONFINED_PACKAGES = ['better-sqlite3', 'drizzle-orm/better-sqlite3'] as const;

/** The SQL keyword only the five locations may put in executable text. */
const CONFINED_SQL_KEYWORD = 'pragma';

/** Everything B2 judges: the whole API workspace. */
const SCANNED_DIRECTORY = 'apps/api';

/**
 * The five permitted locations (FR3/B2). `package.json` is listed for the record;
 * it declares the dependency and is not a parsed module, so the import scan never
 * reaches it.
 */
const ALLOWED_LOCATIONS = [
  'apps/api/src/db/sqlite.ts',
  'apps/api/src/db/client.ts',
  'apps/api/src/db/migrations',
  'apps/api/drizzle.config.ts',
  'apps/api/package.json',
] as const;

/** Excluded from the scan entirely, per C16. */
const EXEMPT_DIRECTORIES = ['apps/api/test'] as const;

/** Synthetic violating sources — no real violating file ever exists (case 38). */
const KNOWN_BAD_DRIVER_SOURCE = `import Database from '${CONFINED_PACKAGES[0]}';`;
const KNOWN_BAD_DIALECT_SOURCE = `import { drizzle } from '${CONFINED_PACKAGES[1]}';`;
const KNOWN_BAD_MIGRATOR_SOURCE = `import { migrate } from '${CONFINED_PACKAGES[1]}/migrator';`;

/** Executable SQL carrying the confined keyword. */
const KNOWN_BAD_PRAGMA_SOURCE = `export const sql = 'PRAGMA journal_mode = WAL';`;
const KNOWN_BAD_PRAGMA_TEMPLATE_SOURCE =
  'export const sql = `PRAGMA table_info(${tableName})`; // template literal';

/** Prose mentioning both — the historic false positive that must stay legal. */
const INNOCENT_COMMENT_SOURCE = `
/**
 * This module is engine-agnostic: it names ${CONFINED_PACKAGES[0]} and PRAGMA only
 * in documentation, and imports neither.
 */
export const note = 1;
`;

/** File name handed to the parser for the synthetic fixtures. */
const FIXTURE_FILE_NAME = 'synthetic.ts';

/** True when the path is one of the five permitted locations. */
function isPermitted(relativePath: string): boolean {
  return isAllowed(relativePath, ALLOWED_LOCATIONS);
}

/** True when the path is inside the C16-exempt test tree. */
function isExempt(relativePath: string): boolean {
  return isAllowed(relativePath, EXEMPT_DIRECTORIES);
}

/** True when `specifier` names a confined package or one of its subpaths. */
function isConfinedPackage(specifier: string): boolean {
  return CONFINED_PACKAGES.some((packageName) => isPackageOrSubpath(specifier, packageName));
}

/** True when executable text carries the confined SQL keyword. */
function hasConfinedKeyword(literal: string): boolean {
  return literal.toLowerCase().includes(CONFINED_SQL_KEYWORD);
}

/** The files B2 actually judges: the API workspace minus the five locations and test/**. */
const judgedFiles = listSourceFiles(SCANNED_DIRECTORY).filter(
  (file) => !isPermitted(file.relativePath) && !isExempt(file.relativePath),
);

/** The permitted files, kept separately so the scan can be proven non-vacuous. */
const permittedFiles = listSourceFiles(SCANNED_DIRECTORY).filter((file) =>
  isPermitted(file.relativePath),
);

const packageViolations: BoundaryViolation[] = [];
const pragmaViolations: BoundaryViolation[] = [];

for (const file of judgedFiles) {
  const code = readSource(file);
  for (const specifier of importSpecifiersOf(code, file.absolutePath)) {
    if (isConfinedPackage(specifier)) {
      packageViolations.push({ file: file.relativePath, specifier });
    }
  }
  for (const literal of stringLiteralsOf(code, file.absolutePath)) {
    if (hasConfinedKeyword(literal)) {
      pragmaViolations.push({ file: file.relativePath, specifier: literal });
    }
  }
}

describe('rule B2 — SQLite specifics stay in the five permitted locations (case 25)', () => {
  it('scans a non-empty set of files outside the permitted locations', () => {
    expect(judgedFiles.length).toBeGreaterThan(0);
  });

  it('excludes apps/api/test/** from the scan entirely (C16)', () => {
    expect(judgedFiles.filter((file) => isExempt(file.relativePath))).toEqual([]);
  });

  it('finds the driver where it is permitted, proving the extractor sees real imports', () => {
    const permittedImports = permittedFiles.flatMap((file) =>
      importSpecifiersOf(readSource(file), file.absolutePath).filter(isConfinedPackage),
    );

    expect(permittedImports.length).toBeGreaterThan(0);
  });

  it('has zero better-sqlite3 or drizzle-orm/better-sqlite3 imports elsewhere', () => {
    expect(packageViolations).toEqual([]);
  });

  it('has zero PRAGMA in executable string or template text elsewhere', () => {
    expect(pragmaViolations).toEqual([]);
  });
});

describe('rule B2 bites: the extractors flag known-bad synthetic sources (case 38)', () => {
  it.each([KNOWN_BAD_DRIVER_SOURCE, KNOWN_BAD_DIALECT_SOURCE, KNOWN_BAD_MIGRATOR_SOURCE])(
    'flags a confined package import',
    (source) => {
      const specifiers = importSpecifiersOf(source, FIXTURE_FILE_NAME);

      expect(specifiers.some(isConfinedPackage)).toBe(true);
    },
  );

  it.each([KNOWN_BAD_PRAGMA_SOURCE, KNOWN_BAD_PRAGMA_TEMPLATE_SOURCE])(
    'flags PRAGMA in executable text',
    (source) => {
      const literals = stringLiteralsOf(source, FIXTURE_FILE_NAME);

      expect(literals.some(hasConfinedKeyword)).toBe(true);
    },
  );

  it('does not flag prose that merely mentions the driver or the keyword', () => {
    const code = INNOCENT_COMMENT_SOURCE;

    expect(importSpecifiersOf(code, FIXTURE_FILE_NAME).filter(isConfinedPackage)).toEqual([]);
    expect(stringLiteralsOf(code, FIXTURE_FILE_NAME).filter(hasConfinedKeyword)).toEqual([]);
  });
});
