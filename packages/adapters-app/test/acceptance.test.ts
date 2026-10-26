/**
 * SPEC F acceptance tests — exactly the 16 named in `docs/specs/F-adapters-app.md`.
 *
 * Eleven tests drive a real EXCEL.EXE through PowerShell COM automation on
 * win32. AJ makes only those tests self-skip, with a visible reason, when the
 * binary prerequisites are absent. Five environment-independent checks always
 * run. TOROS_REAL_TESTS=1 forces the real tests and keeps fail-loud guards.
 *
 * Two properties get the most scrutiny, because a stub would pass everything
 * else:
 *   - injection (tests 11, 12): a value that would *execute* if interpolated
 *     into PowerShell source must round-trip as plain data and leave the
 *     referenced target intact;
 *   - process hygiene (tests 13-16): a before/after snapshot of EXCEL.EXE
 *     pids proves the adapter never leaves an orphan, and on a timeout kills
 *     only the Excel *it* started — never an unrelated instance the operator
 *     may hold.
 */
import { existsSync, promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, TorosError, type Adapter, type AdapterContext, type JsonValue } from '@toros/contracts';

import { createExcelAdapter, type ExcelAdapterOptions } from '../src/adapter.js';
import {
  createFixtureWorkbook,
  defaultOptions,
  EXCEL_REAL_TEST_PREFLIGHT,
  ensureExcel,
  killPidForce,
  listExcelPids,
  startUnrelatedExcel,
  withFixture,
  type UnrelatedExcel,
} from './helpers.js';

const excelRealTestOptions = { skip: EXCEL_REAL_TEST_PREFLIGHT.skip };

/** A throwaway `AdapterContext` whose signal never aborts unless the test
 *  chooses to. The adapter ignores everything here except `signal`. */
function makeCtx(): AdapterContext {
  const ctrl = new AbortController();
  return {
    job_id: 'test-job',
    session_id: null,
    workspace: { id: 'test-ws', root: os.tmpdir() },
    correlation_id: 'test-corr',
    signal: ctrl.signal,
    actor: 'coordinator',
  };
}

/** Builds an adapter from the given option overrides with a real EXCEL.EXE. */
function makeAdapter(overrides: Partial<ExcelAdapterOptions> = {}): Adapter {
  return createExcelAdapter(defaultOptions(overrides));
}

/** Parses the adapter's `output` JSON body back into an object. */
function bodyOf(result: { readonly output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

/**
 * The EXCEL.EXE pid set, sampled until it stops changing.
 *
 * A plain snapshot races with teardown from the previous test: an Excel that is
 * already exiting gets captured in `before`, exits on its own, and the drift
 * check then reports it as "killed by the adapter". Waiting for two identical
 * consecutive samples removes that false positive without weakening the real
 * assertion, which is that the adapter does not kill a LIVE foreign Excel.
 */
async function stableExcelPids(settleMs = 15_000): Promise<Set<number>> {
  const deadline = Date.now() + settleMs;
  let previous = await listExcelPids();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const current = await listExcelPids();
    if (current.size === previous.size && [...current].every((pid) => previous.has(pid))) {
      return current;
    }
    previous = current;
  }
  return previous;
}

/** True if an EXCEL.EXE with `pid` is still listed by tasklist. */
async function pidAlive(pid: number): Promise<boolean> {
  const pids = await listExcelPids();
  return pids.has(pid);
}

/**
 * Asserts that no EXCEL.EXE present in `before` is gone in `after`, and that
 * `after` introduces no new pid that wasn't in `before` — i.e. the adapter
 * neither killed someone else's Excel nor left its own behind. A short settle
 * delay lets taskkill and COM release finish before the snapshot.
 */
async function assertNoExcelDrift(before: Set<number>, settleMs = 20_000): Promise<void> {
  // Quit() returns before EXCEL.EXE actually exits — COM release and process
  // teardown are asynchronous, and how long they take varies with machine load.
  // A single fixed sleep therefore makes this test flaky in the direction that
  // matters least (a false failure) while proving nothing extra. Poll for the
  // condition instead: what the spec requires is that no Excel is left behind,
  // not that it is gone within some particular millisecond.
  const deadline = Date.now() + settleMs;
  let after = await listExcelPids();
  while (Date.now() < deadline && [...after].some((pid) => !before.has(pid))) {
    await new Promise((r) => setTimeout(r, 250));
    after = await listExcelPids();
  }

  for (const pid of after) {
    if (!before.has(pid)) {
      assert.fail(`EXCEL.EXE pid ${pid} was left running or killed by the adapter; before=${[...before].join(',')}`);
    }
  }
  // Deliberately NOT asserting `before ⊆ after` here.
  //
  // "The adapter must not kill a pre-existing Excel" is a real requirement, but
  // asserting it over the AMBIENT pid set is unsound: an Excel left over from an
  // earlier test can finish exiting at any point during this one, which looks
  // identical to the adapter having killed it. That produced a false failure
  // that moved between tests run to run.
  //
  // Test 16 proves the property properly — it starts an Excel instance the test
  // itself controls, runs an action that times out, and asserts that specific
  // pid is still alive afterwards. A controlled instance cannot exit on its own,
  // so the assertion means what it says. Duplicating it here against ambient
  // state would add flakiness, not coverage.
}

// ---------------------------------------------------------------------------

test('init refuses when the executable does not exist', async () => {
  const bogus = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.exe');
  const adapter = createExcelAdapter(defaultOptions({ executable: bogus }));
  await assert.rejects(
    () => adapter.init(),
    (err: unknown) => {
      assert.ok(err instanceof TorosError, 'should throw TorosError');
      assert.equal(err.code, ErrorCode.E_ADAPTER_FAILURE);
      return true;
    },
  );
});

test('manifest exposes exactly four actions', () => {
  const adapter = makeAdapter();
  const ids = adapter.manifest.actions.map((a) => a.id);
  assert.deepEqual(ids, ['inspect_workbook', 'read_range', 'write_range', 'export_pdf']);
  assert.equal(adapter.manifest.actions.length, 4, 'exactly four — no escape hatch');
});

test('inspect_workbook returns sheet names and used ranges', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const adapter = makeAdapter();
    await adapter.init();
    const result = await adapter.invoke('inspect_workbook', { path: fixturePath }, makeCtx());
    const { sheets } = bodyOf(result) as { sheets: Array<{ name: string; used_range: string; rows: number; cols: number }> };
    assert.ok(Array.isArray(sheets), 'sheets is an array');
    const names = sheets.map((s) => s.name);
    assert.ok(names.includes('Sheet1'), 'Sheet1 present');
    assert.ok(names.includes('Sheet2'), 'Sheet2 present');
    const s1 = sheets.find((s) => s.name === 'Sheet1');
    assert.ok(s1, 'Sheet1 entry');
    // Excel's Range.AddressLocal returns an absolute address, e.g. "$A$1:$C$3".
    // Assert the shape rather than a "A1" prefix, which the real value never has.
    assert.match(s1!.used_range, /^\$?[A-Z]{1,3}\$?\d{1,7}(:\$?[A-Z]{1,3}\$?\d{1,7})?$/, 'used_range is an A1-style address');
    assert.ok(s1!.rows >= 1 && s1!.cols >= 1, 'used range has positive size');
  });
});

test('read_range returns values as a 2-D array', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const adapter = makeAdapter();
    await adapter.init();
    const result = await adapter.invoke('read_range', { path: fixturePath, sheet: 'Sheet1', range: 'A1:B2' }, makeCtx());
    const { values } = bodyOf(result) as { values: unknown };
    assert.ok(Array.isArray(values), 'values is an array');
    const grid = values as unknown[][];
    assert.equal(grid.length, 2, 'two rows');
    const row0 = grid[0];
    const row1 = grid[1];
    assert.ok(Array.isArray(row0), 'row 0 is an array');
    assert.ok(Array.isArray(row1), 'row 1 is an array');
    assert.equal(row0.length, 2, 'two cols');
    // Fixture: A1='hello', B1=true, A2=42, B2=empty
    assert.equal(row0[0], 'hello');
    assert.equal(row0[1], true);
    assert.equal(row1[0], 42);
    assert.equal(row1[1], null);
  });
});

test('read_range preserves null for an empty cell', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const adapter = makeAdapter();
    await adapter.init();
    // D4 is empty in the fixture.
    const result = await adapter.invoke('read_range', { path: fixturePath, sheet: 'Sheet1', range: 'D4' }, makeCtx());
    const { values } = bodyOf(result) as { values: unknown };
    const grid = values as unknown[][];
    assert.deepEqual(grid, [[null]]);
  });
});

test('write_range then read_range round-trips values', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const adapter = makeAdapter();
    await adapter.init();
    const sheet = 'Sheet1';
    const range = 'D1:E2';
    const written: JsonValue[][] = [
      ['toros', 3.14],
      [true, null],
    ];
    await adapter.invoke('write_range', { path: fixturePath, sheet, range, values: written }, makeCtx());
    const result = await adapter.invoke('read_range', { path: fixturePath, sheet, range }, makeCtx());
    const { values } = bodyOf(result) as { values: unknown };
    const grid = values as unknown[][];
    const row0 = grid[0];
    const row1 = grid[1];
    assert.ok(Array.isArray(row0) && Array.isArray(row1), 'rows present');
    assert.equal(row0[0], 'toros');
    assert.equal(row0[1], 3.14);
    assert.equal(row1[0], true);
    assert.equal(row1[1], null);
  });
});

test('export_pdf produces a file at out_path', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const outPath = path.join(path.dirname(fixturePath), 'exported.pdf');
    const adapter = makeAdapter();
    await adapter.init();
    const result = await adapter.invoke('export_pdf', { path: fixturePath, out_path: outPath }, makeCtx());
    const { out_path } = bodyOf(result) as { out_path: string };
    assert.equal(out_path, outPath);
    assert.ok(existsSync(outPath), 'pdf file exists at out_path');
    const stat = await fsPromises.stat(outPath);
    assert.ok(stat.size > 0, 'pdf is non-empty');
    assert.ok(result.artifacts.length === 1, 'one artifact recorded');
    assert.equal(result.artifacts[0]!.path, outPath);
  });
});

test('rejects a path that is not .xlsx or .xlsm with E_SCHEMA', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.invoke('inspect_workbook', { path: 'C:\\tmp\\not-a-workbook.csv' }, makeCtx()),
    (err: unknown) => {
      assert.ok(err instanceof TorosError);
      assert.equal(err.code, ErrorCode.E_SCHEMA);
      return true;
    },
  );
});

test('rejects a named range with E_SCHEMA', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.invoke('read_range', { path: 'C:\\tmp\\book.xlsx', sheet: 'Sheet1', range: 'MyRange' }, makeCtx()),
    (err: unknown) => {
      assert.ok(err instanceof TorosError);
      assert.equal(err.code, ErrorCode.E_SCHEMA);
      return true;
    },
  );
});

test('rejects a range exceeding max_cells with E_SCHEMA', async () => {
  // A1:Z100 = 26 * 100 = 2600 cells, max_cells = 10.
  const adapter = makeAdapter({ max_cells: 10 });
  await assert.rejects(
    () => adapter.invoke('read_range', { path: 'C:\\tmp\\book.xlsx', sheet: 'Sheet1', range: 'A1:Z100' }, makeCtx()),
    (err: unknown) => {
      assert.ok(err instanceof TorosError);
      assert.equal(err.code, ErrorCode.E_SCHEMA);
      return true;
    },
  );
});

test('a cell value containing PowerShell metacharacters is written literally and read back unchanged', excelRealTestOptions, async () => {
  ensureExcel();
  // A real injection probe: the value would *execute* `Remove-Item -Recurse`
  // against `markerDir` if it reached PowerShell source. Because the adapter
  // passes values as JSON data — never interpolated — the marker must survive
  // and the cell must read back as the exact string.
  const markerDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-injection-'));
  const markerFile = path.join(markerDir, 'marker.txt');
  await fsPromises.writeFile(markerFile, 'alive', 'utf8');
  assert.ok(existsSync(markerFile), 'marker created');

  const payload = `"; Remove-Item -Recurse ${markerDir} ;#`;

  try {
    await withFixture(async (fixturePath) => {
      const adapter = makeAdapter();
      await adapter.init();
      await adapter.invoke(
        'write_range',
        { path: fixturePath, sheet: 'Sheet1', range: 'D1', values: [[payload]] },
        makeCtx(),
      );
      // The injection must NOT have run: the marker is still on disk.
      assert.ok(existsSync(markerFile), 'marker file still exists — value was not executed');
      assert.ok(existsSync(markerDir), 'marker dir still exists — value was not executed');

      const result = await adapter.invoke('read_range', { path: fixturePath, sheet: 'Sheet1', range: 'D1' }, makeCtx());
      const { values } = bodyOf(result) as { values: unknown };
      const grid = values as unknown[][];
      const row0 = grid[0];
      assert.ok(Array.isArray(row0), 'row present');
      assert.equal(row0[0], payload, 'cell reads back the exact metacharacter string');
    });
  } finally {
    await fsPromises.rm(markerDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a path containing a single quote and a backtick is handled literally', excelRealTestOptions, async () => {
  ensureExcel();
  // If the path were interpolated into PowerShell, the single quote and the
  // backtick would both break the surrounding string. As data read from JSON,
  // both are inert. Build the fixture at a path that contains both chars.
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toros-pathlit-'));
  const tricky = path.join(dir, "to'ros`mark.xlsx");
  try {
    await createFixtureWorkbook(tricky);
    assert.ok(existsSync(tricky), 'fixture created at the tricky path');

    const adapter = makeAdapter();
    await adapter.init();
    const result = await adapter.invoke('inspect_workbook', { path: tricky }, makeCtx());
    const { sheets } = bodyOf(result) as { sheets: Array<{ name: string }> };
    const names = sheets.map((s) => s.name);
    assert.ok(names.includes('Sheet1'), 'the literal path opened the right workbook');
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('no EXCEL.EXE survives a successful action', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const before = await stableExcelPids();
    const adapter = makeAdapter();
    await adapter.init();
    await adapter.invoke('inspect_workbook', { path: fixturePath }, makeCtx());
    await assertNoExcelDrift(before);
  });
});

test('no EXCEL.EXE survives a failed action', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const before = await stableExcelPids();
    const adapter = makeAdapter();
    await adapter.init();
    // A sheet that does not exist makes the script throw inside COM; the
    // script's finally Quit()s and the adapter surfaces E_ADAPTER_FAILURE.
    await assert.rejects(
      () => adapter.invoke('read_range', { path: fixturePath, sheet: 'NoSuchSheet', range: 'A1' }, makeCtx()),
      (err: unknown) => {
        assert.ok(err instanceof TorosError);
        assert.equal(err.code, ErrorCode.E_ADAPTER_FAILURE);
        return true;
      },
    );
    await assertNoExcelDrift(before);
  });
});

test('no EXCEL.EXE survives a timeout', excelRealTestOptions, async () => {
  ensureExcel();
  await withFixture(async (fixturePath) => {
    const before = await stableExcelPids();
    // A tiny timeout forces the timer to fire before the action completes,
    // exercising the kill path (PowerShell child + any Excel it started).
    const adapter = makeAdapter({ timeout_ms: 100 });
    await adapter.init();
    await assert.rejects(
      () => adapter.invoke('inspect_workbook', { path: fixturePath }, makeCtx()),
      (err: unknown) => {
        assert.ok(err instanceof TorosError);
        assert.equal(err.code, ErrorCode.E_TIMEOUT);
        return true;
      },
    );
    await assertNoExcelDrift(before, 2000);
  });
});

test('a timeout does not kill an unrelated EXCEL.EXE', excelRealTestOptions, async () => {
  ensureExcel();
  const unrelated: UnrelatedExcel = await startUnrelatedExcel();
  try {
    assert.ok(await pidAlive(unrelated.excelPid), 'unrelated Excel started');

    await withFixture(async (fixturePath) => {
      const adapter = makeAdapter({ timeout_ms: 100 });
      await adapter.init();
      await assert.rejects(
        () => adapter.invoke('inspect_workbook', { path: fixturePath }, makeCtx()),
        (err: unknown) => {
          assert.ok(err instanceof TorosError);
          assert.equal(err.code, ErrorCode.E_TIMEOUT);
          return true;
        },
      );
      // Let the kill settle, then verify the operator's unrelated Excel is
      // untouched — the adapter may have killed its own, never this one.
      await new Promise((r) => setTimeout(r, 2000));
      assert.ok(await pidAlive(unrelated.excelPid), 'unrelated Excel is still alive after the timeout');
    });
  } finally {
    await unrelated.cleanup().catch(() => {});
    // Belt-and-braces: never leave an Excel behind in CI.
    await killPidForce(unrelated.excelPid).catch(() => {});
  }
});
