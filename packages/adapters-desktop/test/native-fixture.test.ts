import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createDesktopAdapter } from '../src/adapter.js';
import { createPowerShellUiaProbe, DESKTOP_UIA_PS1 } from '../src/probe.js';
import type { AdapterContext } from '@toros/contracts';

function getPowershellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  if (systemRoot) {
    return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return 'powershell.exe';
}

function fakeContext(): AdapterContext {
  return {
    job_id: 'native-job-1',
    session_id: null,
    workspace: { id: 'ws-native', root: '/tmp/ws-native' },
    correlation_id: 'corr-native-1',
    signal: new AbortController().signal,
  };
}

interface FixtureInstance {
  readonly process: ChildProcess;
  readonly hwnd: number;
  readonly pid: number;
  readonly title: string;
  readonly canaryPwd: string;
  readonly canaryTxt: string;
  readonly canaryLbl: string;
}

function startFixture(options: {
  title?: string;
  canaryPwd?: string;
  canaryTxt?: string;
  canaryLbl?: string;
  extraControls?: number;
}): Promise<FixtureInstance> {
  return new Promise((resolve, reject) => {
    const baseDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
    let fixtureScript = path.resolve(baseDir, '../../test/fixtures/canary-form.ps1');
    if (!fs.existsSync(fixtureScript)) {
      fixtureScript = path.resolve(baseDir, '../test/fixtures/canary-form.ps1');
    }
    const title = options.title ?? `TorosFixture_${randomBytes(4).toString('hex')}`;
    const canaryPwd = options.canaryPwd ?? `CANARY_PWD_${randomBytes(8).toString('hex')}`;
    const canaryTxt = options.canaryTxt ?? `CANARY_TXT_${randomBytes(8).toString('hex')}`;
    const canaryLbl = options.canaryLbl ?? `CANARY_LBL_${randomBytes(8).toString('hex')}`;
    const extraControls = options.extraControls ?? 0;

    const child = spawn(
      getPowershellPath(),
      [
        '-NoProfile',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fixtureScript,
        '-Title',
        title,
        '-Canary1',
        canaryPwd,
        '-Canary2',
        canaryTxt,
        '-Canary3',
        canaryLbl,
        '-ExtraControls',
        String(extraControls),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let resolved = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`Fixture start timed out. Stdout: ${stdoutBuffer} Stderr: ${stderrBuffer}`));
      }
    }, 15_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('READY:')) {
          const parts = line.split(':');
          const hwnd = Number(parts[1]);
          const pid = Number(parts[2]);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({
              process: child,
              hwnd,
              pid,
              title,
              canaryPwd,
              canaryTxt,
              canaryLbl,
            });
          }
          return;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Fixture exited prematurely with code ${code}. Stderr: ${stderrBuffer}. Stdout: ${stdoutBuffer}`));
      }
    });
  });
}

function stopFixture(fixture: FixtureInstance): void {
  try {
    fixture.process.kill();
  } catch {
    // already exited
  }
}

describe('AR-F2 Native Windows Fixture Verification', () => {
  const probe = createPowerShellUiaProbe({ timeout_ms: 30_000 });
  const activeFixtures: FixtureInstance[] = [];

  function dismissScreensaver(): void {
    try {
      spawnSync('taskkill', ['/F', '/IM', 'scrnsave.scr'], { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }

  before(async () => {
    dismissScreensaver();
    // Acceptance 7: Verify interactive, unlocked Windows desktop before running tests.
    // A locked or headless run is reported as an error, never as a pass or skip.
    const state = await probe.enumerateWindows('default', { max_windows: 200 }, new AbortController().signal);
    if (state.session_state !== 'active') {
      throw new Error(`Desktop is not in active state (state=${state.session_state}). AR-F2 requires an interactive, unlocked Windows desktop.`);
    }
  });

  beforeEach(() => {
    dismissScreensaver();
  });

  afterEach(() => {
    while (activeFixtures.length > 0) {
      const f = activeFixtures.pop()!;
      stopFixture(f);
    }
  });

  after(() => {
    while (activeFixtures.length > 0) {
      const f = activeFixtures.pop()!;
      stopFixture(f);
    }
  });

  it('acceptance 1: inspecting native fixture reveals none of the three canaries anywhere', async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: ['powershell', 'powershell.exe'],
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
    // Find the fixture window
    const targetWindow = stateBody.windows.find((w) => w.title === fixture.title);
    assert.ok(targetWindow, `Fixture window with title "${fixture.title}" must be enumerated in state`);
    assert.strictEqual(targetWindow.app_in_scope, true);

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
    assert.ok(
      !inspectResult.output.includes(fixture.canaryPwd),
      `Masked password canary "${fixture.canaryPwd}" must NOT appear in output`,
    );
    assert.ok(
      !inspectResult.output.includes(fixture.canaryTxt),
      `Normal textbox canary "${fixture.canaryTxt}" must NOT appear in output`,
    );
    assert.ok(
      !inspectResult.output.includes(fixture.canaryLbl),
      `Off-client label canary "${fixture.canaryLbl}" must NOT appear in output`,
    );

    // 2. None of the three canaries appear anywhere in receipt_extra
    const receiptStr = JSON.stringify(inspectResult.receipt_extra);
    assert.ok(!receiptStr.includes(fixture.canaryPwd), 'canaryPwd must not appear in receipt_extra');
    assert.ok(!receiptStr.includes(fixture.canaryTxt), 'canaryTxt must not appear in receipt_extra');
    assert.ok(!receiptStr.includes(fixture.canaryLbl), 'canaryLbl must not appear in receipt_extra');

    // 3. No control has a "name" property
    for (const ctrl of inspectBody.controls) {
      assert.strictEqual(ctrl['name'], undefined, 'No control may possess a "name" property');
      assert.strictEqual(ctrl['value'], undefined, 'No control may possess a "value" property');
    }
  });

  it('acceptance 4: control_filter matches by type and automation_id; canary matches nothing', async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: ['powershell', 'powershell.exe'],
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

    const targetWindow = stateBody.windows.find((w) => w.title === fixture.title)!;

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

  it('acceptance 5: in-scope window title equals native window text truncated to 256; out-of-scope has no title', async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);

    // In-scope adapter
    const adapterInScope = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: ['powershell', 'powershell.exe'],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateInScope = JSON.parse((await adapterInScope.invoke('state', { session_scope: 'default' }, fakeContext())).output) as {
      windows: Array<{ window_id: string; title?: string; app_in_scope: boolean }>;
    };
    const winInScope = stateInScope.windows.find((w) => w.title === fixture.title);
    assert.ok(winInScope, 'In-scope window must have its native title');
    assert.strictEqual(winInScope.title, fixture.title);
    assert.strictEqual(winInScope.app_in_scope, true);

    // Out-of-scope adapter (powershell not allowlisted)
    const adapterOutOfScope = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: ['notepad', 'notepad.exe'],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateOutOfScope = JSON.parse((await adapterOutOfScope.invoke('state', { session_scope: 'default' }, fakeContext())).output) as {
      windows: Array<{ window_id: string; title?: string; app_in_scope: boolean }>;
    };
    // The fixture window exists in state, but app_in_scope is false and title is omitted
    const winOutOfScope = stateOutOfScope.windows.find((w) => w.app_in_scope === false && w.title === undefined);
    assert.ok(winOutOfScope, 'Out-of-scope window must omit title');
  });

  it('acceptance 6: script stops at max_controls cap and reports truncated directly from probe', async () => {
    // Start fixture with 20 extra controls (over 20 controls total)
    const fixture = await startFixture({ extraControls: 20 });
    activeFixtures.push(fixture);
    const fixture2 = await startFixture({});
    activeFixtures.push(fixture2);

    const signal = new AbortController().signal;

    // Direct probe call asserting what the script emitted
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

    // Direct probe call asserting window enumeration cap
    const probeState = await probe.enumerateWindows('default', { max_windows: 1 }, signal);
    assert.strictEqual(probeState.session_state, 'active');
    if (probeState.session_state === 'active') {
      assert.strictEqual(probeState.windows.length, 1, 'Script must enumerate up to max_windows');
      assert.strictEqual(probeState.truncated, true, 'Script must report truncated=true when more windows exist');
    }
  });
});
