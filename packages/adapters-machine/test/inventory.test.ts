/**
 * Tests for @toros/adapters-machine.
 *
 * Every test injects a custom probe list, node_platform, and the AR-08 /
 * AR-09 seams (drive types, access, PATH) so the readiness taxonomy and the
 * job-scoped filter are deterministic and independent of what is actually
 * installed on the test machine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMachineAdapter,
  type AccessCheck,
  type DriveTypes,
  type MachineProbe,
} from '../src/adapter.js';
import { makeTestAdapter } from './helpers.js';
import type { AdapterContext, NodePlatform, TargetDecisions } from '@toros/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(signal?: AbortSignal, decisions?: TargetDecisions): AdapterContext {
  return {
    job_id: 'test-job',
    session_id: null,
    workspace: { id: 'test-ws', root: '/tmp/test' },
    correlation_id: 'test-correlation',
    signal: signal ?? new AbortController().signal,
    actor: 'coordinator',
    ...(decisions !== undefined ? { target_decisions: decisions } : {}),
  };
}

function parseOutput(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

/**
 * An allow-all decisions map keyed as `<adapterId>.inventory`. The AR-09 filter
 * maps a decision key to its adapter via `key.split('.')[0]`, so this lets tests
 * that exercise readiness (not the job-scope filter) pass explicit, per-adapter
 * decisions for every entry they expect to see in full. Absent decisions now
 * mean "all unauthorized" (AR-F5 round 3, P2), so a full read must be asked for.
 */
function allowDecisions(...adapterIds: readonly string[]): TargetDecisions {
  return new Map(adapterIds.map((id) => [`${id}.inventory`, 'allowed' as const]));
}

/** A DriveTypes seam returning a fixed set of lowercase drive letters. */
function fixedDriveTypes(letters: readonly string[]): DriveTypes {
  return async () => letters;
}

/**
 * Fixed-drive letters that make `process.execPath` (used by the `*_PROBE` file
 * fixtures) resolve as a local fixed path on whatever host runs the suite. On
 * non-Windows the drive-type reader is never consulted, so this returns an
 * empty list — the value is inert. On Windows it returns the single drive
 * letter of the node executable, so a `file` probe of `process.execPath` is
 * still detected as present while the reader seam stays a pure fake.
 */
function execPathFixedDrives(): readonly string[] {
  if (process.platform !== 'win32') return [];
  const match = /^([A-Za-z]):[\\/]/.exec(process.execPath);
  return match === null ? [] : [match[1]!.toLowerCase()];
}

/** An AccessCheck seam that records every path it is asked about and succeeds. */
function recordingAccess(): { access: AccessCheck; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    access: async (candidate: string): Promise<void> => {
      calls.push(candidate);
    },
  };
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
// Tests — readiness taxonomy
// ---------------------------------------------------------------------------

describe('machine.inventory', () => {
  it('registered + present probe → usable', async () => {
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [NODE_FILE_PROBE],
      registered_adapter_ids: () => ['node-finder'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(execPathFixedDrives()),
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('node-finder')));
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'node-finder');
    assert.equal(entries[0]!['readiness'], 'usable');
    assert.equal(entries[0]!['reason'], undefined);

    await adapter.dispose();
  });

  it('present probe with backs_adapter NOT registered → missing_adapter', async () => {
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [ORPHAN_PROBE],
      registered_adapter_ids: () => ['some-other-adapter'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(execPathFixedDrives()),
    });

    const result = await adapter.invoke(
      'inventory',
      {},
      makeCtx(undefined, allowDecisions('orphan-adapter', 'some-other-adapter')),
    );
    const output = parseOutput(result);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 2); // orphan-tool + some-other-adapter

    const orphan = entries.find((e) => e['id'] === 'orphan-tool');
    assert.ok(orphan);
    assert.equal(orphan['readiness'], 'missing_adapter');

    await adapter.dispose();
  });

  it('probe whose platforms exclude node_platform → unsupported_platform', async () => {
    const adapter = makeTestAdapter({
      node_platform: 'linux',
      probes: [WIN32_ONLY_PROBE],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('win32-adapter')));
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
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [ABSENT_EXEC_PROBE],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('absent-exec')));
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
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [ABSENT_FILE_PROBE],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('absent-file')));
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
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [],
      registered_adapter_ids: () => ['chrome', 'excel'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('chrome', 'excel')));
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
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [NODE_FILE_PROBE, ABSENT_EXEC_PROBE],
      registered_adapter_ids: () => ['node-finder'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(execPathFixedDrives()),
    });

    // Without filter, both probes appear.
    const allResult = await adapter.invoke(
      'inventory',
      {},
      makeCtx(undefined, allowDecisions('node-finder', 'absent-exec')),
    );
    const allOutput = parseOutput(allResult);
    const allEntries = allOutput['entries'] as Array<Record<string, unknown>>;
    assert.ok(allEntries.length >= 2);

    // With filter matching only 'node', only the node-finder appears.
    const filteredResult = await adapter.invoke(
      'inventory',
      { capability_filter: 'node' },
      makeCtx(undefined, allowDecisions('node-finder', 'absent-exec')),
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
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [probe],
      registered_adapter_ids: () => ['node-finder'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(execPathFixedDrives()),
    });

    const result = await adapter.invoke(
      'inventory',
      { capability_filter: 'node-find' },
      makeCtx(undefined, allowDecisions('node-finder')),
    );
    const entries = parseOutput(result)['entries'] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'tool-x');
    assert.equal(entries[0]!['backs_adapter'], 'node-finder');

    await adapter.dispose();
  });

  it('present executable found on PATH → usable', async () => {
    // Exercises the kind:'executable' PATH-walk success branch deterministically
    // by injecting a PATH seam that points at a directory holding the file.
    const dir = await mkdtemp(join(tmpdir(), 'toros-path-'));
    const exeName = process.platform === 'win32' ? 'torostestbin.exe' : 'torostestbin';
    await writeFile(join(dir, exeName), '');
    try {
      const adapter = makeTestAdapter({
        node_platform: process.platform as NodePlatform,
        probes: [{
          id: 'testbin',
          platforms: ['linux', 'win32', 'darwin'],
          backs_adapter: 'testbin',
          detect: { kind: 'executable', name: 'torostestbin' },
        }],
        registered_adapter_ids: () => ['testbin'],
        registered_capabilities: () => [],
        timeout_ms: 5_000,
        pathEnv: () => dir,
        driveTypes: fixedDriveTypes(execPathFixedDrives()),
      });
      const entries = parseOutput(await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('testbin'))))['entries'] as Array<Record<string, unknown>>;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!['id'], 'testbin');
      assert.equal(entries[0]!['readiness'], 'usable');
      await adapter.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('output is valid JSON with receipt_extra fields', async () => {
    const probes = [NODE_FILE_PROBE, ABSENT_FILE_PROBE];
    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes,
      registered_adapter_ids: () => ['node-finder'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(execPathFixedDrives()),
    });

    const result = await adapter.invoke(
      'inventory',
      {},
      makeCtx(undefined, allowDecisions('node-finder', 'absent-file')),
    );

    // Output must be valid JSON.
    const output = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(output['node_platform'], process.platform);
    assert.ok(typeof output['observed_at'] === 'string');
    assert.ok(Array.isArray(output['entries']));
    assert.ok(typeof output['path_entries_skipped'] === 'number');

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

    const adapter = makeTestAdapter({
      node_platform: process.platform as NodePlatform,
      probes: [NODE_FILE_PROBE, ABSENT_EXEC_PROBE, ABSENT_FILE_PROBE],
      registered_adapter_ids: () => ['node-finder'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
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

// ---------------------------------------------------------------------------
// Tests — AR-08 local-fixed PATH filtering
// ---------------------------------------------------------------------------

describe('machine.inventory — AR-08 local-fixed PATH filtering', () => {
  it('drops UNC, device, relative and drive-relative PATH entries without touching them', async () => {
    const { access, calls } = recordingAccess();
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [{
        id: 'findme',
        platforms: ['win32'],
        detect: { kind: 'executable', name: 'findme' },
      }],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(['c']),
      access,
      pathEnv: () => '\\\\server\\share;\\\\?\\C:\\device;relative;C:rel',
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('findme')));
    const output = parseOutput(result);
    const entries = output['entries'] as Array<Record<string, unknown>>;

    // None of the four dropped entries may have been touched.
    assert.equal(calls.length, 0, `expected no access calls, got ${JSON.stringify(calls)}`);

    // The probe walked an empty PATH, so it is missing_prerequisite.
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['readiness'], 'missing_prerequisite');

    assert.equal(output['path_entries_skipped'], 4);

    await adapter.dispose();
  });

  it('probes a fixed local PATH entry and skips a non-fixed drive letter', async () => {
    const { access, calls } = recordingAccess();
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [{
        id: 'findme',
        platforms: ['win32'],
        backs_adapter: 'findme',
        detect: { kind: 'executable', name: 'findme' },
      }],
      registered_adapter_ids: () => ['findme'],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(['c']), // only C: is fixed
      access,
      pathEnv: () => 'C:\\tools;D:\\other',
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('findme')));
    const entries = parseOutput(result)['entries'] as Array<Record<string, unknown>>;
    const output = parseOutput(result);

    assert.equal(entries[0]!['readiness'], 'usable');

    // C:\tools was probed (with the executable name resolved, .exe appended).
    assert.equal(calls.length, 1, `expected exactly one access call, got ${JSON.stringify(calls)}`);
    assert.equal(calls[0], 'C:\\tools\\findme.exe');

    // The non-fixed D: entry was dropped and counted, never touched.
    assert.equal(output['path_entries_skipped'], 1);

    await adapter.dispose();
  });

  it('a pre-aborted signal causes zero access and zero drive-type calls', async () => {
    const controller = new AbortController();
    controller.abort();

    const { access, calls } = recordingAccess();
    let driveCalls = 0;
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [{
        id: 'findme',
        platforms: ['win32'],
        detect: { kind: 'executable', name: 'findme' },
      }],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: (async () => {
        driveCalls++;
        return ['c'];
      }) as DriveTypes,
      access,
      pathEnv: () => 'C:\\tools',
    });

    const result = await adapter.invoke('inventory', {}, makeCtx(controller.signal));

    assert.equal(calls.length, 0, 'access was called on a pre-aborted signal');
    assert.equal(driveCalls, 0, 'drive-type reader was called on a pre-aborted signal');
    assert.equal(result.receipt_extra['probe_count'], 0);

    await adapter.dispose();
  });

  it('treats every drive as non-fixed when the drive-type reader fails', async () => {
    const { access, calls } = recordingAccess();
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [{
        id: 'findme',
        platforms: ['win32'],
        detect: { kind: 'executable', name: 'findme' },
      }],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      // A throwing reader models a PowerShell failure: fail closed.
      driveTypes: (async () => {
        throw new Error('powershell unavailable');
      }) as DriveTypes,
      access,
      pathEnv: () => 'C:\\tools;D:\\other',
    });

    const result = await adapter.invoke('inventory', {}, makeCtx());
    const output = parseOutput(result);

    // Both drive entries are dropped (nothing is known-fixed), nothing touched.
    assert.equal(calls.length, 0, `expected no access calls, got ${JSON.stringify(calls)}`);
    assert.equal(output['path_entries_skipped'], 2);

    await adapter.dispose();
  });

  it('a file probe whose fixed path is not local-fixed is never touched', async () => {
    const { access, calls } = recordingAccess();
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [{
        id: 'remoteme',
        platforms: ['win32'],
        detect: { kind: 'file', path: '\\\\server\\share\\tool.exe' },
      }],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(['c']),
      access,
      pathEnv: () => '',
    });

    const entries = parseOutput(await adapter.invoke('inventory', {}, makeCtx(undefined, allowDecisions('remoteme'))))
      ['entries'] as Array<Record<string, unknown>>;

    assert.equal(calls.length, 0, 'a non-local-fixed file path was touched');
    assert.equal(entries[0]!['readiness'], 'missing_prerequisite');

    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests — AR-09 job-scoped inventory filter
// ---------------------------------------------------------------------------

describe('machine.inventory — AR-09 job-scoped filter', () => {
  it('resolver returns one capability target per registered capability id', async () => {
    const capabilityIds = ['machine.inventory', 'desktop.state', 'desktop.inspect', 'excel.read_range'];
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => ['machine', 'desktop', 'excel'],
      registered_capabilities: () => capabilityIds,
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    const resolver = adapter.resolver;
    assert.ok(resolver, 'the machine adapter must expose an A8 resolver');
    const targets = await resolver!.resolve('inventory', {}, makeCtx());

    assert.equal(targets.length, capabilityIds.length);
    for (const target of targets) {
      assert.equal(target.kind, 'capability');
      assert.equal(target.key, target.capability);
      assert.ok(capabilityIds.includes(target.capability));
    }

    await adapter.dispose();
  });

  it('a job with only machine.inventory sees other adapters as unauthorized, bare', async () => {
    // An absent file probe whose backs_adapter is 'desktop' and whose adapter
    // capabilities are denied: it must be probed (so the internal entry carries
    // a missing_prerequisite reason AND a backs_adapter), then fully redacted.
    const desktopProbe: MachineProbe = {
      id: 'desktop-probe',
      platforms: ['win32'],
      backs_adapter: 'desktop',
      detect: { kind: 'file', path: '\\___toros_nonexistent_desktop___' },
    };
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [desktopProbe],
      registered_adapter_ids: () => ['machine', 'desktop'],
      registered_capabilities: () => ['machine.inventory', 'desktop.state', 'desktop.inspect'],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes(['c']),
    });

    const decisions: TargetDecisions = new Map([
      ['machine.inventory', 'allowed'],
      ['desktop.state', 'denied'],
      ['desktop.inspect', 'denied'],
    ]);

    const entries = parseOutput(await adapter.invoke('inventory', {}, makeCtx(undefined, decisions)))
      ['entries'] as Array<Record<string, unknown>>;

    const machine = entries.find((e) => e['id'] === 'machine');
    assert.ok(machine);
    assert.equal(machine['readiness'], 'registered', 'machine.inventory itself is always in full');

    const desktop = entries.find((e) => e['id'] === 'desktop-probe');
    assert.ok(desktop);
    assert.equal(desktop['readiness'], 'unauthorized');
    assert.deepEqual(
      Object.keys(desktop).sort(),
      ['id', 'readiness'],
      'an unauthorized entry must carry no reason, platforms, or backs_adapter',
    );

    await adapter.dispose();
  });

  it('a job with machine.inventory and desktop.state reports the desktop entry in full', async () => {
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => ['machine', 'desktop'],
      registered_capabilities: () => ['machine.inventory', 'desktop.state', 'desktop.inspect'],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    const decisions: TargetDecisions = new Map([
      ['machine.inventory', 'allowed'],
      ['desktop.state', 'allowed'],
      ['desktop.inspect', 'denied'],
    ]);

    const entries = parseOutput(await adapter.invoke('inventory', {}, makeCtx(undefined, decisions)))
      ['entries'] as Array<Record<string, unknown>>;

    const desktop = entries.find((e) => e['id'] === 'desktop');
    assert.ok(desktop);
    assert.equal(desktop['readiness'], 'registered', 'desktop.state allowed → desktop entry in full');
    assert.ok(Array.isArray(desktop['platforms']), 'a full entry carries platforms');

    await adapter.dispose();
  });

  it('absent target_decisions reduces every entry to unauthorized, fail closed', async () => {
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => ['machine', 'desktop'],
      registered_capabilities: () => ['machine.inventory', 'desktop.state'],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    // makeCtx() with no decisions → ctx.target_decisions is undefined, which
    // must mean "empty decision map", so *every* entry fails closed — including
    // machine.inventory itself (AR-F5 round 3, P2).
    const entries = parseOutput(await adapter.invoke('inventory', {}, makeCtx()))
      ['entries'] as Array<Record<string, unknown>>;

    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['id', 'readiness'],
        `entry ${entry['id']} must be bare under absent decisions`,
      );
      assert.equal(entry['readiness'], 'unauthorized');
    }
    assert.ok(entries.some((e) => e['id'] === 'machine'), 'machine.inventory itself is unauthorized');

    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests — manifest
// ---------------------------------------------------------------------------

describe('machine adapter manifest', () => {
  it('declares process.spawn and fs.read', async () => {
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: fixedDriveTypes([]),
    });

    assert.deepEqual(
      [...adapter.manifest.required_permissions].sort(),
      ['fs.read', 'process.spawn'],
    );

    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests — test helper guard (AR-F5 round 2)
// ---------------------------------------------------------------------------

describe('machine.inventory — test helper guard', () => {
  it('makeTestAdapter throws when driveTypes is not injected', () => {
    // A unit test that forgets the driveTypes seam would otherwise fall back to
    // the production PowerShell reader and silently start a child process. The
    // guard must make that failure loud instead of letting it regress.
    assert.throws(
      () =>
        makeTestAdapter({
          node_platform: 'win32',
          probes: [],
          registered_adapter_ids: () => [],
          registered_capabilities: () => [],
          timeout_ms: 5_000,
        }),
      /must inject driveTypes/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — drive reader budget & cache (AR-F5 round 2)
// ---------------------------------------------------------------------------

describe('machine.inventory — drive reader budget & cache', () => {
  it('gives the reader a bounded budget and caches a successful read for 5 minutes', async () => {
    let calls = 0;
    let lastBudgetMs: number | undefined;
    const reader: DriveTypes = (signal, timeoutMs) => {
      calls++;
      lastBudgetMs = timeoutMs;
      assert.equal(signal.aborted, false);
      return Promise.resolve(['c']);
    };

    let clockMs = 0;
    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: reader,
      now: () => clockMs,
    });

    await adapter.invoke('inventory', {}, makeCtx());
    assert.equal(calls, 1, 'first invoke reads the drive type');
    // budget = min(3000, floor(5000 / 2)) = 2500
    assert.equal(lastBudgetMs, 2_500, 'reader got its own bounded budget, not the action timeout');

    await adapter.invoke('inventory', {}, makeCtx());
    assert.equal(calls, 1, 'second invoke within TTL is served from cache');

    // Just inside the 5-minute TTL: still cached.
    clockMs = 5 * 60 * 1_000 - 1;
    await adapter.invoke('inventory', {}, makeCtx());
    assert.equal(calls, 1, 'still within TTL → cache');

    // One past the TTL: cache is stale, reader is called again.
    clockMs = 5 * 60 * 1_000 + 1;
    await adapter.invoke('inventory', {}, makeCtx());
    assert.equal(calls, 2, 'past TTL → re-read');

    await adapter.dispose();
  });

  it('never caches a failed drive read, so each invoke re-reads', async () => {
    let calls = 0;
    const reader: DriveTypes = () => {
      calls++;
      return Promise.reject(new Error('powershell unavailable'));
    };

    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: reader,
      now: () => 0,
    });

    await adapter.invoke('inventory', {}, makeCtx());
    await adapter.invoke('inventory', {}, makeCtx());

    // A failure is never cached: both invokes reached the reader.
    assert.equal(calls, 2, 'a failed drive read must not be cached');

    await adapter.dispose();
  });

  it('does not cache an empty ([]) drive read — it is a failure signal, not success', async () => {
    let calls = 0;
    const reader: DriveTypes = () => {
      calls++;
      return Promise.resolve([]);
    };

    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: reader,
      now: () => 0,
    });

    await adapter.invoke('inventory', {}, makeCtx());
    await adapter.invoke('inventory', {}, makeCtx());

    // An empty result is never a "success" worth caching: both invokes re-read.
    assert.equal(calls, 2, 'an empty drive read must not be cached');

    await adapter.dispose();
  });

  it('does not cache a read whose signal aborted during the call', async () => {
    let calls = 0;
    const controller = new AbortController();
    // The reader resolves non-empty letters but aborts its signal mid-call, so
    // the read itself is not cached even though it resolved successfully.
    const reader: DriveTypes = (signal) => {
      calls++;
      return Promise.resolve(['c']).then((letters) => {
        // Simulate an abort landing while the read was in flight.
        controller.abort();
        return letters;
      });
    };

    const adapter = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: reader,
      now: () => 0,
    });

    await adapter.invoke('inventory', {}, makeCtx(controller.signal));

    // The aborted read resolved but must not have been cached.
    await adapter.invoke('inventory', {}, makeCtx());
    assert.equal(calls, 2, 'a read aborted mid-flight must not be cached');

    await adapter.dispose();
  });

  it('does not cache across separate adapter instances', async () => {
    let calls = 0;
    const reader: DriveTypes = () => {
      calls++;
      return Promise.resolve(['c']);
    };

    const a = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: reader,
      now: () => 0,
    });
    await a.invoke('inventory', {}, makeCtx());
    assert.equal(calls, 1);

    // A fresh instance has no cache.
    const b = makeTestAdapter({
      node_platform: 'win32',
      probes: [],
      registered_adapter_ids: () => [],
      registered_capabilities: () => [],
      timeout_ms: 5_000,
      driveTypes: reader,
      now: () => 0,
    });
    await b.invoke('inventory', {}, makeCtx());
    assert.equal(calls, 2, 'cache is per instance, not shared');

    await a.dispose();
    await b.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests — production drive reader (TOROS_REAL_TESTS=1, win32 only)
// ---------------------------------------------------------------------------

// The production reader spawns real Windows PowerShell, so it is gated behind
// TOROS_REAL_TESTS=1 and win32. It is the only test that builds an adapter
// through createMachineAdapter *without* a driveTypes seam — deliberately, to
// exercise createPowerShellDriveTypes and powershellExe end to end (AR-F5 R3).
const real = process.env['TOROS_REAL_TESTS'] === '1' && process.platform === 'win32';

describe(
  'machine.inventory — production drive reader',
  { skip: real ? false : 'requires TOROS_REAL_TESTS=1 on win32 to spawn real PowerShell' },
  () => {
  it('NODE_FILE_PROBE resolves usable through the real PowerShell drive reader', async () => {
    // Deliberately bypass makeTestAdapter: no driveTypes seam, so the adapter
    // runs the production PowerShell reader to learn the fixed drive letters.
    const adapter = createMachineAdapter({
      node_platform: 'win32',
      probes: [NODE_FILE_PROBE],
      registered_adapter_ids: () => ['node-finder'],
      registered_capabilities: () => [],
      timeout_ms: 30_000,
    });

    const result = await adapter.invoke(
      'inventory',
      {},
      makeCtx(undefined, allowDecisions('node-finder')),
    );
    const entries = parseOutput(result)['entries'] as Array<Record<string, unknown>>;

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['id'], 'node-finder');
    assert.equal(
      entries[0]!['readiness'],
      'usable',
      'the production reader must report the node binary drive as fixed on Windows',
    );

    await adapter.dispose();
  });
});