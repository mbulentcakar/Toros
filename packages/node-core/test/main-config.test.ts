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

import { validateDesktopAuthorizedApps } from '../src/desktop-config.js';

test('accepts a valid AppRule[] (hash, signer+product, path)', () => {
  const rules = validateDesktopAuthorizedApps(
    [
      { image_sha256: 'a'.repeat(64) },
      { signer: 'Contoso Corp', product_name: 'Contoso Editor' },
      { image_path: 'C:\\Program Files\\App\\app.exe' },
    ],
    'config.json',
  );
  assert.ok(rules);
  assert.equal(rules!.length, 3);
  assert.deepEqual(rules![0], { image_sha256: 'a'.repeat(64) });
  assert.deepEqual(rules![1], { signer: 'Contoso Corp', product_name: 'Contoso Editor' });
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
    () => validateDesktopAuthorizedApps([{ signer: 'Contoso Corp' }], 'c'),
    /signer and product_name must appear together/,
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
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: '', product_name: 'x' }], 'c'), /signer/);
  assert.throws(() => validateDesktopAuthorizedApps([{ signer: 'x', product_name: 'x'.repeat(513) }], 'c'), /product_name/);
});