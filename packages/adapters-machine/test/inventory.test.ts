/**
 * Tests for @toros/adapters-machine.
 *
 * Every test injects a custom probe list and node_platform so the
 * readiness taxonomy is deterministic and independent of what is
 * actually installed on the test machine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createMachineAdapter, type MachineProbe } from '../src/adapter.js';
import type { AdapterContext, NodePlatform } from '@toros/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(signal?: AbortSignal): AdapterContext {
  return {
    job_id: 'test-job',
    session_id: null,
    workspace: { id: 'test-ws', root: '/tmp/test' },
    correlation_id: 'test-correlation',
    signal: signal ?? new AbortController().signal,
  };
}

function parseOutput(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Deterministic probe fixtures
// ---------------------------------------------------------------------------

/** A probe for Node's own binary — always present, always a file. */
const NODE_FILE_PROBE: MachineProbe = {
  id: 'node-finder',
  platforms: ['linux', 'win32', 'darwin'],
  backs_adapter: 'node-finder',
  detect: { kind: 'file', path: process.execPath },
};

/** A probe whose backs_adapter will NOT be in the registered list. */
const ORPHAN_PROBE: MachineProbe = {
  id: 'orphan-tool',
  platforms: ['linux', 'win32', 'darwin'],
  backs_adapter: 'orphan-adapter',
  detect: { kind: 'file', path: process.execPath },
};

/** A win32-only probe that should show unsupported_platform on linux. */
const WIN32_ONLY_PROBE: MachineProbe = {
  id: 'win32-tool',
  platforms: ['win32'],
  backs_adapter: 'win32-adapter',
  detect: { kind: 'executable', name: 'cmd' },
};

/** An absent executable — guaranteed to not exist on PATH. */
const ABSENT_EXEC_PROBE: MachineProbe = {
  id: 'absent-exec',
  platforms: ['linux', 'win32', 'darwin'],
  detect: { kind: 'executable', name: '__toros_nonexistent_xyzzy_2026__' },
};

/** An absent file — a bogus absolute path. */
const ABSENT_FILE_PROBE: MachineProbe = {
  id: 'absent-file',
  platforms: ['linux', 'win32', 'darwin'],
  detect: { kind: 'file', path: '/tmp/__toros_nonexistent_file_xyzzy_2026__' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('machine.inventory', () => {
  it('registered + present probe → usable', async () => {
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [NODE_FILE_PROBE],
      registered_adapter_ids: () => ['node-finder'],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'node-finder');
    assert.equal(entries[0]!['readiness'], 'usable');
    assert.equal(entries[0]!['reason'], undefined);

    await adapter.dispose();
  });

  it('present probe with backs_adapter NOT registered → missing_adapter', async () => {
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [ORPHAN_PROBE],
      registered_adapter_ids: () => ['some-other-adapter'],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 2); // orphan-tool + some-other-adapter

    const orphan = entries.find((e) => e['id'] === 'orphan-tool');
    assert.ok(orphan);
    assert.equal(orphan['readiness'], 'missing_adapter');

    await adapter.dispose();
  });

  it('probe whose platforms exclude node_platform → unsupported_platform', async () => {
    const adapter = createMachineAdapter({
      node_platform: 'linux',
      probes: [WIN32_ONLY_PROBE],
      registered_adapter_ids: () => [],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'win32-tool');
    assert.equal(entries[0]!['readiness'], 'unsupported_platform');
    // No detection should have happened, so no reason.
    assert.equal(entries[0]!['reason'], undefined);

    await adapter.dispose();
  });

  it('absent executable → missing_prerequisite with reason', async () => {
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [ABSENT_EXEC_PROBE],
      registered_adapter_ids: () => [],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'absent-exec');
    assert.equal(entries[0]!['readiness'], 'missing_prerequisite');
    assert.ok(typeof entries[0]!['reason'] === 'string');
    assert.ok((entries[0]!['reason'] as string).includes('__toros_nonexistent_xyzzy_2026__'));

    await adapter.dispose();
  });

  it('absent file → missing_prerequisite with reason', async () => {
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [ABSENT_FILE_PROBE],
      registered_adapter_ids: () => [],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'absent-file');
    assert.equal(entries[0]!['readiness'], 'missing_prerequisite');
    assert.ok(typeof entries[0]!['reason'] === 'string');
    assert.ok((entries[0]!['reason'] as string).includes('__toros_nonexistent_file_xyzzy_2026__'));

    await adapter.dispose();
  });

  it('registered adapter id with no probe → registered', async () => {
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [],
      registered_adapter_ids: () => ['chrome', 'excel'],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!['id'], 'chrome');
    assert.equal(entries[0]!['readiness'], 'registered');
    assert.equal(entries[0]!['reason'], undefined);
    assert.equal(entries[1]!['id'], 'excel');
    assert.equal(entries[1]!['readiness'], 'registered');

    await adapter.dispose();
  });

  it('capability_filter narrows the result set', async () => {
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [NODE_FILE_PROBE, ABSENT_EXEC_PROBE],
      registered_adapter_ids: () => ['node-finder'],
      timeout_ms: 5_000,
    });

    // Without filter, both probes appear.
    const allResult = await adapter.invoke('inventory', {}, makeCtx());
    const allOutput = parseOutput(allResult);
    const allEntries = allOutput['entries'] as Array<Record<string, unknown>>;
    assert.ok(allEntries.length >= 2);

    // With filter matching only 'node', only the node-finder appears.
    const filteredResult = await adapter.invoke(
      'inventory',
      { capability_filter: 'node' },
      makeCtx(),
    );
    const filteredOutput = parseOutput(filteredResult);
    const filteredEntries = filteredOutput['entries'] as Array<Record<string, unknown>>;

    const nodeEntry = filteredEntries.find((e) => e['id'] === 'node-finder');
    assert.ok(nodeEntry);
    assert.equal(nodeEntry['readiness'], 'usable');

    const absentEntry = filteredEntries.find((e) => e['id'] === 'absent-exec');
    assert.equal(absentEntry, undefined,
      'absent-exec should be excluded by capability_filter=node');

    await adapter.dispose();
  });

  it('filter matches on backs_adapter even when the id does not contain the needle', async () => {
    // id 'tool-x' does NOT contain 'node-find'; only backs_adapter does. This
    // fails if the backs_adapter branch of the filter is removed.
    const probe: MachineProbe = {
      id: 'tool-x',
      platforms: ['linux', 'win32', 'darwin'],
      backs_adapter: 'node-finder',
      detect: { kind: 'file', path: process.execPath },
    };
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [probe],
      registered_adapter_ids: () => ['node-finder'],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke(
      'inventory',
      { capability_filter: 'node-find' },
      makeCtx(),
    );
    const entries = parseOutput(result)['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'tool-x');
    assert.equal(entries[0]!['backs_adapter'], 'node-finder');

    await adapter.dispose();
  });

  it('present executable found on PATH → usable', async () => {
    // Exercises the kind:'executable' PATH-walk success branch deterministically
    // by putting a matching file on PATH. A stub that never resolves a PATH hit
    // would fail this.
    const dir = await mkdtemp(join(tmpdir(), 'toros-path-'));
    const exeName = process.platform === 'win32' ? 'torostestbin.exe' : 'torostestbin';
    await writeFile(join(dir, exeName), '');
    const savedPath = process.env['PATH'];
    process.env['PATH'] = `${dir}${delimiter}${savedPath ?? ''}`;
    try {
      const adapter = createMachineAdapter({
        node_platform: process.platform as NodePlatform,
        probes: [{
          id: 'testbin',
          platforms: ['linux', 'win32', 'darwin'],
          backs_adapter: 'testbin',
          detect: { kind: 'executable', name: 'torostestbin' },
        }],
        registered_adapter_ids: () => ['testbin'],
        timeout_ms: 5_000,
      });
      const entries = parseOutput(await adapter.invoke('inventory', {}, makeCtx()))['entries'] as Array<Record<string, unknown>>;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!['id'], 'testbin');
      assert.equal(entries[0]!['readiness'], 'usable');
      await adapter.dispose();
    } finally {
      process.env['PATH'] = savedPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('output is valid JSON with receipt_extra fields', async () => {
    const probes = [NODE_FILE_PROBE, ABSENT_FILE_PROBE];
    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes,
      registered_adapter_ids: () => ['node-finder'],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());

    // Output must be valid JSON.
    const output = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(output['node_platform'], process.platform);
    assert.ok(typeof output['observed_at'] === 'string');
    assert.ok(Array.isArray(output['entries']));

    // receipt_extra: probe_count must equal the number of probes examined, not a
    // constant, so a hardcoded value would fail.
    assert.equal(result.truncated, false);
    assert.equal(result.artifacts.length, 0);
    assert.ok(typeof result.receipt_extra['probe_ms'] === 'number');
    assert.equal(result.receipt_extra['probe_count'], probes.length);

    await adapter.dispose();
  });

  it('respects AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort(); // aborted before invoke

    const adapter = createMachineAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [NODE_FILE_PROBE, ABSENT_EXEC_PROBE, ABSENT_FILE_PROBE],
      registered_adapter_ids: () => ['node-finder'],
      timeout_ms: 5_000,
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(controller.signal));
    const output = parseOutput(result);

    // The entries array should be empty because every probe loop breaks on abort.
    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 0);
    // Nothing was examined, so probe_count is 0 — not a constant.
    assert.equal(result.receipt_extra['probe_count'], 0);

    await adapter.dispose();
  });
});