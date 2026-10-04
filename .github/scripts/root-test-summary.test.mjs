import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  formatSummary,
  parseTapSummary,
  selectExitCode,
} from './root-test-summary.mjs';

const ZERO_SKIPS = `TAP version 13
ok 1 - ordinary test
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12.3
`;

const NONZERO_SKIPS = `TAP version 13
ok 1 - real Codex test # SKIP REAL CODEX SKIPPED: missing credential marker
ok 2 - ordinary test
1..2
# tests 2
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 15.2
`;

const FAILING_OUTPUT = `TAP version 13
not ok 1 - deterministic failure
  ---
  error: expected true
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9.1
`;

test('parses a successful Node 24 TAP fixture with zero skips', () => {
  const totals = parseTapSummary(ZERO_SKIPS);
  assert.equal(totals.get('skipped'), 0);
  assert.equal(selectExitCode(0, totals), 0);
  assert.match(formatSummary(totals), /- skipped: \*\*0\*\*/);
});

test('parses a successful Node 24 TAP fixture with nonzero skips', () => {
  const totals = parseTapSummary(NONZERO_SKIPS);
  assert.equal(totals.get('tests'), 2);
  assert.equal(totals.get('skipped'), 1);
  assert.equal(selectExitCode(0, totals), 0);
  assert.match(formatSummary(totals), /- skipped: \*\*1\*\*/);
});

test('parses failing output and preserves the original test-process failure', () => {
  const totals = parseTapSummary(FAILING_OUTPUT);
  assert.equal(totals.get('fail'), 1);
  assert.equal(selectExitCode(7, totals), 7);
});

test('fails a green run when the selected reporter contract disappears', () => {
  assert.equal(selectExitCode(0, parseTapSummary('ordinary output only\n')), 1);
});

test('credential-less real-test wiring exposes exactly 23 individual skips', async () => {
  const cases = [
    ['packages/adapters-cli/test/real-cli.test.ts', ', realCodexTestOptions,', 7],
    ['packages/adapters-cli/test/real-claude.test.ts', ', realClaudeTestOptions,', 5],
    ['packages/adapters-app/test/acceptance.test.ts', ', excelRealTestOptions,', 11],
  ];
  let total = 0;

  for (const [path, marker, expected] of cases) {
    const source = await readFile(path, 'utf8');
    const actual = source.split(marker).length - 1;
    assert.equal(actual, expected, `${path} must mark every real test individually`);
    assert.doesNotMatch(source, /describe\([^\n]+skip:/, `${path} must not disappear through a suite-level skip`);
    total += actual;
  }

  assert.equal(total, 23);
});
