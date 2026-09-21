/**
 * Case 27 — rule B4: the web app has no path to the database.
 *
 * `apps/web/src` may not import `drizzle-orm`, `better-sqlite3`, or anything from
 * `apps/api/src`. The HTTP API is the browser's only data path; a shared type
 * belongs in `@finance/contracts`, not in a reach across the app boundary.
 *
 * ## `apps/web` DOES NOT EXIST YET — and this test is not skipped
 * task12 creates it. Rather than `describe.skip` (which would stay skipped
 * forever and quietly stop protecting anything), the state of the directory is
 * **measured at load time and reported in the describe title**: today the suite
 * reads "apps/web/src ABSENT — created by task12", and the absence is asserted
 * explicitly so a reader cannot mistake it for a genuine pass. The moment task12
 * creates the directory, the same code starts scanning real files, the title
 * flips to "present", and the non-vacuity assertion begins to require that the
 * scan found something. No edit here is needed for that to happen.
 */
import { describe, expect, it } from 'vitest';

import {
  directoryExists,
  importSpecifiersOf,
  isAtOrUnder,
  isPackageOrSubpath,
  listSourceFiles,
  readSource,
  resolveRelativeSpecifier,
  stripModuleExtension,
  type BoundaryViolation,
} from './support/imports.js';

/** The web source tree B4 judges. Absent until task12. */
const SCANNED_DIRECTORY = 'apps/web/src';

/** Packages the browser bundle may never name. */
const FORBIDDEN_PACKAGES = ['drizzle-orm', 'better-sqlite3'] as const;

/** The server tree the web app may never reach into, however it is spelled. */
const FORBIDDEN_API_DIRECTORY = 'apps/api/src';

/** Title fragments making the directory's state visible in the test output. */
const DIRECTORY_PRESENT_LABEL = 'apps/web/src present';
const DIRECTORY_ABSENT_LABEL = 'apps/web/src ABSENT — created by task12';

/** Synthetic violating web modules (case 38) — the only violations that exist. */
const KNOWN_BAD_ORM_SOURCE = `import { eq } from '${FORBIDDEN_PACKAGES[0]}';`;
const KNOWN_BAD_DRIVER_SOURCE = `import Database from '${FORBIDDEN_PACKAGES[1]}';`;
const KNOWN_BAD_RELATIVE_API_SOURCE = `import { users } from '../../../api/src/db/schema.js';`;
const KNOWN_BAD_ALIASED_API_SOURCE = `import { buildServer } from '${FORBIDDEN_API_DIRECTORY}/server.js';`;
const KNOWN_BAD_DYNAMIC_API_SOURCE = `export const load = () => import('../../../api/src/config.js');`;

/** What the web app is supposed to do instead. */
const INNOCENT_CONTRACTS_SOURCE = `import { LoginRequestSchema } from '@finance/contracts';`;

/** Prose naming the forbidden packages — must stay legal. */
const INNOCENT_COMMENT_SOURCE = `
/** The browser never sees ${FORBIDDEN_PACKAGES[0]} or ${FORBIDDEN_PACKAGES[1]}; it calls the HTTP API. */
export const note = 1;
`;

/** Where the synthetic fixtures pretend to live, for relative resolution. */
const FIXTURE_WEB_FILE_PATH = 'apps/web/src/lib/synthetic.ts';

const webDirectoryExists = directoryExists(SCANNED_DIRECTORY);
const webSourceFiles = listSourceFiles(SCANNED_DIRECTORY);
const describeTitle = webDirectoryExists ? DIRECTORY_PRESENT_LABEL : DIRECTORY_ABSENT_LABEL;

/**
 * True when `specifier` names the API source tree, relative or otherwise.
 *
 * A relative specifier is resolved to a real repo-relative path first, so
 * `../../../api/src/server.js` is caught as surely as a literal
 * `apps/api/src/server` alias would be.
 */
function resolvesIntoApiSource(specifier: string, importingRelativePath: string): boolean {
  const resolved = resolveRelativeSpecifier(specifier, importingRelativePath);
  const candidate = resolved ?? stripModuleExtension(specifier);
  return isAtOrUnder(candidate, FORBIDDEN_API_DIRECTORY);
}

/** Every forbidden edge in one web module. */
function forbiddenImportsOf(relativePath: string, code: string): BoundaryViolation[] {
  return importSpecifiersOf(code, relativePath)
    .filter(
      (specifier) =>
        FORBIDDEN_PACKAGES.some((packageName) => isPackageOrSubpath(specifier, packageName)) ||
        resolvesIntoApiSource(specifier, relativePath),
    )
    .map((specifier) => ({ file: relativePath, specifier }));
}

describe(`rule B4 — the web app has no path to the database (case 27; ${describeTitle})`, () => {
  it('reports the state of apps/web/src explicitly, so an empty scan is never mistaken for a pass', () => {
    if (!webDirectoryExists) {
      // task12 has not run. Nothing to scan, so B4 is trivially satisfied — and
      // this branch disappears on its own the moment the directory appears.
      expect(webSourceFiles).toEqual([]);
      return;
    }
    expect(webSourceFiles.length).toBeGreaterThan(0);
  });

  it('has zero drizzle-orm, better-sqlite3 or apps/api/src imports in apps/web/src', () => {
    const violations = webSourceFiles.flatMap((file) =>
      forbiddenImportsOf(file.relativePath, readSource(file)),
    );

    expect(violations).toEqual([]);
  });
});

describe('rule B4 bites: the rule flags known-bad synthetic web modules (case 38)', () => {
  it.each([
    KNOWN_BAD_ORM_SOURCE,
    KNOWN_BAD_DRIVER_SOURCE,
    KNOWN_BAD_RELATIVE_API_SOURCE,
    KNOWN_BAD_ALIASED_API_SOURCE,
    KNOWN_BAD_DYNAMIC_API_SOURCE,
  ])('flags a forbidden web import', (source) => {
    // This is the permanent substitute for mutating a real file: `apps/web`
    // cannot be violated until task12 creates it, but the rule is provably armed.
    expect(forbiddenImportsOf(FIXTURE_WEB_FILE_PATH, source).length).toBeGreaterThan(0);
  });

  it.each([INNOCENT_CONTRACTS_SOURCE, INNOCENT_COMMENT_SOURCE])(
    'does not flag a contracts import or prose about the forbidden packages',
    (source) => {
      expect(forbiddenImportsOf(FIXTURE_WEB_FILE_PATH, source)).toEqual([]);
    },
  );
});
