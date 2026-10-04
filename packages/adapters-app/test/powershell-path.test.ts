/**
 * The interpreter this adapter spawns is named absolutely, not by PATH lookup.
 *
 * Everything else about the spawn was already right -- a fixed parameter-free
 * script, every input in a JSON file, `shell: false`, nothing interpolated.
 * The bare name `powershell.exe` was the exception: it resolved through the
 * inherited PATH, in a process Node Core spawns and which therefore sits
 * beside the node's own credentials.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { powershellPath } from '../src/adapter.js';

test('builds the interpreter path from SystemRoot', () => {
  const resolved = powershellPath({ SystemRoot: path.join('C:', 'WINDOWS') });
  assert.equal(resolved, path.join('C:', 'WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.ok(path.isAbsolute(resolved) || resolved.startsWith('C:'), 'must not be a bare name');
});

test('accepts either casing of the variable, because Windows gives both', () => {
  assert.match(powershellPath({ SYSTEMROOT: path.join('D:', 'Win') }), /^D:/);
});

test('falls back to the bare name only when SystemRoot is absent or empty', () => {
  assert.equal(powershellPath({}), 'powershell.exe');
  assert.equal(powershellPath({ SystemRoot: '' }), 'powershell.exe');
});

test('resolves to a real interpreter on this machine', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only — the adapter declares platforms: [win32]');
    return;
  }
  assert.doesNotThrow(() => readFileSync(powershellPath()).subarray(0, 2));
});

test('the adapter spawns that path and never a bare executable name', () => {
  // The COMPILED module, beside this compiled test — what actually ships, and
  // the only copy whose location is the same at build time and at run time.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapter.js'),
    'utf8',
  );
  assert.match(source, /spawn\(\s*powershellPath\(\),/, 'the spawn must use the resolved path');
  assert.doesNotMatch(source, /spawn\(\s*'powershell\.exe'/, 'a bare interpreter name came back');
});
