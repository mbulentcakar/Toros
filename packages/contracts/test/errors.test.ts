import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ErrorCode, isErrorCode } from '../src/errors.js';

describe('ErrorCode — amendment A11 (spec AT)', () => {
  it('adds E_GRANT_INVALID as its own code', () => {
    assert.equal(ErrorCode.E_GRANT_INVALID, 'E_GRANT_INVALID');
    assert.ok(isErrorCode('E_GRANT_INVALID'));
  });

  it('keeps it distinct from the run-credential and capability codes', () => {
    assert.notEqual(ErrorCode.E_GRANT_INVALID, ErrorCode.E_RUN_INVALID);
    assert.notEqual(ErrorCode.E_GRANT_INVALID, ErrorCode.E_CAP_NOT_ALLOWED);
    assert.equal(ErrorCode.E_MODE_DENIED, 'E_MODE_DENIED');
  });

  it('has no duplicate values', () => {
    const values = Object.values(ErrorCode);
    assert.equal(new Set(values).size, values.length);
  });
});
