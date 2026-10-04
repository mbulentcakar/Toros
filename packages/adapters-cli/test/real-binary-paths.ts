/**
 * Where the real CLI binaries are expected, in ONE place.
 *
 * These paths lived as literals inside `real-cli.test.ts` and
 * `real-claude.test.ts`, and drifted without anyone noticing: the codex path
 * named a WinGet shim directory that no longer exists on the node this
 * repository documents, so its suite skipped — quietly, and for weeks, while
 * `docs/STATUS.md` attributed the failures to an exhausted provider quota.
 *
 * A path recorded in two files disagrees with itself eventually. A path
 * recorded here is also readable by `tools/orient.mjs`, which reports whether
 * each suite will run on this machine and why — so a silent skip becomes a
 * visible line rather than a green tick nobody questions.
 */
import { join } from 'node:path';

function fromEnvironment(variable: string, ...parts: readonly string[]): string {
  return join(process.env[variable] ?? '', ...parts);
}

/**
 * Codex ships a native binary inside a per-platform package, several levels
 * below the package the shim on PATH points at. `npm run orient` resolves it
 * and prints the path; this is that path, expressed relative to `%APPDATA%`.
 *
 * It is deliberately NOT the `%LOCALAPPDATA%\Microsoft\WinGet\Links\codex.exe`
 * this file used to name. That is a shim directory, and the adapter refuses a
 * shim; the entry there had also stopped existing.
 */
export const REAL_CODEX_EXECUTABLE = fromEnvironment(
  'APPDATA',
  'npm', 'node_modules', '@openai', 'codex',
  'node_modules', '@openai', 'codex-win32-x64',
  'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe',
);

/** Claude's npm package ships a native executable in its own `bin`. */
export const REAL_CLAUDE_EXECUTABLE = fromEnvironment(
  'APPDATA',
  'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
);
