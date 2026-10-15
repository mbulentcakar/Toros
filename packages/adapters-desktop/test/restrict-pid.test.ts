import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPowerShellUiaProbe, DESKTOP_UIA_PS1 } from '../src/probe.js';
import { parseFixtureReadyLine } from './native-utils.js';

// ---------------------------------------------------------------------------
// AR-F2 Round 3, item 1: the PID restriction cannot fail open.
//
// These tests are deliberately WINDOW-LESS and PROCESS-LESS: they exercise the
// factory value validation and the fixture READY-line helper directly, plus
// static checks over the embedded PowerShell source. Nothing here spawns a
// process or opens a window.
// ---------------------------------------------------------------------------

describe('AR-F2 round 3 — restrict_to_pid cannot fail open', () => {
  it('factory rejects a restrict_to_pid that is not a positive safe integer, before PowerShell starts', () => {
    const badValues: unknown[] = [
      NaN,
      Infinity,
      -Infinity,
      1.5,
      -1,
      0,
      -7,
      Number.MAX_SAFE_INTEGER + 1, // 2^53 — not a safe integer
      '123', // string
      'abc',
      true, // boolean
      {}, // object
      [], // array
    ];
    for (const bad of badValues) {
      assert.throws(
        () => createPowerShellUiaProbe({ timeout_ms: 1000, restrict_to_pid: bad as number | null }),
        /positive safe integer/,
        `restrict_to_pid=${String(bad)} must be rejected by the factory`,
      );
    }
  });

  it('factory accepts absent/null (no restriction) and positive safe integers', () => {
    // Absent means "no restriction" — the normal production path.
    assert.doesNotThrow(() => createPowerShellUiaProbe({ timeout_ms: 1000 }));
    assert.doesNotThrow(() => createPowerShellUiaProbe({ timeout_ms: 1000, restrict_to_pid: null }));
    // A positive safe integer binds the probe to that PID.
    assert.doesNotThrow(() => createPowerShellUiaProbe({ timeout_ms: 1000, restrict_to_pid: 12345 }));
    assert.doesNotThrow(() =>
      createPowerShellUiaProbe({ timeout_ms: 1000, restrict_to_pid: Number.MAX_SAFE_INTEGER }),
    );
  });

  it('the script refuses a present-but-malformed restrict_to_pid BEFORE it enumerates anything', () => {
    // The fail-closed error text must exist in the embedded script.
    const errorText = 'restrict_to_pid must parse as a positive integer';
    assert.ok(
      DESKTOP_UIA_PS1.includes(errorText),
      'script must carry the fail-closed restriction error text',
    );
    const errorIndex = DESKTOP_UIA_PS1.indexOf(errorText);
    assert.ok(errorIndex >= 0, 'script must contain the fail-closed error message');

    // The check must run before either action walk can read a single window.
    const firstAction = Math.min(
      DESKTOP_UIA_PS1.indexOf('enumerate_windows'),
      DESKTOP_UIA_PS1.indexOf('inspect_window'),
    );
    assert.ok(firstAction > 0, 'both action walks must exist in the script');
    assert.ok(errorIndex < firstAction, 'malformed-value error must run before any enumeration or inspection');

    // And it must emit the error and STOP (return) — never continue and mean
    // "no restriction".
    const afterError = DESKTOP_UIA_PS1.slice(errorIndex);
    assert.ok(afterError.includes('refusing to enumerate'), 'the error must state that nothing will be enumerated');
    assert.ok(afterError.includes('return'), 'the script must return after emitting the restriction error');

    // Strictness of the parse: only digit strings are accepted, the value must
    // parse as a long integer, and non-positive results are rejected.
    const validationBlock = DESKTOP_UIA_PS1.slice(
      DESKTOP_UIA_PS1.indexOf("PSObject.Properties['restrict_to_pid']"),
    );
    assert.ok(
      validationBlock.includes("'^\\d+$'"),
      'only positive digit strings may be accepted by the script',
    );
    assert.ok(validationBlock.includes('[long]::TryParse'), 'the value must parse as an integer');
    assert.ok(validationBlock.includes('-le 0'), 'zero and negatives must be rejected');
  });

  it('the helper rejects a READY pid that does not equal the spawned child.pid', () => {
    const expected = { pid: 4242, process_name: 'toros-fixture-abc123' };
    // Mismatched numeric pid → fail before any probe can bound to it.
    assert.throws(
      () => parseFixtureReadyLine('READY:12345:4141:toros-fixture-abc123', expected),
      /does not equal the spawned child\.pid 4242/,
    );
    // Missing / non-integer reported pid also fails.
    assert.throws(() => parseFixtureReadyLine('READY:12345:not-a-number:toros-fixture-abc123', expected));
    assert.throws(() => parseFixtureReadyLine('READY:12345::toros-fixture-abc123', expected));
    assert.throws(() => parseFixtureReadyLine('READY:12345:0:toros-fixture-abc123', expected));
  });

  it('the helper rejects malformed READY lines and a generic process name', () => {
    const expected = { pid: 4242, process_name: 'toros-fixture-abc123' };
    // Not a READY line, or too few fields.
    assert.throws(() => parseFixtureReadyLine('BOOT:1:2:3', expected), /Malformed fixture READY line/);
    assert.throws(() => parseFixtureReadyLine('READY:12345', expected), /Malformed fixture READY line/);
    // Invalid HWND.
    assert.throws(() => parseFixtureReadyLine('READY:not-a-hwnd:4242:toros-fixture-abc123', expected), /invalid HWND/);
    // The reported process name must be the unique copied executable name —
    // a generic name like `powershell` must never be accepted.
    assert.throws(
      () => parseFixtureReadyLine('READY:12345:4242:powershell', expected),
      /does not equal the copied fixture executable/,
    );
  });

  it('the helper accepts a matching READY line', () => {
    const expected = { pid: 4242, process_name: 'toros-fixture-abc123' };
    const ready = parseFixtureReadyLine('READY:12345:4242:toros-fixture-abc123', expected);
    assert.deepStrictEqual(ready, { hwnd: 12345, pid: 4242, process_name: 'toros-fixture-abc123' });
  });
});