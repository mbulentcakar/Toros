/**
 * Acceptance tests for @toros/envelope — 18 tests matching the spec checklist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, TorosError } from '@toros/contracts';
import type { JobEnvelope } from '@toros/contracts';

import {
  sealEnvelope,
  assertDigest,
  isExpired,
  assertNotExpired,
  assertBudget,
  assertRetries,
  isForbidden,
  parseCoordinatorResponse,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixture: a valid envelope used across tests
// ---------------------------------------------------------------------------

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

function validEnvelope(): JobEnvelope {
  return sealEnvelope(validInput()).envelope;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that `fn` throws a TorosError with the given code.
 * Returns the error for further inspection.
 */
function assertThrowsTorosError(
  fn: () => unknown,
  expectedCode: string,
): TorosError {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@toros/envelope', () => {

  // -----------------------------------------------------------------------
  // 1. seals a valid envelope and returns a 64-hex digest
  // -----------------------------------------------------------------------
  it('seals a valid envelope and returns a 64-hex digest', () => {
    const result = sealEnvelope(validInput());
    assert.equal(typeof result.envelope_digest, 'string');
    // SHA-256 hex is exactly 64 characters
    assert.equal(result.envelope_digest.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(result.envelope_digest));

    // The envelope must have all JobEnvelope fields
    const e = result.envelope;
    assert.equal(e.job_id, validInput().job_id);
    assert.equal(e.objective, validInput().objective);
    assert.deepEqual([...e.allowed_capabilities], validInput().allowed_capabilities);
    assert.deepEqual([...e.allowed_workspaces], validInput().allowed_workspaces);
    assert.deepEqual([...e.acceptance], validInput().acceptance);
    assert.deepEqual([...e.forbidden], validInput().forbidden);
    assert.equal(e.max_actions, validInput().max_actions);
    assert.equal(e.max_retries, validInput().max_retries);
    assert.equal(e.expires_at, validInput().expires_at);
  });

  // -----------------------------------------------------------------------
  // 2. rejects each missing required field with E_ENVELOPE_INVALID and names
  //    the field in detail
  // -----------------------------------------------------------------------
  it('rejects each missing required field with E_ENVELOPE_INVALID and names the field in detail', () => {
    const requiredFields = [
      'job_id',
      'objective',
      'allowed_capabilities',
      'allowed_workspaces',
      'acceptance',
      'forbidden',
      'max_actions',
      'max_retries',
      'expires_at',
    ];

    for (const field of requiredFields) {
      const input = validInput();
      delete input[field];
      const err = assertThrowsTorosError(
        () => sealEnvelope(input),
        ErrorCode.E_ENVELOPE_INVALID,
      );
      assert.equal(err.detail.field, field, `Expected field ${field} in detail`);
    }

    // Also test null input
    const err = assertThrowsTorosError(
      () => sealEnvelope(null),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err.detail.field, '$');
  });

  // -----------------------------------------------------------------------
  // 3. rejects an unknown property rather than stripping it
  // -----------------------------------------------------------------------
  it('rejects an unknown property rather than stripping it', () => {
    const input = validInput();
    (input as Record<string, unknown>)['extra_field'] = 'something';
    const err = assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err.detail.field, 'extra_field');
  });

  // -----------------------------------------------------------------------
  // 4. rejects a timestamp with no offset
  // -----------------------------------------------------------------------
  it('rejects a timestamp with no offset', () => {
    const input = validInput();
    input.expires_at = '2026-08-02T10:00:00';
    const err = assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err.detail.field, 'expires_at');

    // But with Z it should be fine
    input.expires_at = '2026-08-02T10:00:00Z';
    assert.ok(sealEnvelope(input));

    // And with explicit offset
    input.expires_at = '2026-08-02T10:00:00+05:30';
    assert.ok(sealEnvelope(input));

    input.expires_at = '2026-08-02T10:00:00-00:00';
    assert.ok(sealEnvelope(input));
  });

  // -----------------------------------------------------------------------
  // 5. accepts max_actions: 0 and then denies the first action
  // -----------------------------------------------------------------------
  it('accepts max_actions: 0 and then denies the first action', () => {
    const input = validInput();
    input.max_actions = 0;
    const sealed = sealEnvelope(input);
    assert.equal(sealed.envelope.max_actions, 0);

    // The first action at index 0 should be denied because 0 >= 0
    const err = assertThrowsTorosError(
      () => assertBudget(sealed.envelope, 0),
      ErrorCode.E_BUDGET_EXHAUSTED,
    );
    assert.ok(err.detail.max_actions === 0);
    assert.ok(err.detail.actions_used === 0);
  });

  // -----------------------------------------------------------------------
  // 6. rejects duplicate entries in allowed_capabilities
  // -----------------------------------------------------------------------
  it('rejects duplicate entries in allowed_capabilities', () => {
    const input = validInput();
    input.allowed_capabilities = ['fs.read_file', 'fs.read_file'];
    const err = assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err.detail.field, 'allowed_capabilities');
  });

  // -----------------------------------------------------------------------
  // 7. rejects a malformed capability id
  // -----------------------------------------------------------------------
  it('rejects a malformed capability id', () => {
    const input = validInput();
    input.allowed_capabilities = ['UPPERCASE.is_bad', 'has space'];
    const err = assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err.detail.field, 'allowed_capabilities');

    // Also test no dot
    const input2 = validInput();
    input2.allowed_capabilities = ['nodot'];
    const err2 = assertThrowsTorosError(
      () => sealEnvelope(input2),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err2.detail.field, 'allowed_capabilities');
  });

  // -----------------------------------------------------------------------
  // 8. produces the same digest regardless of JSON key order
  // -----------------------------------------------------------------------
  it('produces the same digest regardless of JSON key order', () => {
    // First sealed envelope with default order
    const first = sealEnvelope(validInput());

    // Build input with keys in reverse-ish order
    const reversed: Record<string, unknown> = {
      expires_at: '2030-01-01T00:00:00Z',
      max_retries: 3,
      max_actions: 100,
      forbidden: ['push', 'deploy'],
      acceptance: ['Lists files', 'No errors'],
      allowed_workspaces: ['project-x'],
      allowed_capabilities: ['fs.read_file', 'fs.list_dir'],
      objective: 'List all files in the workspace',
      job_id: '550e8400-e29b-41d4-a716-446655440000',
    };
    const second = sealEnvelope(reversed);

    assert.equal(first.envelope_digest, second.envelope_digest);
  });

  // -----------------------------------------------------------------------
  // 9. assertDigest accepts the matching digest and throws
  //    E_ENVELOPE_DIGEST_MISMATCH otherwise
  // -----------------------------------------------------------------------
  it('assertDigest accepts the matching digest and throws E_ENVELOPE_DIGEST_MISMATCH otherwise', () => {
    const sealed = sealEnvelope(validInput());

    // Should not throw for correct digest
    assertDigest(sealed.envelope, sealed.envelope_digest);

    // Should throw for incorrect digest
    const wrongDigest = 'a'.repeat(64);
    assertThrowsTorosError(
      () => assertDigest(sealed.envelope, wrongDigest),
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
    );

    // If the envelope changes, the original digest should not match
    const modified = { ...sealed.envelope, objective: 'different' };
    assertThrowsTorosError(
      () => assertDigest(modified, sealed.envelope_digest),
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
    );
  });

  // -----------------------------------------------------------------------
  // 10. assertDigest throws rather than returning false on a length mismatch
  // -----------------------------------------------------------------------
  it('assertDigest throws rather than returning false on a length mismatch', () => {
    const sealed = sealEnvelope(validInput());

    // Short digest
    assertThrowsTorosError(
      () => assertDigest(sealed.envelope, 'too-short'),
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
    );

    // Long digest
    assertThrowsTorosError(
      () => assertDigest(sealed.envelope, 'f'.repeat(128)),
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
    );

    // Empty string
    assertThrowsTorosError(
      () => assertDigest(sealed.envelope, ''),
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
    );
  });

  // -----------------------------------------------------------------------
  // 11. isExpired is false one second before expiry and true at the instant
  //     of expiry
  // -----------------------------------------------------------------------
  it('isExpired is false one second before expiry and true at the instant of expiry', () => {
    // Create an envelope that expires at a specific second
    const input = validInput();
    input.expires_at = '2027-06-15T12:00:00Z';
    const sealed = sealEnvelope(input);
    const env = sealed.envelope;

    const expiryMs = new Date('2027-06-15T12:00:00Z').getTime();

    // One second before
    const before = new Date(expiryMs - 1000);
    assert.equal(isExpired(env, before), false);

    // Exactly at the expiry instant — should be expired (now >= expires_at)
    const exactly = new Date(expiryMs);
    assert.equal(isExpired(env, exactly), true);

    // One second after
    const after = new Date(expiryMs + 1000);
    assert.equal(isExpired(env, after), true);

    // assertNotExpired
    assertNotExpired(env, before); // should not throw
    assertThrowsTorosError(
      () => assertNotExpired(env, exactly),
      ErrorCode.E_EXPIRED,
    );
    assertThrowsTorosError(
      () => assertNotExpired(env, after),
      ErrorCode.E_EXPIRED,
    );
  });

  // -----------------------------------------------------------------------
  // 12. assertBudget throws E_BUDGET_EXHAUSTED exactly at max_actions, not
  //     after
  // -----------------------------------------------------------------------
  it('assertBudget throws E_BUDGET_EXHAUSTED exactly at max_actions, not after', () => {
    const input = validInput();
    input.max_actions = 5;
    const sealed = sealEnvelope(input);
    const env = sealed.envelope;

    // actionsUsed = 0, 1, 2, 3, 4 are all fine (0..4 < 5)
    for (let i = 0; i < 5; i++) {
      assertBudget(env, i); // should not throw
    }

    // actionsUsed = 5 is the 6th call — exactly at max, and should be denied
    assertThrowsTorosError(
      () => assertBudget(env, 5),
      ErrorCode.E_BUDGET_EXHAUSTED,
    );

    // actionsUsed = 6 is also denied
    assertThrowsTorosError(
      () => assertBudget(env, 6),
      ErrorCode.E_BUDGET_EXHAUSTED,
    );
  });

  // -----------------------------------------------------------------------
  // 13. assertRetries throws E_RETRIES_EXHAUSTED exactly at max_retries
  // -----------------------------------------------------------------------
  it('assertRetries throws E_RETRIES_EXHAUSTED exactly at max_retries', () => {
    const input = validInput();
    input.max_retries = 3;
    const sealed = sealEnvelope(input);
    const env = sealed.envelope;

    // retriesUsed = 0, 1, 2 are all fine
    for (let i = 0; i < 3; i++) {
      assertRetries(env, i); // should not throw
    }

    // retriesUsed = 3 is exactly at max — denied
    assertThrowsTorosError(
      () => assertRetries(env, 3),
      ErrorCode.E_RETRIES_EXHAUSTED,
    );

    // retriesUsed = 4 also denied
    assertThrowsTorosError(
      () => assertRetries(env, 4),
      ErrorCode.E_RETRIES_EXHAUSTED,
    );

    // max_retries: 0 means "do not retry" — it must NOT deny the first attempt.
    // The bare `retriesUsed >= max_retries` made 0 >= 0 true and denied every
    // action on such a job before the capability allowlist was consulted; Node
    // Core integration surfaced it as E_RETRIES_EXHAUSTED where
    // E_CAP_NOT_ALLOWED was expected.
    const noRetries = sealEnvelope({ ...validInput(), max_retries: 0 }).envelope;
    assertRetries(noRetries, 0); // first attempt, not a retry — allowed
    assertThrowsTorosError(
      () => assertRetries(noRetries, 1),
      ErrorCode.E_RETRIES_EXHAUSTED,
    );
  });

  // -----------------------------------------------------------------------
  // 14. isForbidden matches whole tokens case-insensitively and does not
  //     match substrings
  // -----------------------------------------------------------------------
  it('isForbidden matches whole tokens case-insensitively and does not match substrings', () => {
    const env = validEnvelope(); // forbidden: ['push', 'deploy']

    // Should match: exact term
    assert.equal(isForbidden(env, 'push'), true);
    assert.equal(isForbidden(env, 'deploy'), true);

    // Should match: case-insensitive
    assert.equal(isForbidden(env, 'PUSH'), true);
    assert.equal(isForbidden(env, 'Deploy'), true);

    // Should match: term with extra tokens separated by non-alphanumeric
    assert.equal(isForbidden(env, 'git push'), true);
    assert.equal(isForbidden(env, 'force-push'), true);
    assert.equal(isForbidden(env, 'git push --force'), true);

    // Should NOT match: substring (pushover contains "push" but not as a whole token)
    assert.equal(isForbidden(env, 'pushover'), false);
    assert.equal(isForbidden(env, 'git pushover'), false);
    assert.equal(isForbidden(env, 'deployment'), false);

    // Should NOT match: unrelated terms
    assert.equal(isForbidden(env, 'read'), false);
    assert.equal(isForbidden(env, 'list'), false);

    // Empty forbidden list
    const noForbid = validInput();
    noForbid.forbidden = [];
    const sealed = sealEnvelope(noForbid);
    assert.equal(isForbidden(sealed.envelope, 'push'), false);
  });

  // -----------------------------------------------------------------------
  // 15. parseCoordinatorResponse accepts act with one action
  // -----------------------------------------------------------------------
  it('parseCoordinatorResponse accepts act with one action', () => {
    const response = parseCoordinatorResponse({
      state: 'act',
      reason: 'Running the requested file read',
      action: {
        tool: 'fs.read_file',
        arguments: { path: '/workspace/readme.md' },
      },
    });
    assert.equal(response.state, 'act');
    assert.equal(response.reason, 'Running the requested file read');
    assert.ok(response.action);
    assert.equal(response.action.tool, 'fs.read_file');
    assert.deepEqual(response.action.arguments, { path: '/workspace/readme.md' });
  });

  // -----------------------------------------------------------------------
  // 16. parseCoordinatorResponse rejects complete carrying an action with
  //     E_PARALLEL_ACTION
  // -----------------------------------------------------------------------
  it('parseCoordinatorResponse rejects complete carrying an action with E_PARALLEL_ACTION', () => {
    const err = assertThrowsTorosError(
      () => parseCoordinatorResponse({
        state: 'complete',
        reason: 'Done',
        action: {
          tool: 'fs.read_file',
          arguments: {},
        },
      }),
      ErrorCode.E_PARALLEL_ACTION,
    );
    assert.equal(err.detail.field, 'action');
  });

  // -----------------------------------------------------------------------
  // 17. parseCoordinatorResponse rejects an action array with
  //     E_PARALLEL_ACTION
  // -----------------------------------------------------------------------
  it('parseCoordinatorResponse rejects an action array with E_PARALLEL_ACTION', () => {
    // Array in act state
    const err1 = assertThrowsTorosError(
      () => parseCoordinatorResponse({
        state: 'act',
        reason: 'Multiple actions',
        action: [
          { tool: 'fs.read_file', arguments: {} },
          { tool: 'fs.list_dir', arguments: {} },
        ],
      }),
      ErrorCode.E_PARALLEL_ACTION,
    );
    assert.equal(err1.detail.field, 'action');

    // Array in non-act state
    const err2 = assertThrowsTorosError(
      () => parseCoordinatorResponse({
        state: 'complete',
        reason: 'Done',
        action: [{ tool: 'fs.read_file', arguments: {} }],
      }),
      ErrorCode.E_PARALLEL_ACTION,
    );
    assert.equal(err2.detail.field, 'action');
  });

  // -----------------------------------------------------------------------
  // 18. parseCoordinatorResponse rejects an unknown state
  // -----------------------------------------------------------------------
  it('parseCoordinatorResponse rejects an unknown state', () => {
    const err = assertThrowsTorosError(
      () => parseCoordinatorResponse({
        state: 'invalid_state',
        reason: 'Whatever',
      }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err.detail.field, 'state');
  });

  // -----------------------------------------------------------------------
  // Additional edge-case tests (not in the 18 but validate robustness)
  // -----------------------------------------------------------------------

  it('assertBudget works with max_actions at upper bound 10000', () => {
    const input = validInput();
    input.max_actions = 10000;
    const sealed = sealEnvelope(input);
    const env = sealed.envelope;

    // 9999 should be fine
    assertBudget(env, 9999);

    // 10000 should be denied
    assertThrowsTorosError(
      () => assertBudget(env, 10000),
      ErrorCode.E_BUDGET_EXHAUSTED,
    );
  });

  it('parseCoordinatorResponse accepts ask, complete, blocked without action', () => {
    for (const state of ['ask', 'complete', 'blocked'] as const) {
      const result = parseCoordinatorResponse({
        state,
        reason: 'Reason for ' + state,
      });
      assert.equal(result.state, state);
      assert.equal(result.reason, 'Reason for ' + state);
      // action should be undefined
      assert.ok(!('action' in result) || result.action === undefined);
    }
  });

  it('parseCoordinatorResponse rejects non-object input', () => {
    const err = assertThrowsTorosError(
      () => parseCoordinatorResponse('not an object'),
      ErrorCode.E_ENVELOPE_INVALID,
    );
    assert.equal(err.detail.field, '$');
  });

  it('rejects max_actions above 10000', () => {
    const input = validInput();
    input.max_actions = 10001;
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects max_retries above 100', () => {
    const input = validInput();
    input.max_retries = 101;
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects empty objective after trimming', () => {
    const input = validInput();
    input.objective = '   ';
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects objective longer than 4096 chars', () => {
    const input = validInput();
    input.objective = 'x'.repeat(4097);
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects duplicate entries in allowed_workspaces', () => {
    const input = validInput();
    input.allowed_workspaces = ['a', 'a'];
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects duplicate entries in forbidden', () => {
    const input = validInput();
    input.forbidden = ['push', 'push'];
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects empty array entry in acceptance', () => {
    const input = validInput();
    input.acceptance = [''];
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects empty array entry in allowed_workspaces', () => {
    const input = validInput();
    input.allowed_workspaces = [''];
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects empty array entry in forbidden', () => {
    const input = validInput();
    input.forbidden = [''];
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects negative max_actions', () => {
    const input = validInput();
    input.max_actions = -1;
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects non-integer max_actions', () => {
    const input = validInput();
    input.max_actions = 1.5;
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects non-integer max_retries', () => {
    const input = validInput();
    input.max_retries = 1.5;
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects invalid UUID in job_id', () => {
    const input = validInput();
    input.job_id = 'not-a-uuid';
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects invalid RFC 3339 format in expires_at', () => {
    const input = validInput();
    input.expires_at = '2026/08/02';
    assertThrowsTorosError(
      () => sealEnvelope(input),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('rejects blank reason in parseCoordinatorResponse', () => {
    assertThrowsTorosError(
      () => parseCoordinatorResponse({ state: 'ask', reason: '' }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('parseCoordinatorResponse rejects act with missing action', () => {
    assertThrowsTorosError(
      () => parseCoordinatorResponse({ state: 'act', reason: 'Do something' }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('parseCoordinatorResponse rejects act with empty tool', () => {
    assertThrowsTorosError(
      () => parseCoordinatorResponse({
        state: 'act',
        reason: 'Do something',
        action: { tool: '', arguments: {} },
      }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('parseCoordinatorResponse rejects act with non-object arguments', () => {
    assertThrowsTorosError(
      () => parseCoordinatorResponse({
        state: 'act',
        reason: 'Do something',
        action: { tool: 'fs.read', arguments: 'not-an-object' },
      }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('parseCoordinatorResponse rejects act with arguments as array', () => {
    assertThrowsTorosError(
      () => parseCoordinatorResponse({
        state: 'act',
        reason: 'Do something',
        action: { tool: 'fs.read', arguments: [] },
      }),
      ErrorCode.E_ENVELOPE_INVALID,
    );
  });

  it('assertDigest uses timingSafeEqual (accepts valid, rejects invalid)', () => {
    const sealed = sealEnvelope(validInput());

    // Must accept its own digest
    assertDigest(sealed.envelope, sealed.envelope_digest);

    // Must reject a different digest
    assertThrowsTorosError(
      () => assertDigest(sealed.envelope, '0'.repeat(64)),
      ErrorCode.E_ENVELOPE_DIGEST_MISMATCH,
    );
  });
});
// ---------------------------------------------------------------------------
// 4a. expires_at must be a real calendar instant
// ---------------------------------------------------------------------------
describe('expires_at calendar validity', () => {
  // Date.parse NORMALISES rather than rejects: 2026-02-30 comes back as
  // 2 March and 24:00:00 as the following day, both without error. An envelope
  // whose expiry silently means a different instant than it says makes
  // assertNotExpired answer about a moment the operator never wrote.
  for (const bad of [
    '2026-02-30T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-04-31T12:00:00Z',
  ]) {
    it(`rejects the normalised timestamp ${bad}`, () => {
      assertThrowsTorosError(
        () => sealEnvelope({ ...validInput(), expires_at: bad }),
        ErrorCode.E_ENVELOPE_INVALID,
      );
    });
  }

  for (const good of [
    '2026-02-28T23:59:59Z',
    '2028-02-29T00:00:00Z', // a real leap day
    '2026-08-02T10:00:00+05:30',
    '2026-08-02T10:00:00.123-03:00',
  ]) {
    it(`accepts the real instant ${good}`, () => {
      assert.ok(sealEnvelope({ ...validInput(), expires_at: good }).envelope_digest.length === 64);
    });
  }
});
