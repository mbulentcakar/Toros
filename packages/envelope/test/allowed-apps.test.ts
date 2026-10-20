/**
 * Acceptance tests for the amendment A8 `allowed_apps` envelope field.
 *
 * The field is optional and participates in the digest only when present, so an
 * envelope without it must seal to exactly the digest it always did. That is
 * asserted against a digest hard-coded from the pre-A8 base commit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, TorosError } from '@toros/contracts';

import { sealEnvelope } from '../src/index.js';

function validInput(): Record<string, unknown> {
  return {
    job_id: '550e8400-e29b-41d4-a716-446655440000',
    objective: 'List all files in the workspace',
    allowed_capabilities: ['fs.read_file', 'fs.list_dir'],
    allowed_workspaces: ['project-x'],
    acceptance: ['Lists files', 'No errors'],
    forbidden: ['push', 'deploy'],
    max_actions: 100,
    max_retries: 3,
    expires_at: '2030-01-01T00:00:00Z',
  };
}

function assertThrowsTorosError(fn: () => unknown, expectedCode: string): TorosError {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof TorosError, `Expected TorosError, got ${typeof err}`);
  assert.equal((err as TorosError).code, expectedCode);
  return err as TorosError;
}

describe('@toros/envelope allowed_apps (amendment A8)', () => {
  it('seals an envelope without allowed_apps to the unchanged pre-A8 digest', () => {
    // Computed on the base commit, before `allowed_apps` existed, for exactly
    // this input. A regression here means the optional field leaked into the
    // digest for envelopes that do not carry it.
    const sealed = sealEnvelope(validInput());
    assert.equal(sealed.envelope_digest, '10b4bb06ec4cf372391dddd5fcc3d445545c64ce51bcc19f268f2f31c4bc4420');
    assert.equal(sealed.envelope.allowed_apps, undefined);
  });

  it('includes allowed_apps in the digest when present', () => {
    const bare = sealEnvelope(validInput());
    const withApps = sealEnvelope({
      ...validInput(),
      allowed_apps: [{ image_sha256: 'a'.repeat(64) }],
    });
    assert.notEqual(bare.envelope_digest, withApps.envelope_digest);
    assert.deepEqual([...withApps.envelope.allowed_apps!], [{ image_sha256: 'a'.repeat(64) }]);
  });

  it('accepts each of the three rule shapes', () => {
    const sha = sealEnvelope({ ...validInput(), allowed_apps: [{ image_sha256: '0123456789abcdef'.repeat(4) }] });
    assert.equal(sha.envelope.allowed_apps!.length, 1);

    const signer = sealEnvelope({
      ...validInput(),
      allowed_apps: [{ signer: 'Contoso Corp', product_name: 'Contoso Editor' }],
    });
    assert.deepEqual([...signer.envelope.allowed_apps!], [{ signer: 'Contoso Corp', product_name: 'Contoso Editor' }]);

    const path = sealEnvelope({ ...validInput(), allowed_apps: [{ image_path: 'C:\\Program Files\\App\\app.exe' }] });
    assert.deepEqual([...path.envelope.allowed_apps!], [{ image_path: 'C:\\Program Files\\App\\app.exe' }]);
  });

  it('accepts a forward-slash and a UNC absolute image_path', () => {
    assert.ok(sealEnvelope({ ...validInput(), allowed_apps: [{ image_path: 'C:/Program Files/App/app.exe' }] }));
    assert.ok(sealEnvelope({ ...validInput(), allowed_apps: [{ image_path: '\\\\server\\share\\app.exe' }] }));
  });

  it('rejects allowed_apps when it is not an array or is null', () => {
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: 'x' }), ErrorCode.E_ENVELOPE_INVALID);
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: null as unknown }), ErrorCode.E_ENVELOPE_INVALID);
  });

  it('rejects a rule with an unknown key', () => {
    assertThrowsTorosError(
      () => sealEnvelope({ ...validInput(), allowed_apps: [{ image_sha256: 'a'.repeat(64), basename: 'x' }] }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects a rule carrying two shapes at once', () => {
    assertThrowsTorosError(
      () => sealEnvelope({ ...validInput(), allowed_apps: [{ image_sha256: 'a'.repeat(64), image_path: 'C:\\app.exe' }] }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects a signer rule missing its product_name', () => {
    assertThrowsTorosError(
      () => sealEnvelope({ ...validInput(), allowed_apps: [{ signer: 'Contoso Corp' }] }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects an empty object rule', () => {
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: [{}] }), ErrorCode.E_ENVELOPE_INVALID);
  });

  it('rejects a non 64-hex image_sha256', () => {
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: [{ image_sha256: 'xyz' }] }), ErrorCode.E_ENVELOPE_INVALID);
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: [{ image_sha256: 'A'.repeat(64) }] }), ErrorCode.E_ENVELOPE_INVALID);
  });

  it('rejects a relative image_path', () => {
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: [{ image_path: 'notepad.exe' }] }), ErrorCode.E_ENVELOPE_INVALID);
  });

  it('rejects empty or over-long rule strings', () => {
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: [{ signer: '', product_name: 'x' }] }), ErrorCode.E_ENVELOPE_INVALID);
    assertThrowsTorosError(() => sealEnvelope({ ...validInput(), allowed_apps: [{ signer: 'x'.repeat(513), product_name: 'x' }] }), ErrorCode.E_ENVELOPE_INVALID);
  });
});