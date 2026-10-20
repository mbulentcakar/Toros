// Repository-wide standing rule (R2 round 2, item 1): every Windows PowerShell
// (5.1) spawn in the production source tree must pass its child environment
// through the shared powershellChildEnvironment() rule, which strips every
// PSModulePath casing so 5.1 rebuilds its own default module path.
//
// This test greps packages/*/src source files directly, so a future
// powershell.exe / WindowsPowerShell spawn that forgets the env rule fails here
// - with no Windows host and no real process spawned. It deliberately reads only
// src (not test): the rule's seam tests cover the drive reader and the
// session-id runner through their injectable spawn parameters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiled to packages/node-core/dist/test/<this>.js; four levels up is the repo
// root, under which every package's src/ lives.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// A process-spawn call of any kind (the win32 spawns use spawn/execFile). The
// negative lookbehind excludes method calls such as RegExp#exec (`.exec(`).
const SPAWN_CALL = /(?<![\w.])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/;
// A reference to the Windows PowerShell interpreter: the literal powershell.exe,
// the WindowsPowerShell install path segment, or the powershellPath / powershellExe resolvers.
const POWERSHELL_TARGET = /powershell\.exe|WindowsPowerShell|powershellPath\s*\(|powershellExe\s*\(/i;

test('every Windows PowerShell spawn in packages/*/src passes through powershellChildEnvironment', () => {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    files.push(...listTsFiles(src));
  }

  assert.ok(files.length > 0, 'expected to find package source files under packages/*/src');

  const offenders: string[] = [];
  let powershellSpawns = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!SPAWN_CALL.test(text) || !POWERSHELL_TARGET.test(text)) continue;
    powershellSpawns += 1;
    if (!text.includes('powershellChildEnvironment')) offenders.push(file);
  }

  assert.ok(
    powershellSpawns >= 1,
    'sanity check failed: expected at least one Windows PowerShell spawn in packages/*/src',
  );
  assert.deepEqual(
    offenders,
    [],
    'a Windows PowerShell spawn does not pass its child environment through powershellChildEnvironment',
  );
});