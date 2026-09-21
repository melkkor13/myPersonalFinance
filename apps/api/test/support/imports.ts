/**
 * Static source analysis for the FR3 boundary rules (B1–B4).
 *
 * ## Why this parses the TypeScript AST instead of grepping text
 * Tasks 05 and 06 both had to **reword ordinary prose comments** because a naive
 * text grep for `PRAGMA`, `better-sqlite3` or `@fastify/jwt` matched documentation
 * that merely *mentioned* the token. A rule that punishes comments is a rule that
 * pressures people to stop writing them, and it is defeated by trivial string
 * concatenation anyway.
 *
 * So the rules here are asserted against **real import specifiers**, extracted by
 * `typescript`'s own parser (`ts.createSourceFile`, `ScriptTarget.Latest`,
 * parse-only — no type checker, no program, no `tsconfig` resolution). That is
 * immune to comments by construction and cannot be talked out of a genuine
 * `import`. `typescript@6.0.3` is already a root devDependency (it is the
 * `typecheck` compiler), so this adds no dependency.
 *
 * Four import forms are collected, because all four are real edges in the module
 * graph:
 *   - `import x from 's'` / `import type { x } from 's'` (`ImportDeclaration`)
 *   - `export { x } from 's'` (a re-export is an import plus a publish)
 *   - `import x = require('s')` (`ImportEqualsDeclaration`)
 *   - `await import('s')` and `require('s')` (`CallExpression`)
 *
 * ## The one legitimately text-based check
 * Rule B2 also forbids the `PRAGMA` **SQL text**, which is not an import at all.
 * `stringLiteralsOf()` exists for that: it walks string and template literals
 * specifically, so a `PRAGMA` in a comment is still free but a `PRAGMA` in
 * executable SQL is caught.
 *
 * ## Analysis, never execution
 * Nothing here imports the files it inspects. Executing a forbidden import is
 * precisely the event the rules forbid, so the rules are checked by reading.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Repository root, resolved from this file rather than `process.cwd()`.
 *
 * Four levels up because this file sits in `apps/api/test/support/` — one deeper
 * than `test/`, so the `../../../` used by suites in `test/` would land on `apps/`.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Extensions that carry module graph edges and are therefore parsed. */
const PARSED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** Directories never part of the source under test. */
const SKIPPED_DIRECTORIES = ['node_modules', 'dist', 'coverage', '.git'] as const;

/** `require` — recognised as a module edge alongside `import`. */
const REQUIRE_IDENTIFIER = 'require';

/** Prefixes marking a relative (intra-repository) specifier. */
const RELATIVE_PREFIX = '.';

/** A single file the boundary rules may judge. */
export interface ScannedFile {
  /** Absolute path on disk. */
  readonly absolutePath: string;
  /** Path relative to the repository root, always with `/` separators. */
  readonly relativePath: string;
}

/** A rule violation: which file, and which specifier tripped it. */
export interface BoundaryViolation {
  readonly file: string;
  readonly specifier: string;
}

/** Normalise an absolute path to a repo-relative, forward-slash path. */
export function toRepoRelative(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split(sep).join(posix.sep);
}

/** True when `relativeDirectory` exists under the repository root. */
export function directoryExists(relativeDirectory: string): boolean {
  try {
    return statSync(join(REPO_ROOT, relativeDirectory)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every parseable source file under `relativeDirectory`, recursively.
 *
 * Returns an empty list when the directory does not exist — rule B4 needs that,
 * because `apps/web` arrives in task12.
 */
export function listSourceFiles(relativeDirectory: string): ScannedFile[] {
  if (!directoryExists(relativeDirectory)) {
    return [];
  }
  const found: ScannedFile[] = [];
  collectInto(join(REPO_ROOT, relativeDirectory), found);
  return found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/**
 * Recurse by hand rather than with `recursive: true`, so `node_modules` and
 * `dist` are **pruned** instead of walked and then filtered out — `apps/api`
 * contains both, and walking them would be enormously slower for no benefit.
 */
function collectInto(directory: string, found: ScannedFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.some((skipped) => skipped === entry.name)) {
        collectInto(absolutePath, found);
      }
      continue;
    }
    if (entry.isFile() && PARSED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push({ absolutePath, relativePath: toRepoRelative(absolutePath) });
    }
  }
}

/** Read a file's text. */
export function readSource(file: ScannedFile): string {
  return readFileSync(file.absolutePath, 'utf8');
}

/** Parse without a program: syntax only, which is all an import scan needs. */
function parse(code: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, /* setParentNodes */ false);
}

/** Depth-first walk over every node of a parsed file. */
function visitAll(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    visitAll(child, visit);
  });
}

/** The specifier of a `require('s')` or dynamic `import('s')` call, if any. */
function callSpecifier(node: ts.CallExpression): string | undefined {
  const isModuleCall =
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === REQUIRE_IDENTIFIER);
  if (!isModuleCall) {
    return undefined;
  }
  const [firstArgument] = node.arguments;
  return firstArgument !== undefined && ts.isStringLiteralLike(firstArgument)
    ? firstArgument.text
    : undefined;
}

/**
 * Every module specifier `code` actually imports, in source order.
 *
 * Exported so the rule tests can run the very same extractor over a synthetic
 * known-bad fixture string and prove it still bites (case 38) — no real file, and
 * therefore no violating file, ever has to exist in the repository for that.
 */
export function importSpecifiersOf(code: string, fileName: string): string[] {
  const specifiers: string[] = [];

  visitAll(parse(code, fileName), (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
      return;
    }
    if (ts.isCallExpression(node)) {
      const specifier = callSpecifier(node);
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  });

  return specifiers;
}

/**
 * Every string and template literal in `code` — comments excluded by construction.
 *
 * Used only by rule B2's `PRAGMA` SQL-text check, which is not an import rule.
 */
export function stringLiteralsOf(code: string, fileName: string): string[] {
  const literals: string[] = [];

  visitAll(parse(code, fileName), (node) => {
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text);
      return;
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      literals.push(node.text);
    }
  });

  return literals;
}

/** Every import specifier of every file in `files`, keyed by repo-relative path. */
export function importsByFile(files: ScannedFile[]): Map<string, string[]> {
  return new Map(
    files.map((file) => [
      file.relativePath,
      importSpecifiersOf(readSource(file), file.absolutePath),
    ]),
  );
}

/**
 * True when `specifier` names `packageName` or a subpath of it.
 *
 * Subpath-aware on purpose, so `drizzle-orm/better-sqlite3` is matched by the
 * `drizzle-orm/better-sqlite3` rule, while `@types/better-sqlite3` is NOT matched
 * by the `better-sqlite3` rule — different packages, different rules.
 */
export function isPackageOrSubpath(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

/** True when `relativePath` equals `allowed` or sits under it as a directory. */
export function isAtOrUnder(relativePath: string, allowed: string): boolean {
  return relativePath === allowed || relativePath.startsWith(`${allowed}${posix.sep}`);
}

/** True when `relativePath` is covered by any entry of `allowlist`. */
export function isAllowed(relativePath: string, allowlist: readonly string[]): boolean {
  return allowlist.some((allowed) => isAtOrUnder(relativePath, allowed));
}

/**
 * Where a relative `specifier` written inside `importingRelativePath` points,
 * as a repo-relative path with any module extension stripped.
 *
 * Returns `undefined` for bare package specifiers, which are not intra-repo edges.
 * The `.js` → `.ts` mismatch (NodeNext emits `.js` specifiers for `.ts` sources)
 * is handled by comparing extension-free paths.
 */
export function resolveRelativeSpecifier(
  specifier: string,
  importingRelativePath: string,
): string | undefined {
  if (!specifier.startsWith(RELATIVE_PREFIX)) {
    return undefined;
  }
  const importingDirectory = resolve(REPO_ROOT, importingRelativePath, '..');
  const target = toRepoRelative(resolve(importingDirectory, specifier));
  return stripModuleExtension(target);
}

/** Drop a trailing module extension so `db/client.js` and `db/client.ts` unify. */
export function stripModuleExtension(path: string): string {
  const extension = PARSED_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  return extension === undefined ? path : path.slice(0, -extension.length);
}
