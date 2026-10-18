import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDesktopAdapter } from '../src/adapter.js';
import { DESKTOP_UIA_PS1 } from '../src/probe.js';
import {
  fakeContext,
  fixtureProbe,
  startFixture,
  stopFixture,
  NATIVE_DESKTOP_TEST_PREFLIGHT,
  type FixtureInstance,
} from './native-utils.js';

// Round 5: this suite starts a real WinForms window and walks the live
// desktop, so a plain `npm test` must never run it. It runs only when the
// operator opts in with TOROS_REAL_TESTS=1; with that set, a missing
// prerequisite (no interactive desktop, a locked desktop) fails loudly inside
// the test rather than skipping. See the preflight in native-utils.
const nativeDesktopTestOptions = { skip: NATIVE_DESKTOP_TEST_PREFLIGHT.skip };

describe('AR-F2 Native Windows Fixture Verification', () => {
  const activeFixtures: FixtureInstance[] = [];

  afterEach(async () => {
    while (activeFixtures.length > 0) {
      const f = activeFixtures.pop()!;
      await stopFixture(f);
    }
  });

  after(async () => {
    while (activeFixtures.length > 0) {
      const f = activeFixtures.pop()!;
      await stopFixture(f);
    }
  });

  it('acceptance 1 + P1: fixture-bound enumeration; none of the three canaries anywhere in output', nativeDesktopTestOptions, async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    // Acceptance 7 / safety rules (Round 4, item 2): the locked-desktop
    // precondition check runs AFTER the fixture starts, using the fixture-bound
    // probe. The PID filter makes the walk skip every other window before any
    // text is read, so the check never inspects the operator's real applications.
    // A locked or non-interactive desktop fails the test here with a clear
    // message; the afterEach/after cleanup removes the fixture's temp dir.
    const deskState = await probe.enumerateWindows('default', { max_windows: 200 }, new AbortController().signal);
    if (deskState.session_state !== 'active') {
      throw new Error(
        `Desktop is not in active state (state=${deskState.session_state}). AR-F2 requires an interactive, unlocked Windows desktop.`,
      );
    }

    // P1 binding at the raw layer: every enumerated window belongs to the
    // spawned child's PID and the fixture's own reported HWND. Nothing else was
    // enumerated, so no other process's window text was ever read.
    const raw = await probe.enumerateWindows(
      'default',
      { max_windows: 200 },
      new AbortController().signal,
    );
    assert.strictEqual(raw.session_state, 'active');
    if (raw.session_state === 'active') {
      assert.ok(raw.windows.length >= 1, 'the fixture window must be enumerated');
      for (const w of raw.windows) {
        assert.strictEqual(
          w.native_handle,
          String(fixture.hwnd),
          `every returned window must be the fixture's own HWND, got ${w.native_handle}`,
        );
      }
      const norm = (s: string): string => s.toLowerCase().replace(/\.exe$/, '');
      assert.ok(
        raw.windows.some((w) => norm(w.process_name) === norm(fixture.process_name)),
        'the enumerated window must report the fixture process',
      );
    }

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      // The allowlist names the fixture's own UNIQUE process (the renamed
      // PowerShell copy startFixture placed in its temp dir, never a generic
      // `powershell`), and because the probe is PID-bound to the fixture, no
      // other process's window can satisfy it.
      authorized_apps: [fixture.process_name],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const ctx = fakeContext();
    const stateResult = await adapter.invoke('state', { session_scope: 'default' }, ctx);
    const stateBody = JSON.parse(stateResult.output) as {
      freshness_token: string;
      windows: Array<{ window_id: string; title?: string; app_in_scope: boolean }>;
    };

    assert.ok(stateBody.freshness_token, 'freshness_token must be present');
    // Binding at the public layer: only the fixture's window is enumerated.
    assert.strictEqual(stateBody.windows.length, 1, 'only the fixture window may be in state');
    const targetWindow = stateBody.windows.find((w) => w.title === fixture.title);
    assert.ok(targetWindow, `Fixture window with title "${fixture.title}" must be enumerated in state`);
    assert.strictEqual(targetWindow.app_in_scope, true);
    assert.strictEqual(targetWindow.title, fixture.title);

    const inspectResult = await adapter.invoke(
      'inspect',
      { window_id: targetWindow.window_id, freshness_token: stateBody.freshness_token },
      ctx,
    );

    const inspectBody = JSON.parse(inspectResult.output) as {
      status: string;
      controls: Array<Record<string, unknown>>;
    };

    assert.strictEqual(inspectBody.status, 'ok');
    assert.ok(inspectBody.controls.length > 0, 'Must inspect at least one control');

    // 1. None of the three canaries appear anywhere in output
    for (const canary of [fixture.canaryPwd, fixture.canaryTxt, fixture.canaryLbl]) {
      assert.ok(!inspectResult.output.includes(canary), `canary "${canary}" must NOT appear in inspect output`);
      assert.ok(!stateResult.output.includes(canary), `canary "${canary}" must NOT appear in state output`);
    }

    // 2. None of the three canaries appear anywhere in receipt_extra
    const receiptStr = JSON.stringify(inspectResult.receipt_extra);
    for (const canary of [fixture.canaryPwd, fixture.canaryTxt, fixture.canaryLbl]) {
      assert.ok(!receiptStr.includes(canary), `canary "${canary}" must not appear in receipt_extra`);
    }

    // 3. No control has a "name" property
    for (const ctrl of inspectBody.controls) {
      assert.strictEqual(ctrl['name'], undefined, 'No control may possess a "name" property');
      assert.strictEqual(ctrl['value'], undefined, 'No control may possess a "value" property');
    }
  });

  it('acceptance 4: control_filter matches by type and automation_id; canary matches nothing', nativeDesktopTestOptions, async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [fixture.process_name],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const ctx = fakeContext();
    const stateResult = await adapter.invoke('state', { session_scope: 'default' }, ctx);
    const stateBody = JSON.parse(stateResult.output) as {
      freshness_token: string;
      windows: Array<{ window_id: string; title?: string }>;
    };

    const target = stateBody.windows.find((w) => w.title === fixture.title);
    assert.ok(target, `Fixture window with title "${fixture.title}" must be enumerated in state`);
    const targetWindow = target!;

    // Filter by canary: must match nothing
    const canaryFilterResult = await adapter.invoke(
      'inspect',
      {
        window_id: targetWindow.window_id,
        freshness_token: stateBody.freshness_token,
        control_filter: fixture.canaryPwd,
      },
      ctx,
    );
    const canaryFilterBody = JSON.parse(canaryFilterResult.output) as { controls: Array<unknown> };
    assert.strictEqual(canaryFilterBody.controls.length, 0, 'Canary as control_filter must match nothing');

    // Filter by type: e.g. "Pane" or "Edit"
    const typeFilterResult = await adapter.invoke(
      'inspect',
      {
        window_id: targetWindow.window_id,
        freshness_token: stateBody.freshness_token,
        control_filter: 'Pane',
      },
      ctx,
    );
    const typeFilterBody = JSON.parse(typeFilterResult.output) as { controls: Array<Record<string, unknown>> };
    assert.ok(typeFilterBody.controls.length > 0, 'Filter by type "Pane" should match at least one control');
    assert.ok(typeFilterBody.controls.every((c) => String(c['type']).toLowerCase().includes('pane')));
  });

  it('acceptance 5 + finding 3: native long title truncated to 256; out-of-scope fixture window has no title', nativeDesktopTestOptions, async () => {
    // The fixture sets an ACTUAL native window text longer than 256 characters;
    // GetWindowText on the real handle is capped at 256 by the script.
    const longTitle = 'W'.repeat(300);
    const fixture = await startFixture({ title: longTitle });
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    // Native evidence at the raw layer: only the fixture appears, and its real
    // window text is exactly the first 256 characters.
    const raw = await probe.enumerateWindows(
      'default',
      { max_windows: 200 },
      new AbortController().signal,
    );
    assert.strictEqual(raw.session_state, 'active');
    if (raw.session_state === 'active') {
      const rawWin = raw.windows.find((w) => w.native_handle === String(fixture.hwnd));
      assert.ok(rawWin, 'fixture window must appear in the PID-bound enumeration');
      assert.strictEqual(rawWin?.title, longTitle.slice(0, 256), 'the script must cap native window text at 256');
    }

    // In-scope adapter: authorized_apps is exactly the fixture's process.
    const adapterInScope = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [fixture.process_name],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateInScope = JSON.parse(
      (await adapterInScope.invoke('state', { session_scope: 'default' }, fakeContext())).output,
    ) as {
      windows: Array<{ window_id: string; title?: string; app_in_scope: boolean }>;
    };
    const winInScope = stateInScope.windows.find((w) => w.title === longTitle.slice(0, 256));
    assert.ok(winInScope, 'in-scope window must carry its native title truncated to 256');
    assert.strictEqual(winInScope?.title, longTitle.slice(0, 256));
    assert.strictEqual(winInScope?.app_in_scope, true);

    // Out-of-scope adapter: authorized_apps EXCLUDES the fixture's process.
    const adapterOutOfScope = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: ['definitely-not-the-fixture-app'],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateOutOfScope = JSON.parse(
      (await adapterOutOfScope.invoke('state', { session_scope: 'default' }, fakeContext())).output,
    ) as {
      windows: Array<{ window_id: string; title?: string; app_in_scope: boolean }>;
    };
    // Finding 3: the out-of-scope assertion targets the FIXTURE's own window.
    // The PID-bound probe enumerates only the fixture, so the single returned
    // window IS the fixture — it must be marked out-of-scope with no title.
    assert.strictEqual(stateOutOfScope.windows.length, 1, 'only the fixture window may be in state');
    const winOutOfScope = stateOutOfScope.windows[0]!;
    assert.strictEqual(winOutOfScope.app_in_scope, false);
    assert.strictEqual(winOutOfScope.title, undefined, 'out-of-scope window must omit title');
  });

  it('acceptance 6: script stops at the caps and reports truncated, with only the fixture bound', nativeDesktopTestOptions, async () => {
    // The fixture owns ONE main form plus two extra top-level forms from the
    // SAME process, and 20 extra child controls: both caps are exceeded while
    // every window still belongs to the single PID the probe is bound to.
    const fixture = await startFixture({ extraControls: 20, extraWindows: 2 });
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);
    const signal = new AbortController().signal;

    const probeResult = await probe.inspectWindow(
      String(fixture.hwnd),
      { depth: 3, max_controls: 5 },
      signal,
    );

    assert.strictEqual(probeResult.closed, false);
    if (!probeResult.closed) {
      assert.strictEqual(probeResult.controls.length, 5, 'Script must emit exactly max_controls items');
      assert.strictEqual(probeResult.truncated, true, 'Script must report truncated=true when stopping early');
    }

    const probeState = await probe.enumerateWindows('default', { max_windows: 1 }, signal);
    assert.strictEqual(probeState.session_state, 'active');
    if (probeState.session_state === 'active') {
      assert.strictEqual(probeState.windows.length, 1, 'Script must enumerate up to max_windows');
      assert.strictEqual(probeState.truncated, true, 'Script must report truncated=true when more fixture windows exist');
    }
  });

  it('static: the script binds restrict_to_pid before any native text is read (P1 regression guard)', nativeDesktopTestOptions, () => {
    // The PID guard must sit inside the enumerate walk BEFORE GetWindowText, so
    // skipped windows are never read. `enumerate_windows` appears before any
    // window text read in that walk and after the TorosNative class definition.
    const enumerateBlock = DESKTOP_UIA_PS1.slice(DESKTOP_UIA_PS1.indexOf('enumerate_windows'));
    const pidGuard = enumerateBlock.indexOf('restrictPid');
    const titleRead = enumerateBlock.indexOf('GetWindowText');
    assert.ok(DESKTOP_UIA_PS1.includes('restrict_to_pid'), 'script must read restrict_to_pid from input.json');
    assert.ok(pidGuard >= 0, 'script must contain the restrictPid guard');
    assert.ok(titleRead >= 0, 'script must contain a GetWindowText read');
    assert.ok(pidGuard < titleRead, 'the PID guard must run before GetWindowText');

    const inspectBlock = DESKTOP_UIA_PS1.slice(DESKTOP_UIA_PS1.indexOf('inspect_window'));
    assert.ok(inspectBlock.indexOf('restrictPid') >= 0,
      'the PID guard must also run in the inspect window walk');
    assert.strictEqual(inspectBlock.indexOf('GetWindowText'), -1,
      'inspecting a window must never read native window text');
  });
});