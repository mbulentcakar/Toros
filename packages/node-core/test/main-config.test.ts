/**
 * Config parsing tests for the F3b desktop configuration (amendment A8):
 * `desktop.authorized_apps` becomes `AppRule[]` and a bare string entry — the
 * old basename form — refuses to start with a message naming the new format.
 *
 * Process-free: these exercise `validateDesktopAuthorizedApps` directly, no
 * PowerShell, no windows, no session probe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';

import {
  validateDesktopAuthorizedApps,
  resolveNodeSessionId,
  NODE_SESSION_ID_PS1,
  powershellChildEnvironment,
  defaultNodeSessionIdRunner,
  type NodeSessionIdRunner,
  type SessionSpawn,
} from '../src/desktop-config.js';

test('accepts a valid AppRule[] (hash, signer+product+original_filename, path)', () => {
  const rules = validateDesktopAuthorizedApps(
    [
      { image_sha256: 'a'.repeat(64) },
      { signer: 'Contoso Corp', product_name: 'Contoso Editor', original_filename: 'app.exe' },
      { image_path: 'C:\\Program Files\\App\\app.exe' },
    ],
    'config.json',
  );
  assert.ok(rules);
  assert.equal(rules!.length, 3);
  assert.deepEqual(rules![0], { image_sha256: 'a'.repeat(64) });
  assert.deepEqual(rules![1], { signer: 'Contoso Corp', product_name: 'Contoso Editor', original_filename: 'app.exe' });
  assert.deepEqual(rules![2], { image_path: 'C:\\Program Files\\App\\app.exe' });
});

test('returns undefined when the desktop block is absent', () => {
  assert.equal(validateDesktopAuthorizedApps(undefined, 'config.json'), undefined);
});

test('a bare string entry (the old basename form) refuses with a message naming the new format', () => {
  assert.throws(
    () => validateDesktopAuthorizedApps(['notepad.exe'], 'config.json'),
    (err: unknown) =>
      err instanceof Error
      && err.message.includes('notepad.exe')
      && err.message.includes('bare string')
      && err.message.includes('image_sha256')
      && err.message.includes('image_path'),
  );
});

test('rejects a non-array value', () => {
  assert.throws(() => validateDesktopAuthorizedApps('notepad.exe', 'c'), /must be an array/);
  assert.throws(() => validateDesktopAuthorizedApps({}, 'c'), /must be an array/);
  assert.throws(() => validateDesktopAuthorizedApps(null, 'c'), /must be an array/);
});

test('rejects a rule that is neither object nor string', () => {
  assert.throws(() => validateDesktopAuthorizedApps([42], 'c'), /must be an application rule object/);
  assert.throws(() => validateDesktopAuthorizedApps([null], 'c'), /must be an application rule object/);
});

test('rejects an unknown property on a rule', () => {
  assert.throws(
    () => validateDesktopAuthorizedApps([{ image_sha256: 'a'.repeat(64), basename: 'x' }], 'c'),
    /unknown property: basename/,
  );
});

test('rejects a rule with more than one shape', () => {
  assert.throws(
    () => validateDesktopAuthorizedApps([{ image_sha256: 'a'.repeat(64), image_path: 'C:\\app.exe' }], 'c'),
    /exactly one rule shape/,
  );
  assert.throws(
    () => validateDesktopAuthorizedApps([{ signer: 'Contoso Corp', original_filename: 'app.exe' }], 'c'),
    /signer, product_name and original_filename must appear together/,
  );
  assert.throws(
    () => validateDesktopAuthorizedApps([{ signer: 'Contoso Corp', product_name: 'Contoso Editor' }], 'c'),
    /signer, product_name and original_filename must appear together/,
  );
  assert.throws(
    () => validateDesktopAuthorizedApps([{}], 'c'),
    /exactly one rule shape/,
  );
});

test('rejects a malformed image_sha256', () => {
  assert.throws(() => validateDesktopAuthorizedApps([{ image_sha256: 'xyz' }], 'c'), /64 lower-case hex/);
  assert.throws(() => validateDesktopAuthorizedApps([{ image_sha256: 'A'.repeat(64) }], 'c'), /64 lower-case hex/);
  assert.throws(() => validateDesktopAuthorizedApps([{ image_sha256: 'a'.repeat(63) }], 'c'), /64 lower-case hex/);
});

test('rejects a non-absolute image_path', () => {
  assert.throws(() => validateDesktopAuthorizedApps([{ image_path: 'notepad.exe' }], 'c'), /must be absolute/);
});

test('rejects over-long or empty signer / product_name', () => {
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: '', product_name: 'x', original_filename: 'app.exe' }], 'c'), /signer/);
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: 'x', product_name: 'x'.repeat(513), original_filename: 'app.exe' }], 'c'), /product_name/);
});

test('rejects an original_filename with a path separator or over 260 characters (amendment A9)', () => {
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: 'x', product_name: 'x', original_filename: 'dir\\app.exe' }], 'c'), /original_filename/);
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: 'x', product_name: 'x', original_filename: 'dir/app.exe' }], 'c'), /original_filename/);
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: 'x', product_name: 'x', original_filename: 'x'.repeat(261) }], 'c'), /original_filename/);
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: 'x', product_name: 'x', original_filename: '' }], 'c'), /original_filename/);
});

// ---------------------------------------------------------------------------
// Node session id (amendment A8, F3b): resolveNodeSessionId with an injected
// runner — process-free, no PowerShell, no temp dir left behind.
// ---------------------------------------------------------------------------

test('NODE_SESSION_ID_PS1 uses Windows PowerShell 5.1 syntax only', () => {
  // The `u` numeric-literal suffix is a parse error in Windows PowerShell 5.1;
  // both TryParse targets must be declared [uint32] before [ref] use.
  assert.ok(!/\b\d+u\b/.test(NODE_SESSION_ID_PS1), 'the script must not use a u literal suffix');
  assert.ok(NODE_SESSION_ID_PS1.includes('[uint32]::TryParse'), 'the script must use [uint32]::TryParse');
  assert.ok(NODE_SESSION_ID_PS1.includes('[uint32]$targetPid = 0'), 'the target pid must be a pre-declared [uint32]');
  assert.ok(NODE_SESSION_ID_PS1.includes('[uint32]$sid = 0'), 'the session id must be a pre-declared [uint32]');
  assert.ok(!/\$\w+\s*=\s*0u/.test(NODE_SESSION_ID_PS1), 'no variable may be assigned a u-suffixed literal');
});

test('resolveNodeSessionId returns the session id the runner prints, writing the fixed script', async () => {
  let capturedArgs: readonly string[] = [];
  let capturedScript: string | undefined;
  const runner: NodeSessionIdRunner = async (_powershell, scriptPath, args) => {
    capturedArgs = args;
    capturedScript = await fsPromises.readFile(scriptPath, 'utf8');
    return '7\n';
  };

  const id = await resolveNodeSessionId(4242, 'C:\\Windows', runner);
  assert.equal(id, 7, 'the printed session id must parse to a number');
  assert.deepEqual(capturedArgs, ['4242'], 'the pid must be passed as a single positional arg');
  assert.equal(capturedScript, NODE_SESSION_ID_PS1, 'the fixed script must be written unchanged into the temp dir');
});

test('resolveNodeSessionId returns null for a non-numeric or negative runner output', async () => {
  const noop: NodeSessionIdRunner = async () => 'garbage';
  assert.equal(await resolveNodeSessionId(1, undefined, noop), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '-3'), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '1.5'), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => 'NaN'), null);
});

// RR-05 — strict session-id parsing: only whitespace-surrounded decimal digits
// 1–10 long that fit in uint32 are accepted. Empty output, whitespace, hex,
// negative, exponent notation and out-of-range all give null.
test('resolveNodeSessionId accepts only a uint32-compatible decimal string (RR-05)', async () => {
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '1'), 1);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '  7  '), 7);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '4294967295'), 4294967295);
  // Rejected shapes.
  assert.equal(await resolveNodeSessionId(1, undefined, async () => ''), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '  '), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '0x10'), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '-1'), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '1e3'), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '4294967296'), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '1.5'), null);
  assert.equal(await resolveNodeSessionId(1, undefined, async () => '12345678901'), null);
});

test('resolveNodeSessionId rejects when the runner throws, and still cleans up', async () => {
  const failing: NodeSessionIdRunner = async () => { throw new Error('powershell failed'); };
  await assert.rejects(resolveNodeSessionId(4242, undefined, failing), /powershell failed/);
});

// ---------------------------------------------------------------------------
// PSModulePath isolation (amendment A9): the child environment for a Windows
// PowerShell 5.1 spawn must not carry PSModulePath, and process.env is never
// mutated.
// ---------------------------------------------------------------------------

test('powershellChildEnvironment removes every PSModulePath casing without mutating process.env', () => {
  const original = process.env['PsModulePath'];
  process.env['PsModulePath'] = 'C:\\polluted'; // mixed casing, not the canonical key
  try {
    const env = powershellChildEnvironment();
    const surviving = Object.keys(env).filter((k) => k.toLowerCase() === 'psmodulepath');
    assert.deepEqual(surviving, [], `no PSModulePath casing may survive: ${surviving.join(', ')}`);
    assert.equal(env['PsModulePath'], undefined, 'the child environment must not carry PsModulePath');
    assert.equal(env['PSMODULEPATH'], undefined, 'the child environment must not carry PSMODULEPATH');
    assert.equal(process.env['PsModulePath'], 'C:\\polluted', 'process.env must not be mutated');
  } finally {
    if (original === undefined) delete process.env['PsModulePath'];
    else process.env['PsModulePath'] = original;
  }
});

test('defaultNodeSessionIdRunner passes the spawned child an environment with every PSModulePath casing removed (through the seam)', async () => {
  const original = process.env['PsModulePath'];
  process.env['PsModulePath'] = 'C:\\polluted';
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const spawn: SessionSpawn = (_file, _args, opts, callback) => {
    capturedEnv = opts.env;
    callback(null, '7\n', '');
    return { kill: () => {} };
  };
  try {
    const runner = defaultNodeSessionIdRunner(spawn);
    const stdout = await runner('powershell.exe', 'C:\\x\\session.ps1', ['4242']);
    assert.equal(stdout, '7\n');
    assert.ok(capturedEnv, 'the spawn seam must receive an env');
    const surviving = Object.keys(capturedEnv!).filter((k) => k.toLowerCase() === 'psmodulepath');
    assert.deepEqual(surviving, [], `the child environment must carry no PSModulePath casing: ${surviving.join(', ')}`);
    assert.equal(process.env['PsModulePath'], 'C:\\polluted', 'process.env must not be mutated');
  } finally {
    if (original === undefined) delete process.env['PsModulePath'];
    else process.env['PsModulePath'] = original;
  }
});