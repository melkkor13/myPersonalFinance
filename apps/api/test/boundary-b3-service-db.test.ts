/**
 * Case 26 — rule B3: services reach data only through their module's repository.
 *
 * Nothing in `apps/api/src/modules/**\/*.service.ts` may import from
 * `apps/api/src/db/**` — not the schema, not the client, not the connection
 * helper. `health.service.ts` is explicitly included: the cheapest way to answer
 * "is the database up?" is to ping the connection directly, and that shortcut is
 * exactly what the rule forbids. It must go through `health.repository.ts`.
 *
 * The check resolves each relative specifier to a real repo-relative path, so it
 * does not care whether a service writes `../../db/client.js`, `../../db/index.js`
 * or a deeper path — all of them land under `apps/api/src/db` and all of them
 * fail. Extension-free comparison handles NodeNext's `.js`-specifier-for-`.ts`
 * -source convention.
 */
import { describe, expect, it } from 'vitest';

import {
  importSpecifiersOf,
  isAtOrUnder,
  listSourceFiles,
  readSource,
  resolveRelativeSpecifier,
  stripModuleExtension,
  type BoundaryViolation,
  type ScannedFile,
} from './support/imports.js';

/** The layer B3 forbids services from reaching. */
const FORBIDDEN_DIRECTORY = 'apps/api/src/db';

/** Where the services live. */
const SCANNED_DIRECTORY = 'apps/api/src/modules';

/** Suffix identifying a service file. */
const SERVICE_FILE_SUFFIX = '.service.ts';

/** The service that must be checked by name, because it is the tempting one. */
const HEALTH_SERVICE_PATH = 'apps/api/src/modules/health/health.service.ts';

/** Synthetic violating services — no real violating file ever exists (case 38). */
const KNOWN_BAD_CLIENT_SOURCE = `import { getDb } from '../../db/client.js';`;
const KNOWN_BAD_SCHEMA_SOURCE = `import { users } from '../../db/schema.js';`;
const KNOWN_BAD_CONNECTION_SOURCE = `import { ping } from '../../db/sqlite.js';`;
const KNOWN_BAD_DEEP_SOURCE = `import { thing } from '../../db/nested/deeper/thing.js';`;
const KNOWN_BAD_DYNAMIC_SOURCE = `export const load = async () => import('../../db/client.js');`;

/** A legitimate service import: its own module's repository. */
const INNOCENT_REPOSITORY_SOURCE = `import { findUser } from './auth.repository.js';`;

/** Prose naming the layer without importing it — must stay legal. */
const INNOCENT_COMMENT_SOURCE = `
/** This service imports nothing from src/db/**: the repository owns that edge. */
export const note = 'src/db/client.js';
`;

/**
 * Where the synthetic fixtures pretend to live, so their relative specifiers
 * resolve the way a real service's would.
 */
const FIXTURE_SERVICE_PATH = 'apps/api/src/modules/synthetic/synthetic.service.ts';

const serviceFiles = listSourceFiles(SCANNED_DIRECTORY).filter((file) =>
  file.relativePath.endsWith(SERVICE_FILE_SUFFIX),
);

/** Every import a service makes that lands inside the forbidden DB layer. */
function dbImportsOf(relativePath: string, code: string): BoundaryViolation[] {
  return importSpecifiersOf(code, relativePath)
    .filter((specifier) => {
      const resolved = resolveRelativeSpecifier(specifier, relativePath);
      return resolved === undefined
        ? isAtOrUnder(stripModuleExtension(specifier), FORBIDDEN_DIRECTORY)
        : isAtOrUnder(resolved, FORBIDDEN_DIRECTORY);
    })
    .map((specifier) => ({ file: relativePath, specifier }));
}

function violationsIn(files: ScannedFile[]): BoundaryViolation[] {
  return files.flatMap((file) => dbImportsOf(file.relativePath, readSource(file)));
}

describe('rule B3 — services never import the DB layer (case 26)', () => {
  it('scans a non-empty set of service files', () => {
    expect(serviceFiles.length).toBeGreaterThan(0);
  });

  it('includes health.service.ts in the scan by name', () => {
    expect(serviceFiles.map((file) => file.relativePath)).toContain(HEALTH_SERVICE_PATH);
  });

  it('reads real imports out of every service, so the scan is not vacuous', () => {
    for (const file of serviceFiles) {
      expect(importSpecifiersOf(readSource(file), file.relativePath).length).toBeGreaterThan(0);
    }
  });

  it('has zero src/db/** imports in any *.service.ts', () => {
    expect(violationsIn(serviceFiles)).toEqual([]);
  });
});

describe('rule B3 bites: the resolver flags known-bad synthetic services (case 38)', () => {
  it.each([
    KNOWN_BAD_CLIENT_SOURCE,
    KNOWN_BAD_SCHEMA_SOURCE,
    KNOWN_BAD_CONNECTION_SOURCE,
    KNOWN_BAD_DEEP_SOURCE,
    KNOWN_BAD_DYNAMIC_SOURCE,
  ])('flags a service import that resolves into src/db', (source) => {
    expect(dbImportsOf(FIXTURE_SERVICE_PATH, source).length).toBeGreaterThan(0);
  });

  it.each([INNOCENT_REPOSITORY_SOURCE, INNOCENT_COMMENT_SOURCE])(
    'does not flag a repository import or prose about the DB layer',
    (source) => {
      expect(dbImportsOf(FIXTURE_SERVICE_PATH, source)).toEqual([]);
    },
  );
});
