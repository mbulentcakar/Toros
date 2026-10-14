import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createDesktopAdapter,
  type UiaProbe,
  type RawWindow,
  type RawControl,
} from '../src/adapter.js';
import { DESKTOP_UIA_PS1 } from '../src/probe.js';

import type { AdapterContext, JsonValue } from '@toros/contracts';

// ---------------------------------------------------------------------------
// Fake UiaProbe for testing — canned data, no PowerShell
// ---------------------------------------------------------------------------

function makeFakeProbe(
  windows: readonly RawWindow[] = [],
  sessionState: 'active' | 'locked' | 'disconnected' = 'active',
  controls: readonly RawControl[] = [],
  closed: boolean = false,
  truncated: boolean = false,
  // The LIVE process name the probe reports for the inspected window. Defaults to
  // the in-scope app so ok-path tests pass re-validation; override to simulate a
  // reused handle now owned by a different process.
  inspectProcessName: string = 'NOTEPAD.EXE',
): UiaProbe {
  return {
    async enumerateWindows(
      _sessionScope: string,
      optsOrSignal?: { max_windows: number } | AbortSignal,
      _maybeSignal?: AbortSignal,
    ) {
      if (sessionState === 'active') {
        const opts = optsOrSignal && typeof optsOrSignal === 'object' && 'max_windows' in optsOrSignal ? optsOrSignal : undefined;
        const maxw = opts?.max_windows ?? windows.length;
        const isTruncated = truncated || windows.length > maxw;
        return { session_state: 'active', windows: windows.slice(0, maxw), truncated: isTruncated };
      }
      return { session_state: sessionState };
    },
    async inspectWindow(
      _nativeHandle: string,
      _opts: { depth: number; max_controls: number },
      _signal: AbortSignal,
    ) {
      if (closed) return { closed: true };
      return { closed: false, process_name: inspectProcessName, controls, truncated };
    },
  };
}

function fakeContext(): AdapterContext {
  return {
    job_id: 'job-1',
    session_id: null,
    workspace: { id: 'ws-1', root: '/tmp/ws-1' },
    correlation_id: 'corr-1',
    signal: new AbortController().signal,
  };
}

function okOutput(obj: unknown): string {
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Canned test data
// ---------------------------------------------------------------------------

const inScopeApp = 'NOTEPAD.EXE';
const outScopeApp = 'CALC.EXE';

const rawExcelWindow: RawWindow = {
  native_handle: '123456',
  title: 'Book1 — Excel',
  process_name: inScopeApp,
  z_order: 0,
  foreground: true,
};

const rawCalcWindow: RawWindow = {
  native_handle: '789012',
  title: 'Calculator',
  process_name: outScopeApp,
  z_order: 1,
  foreground: false,
};

const rawControls: RawControl[] = [
  {
    native_id: 'c1',
    control_type: 'Button',
    automation_id: 'btn-ok',
    enabled: true,
    patterns: ['Invoke'],
  },
  {
    native_id: 'c2',
    control_type: 'Edit',
    automation_id: 'txt-doc',
    enabled: true,
    patterns: ['Value', 'Text'],
  },
  {
    native_id: 'c3',
    control_type: 'CheckBox',
    automation_id: 'chk-feature',
    enabled: true,
    patterns: ['Toggle'],
  },
];

// ---------------------------------------------------------------------------
// Test 1: desktop.state active — opaque ids, freshness_token, scoped titles
// ---------------------------------------------------------------------------

describe('desktop.state', () => {
  it('active session returns opaque window_ids, freshness_token, and scoped titles', async () => {
    const probe = makeFakeProbe([rawExcelWindow, rawCalcWindow]);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const result = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());

    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.session_state, 'active');
    assert.ok(typeof body.freshness_token === 'string' && body.freshness_token.length > 0);

    const windows = body.windows as Array<Record<string, unknown>>;
    assert.strictEqual(windows.length, 2);

    // Window 0: app_in_scope → has title
    const w0 = windows[0]!;
    assert.ok(typeof w0.window_id === 'string' && w0.window_id.length > 0);
    // Assert window_id is NOT the native handle
    assert.notStrictEqual(w0.window_id, rawExcelWindow.native_handle);
    assert.strictEqual(w0.app_in_scope, true);
    assert.strictEqual(w0.title, rawExcelWindow.title);
    assert.strictEqual(w0.z_order, 0);
    assert.strictEqual(w0.foreground, true);

    // Window 1: NOT app_in_scope → title OMITTED
    const w1 = windows[1]!;
    assert.ok(typeof w1.window_id === 'string' && w1.window_id.length > 0);
    assert.notStrictEqual(w1.window_id, rawCalcWindow.native_handle);
    assert.strictEqual(w1.app_in_scope, false);
    assert.strictEqual(w1.title, undefined);

    // receipt_extra
    assert.strictEqual(result.receipt_extra.window_count, 2);
    assert.strictEqual(result.receipt_extra.session_state, 'active');
    assert.strictEqual(result.receipt_extra.truncated, false);
  });

  // ---------------------------------------------------------------------------
  // Test 2: desktop.state locked and disconnected — no windows
  // ---------------------------------------------------------------------------

  it('locked session returns session_state=locked, windows=[]', async () => {
    const probe = makeFakeProbe([], 'locked');
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const result = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.session_state, 'locked');
    const windows = body.windows as Array<unknown>;
    assert.strictEqual(windows.length, 0);
    assert.strictEqual(body.freshness_token, undefined);
    assert.strictEqual(result.receipt_extra.session_state, 'locked');
    assert.strictEqual(result.receipt_extra.window_count, 0);
  });

  it('disconnected session returns session_state=disconnected, windows=[]', async () => {
    const probe = makeFakeProbe([], 'disconnected');
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const result = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.session_state, 'disconnected');
    const windows = body.windows as Array<unknown>;
    assert.strictEqual(windows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: desktop.inspect with valid token and in-scope window → status ok
// ---------------------------------------------------------------------------

describe('desktop.inspect', () => {
  it('in-scope window returns status=ok with opaque control ids and no value field', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    // First get state to obtain the freshness token and window_id
    const stateResult = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const stateBody = JSON.parse(stateResult.output) as Record<string, unknown>;
    const freshnessToken = stateBody.freshness_token as string;
    const windows = stateBody.windows as Array<Record<string, unknown>>;
    const windowId = windows[0]!.window_id as string;

    // Now inspect
    const inspectResult = await adapter.invoke('inspect', {
      window_id: windowId,
      freshness_token: freshnessToken,
    }, fakeContext());

    const body = JSON.parse(inspectResult.output) as Record<string, unknown>;
    assert.strictEqual(body.status, 'ok');
    const controls = body.controls as Array<Record<string, unknown>>;
    assert.strictEqual(controls.length, 3);

    // Check first control — opaque id, automation_id present, NO name, NO value
    const c0 = controls[0]!;
    assert.ok(typeof c0.control_id === 'string' && c0.control_id.length > 0);
    assert.notStrictEqual(c0.control_id, 'c1'); // NOT the native id
    assert.strictEqual(c0.type, 'Button');
    assert.strictEqual(c0.enabled, true);
    assert.strictEqual(c0.automation_id, 'btn-ok');
    assert.strictEqual((c0 as Record<string, unknown>).name, undefined); // NEVER a name field
    assert.strictEqual((c0 as Record<string, unknown>).value, undefined); // NEVER a value field
    assert.deepStrictEqual(Object.keys(c0).sort(), ['automation_id', 'control_id', 'enabled', 'patterns', 'type'].sort());

    // Check second control
    const c1 = controls[1]!;
    assert.strictEqual(c1.type, 'Edit');
    assert.strictEqual(c1.automation_id, 'txt-doc');
    assert.strictEqual((c1 as Record<string, unknown>).name, undefined); // NEVER a name field
    assert.strictEqual((c1 as Record<string, unknown>).value, undefined); // NEVER a value field
    assert.deepStrictEqual(Object.keys(c1).sort(), ['automation_id', 'control_id', 'enabled', 'patterns', 'type'].sort());

    // receipt_extra
    assert.strictEqual(inspectResult.receipt_extra.status, 'ok');
    assert.strictEqual(inspectResult.receipt_extra.control_count, 3);
  });

  // ---------------------------------------------------------------------------
  // Test 4: stale token or unknown window_id → refresh_required
  // ---------------------------------------------------------------------------

  it('stale freshness_token returns refresh_required', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    // First state call
    const stateResult1 = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const stateBody1 = JSON.parse(stateResult1.output) as Record<string, unknown>;
    const freshnessToken1 = stateBody1.freshness_token as string;
    const windows1 = stateBody1.windows as Array<Record<string, unknown>>;
    const windowId1 = windows1[0]!.window_id as string;

    // Second state call — rotates the enumeration
    await adapter.invoke('state', { session_scope: 'default' }, fakeContext());

    // Try inspect with the OLD token → refresh_required
    const result = await adapter.invoke('inspect', {
      window_id: windowId1,
      freshness_token: freshnessToken1,
    }, fakeContext());

    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.status, 'refresh_required');
    assert.strictEqual(body.controls, undefined);
    assert.strictEqual(result.receipt_extra.status, 'refresh_required');
    assert.strictEqual(result.receipt_extra.control_count, 0);
  });

  it('unknown window_id returns refresh_required', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateResult = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const stateBody = JSON.parse(stateResult.output) as Record<string, unknown>;
    const freshnessToken = stateBody.freshness_token as string;

    // Use a made-up window_id
    const result = await adapter.invoke('inspect', {
      window_id: 'bogus-window-id',
      freshness_token: freshnessToken,
    }, fakeContext());

    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.status, 'refresh_required');
  });

  it('inspect with no prior enumeration returns refresh_required', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    // Call inspect without prior state — no enumeration stored
    const result = await adapter.invoke('inspect', {
      window_id: 'any-id',
      freshness_token: 'any-token',
    }, fakeContext());

    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.status, 'refresh_required');
  });

  // ---------------------------------------------------------------------------
  // Test 5: out-of-scope window → denied
  // ---------------------------------------------------------------------------

  it('out-of-scope window returns status=denied, no controls', async () => {
    const probe = makeFakeProbe([rawCalcWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp], // only inScopeApp is authorized
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateResult = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const stateBody = JSON.parse(stateResult.output) as Record<string, unknown>;
    const freshnessToken = stateBody.freshness_token as string;
    const windows = stateBody.windows as Array<Record<string, unknown>>;
    const calcWindowId = windows[0]!.window_id as string;
    assert.strictEqual(windows[0]!.app_in_scope, false);

    const result = await adapter.invoke('inspect', {
      window_id: calcWindowId,
      freshness_token: freshnessToken,
    }, fakeContext());

    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.status, 'denied');
    assert.strictEqual(body.controls, undefined);
    assert.strictEqual(result.receipt_extra.status, 'denied');
  });

  // ---------------------------------------------------------------------------
  // Test 6: closed window → unavailable
  // ---------------------------------------------------------------------------

  it('closed window returns status=unavailable', async () => {
    // Fake probe that returns closed:true for inspectWindow
    const probe: UiaProbe = {
      async enumerateWindows(_sessionScope: string, _opts: { max_windows: number }, _signal: AbortSignal) {
        return { session_state: 'active', windows: [rawExcelWindow] };
      },
      async inspectWindow(
        _nativeHandle: string,
        _opts: { depth: number; max_controls: number },
        _signal: AbortSignal,
      ) {
        return { closed: true };
      },
    };

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateResult = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const stateBody = JSON.parse(stateResult.output) as Record<string, unknown>;
    const freshnessToken = stateBody.freshness_token as string;
    const windows = stateBody.windows as Array<Record<string, unknown>>;
    const windowId = windows[0]!.window_id as string;

    const result = await adapter.invoke('inspect', {
      window_id: windowId,
      freshness_token: freshnessToken,
    }, fakeContext());

    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.status, 'unavailable');
    assert.strictEqual(result.receipt_extra.status, 'unavailable');
  });

  // ---------------------------------------------------------------------------
  // Test 7: pagination/limits — truncated + next_page, max_controls respected
  // ---------------------------------------------------------------------------

  it('adapter paginates the probe controls: truncated + next_page, filter before paging', async () => {
    // The probe returns the full document-order list; the ADAPTER filters then paginates.
    const manyControls: RawControl[] = [
      { native_id: 'c1', control_type: 'Button', automation_id: 'B1', enabled: true, patterns: [] },
      { native_id: 'c2', control_type: 'Edit', automation_id: 'E1', enabled: true, patterns: [] },
      { native_id: 'c3', control_type: 'Button', automation_id: 'B2', enabled: true, patterns: [] },
      { native_id: 'c4', control_type: 'Button', automation_id: 'B3', enabled: true, patterns: [] },
    ];
    const probe = makeFakeProbe([rawExcelWindow], 'active', manyControls, false, false);
    const adapter = createDesktopAdapter({
      node_platform: 'win32', authorized_apps: [inScopeApp], probe,
      max_windows: 200, max_controls: 2000, timeout_ms: 30_000,
    });
    const sb = JSON.parse((await adapter.invoke('state', { session_scope: 'default' }, fakeContext())).output) as Record<string, unknown>;
    const ft = sb.freshness_token as string;
    const wid = (sb.windows as Array<Record<string, unknown>>)[0]!.window_id as string;

    // Page 1, size 2 → first two, truncated + next_page.
    const p1 = JSON.parse((await adapter.invoke('inspect', { window_id: wid, freshness_token: ft, page: 1, page_size: 2 }, fakeContext())).output) as Record<string, unknown>;
    assert.strictEqual(p1.status, 'ok');
    assert.strictEqual((p1.controls as unknown[]).length, 2);
    assert.strictEqual(p1.truncated, true);
    assert.strictEqual(p1.next_page, 2);

    // Page 2 → last two, no next_page.
    const p2 = JSON.parse((await adapter.invoke('inspect', { window_id: wid, freshness_token: ft, page: 2, page_size: 2 }, fakeContext())).output) as Record<string, unknown>;
    assert.strictEqual((p2.controls as unknown[]).length, 2);
    assert.strictEqual(p2.truncated, false);
    assert.strictEqual(p2.next_page, undefined);

    // Filter BEFORE paging: 'Button' → 3 buttons across the whole list, not just page 1.
    const f = JSON.parse((await adapter.invoke('inspect', { window_id: wid, freshness_token: ft, control_filter: 'Button', page: 1, page_size: 2 }, fakeContext())).output) as Record<string, unknown>;
    assert.strictEqual((f.controls as Array<Record<string, unknown>>).every((c) => c.type === 'Button'), true);
    assert.strictEqual((f.controls as unknown[]).length, 2);
    assert.strictEqual(f.truncated, true);  // 3 buttons, page_size 2 → more remain
    assert.strictEqual(f.next_page, 2);
  });

  it('max_controls is passed to the probe', async () => {
    let seenMax = -1;
    const probe: UiaProbe = {
      async enumerateWindows(_s: string, _opts: { max_windows: number }, _sig: AbortSignal) { return { session_state: 'active', windows: [rawExcelWindow] }; },
      async inspectWindow(_nh: string, opts: { depth: number; max_controls: number }, _sig: AbortSignal) {
        seenMax = opts.max_controls;
        return { closed: false, process_name: inScopeApp, controls: [], truncated: true };
      },
    };
    const adapter = createDesktopAdapter({
      node_platform: 'win32', authorized_apps: [inScopeApp], probe,
      max_windows: 200, max_controls: 20, timeout_ms: 30_000,
    });
    const sb = JSON.parse((await adapter.invoke('state', { session_scope: 'default' }, fakeContext())).output) as Record<string, unknown>;
    const ft = sb.freshness_token as string;
    const wid = (sb.windows as Array<Record<string, unknown>>)[0]!.window_id as string;
    const b = JSON.parse((await adapter.invoke('inspect', { window_id: wid, freshness_token: ft }, fakeContext())).output) as Record<string, unknown>;
    assert.strictEqual(seenMax, 20);          // configured max_controls reaches the probe
    assert.strictEqual(b.truncated, true);    // probe-level truncation is surfaced
  });

  // ---------------------------------------------------------------------------
  // Test 8: control_filter narrows by type/automation_id only, never name
  // ---------------------------------------------------------------------------

  it('control_filter narrows by type and automation_id only, never name', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const sr = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const sb = JSON.parse(sr.output) as Record<string, unknown>;
    const ft = sb.freshness_token as string;
    const ws = sb.windows as Array<Record<string, unknown>>;
    const wid = ws[0]!.window_id as string;

    // Filter by type substring: "Button" should match the Button control
    const r1 = await adapter.invoke('inspect', {
      window_id: wid,
      freshness_token: ft,
      control_filter: 'Button',
    }, fakeContext());
    const b1 = JSON.parse(r1.output) as Record<string, unknown>;
    assert.strictEqual(b1.status, 'ok');
    const c1 = b1.controls as Array<Record<string, unknown>>;
    assert.strictEqual(c1.length, 1);
    assert.strictEqual(c1[0]!.type, 'Button');

    // Filter by automation_id substring: "doc" should match Edit with automation_id 'txt-doc'
    const r2 = await adapter.invoke('inspect', {
      window_id: wid,
      freshness_token: ft,
      control_filter: 'doc',
    }, fakeContext());
    const b2 = JSON.parse(r2.output) as Record<string, unknown>;
    const c2 = b2.controls as Array<Record<string, unknown>>;
    assert.strictEqual(c2.length, 1);
    assert.strictEqual(c2[0]!.type, 'Edit');

    // Filter by canary string that would have been a control name: matches nothing
    const r3 = await adapter.invoke('inspect', {
      window_id: wid,
      freshness_token: ft,
      control_filter: 'CANARY_NAME_NEVER_MATCHES',
    }, fakeContext());
    const b3 = JSON.parse(r3.output) as Record<string, unknown>;
    const c3 = b3.controls as Array<Record<string, unknown>>;
    assert.strictEqual(c3.length, 0);
  });

  // ---------------------------------------------------------------------------
  // Static test (Acceptance 2)
  // ---------------------------------------------------------------------------

  it('static test: DESKTOP_UIA_PS1 contains no Current.Name and no NameProperty', () => {
    assert.ok(!DESKTOP_UIA_PS1.includes('Current.Name'), 'DESKTOP_UIA_PS1 must not contain Current.Name');
    assert.ok(!DESKTOP_UIA_PS1.includes('NameProperty'), 'DESKTOP_UIA_PS1 must not contain NameProperty');

    const probeFile = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../src/probe.ts');
    if (fs.existsSync(probeFile)) {
      const probeSource = fs.readFileSync(probeFile, 'utf8');
      const scriptMatch = probeSource.match(/export const DESKTOP_UIA_PS1 = `([\s\S]*?)`;/);
      assert.ok(scriptMatch, 'DESKTOP_UIA_PS1 declaration found in probe.ts');
      assert.ok(!scriptMatch[1]!.includes('Current.Name'), 'probe.ts script body must not contain Current.Name');
      assert.ok(!scriptMatch[1]!.includes('NameProperty'), 'probe.ts script body must not contain NameProperty');
    }
  });

  // ---------------------------------------------------------------------------
  // Key count and automation_id validation (Acceptance 3)
  // ---------------------------------------------------------------------------

  it('control output objects contain exactly the five keys; over-long or non-ASCII automation_id is omitted', async () => {
    const variedControls: RawControl[] = [
      // 1. Valid 1-128 ASCII -> included (5 keys)
      { native_id: 'v1', control_type: 'Button', automation_id: 'btn-1', enabled: true, patterns: [] },
      // 2. Over-long (>128 chars) -> omitted (4 keys)
      { native_id: 'v2', control_type: 'Button', automation_id: 'a'.repeat(129), enabled: true, patterns: [] },
      // 3. Non-ASCII characters -> omitted (4 keys)
      { native_id: 'v3', control_type: 'Button', automation_id: 'btn_ü_test', enabled: true, patterns: [] },
      // 4. Control chars (newline) -> omitted (4 keys)
      { native_id: 'v4', control_type: 'Button', automation_id: 'btn\nnewline', enabled: true, patterns: [] },
      // 5. Empty string -> omitted (4 keys)
      { native_id: 'v5', control_type: 'Button', automation_id: '', enabled: true, patterns: [] },
      // 6. Undefined -> omitted (4 keys)
      { native_id: 'v6', control_type: 'Button', enabled: true, patterns: [] },
    ];
    const probe = makeFakeProbe([rawExcelWindow], 'active', variedControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });
    const sr = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const ft = (JSON.parse(sr.output) as Record<string, unknown>).freshness_token as string;
    const wid = ((JSON.parse(sr.output) as Record<string, unknown>).windows as Array<Record<string, unknown>>)[0]!.window_id as string;

    const r = await adapter.invoke('inspect', { window_id: wid, freshness_token: ft }, fakeContext());
    const controls = (JSON.parse(r.output) as Record<string, unknown>).controls as Array<Record<string, unknown>>;
    assert.strictEqual(controls.length, 6);

    // v1: valid automation_id -> exactly 5 keys: control_id, type, automation_id, enabled, patterns
    assert.strictEqual(controls[0]!.automation_id, 'btn-1');
    assert.deepStrictEqual(Object.keys(controls[0]!).sort(), ['automation_id', 'control_id', 'enabled', 'patterns', 'type'].sort());
    assert.strictEqual((controls[0]! as Record<string, unknown>).name, undefined);

    // v2: over-long -> automation_id omitted, exactly 4 keys
    assert.strictEqual(controls[1]!.automation_id, undefined);
    assert.deepStrictEqual(Object.keys(controls[1]!).sort(), ['control_id', 'enabled', 'patterns', 'type'].sort());

    // v3: non-ASCII -> automation_id omitted, exactly 4 keys
    assert.strictEqual(controls[2]!.automation_id, undefined);
    assert.deepStrictEqual(Object.keys(controls[2]!).sort(), ['control_id', 'enabled', 'patterns', 'type'].sort());

    // v4: control char -> omitted, exactly 4 keys
    assert.strictEqual(controls[3]!.automation_id, undefined);
    assert.deepStrictEqual(Object.keys(controls[3]!).sort(), ['control_id', 'enabled', 'patterns', 'type'].sort());

    // v5: empty -> omitted, exactly 4 keys
    assert.strictEqual(controls[4]!.automation_id, undefined);
    assert.deepStrictEqual(Object.keys(controls[4]!).sort(), ['control_id', 'enabled', 'patterns', 'type'].sort());

    // v6: undefined -> omitted, exactly 4 keys
    assert.strictEqual(controls[5]!.automation_id, undefined);
    assert.deepStrictEqual(Object.keys(controls[5]!).sort(), ['control_id', 'enabled', 'patterns', 'type'].sort());
  });

  // ---------------------------------------------------------------------------
  // Window title truncation and source (Acceptance 5)
  // ---------------------------------------------------------------------------

  it('window title equals native window text truncated to 256; out-of-scope window has no title; window without native handle has no title', async () => {
    const longTitle = 'W'.repeat(300);
    const inScopeLongWindow: RawWindow = {
      native_handle: '111',
      title: longTitle,
      process_name: inScopeApp,
      z_order: 0,
      foreground: true,
    };
    const outScopeWindow: RawWindow = {
      native_handle: '222',
      title: 'Should Be Hidden',
      process_name: outScopeApp,
      z_order: 1,
      foreground: false,
    };
    const noHandleWindow: RawWindow = {
      native_handle: 'rid:1,2,3',
      // no native handle -> title is undefined
      process_name: inScopeApp,
      z_order: 2,
      foreground: false,
    };

    const probe = makeFakeProbe([inScopeLongWindow, outScopeWindow, noHandleWindow]);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const result = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const body = JSON.parse(result.output) as Record<string, unknown>;
    const windows = body.windows as Array<Record<string, unknown>>;

    // Window 0: in scope, long title -> truncated to 256
    assert.strictEqual(windows[0]!.app_in_scope, true);
    assert.strictEqual(windows[0]!.title, 'W'.repeat(256));
    assert.strictEqual((windows[0]!.title as string).length, 256);

    // Window 1: out of scope -> no title
    assert.strictEqual(windows[1]!.app_in_scope, false);
    assert.strictEqual(windows[1]!.title, undefined);

    // Window 2: in scope but no native handle (title undefined) -> title undefined
    assert.strictEqual(windows[2]!.app_in_scope, true);
    assert.strictEqual(windows[2]!.title, undefined);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Receipts — receipt_extra matches receipt_fields
  // ---------------------------------------------------------------------------

  it('receipt_extra fields match manifest receipt_fields for state', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active');
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const result = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());

    assert.strictEqual(typeof result.receipt_extra.window_count, 'number');
    assert.strictEqual(typeof result.receipt_extra.session_state, 'string');
    assert.strictEqual(typeof result.receipt_extra.truncated, 'boolean');

    // All receipt_extra keys must be in manifest.receipt_fields
    const extraKeys = Object.keys(result.receipt_extra);
    const receiptFields = new Set(adapter.manifest.receipt_fields);
    for (const key of extraKeys) {
      assert.ok(receiptFields.has(key), `receipt_extra key "${key}" not in manifest.receipt_fields`);
    }
  });

  it('receipt_extra fields match manifest receipt_fields for inspect', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const sr = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const sb = JSON.parse(sr.output) as Record<string, unknown>;
    const ft = sb.freshness_token as string;
    const ws = sb.windows as Array<Record<string, unknown>>;
    const wid = ws[0]!.window_id as string;

    const result = await adapter.invoke('inspect', { window_id: wid, freshness_token: ft }, fakeContext());

    assert.strictEqual(typeof result.receipt_extra.status, 'string');
    assert.strictEqual(typeof result.receipt_extra.control_count, 'number');
    assert.strictEqual(typeof result.receipt_extra.truncated, 'boolean');
    assert.strictEqual(typeof result.receipt_extra.depth, 'number');

    const extraKeys = Object.keys(result.receipt_extra);
    const receiptFields = new Set(adapter.manifest.receipt_fields);
    for (const key of extraKeys) {
      assert.ok(receiptFields.has(key), `receipt_extra key "${key}" not in manifest.receipt_fields`);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 10: NO control value ever appears in any inspect output
  // ---------------------------------------------------------------------------

  it('no value field in any inspect output', async () => {
    // Controls with names that could be mistaken for values
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const sr = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const sb = JSON.parse(sr.output) as Record<string, unknown>;
    const ft = sb.freshness_token as string;
    const ws = sb.windows as Array<Record<string, unknown>>;
    const wid = ws[0]!.window_id as string;

    const result = await adapter.invoke('inspect', { window_id: wid, freshness_token: ft }, fakeContext());
    const body = JSON.parse(result.output) as Record<string, unknown>;
    const controls = body.controls as Array<Record<string, unknown>>;

    for (const control of controls) {
      assert.strictEqual(control.value, undefined, `control ${JSON.stringify(control.control_id)} has a value field`);
      assert.strictEqual(control.Value, undefined);
      assert.strictEqual(control.text, undefined);
      assert.strictEqual(control.content, undefined);
    }

    // Also check the raw output string to be sure
    assert.ok(!result.output.includes('"value"'), 'output string contains "value"');
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: inspect depth validation
  // ---------------------------------------------------------------------------

  it('depth defaults to 3 and is clamped to [1, 10]', async () => {
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const sr = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const sb = JSON.parse(sr.output) as Record<string, unknown>;
    const ft = sb.freshness_token as string;
    const ws = sb.windows as Array<Record<string, unknown>>;
    const wid = ws[0]!.window_id as string;

    // Default depth → receipt shows 3
    const r1 = await adapter.invoke('inspect', { window_id: wid, freshness_token: ft }, fakeContext());
    assert.strictEqual(r1.receipt_extra.depth, 3);

    // Explicit depth that's too high → clamped to 10
    const r2 = await adapter.invoke('inspect', { window_id: wid, freshness_token: ft, depth: 100 }, fakeContext());
    assert.strictEqual(r2.receipt_extra.depth, 10);

    // Below minimum → clamped to 1
    const r3 = await adapter.invoke('inspect', { window_id: wid, freshness_token: ft, depth: 0 }, fakeContext());
    assert.strictEqual(r3.receipt_extra.depth, 3); // 0 is not >= 1, so fallback to default 3
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: max_windows truncation
  // ---------------------------------------------------------------------------

  it('max_windows truncates window list and sets truncated flag', async () => {
    const manyWindows: RawWindow[] = Array.from({ length: 10 }, (_, i) => ({
      native_handle: `hwnd-${i}`,
      title: `Window ${i}`,
      process_name: inScopeApp,
      z_order: i,
      foreground: i === 0,
    }));

    const probe = makeFakeProbe(manyWindows, 'active');
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 5,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const result = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const body = JSON.parse(result.output) as Record<string, unknown>;
    assert.strictEqual(body.session_state, 'active');
    const windows = body.windows as Array<Record<string, unknown>>;
    assert.strictEqual(windows.length, 5);
  });

  it('scope match is tolerant of a trailing .exe on either side', async () => {
    // authorized_apps has no extension; the window process is 'NOTEPAD.EXE'.
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: ['notepad'],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });
    const result = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const body = JSON.parse(result.output) as Record<string, unknown>;
    const windows = body.windows as Array<Record<string, unknown>>;
    assert.strictEqual(windows[0]!.app_in_scope, true);
    assert.strictEqual(windows[0]!.title, rawExcelWindow.title);
  });

  it('inspect re-validates the live process: a reused handle now owned by another app → unavailable', async () => {
    // Enumerate an in-scope window, but at inspect time the probe reports a
    // DIFFERENT (out-of-scope) process for that handle — a reused hwnd. The
    // adapter must refuse, never dump the other app's tree.
    const probe = makeFakeProbe([rawExcelWindow], 'active', rawControls, false, false, outScopeApp);
    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [inScopeApp],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });
    const sr = await adapter.invoke('state', { session_scope: 'default' }, fakeContext());
    const sb = JSON.parse(sr.output) as Record<string, unknown>;
    const ft = sb.freshness_token as string;
    const wid = (sb.windows as Array<Record<string, unknown>>)[0]!.window_id as string;

    const r = await adapter.invoke('inspect', { window_id: wid, freshness_token: ft }, fakeContext());
    const b = JSON.parse(r.output) as Record<string, unknown>;
    assert.strictEqual(b.status, 'unavailable');
    assert.strictEqual(b.controls, undefined);
  });
});