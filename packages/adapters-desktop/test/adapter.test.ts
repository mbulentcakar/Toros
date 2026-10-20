import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDesktopAdapter,
  type UiaProbe,
  type RawWindow,
  type RawControl,
} from '../src/adapter.js';
import type { AdapterContext, AppIdentity, JsonValue } from '@toros/contracts';
import { createRegistry } from '@toros/registry';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeIdentity(overrides: Partial<AppIdentity> = {}): AppIdentity {
  return {
    pid: 1234,
    created_at: '2026-01-01T00:00:00.000Z',
    image_path: 'C:\\Program Files\\Contoso\\app.exe',
    image_sha256: 'a'.repeat(64),
    signature: 'valid',
    signer: 'Contoso Corp',
    product_name: 'Contoso Editor',
    session_id: 7,
    ...overrides,
  };
}

function makeRawWindow(overrides: Partial<RawWindow> & { identity?: AppIdentity } = {}): RawWindow {
  return {
    native_handle: '123456',
    title: 'Book1 — Excel',
    identity: makeIdentity(),
    z_order: 0,
    foreground: true,
    ...overrides,
  };
}

function makeFakeProbe(
  windows: readonly RawWindow[] = [],
  sessionState: 'active' | 'locked' | 'disconnected' = 'active',
  // The LIVE identity the probe reports back for an inspected/re-verified window.
  // Defaults to the resolved identity; override to simulate a reused handle.
  inspectIdentity: AppIdentity | null = makeIdentity(),
  controls: readonly RawControl[] = [],
  closed: boolean = false,
  truncated: boolean = false,
): UiaProbe & { enumerateCalls: number } {
  const probe = {
    enumerateCalls: 0,
    async enumerateWindows(opts: { max_windows: number }, _signal: AbortSignal) {
      probe.enumerateCalls += 1;
      if (sessionState === 'active') {
        const maxw = opts.max_windows;
        const isTruncated = truncated || windows.length > maxw;
        return { session_state: 'active' as const, windows: windows.slice(0, maxw), truncated: isTruncated };
      }
      return { session_state: sessionState };
    },
    async inspectWindow(_nativeHandle: string, _opts: { depth: number; max_controls: number }, _signal: AbortSignal) {
      if (closed) return { closed: true as const };
      return { closed: false as const, identity: inspectIdentity, controls, truncated };
    },
  };
  return probe;
}

function fakeContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    job_id: 'job-1',
    session_id: null,
    workspace: { id: 'ws-1', root: '/tmp/ws-1' },
    correlation_id: 'corr-1',
    signal: new AbortController().signal,
    actor: 'coordinator',
    ...overrides,
  };
}

const IN_SCOPE_SHA = 'a'.repeat(64);

function makeAdapter(
  authorizedApps: Parameters<typeof createDesktopAdapter>[0]['authorized_apps'] = [{ image_sha256: IN_SCOPE_SHA }],
  probe: UiaProbe = makeFakeProbe(),
  now?: () => number,
): ReturnType<typeof createDesktopAdapter> {
  return createDesktopAdapter({
    node_platform: 'win32',
    authorized_apps: authorizedApps,
    probe,
    max_windows: 200,
    max_controls: 2000,
    timeout_ms: 30_000,
    ...(now === undefined ? {} : { now }),
  });
}

/** Drive a full two-phase `state` request: resolve, then invoke with decisions. */
type TargetDecisionsMap = ReadonlyMap<string, 'allowed' | 'denied'>;
const allowedMap = (...keys: string[]): TargetDecisionsMap => new Map(keys.map((k) => [k, 'allowed'] as const));
const deniedMap = (...keys: string[]): TargetDecisionsMap => new Map(keys.map((k) => [k, 'denied'] as const));
const emptyMap = (): TargetDecisionsMap => new Map<string, 'allowed' | 'denied'>();

describe('F3b desktop adapter — two-phase resolve', () => {
  it('resolves only global-bound windows as app targets and publishes only allowed keys', async () => {
    const probe = makeFakeProbe([
      makeRawWindow({ identity: makeIdentity() }), // in scope (sha matches)
      makeRawWindow({ native_handle: '999', identity: makeIdentity({ image_sha256: 'b'.repeat(64) }) }), // out of global bound
    ]);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);
    const ctx = fakeContext();

    const resolver = adapter.resolver!;
    const targets = await resolver.resolve('state', {}, ctx);

    // Only the in-scope window becomes a target.
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.kind, 'app');

    // invoke with only that key allowed.
    const key = (targets[0]! as { key: string }).key;
    const decisions = allowedMap(key);
    const result = await adapter.invoke('state', {}, { ...ctx, target_decisions: decisions });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(body.session, 'active');
    assert.equal((body.windows as unknown[]).length, 1);
    assert.ok((body.freshness_token as string).length > 0);
  });

  it('a window denied by Core never appears in output', async () => {
    const probe = makeFakeProbe([makeRawWindow()]);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);
    const ctx = fakeContext();

    const resolver = adapter.resolver!;
    const targets = await resolver.resolve('state', {}, ctx);
    const key = (targets[0]! as { key: string }).key;
    // Core denies it (e.g. envelope does not name the app).
    const result = await adapter.invoke('state', {}, { ...ctx, target_decisions: deniedMap(key) });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal((body.windows as unknown[]).length, 0);
  });

  it('locked/disconnected session returns session=unavailable with a reason and no windows', async () => {
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], makeFakeProbe([], 'locked'));
    const ctx = fakeContext();
    const targets = await adapter.resolver!.resolve('state', {}, ctx);
    assert.equal(targets.length, 0);
    const result = await adapter.invoke('state', {}, { ...ctx, target_decisions: emptyMap() });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(body.session, 'unavailable');
    assert.equal(body.reason, 'locked');
    assert.equal((body.windows as unknown[]).length, 0);
  });

  it('re-verifies identity at invoke: a changed pid drops the window and counts changed', async () => {
    const resolved = makeIdentity();
    // The probe reports a DIFFERENT live pid for the same handle at invoke time.
    const probe = makeFakeProbe([makeRawWindow({ identity: resolved })], 'active', makeIdentity({ pid: 9999 }));
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);
    const ctx = fakeContext();
    const targets = await adapter.resolver!.resolve('state', {}, ctx);
    const key = (targets[0]! as { key: string }).key;
    const result = await adapter.invoke('state', {}, { ...ctx, target_decisions: allowedMap(key) });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal((body.windows as unknown[]).length, 0, 'a changed identity window must be dropped');
    assert.equal(result.receipt_extra.changed, 1);
  });
});

describe('F3b desktop adapter — handles (AR-05)', () => {
  it('a foreign actor using the same window handle gets refresh_required', async () => {
    const probe = makeFakeProbe([makeRawWindow()], 'active', makeIdentity(), []);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);

    // Actor A enumerates.
    const ctxA = fakeContext({ job_id: 'job-1', actor: 'actor-a' });
    const targets = await adapter.resolver!.resolve('state', {}, ctxA);
    const key = (targets[0]! as { key: string }).key;
    const tokenBody = JSON.parse((await adapter.invoke('state', {}, { ...ctxA, target_decisions: allowedMap(key) })).output) as { freshness_token: string };

    // Actor B (same job) inspects with A's window_id + token.
    const ctxB = fakeContext({ job_id: 'job-1', actor: 'actor-b' });
    const inspectTargets = await adapter.resolver!.resolve('inspect', { window_id: key, freshness_token: tokenBody.freshness_token }, ctxB);
    assert.equal(inspectTargets.length, 0, 'a foreign actor must resolve no target');
    const result = await adapter.invoke('inspect', { window_id: key, freshness_token: tokenBody.freshness_token }, { ...ctxB, target_decisions: emptyMap() });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(body.status, 'refresh_required');
  });

  it('a foreign job using the same window handle gets refresh_required', async () => {
    const probe = makeFakeProbe([makeRawWindow()], 'active', makeIdentity(), []);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);
    const ctxA = fakeContext({ job_id: 'job-1', actor: 'actor' });
    const targets = await adapter.resolver!.resolve('state', {}, ctxA);
    const key = (targets[0]! as { key: string }).key;
    const tokenBody = JSON.parse((await adapter.invoke('state', {}, { ...ctxA, target_decisions: allowedMap(key) })).output) as { freshness_token: string };

    const ctxB = fakeContext({ job_id: 'job-2', actor: 'actor' });
    const result = await adapter.invoke('inspect', { window_id: key, freshness_token: tokenBody.freshness_token }, { ...ctxB, target_decisions: emptyMap() });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(body.status, 'refresh_required');
  });

  it('a single-use handle is consumed: the second inspect returns refresh_required', async () => {
    const probe = makeFakeProbe([makeRawWindow()], 'active', makeIdentity(), []);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);
    const ctx = fakeContext();
    const targets = await adapter.resolver!.resolve('state', {}, ctx);
    const key = (targets[0]! as { key: string }).key;
    const tokenBody = JSON.parse((await adapter.invoke('state', {}, { ...ctx, target_decisions: allowedMap(key) })).output) as { freshness_token: string };
    const token = tokenBody.freshness_token;

    // First inspect (allowed) succeeds.
    const firstTargets = await adapter.resolver!.resolve('inspect', { window_id: key, freshness_token: token }, ctx);
    assert.equal(firstTargets.length, 1);
    const first = await adapter.invoke('inspect', { window_id: key, freshness_token: token }, { ...ctx, target_decisions: allowedMap(key) });
    const firstBody = JSON.parse(first.output) as Record<string, unknown>;
    assert.equal(firstBody.status, 'ok');

    // Second inspect with the same pair → refresh_required (single-use).
    const secondTargets = await adapter.resolver!.resolve('inspect', { window_id: key, freshness_token: token }, ctx);
    assert.equal(secondTargets.length, 0);
    const second = await adapter.invoke('inspect', { window_id: key, freshness_token: token }, { ...ctx, target_decisions: emptyMap() });
    const secondBody = JSON.parse(second.output) as Record<string, unknown>;
    assert.equal(secondBody.status, 'refresh_required');
  });

  it('an expired handle returns refresh_required (the 60 s TTL)', async () => {
    // Injectable clock: the enumeration is minted at t=0; advancing past 60 s
    // expires it without a re-enumeration.
    let nowMs = 0;
    const probe = makeFakeProbe([makeRawWindow()], 'active', makeIdentity(), []);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe, () => nowMs);
    const ctx = fakeContext();
    const targets = await adapter.resolver!.resolve('state', {}, ctx);
    const key = (targets[0]! as { key: string }).key;
    const tokenBody = JSON.parse((await adapter.invoke('state', {}, { ...ctx, target_decisions: allowedMap(key) })).output) as { freshness_token: string };
    const token = tokenBody.freshness_token;

    // Still valid before the TTL.
    assert.equal((await adapter.resolver!.resolve('inspect', { window_id: key, freshness_token: token }, ctx)).length, 1);

    // Advance past the 60 s TTL.
    nowMs = 61_000;
    assert.equal((await adapter.resolver!.resolve('inspect', { window_id: key, freshness_token: token }, ctx)).length, 0, 'an expired handle must resolve nothing');
    const result = await adapter.invoke('inspect', { window_id: key, freshness_token: token }, { ...ctx, target_decisions: emptyMap() });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(body.status, 'refresh_required');
  });

  it('a window_id unknown to the enumeration returns refresh_required', async () => {
    const probe = makeFakeProbe([makeRawWindow()], 'active', makeIdentity(), []);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);
    const ctx = fakeContext();
    const targets = await adapter.resolver!.resolve('state', {}, ctx);
    void targets;
    const result = await adapter.invoke('inspect', { window_id: 'bogus-id', freshness_token: 'any' }, { ...ctx, target_decisions: emptyMap() });
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(body.status, 'refresh_required');
  });

  it('evicts the oldest enumeration at the 32-enumeration cap', async () => {
    const probe = makeFakeProbe([makeRawWindow()], 'active', makeIdentity(), []);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);

    // Fill 32 distinct (job, actor) enumerations.
    for (let i = 0; i < 32; i++) {
      const ctx = fakeContext({ job_id: `job-${i}`, actor: 'actor' });
      await adapter.resolver!.resolve('state', {}, ctx);
    }
    // A 33rd evicts job-0.
    const ctx33 = fakeContext({ job_id: 'job-33', actor: 'actor' });
    await adapter.resolver!.resolve('state', {}, ctx33);

    // job-0's enumeration is gone: its inspect resolves nothing.
    const ctx0 = fakeContext({ job_id: 'job-0', actor: 'actor' });
    const targets = await adapter.resolver!.resolve('inspect', { window_id: 'any', freshness_token: 'any' }, ctx0);
    assert.equal(targets.length, 0);
  });
});

describe('F3b desktop adapter — session enum + inspect scope', () => {
  it('manifest declares session_scope as the "interactive" enum and required fs permissions', () => {
    const adapter = makeAdapter();
    const state = adapter.manifest.actions.find((a) => a.id === 'state')!;
    const props = (state.input_schema as { properties: Record<string, unknown> }).properties;
    assert.deepEqual((props['session_scope'] as { enum: readonly string[] }).enum, ['interactive']);
    const inspect = adapter.manifest.actions.find((a) => a.id === 'inspect')!;
    const inspectProps = (inspect.input_schema as { properties: Record<string, unknown> }).properties;
    assert.deepEqual((inspectProps['session_scope'] as { enum: readonly string[] }).enum, ['interactive']);
    assert.ok(adapter.manifest.required_permissions.includes('fs.read'));
    assert.ok(adapter.manifest.required_permissions.includes('fs.write'));
  });

  it('the registry raises E_SCHEMA for a session_scope other than "interactive"', async () => {
    const adapter = makeAdapter();
    const registry = createRegistry({ workspaces: [{ id: 'ws-1', root: '/tmp/ws-1' }] });
    await registry.register(adapter);
    // valid
    registry.validateArguments('desktop.state', { session_scope: 'interactive' });
    // invalid
    assert.throws(
      () => registry.validateArguments('desktop.state', { session_scope: 'default' }),
      (err: unknown) => (err as { code?: string }).code === 'E_SCHEMA',
    );
  });

  it('inspect on an allowed decision returns ok; on a denied decision returns denied', async () => {
    const probe = makeFakeProbe([makeRawWindow()], 'active', makeIdentity(), [
      { native_id: 'c1', control_type: 'Button', automation_id: 'btn', enabled: true, patterns: [] },
    ]);
    const adapter = makeAdapter([{ image_sha256: IN_SCOPE_SHA }], probe);
    const ctx = fakeContext();
    const targets = await adapter.resolver!.resolve('state', {}, ctx);
    const key = (targets[0]! as { key: string }).key;
    const tokenBody = JSON.parse((await adapter.invoke('state', {}, { ...ctx, target_decisions: allowedMap(key) })).output) as { freshness_token: string };
    const token = tokenBody.freshness_token;

    // allowed
    const okTargets = await adapter.resolver!.resolve('inspect', { window_id: key, freshness_token: token }, ctx);
    const okDec = allowedMap(...okTargets.map((t) => (t as { key: string }).key));
    const ok = await adapter.invoke('inspect', { window_id: key, freshness_token: token }, { ...ctx, target_decisions: okDec });
    assert.equal((JSON.parse(ok.output) as Record<string, unknown>).status, 'ok');

    // denied — but the handle is already consumed by the ok inspect, so mint a
    // fresh handle for the denied case.
    const t2 = await adapter.resolver!.resolve('state', {}, ctx);
    const key2 = (t2[0]! as { key: string }).key;
    const tok2 = JSON.parse((await adapter.invoke('state', {}, { ...ctx, target_decisions: allowedMap(key2) })).output) as { freshness_token: string };
    await adapter.resolver!.resolve('inspect', { window_id: key2, freshness_token: tok2.freshness_token }, ctx);
    const denied = await adapter.invoke('inspect', { window_id: key2, freshness_token: tok2.freshness_token }, { ...ctx, target_decisions: deniedMap(key2) });
    assert.equal((JSON.parse(denied.output) as Record<string, unknown>).status, 'denied');
  });
});