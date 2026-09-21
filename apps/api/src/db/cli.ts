/**
 * Shared helper for the three db CLI scripts (`migrate`, `seed`, `reset`).
 *
 * Each of those files doubles as an importable module (tests and `reset.ts`
 * reuse their exported functions) and as a `node dist/db/*.js` entry point.
 * Running the script body only when the file *is* the entry point keeps importing
 * it side-effect free — the same no-side-effects-on-import rule the rest of the
 * db layer follows (FR8).
 *
 * `import.meta.main` would express this directly but only exists from Node 24;
 * the project targets Node 22 LTS (Q3).
 */
import { pathToFileURL } from 'node:url';

/**
 * True when `moduleUrl` is the module Node was started with.
 *
 * @param moduleUrl the calling module's `import.meta.url`.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === moduleUrl;
}

/** Write one line to stdout. The db scripts' only output channel. */
export function printLine(message: string): void {
  process.stdout.write(`${message}\n`);
}
