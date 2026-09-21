/**
 * Case 24 — rule B1: the ORM stays behind the repositories.
 *
 * `drizzle-orm` may be imported **only** in `*.repository.ts` files and under
 * `apps/api/src/db/**`. Routes, services and plugins must have zero matches: a
 * route that can build a query has no reason to go through a service, and a
 * service that can build a query has made the repository decorative.
 *
 * Asserted against **parsed import specifiers**, never raw file text — the comment
 * you are reading names `drizzle-orm` and must not fail its own rule. See
 * `test/support/imports.ts` for why that choice is load-bearing.
 */
import { describe, expect, it } from 'vitest';

import {
  importSpecifiersOf,
  importsByFile,
  isAllowed,
  isPackageOrSubpath,
  listSourceFiles,
  type BoundaryViolation,
} from './support/imports.js';

/** The package rule B1 confines. Subpaths (`drizzle-orm/sqlite-core`) included. */
const CONFINED_PACKAGE = 'drizzle-orm';

/** Everything B1 judges: the whole API source tree. */
const SCANNED_DIRECTORY = 'apps/api/src';

/** The only places the ORM may be named (FR3/B1). */
const ALLOWED_DIRECTORIES = ['apps/api/src/db'] as const;
const ALLOWED_FILE_SUFFIX = '.repository.ts';

/** The three layers case 24 requires zero matches in. */
const FORBIDDEN_LAYER_SUFFIXES = ['.routes.ts', '.service.ts'] as const;
const FORBIDDEN_LAYER_DIRECTORIES = ['apps/api/src/plugins'] as const;

/**
 * A synthetic violating service, held as a string so the repository never has to
 * contain a real violation (case 38). The extractor below is the same one the
 * real scan uses, so a green run here means the rule genuinely bites.
 */
const KNOWN_BAD_SERVICE_SOURCE = `
// A comment naming ${CONFINED_PACKAGE} must NOT count — only the import below does.
import { eq } from '${CONFINED_PACKAGE}';
export const broken = eq;
`;

/** The same violation via a subpath, a dynamic import and CommonJS interop. */
const KNOWN_BAD_SUBPATH_SOURCE = `import { sqliteTable } from '${CONFINED_PACKAGE}/sqlite-core';`;
const KNOWN_BAD_DYNAMIC_SOURCE = `export async function load() { return import('${CONFINED_PACKAGE}'); }`;
const KNOWN_BAD_REQUIRE_SOURCE = `const orm = require('${CONFINED_PACKAGE}');`;

/** Prose that merely mentions the package: the historic false positive. */
const INNOCENT_COMMENT_SOURCE = `
/** This service deliberately imports no ${CONFINED_PACKAGE}, and issues no SQL. */
export const note = 'the string "${CONFINED_PACKAGE}" in SQL-free prose is not an import';
`;

/** File name handed to the parser for the synthetic fixtures. */
const FIXTURE_FILE_NAME = 'synthetic.service.ts';

/** True when the file may name the ORM at all. */
function mayImportOrm(relativePath: string): boolean {
  return isAllowed(relativePath, ALLOWED_DIRECTORIES) || relativePath.endsWith(ALLOWED_FILE_SUFFIX);
}

/** True when the file is a route, a service or a plugin. */
function isForbiddenLayer(relativePath: string): boolean {
  return (
    FORBIDDEN_LAYER_SUFFIXES.some((suffix) => relativePath.endsWith(suffix)) ||
    isAllowed(relativePath, FORBIDDEN_LAYER_DIRECTORIES)
  );
}

const apiSourceFiles = listSourceFiles(SCANNED_DIRECTORY);
const importsPerFile = importsByFile(apiSourceFiles);

/** Every (file, specifier) pair where the file imports the confined package. */
function ormImportsIn(predicate: (relativePath: string) => boolean): BoundaryViolation[] {
  const found: BoundaryViolation[] = [];
  for (const [file, specifiers] of importsPerFile) {
    if (!predicate(file)) {
      continue;
    }
    for (const specifier of specifiers) {
      if (isPackageOrSubpath(specifier, CONFINED_PACKAGE)) {
        found.push({ file, specifier });
      }
    }
  }
  return found;
}

describe('rule B1 — drizzle-orm stays out of routes, services and plugins (case 24)', () => {
  it('scans a non-empty set of API source files', () => {
    // Without this the assertions below could pass because nothing was read.
    expect(apiSourceFiles.length).toBeGreaterThan(0);
  });

  it('finds the ORM where it is allowed, proving the extractor sees real imports', () => {
    expect(ormImportsIn(mayImportOrm).length).toBeGreaterThan(0);
  });

  it('has zero ORM imports in any *.routes.ts, *.service.ts or plugins/** file', () => {
    expect(ormImportsIn(isForbiddenLayer)).toEqual([]);
  });

  it('has zero ORM imports anywhere outside *.repository.ts and src/db/**', () => {
    expect(ormImportsIn((file) => !mayImportOrm(file))).toEqual([]);
  });
});

describe('rule B1 bites: the extractor flags known-bad synthetic sources (case 38)', () => {
  it.each([
    KNOWN_BAD_SERVICE_SOURCE,
    KNOWN_BAD_SUBPATH_SOURCE,
    KNOWN_BAD_DYNAMIC_SOURCE,
    KNOWN_BAD_REQUIRE_SOURCE,
  ])('flags a violating import form', (source) => {
    const specifiers = importSpecifiersOf(source, FIXTURE_FILE_NAME);

    expect(specifiers.some((specifier) => isPackageOrSubpath(specifier, CONFINED_PACKAGE))).toBe(
      true,
    );
  });

  it('does not flag prose or a string that merely names the package', () => {
    const specifiers = importSpecifiersOf(INNOCENT_COMMENT_SOURCE, FIXTURE_FILE_NAME);

    expect(specifiers).toEqual([]);
  });
});
