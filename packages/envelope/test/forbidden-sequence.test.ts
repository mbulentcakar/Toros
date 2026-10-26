/**
 * RR-01 acceptance tests: `isForbidden` matches forbidden terms as contiguous
 * token sequences, and `sealEnvelope` refuses a term that produces no token.
 *
 * Both the forbidden term and the candidate are split into lower-case
 * alphanumeric words; a term matches when its words appear consecutively in the
 * candidate's words.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, TorosError } from '@toros/contracts';
import type { JobEnvelope } from '@toros/contracts';

import { sealEnvelope, isForbidden } from '../src/index.js';

function envelopeWith(forbidden: readonly string[]): JobEnvelope {
  return sealEnvelope({
    job_id: '550e8400-e29b-41d4-a716-446655440000',
    objective: 'test',
    allowed_capabilities: ['fs.read_file'],
    allowed_workspaces: ['project-x'],
    acceptance: ['done'],
    forbidden: [...forbidden],
    max_actions: 100,
    max_retries: 3,
    expires_at: '2030-01-01T00:00:00Z',
  }).envelope;
}

describe('@toros/envelope forbidden token-sequence matching (RR-01)', () => {
  it('matches powershell.exe and notepad.exe against their executable names', () => {
    const env = envelopeWith(['powershell.exe', 'notepad.exe']);
    assert.equal(isForbidden(env, 'powershell.exe'), true);
    assert.equal(isForbidden(env, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), true);
    assert.equal(isForbidden(env, 'notepad.exe'), true);
    assert.equal(isForbidden(env, 'C:\\Windows\\System32\\notepad.exe'), true);
  });

  it('matches toros-fixture against toros-fixture-ab12.exe', () => {
    const env = envelopeWith(['toros-fixture']);
    assert.equal(isForbidden(env, 'toros-fixture-ab12.exe'), true);
  });

  it('matches Microsoft Windows against Microsoft® Windows® Operating System', () => {
    const env = envelopeWith(['Microsoft Windows']);
    assert.equal(isForbidden(env, 'Microsoft® Windows® Operating System'), true);
  });

  it('matches desktop.inspect against the capability id desktop.inspect', () => {
    const env = envelopeWith(['desktop.inspect']);
    assert.equal(isForbidden(env, 'desktop.inspect'), true);
  });

  it('matches a directory term such as keepass against C:\\Program Files\\KeePass\\app.exe', () => {
    const env = envelopeWith(['keepass']);
    assert.equal(isForbidden(env, 'C:\\Program Files\\KeePass\\app.exe'), true);
  });

  it('does not match deploy against redeploy', () => {
    const env = envelopeWith(['deploy']);
    assert.equal(isForbidden(env, 'redeploy'), false);
  });

  it('does not match a partial token such as power against powershell', () => {
    const env = envelopeWith(['power']);
    assert.equal(isForbidden(env, 'powershell'), false);
  });

  it('does not match when the words are present but not consecutive', () => {
    const env = envelopeWith(['microsoft windows']);
    assert.equal(isForbidden(env, 'microsoft office windows'), false);
  });

  it('refuses a zero-token forbidden term at seal time', () => {
    for (const term of ['--', '...', '!!!', '\t\n ']) {
      assert.throws(
        () => envelopeWith([term]),
        (err: unknown) => err instanceof TorosError && err.code === ErrorCode.E_ENVELOPE_INVALID,
      );
    }
  });
});