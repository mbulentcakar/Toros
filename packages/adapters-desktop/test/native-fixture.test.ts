import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Adapter, AdapterContext } from '@toros/contracts';

import { createDesktopAdapter } from '../src/adapter.js';
import { DESKTOP_UIA_PS1, createPowerShellUiaProbe, powershellChildEnvironment } from '../src/probe.js';
import {
  fakeContext,
  fixtureProbe,
  getPowershellPath,
  startFixture,
  stopFixture,
  NATIVE_DESKTOP_TEST_PREFLIGHT,
  type FixtureInstance,
} from './native-utils.js';

// Round 5: this suite starts a real WinForms window and walks the live desktop,
// so a plain `npm test` must never run it. It runs only when the operator opts
// in with TOROS_REAL_TESTS=1; with that set, a missing prerequisite (no
// interactive desktop, a locked desktop) fails loudly inside the test rather
// than skipping. See the preflight in native-utils.
const nativeDesktopTestOptions = { skip: NATIVE_DESKTOP_TEST_PREFLIGHT.skip };

// The two-phase resolve (amendment A8): Core decides each resolved key and the
// adapter acts only on the keys it allowed. The native tests drive the resolver
// and the invoke themselves, simulating Core's decision by marking every
// resolved key `allowed`.
type AllowedDecisions = ReadonlyMap<string, 'allowed'>;
function allowedDecisions(keys: readonly string[]): AllowedDecisions {
  return new Map(keys.map((k) => [k, 'allowed'] as const));
}

/** Full two-phase `state` request: resolve, then invoke with every key allowed. */
async function enumerateState(
  adapter: Adapter,
  ctx: AdapterContext,
): Promise<{ freshness_token: string; windows: Array<{ window_id: string; title?: string }> }> {
  const targets = await adapter.resolver!.resolve('state', {}, ctx);
  const keys = targets.map((t) => (t as { key: string }).key);
  const result = await adapter.invoke('state', {}, { ...ctx, target_decisions: allowedDecisions(keys) });
  return JSON.parse(result.output) as { freshness_token: string; windows: Array<{ window_id: string; title?: string }> };
}

/** Full two-phase `inspect` request on a fresh handle: resolve, then invoke. */
async function inspectWindow(
  adapter: Adapter,
  ctx: AdapterContext,
  windowId: string,
  token: string,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const args = { window_id: windowId, freshness_token: token, ...extra };
  const targets = await adapter.resolver!.resolve('inspect', args, ctx);
  const keys = targets.map((t) => (t as { key: string }).key);
  const result = await adapter.invoke('inspect', args, { ...ctx, target_decisions: allowedDecisions(keys) });
  return JSON.parse(result.output) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// R5 FR-01 (native): prove the language-neutral OriginalFilename. The fixture is
// a renamed copy of Windows PowerShell in a fresh temp dir (no en-US subfolder),
// so its neutral OriginalFilename is the vendor's value. The inbox powershell.exe
// sits beside an en-US MUI, which is exactly the case FileVersionInfo used to get
// wrong (PowerShell.EXE.MUI). Both must report the SAME neutral value through the
// same helper, reusing the TorosNative type from the emitted script.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Extract the `TorosNative` C# class from the emitted script (the sole
 * `Add-Type @"` here-string), so a test-owned PowerShell re-runs the EXACT type
 * the probe compiles rather than a hand-copied approximation.
 */
function torosNativeAddTypeSource(): string {
  const start = DESKTOP_UIA_PS1.indexOf('Add-Type @"');
  if (start < 0) throw new Error('the emitted script must contain an Add-Type here-string');
  const contentStart = DESKTOP_UIA_PS1.indexOf('\n', start) + 1;
  const end = DESKTOP_UIA_PS1.indexOf('\n"@', contentStart);
  if (end < 0) throw new Error('the emitted script must terminate its Add-Type here-string');
  return DESKTOP_UIA_PS1.slice(contentStart, end);
}

/**
 * Run the emitted script's `TorosNative` type in a test-owned Windows PowerShell
 * and ask it for the neutral OriginalFilename of one executable. Returns null
 * when the helper yields nothing; throws on a spawn or compile failure so a
 * broken helper cannot be read as "no value".
 */
async function neutralOriginalFilenameViaType(exePath: string): Promise<string | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toros-neutral-ofn-'));
  const scriptPath = path.join(tempDir, 'neutral.ps1');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type @"',
    torosNativeAddTypeSource(),
    '"@',
    `Write-Output ([TorosNative]::NeutralOriginalFilename('${exePath}'))`,
  ].join('\n');
  try {
    fs.writeFileSync(scriptPath, script, 'utf8');
    const { stdout } = await execFileAsync(
      getPowershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, env: powershellChildEnvironment(), timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    const value = stdout.trim();
    return value.length === 0 ? null : value;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('AR-F3b Native Windows Identity Verification', () => {
  const activeFixtures: FixtureInstance[] = [];

  afterEach(async () => {
    while (activeFixtures.length > 0) {
      await stopFixture(activeFixtures.pop()!);
    }
  });

  after(async () => {
    while (activeFixtures.length > 0) {
      await stopFixture(activeFixtures.pop()!);
    }
  });

  // -------------------------------------------------------------------------
  // F3b identity tests (round 1): the A8 identity the probe emits.
  // -------------------------------------------------------------------------

  it('the canary fixture identity comes back with a real SHA-256, image path and session id', nativeDesktopTestOptions, async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    const raw = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
    if (raw.session_state !== 'active') {
      throw new Error(
        `Desktop is not in active state (state=${raw.session_state}). AR-F3b requires an interactive, unlocked Windows desktop.`,
      );
    }
    assert.ok(raw.windows.length >= 1, 'the fixture window must be enumerated');
    const fixtureWindow = raw.windows.find((w) => w.native_handle === String(fixture.hwnd));
    assert.ok(fixtureWindow, 'the fixture window must be in the identity enumeration');

    const id = fixtureWindow!.identity;
    assert.match(id.image_sha256, /^[0-9a-f]{64}$/, 'image_sha256 must be 64 lower-case hex');
    assert.ok(Number.isSafeInteger(id.session_id) && id.session_id >= 0, 'session_id must be a non-negative integer');
    assert.ok(id.image_path.toLowerCase().endsWith('.exe'), 'image_path must be the canonical image path');
    assert.ok(!id.image_path.startsWith('\\\\?\\'), 'image_path must not carry a namespace prefix');
    assert.ok(Number.isSafeInteger(id.pid) && id.pid > 0, 'pid must be a positive integer');
    assert.match(id.created_at, /Z$/, 'created_at must be an ISO-8601 UTC string ending in Z');
// A9: the fixture is a renamed copy of the PowerShell executable, so its
    // version resource still carries the vendor's OriginalFilename.
    assert.ok(typeof id.original_filename === 'string' && id.original_filename.length > 0, 'original_filename must be present on the fixture identity');
  });

  it('the fixture identity reports the language-neutral OriginalFilename, equal to the inbox powershell.exe (R5 FR-01)', nativeDesktopTestOptions, async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    const raw = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
    if (raw.session_state !== 'active') {
      throw new Error(`Desktop is not in active state (state=${raw.session_state}). R5 FR-01 requires an interactive, unlocked Windows desktop.`);
    }
    const fixtureWindow = raw.windows.find((w) => w.native_handle === String(fixture.hwnd));
    assert.ok(fixtureWindow, 'the fixture window must be enumerated');
    const original = fixtureWindow!.identity.original_filename;
    if (typeof original !== 'string' || original.length === 0) {
      throw new Error(`fixture identity must carry a non-empty original_filename, got ${String(original)}`);
    }
    // The fixture is a renamed copy of Windows PowerShell placed in a fresh temp
    // dir with no en-US subfolder, so its language-neutral OriginalFilename is the
    // vendor's value — NOT the MUI-tainted form (PowerShell.EXE.MUI) that
    // FileVersionInfo.OriginalFilename used to report for the inbox binary.
    assert.equal(original.toLowerCase(), 'powershell.exe', 'the fixture must report the language-neutral OriginalFilename PowerShell.EXE');

    // Second assertion: the inbox powershell.exe (which sits beside an en-US MUI)
    // must report the SAME neutral value through the same helper, so a signer rule
    // names one value whether the operator reads the inbox binary or a copy.
    const inbox = await neutralOriginalFilenameViaType(getPowershellPath());
    if (typeof inbox !== 'string' || inbox.length === 0) {
      throw new Error('the inbox powershell.exe must yield a language-neutral OriginalFilename');
    }
    assert.equal(inbox.toLowerCase(), original.toLowerCase(), 'the inbox powershell.exe and its copy must report the same language-neutral OriginalFilename');
    assert.equal(inbox.toLowerCase(), 'powershell.exe', 'the inbox powershell.exe must report PowerShell.EXE, never PowerShell.EXE.MUI');
  });

  it('a polluted PSModulePath does not change the reported signature status (amendment A9)', nativeDesktopTestOptions, async () => {
    // The probe spawns Windows PowerShell with PSModulePath removed, so a node
    // started under a polluted PSModulePath (pointed at a nonexistent folder)
    // must still report the real signature status of the signed fixture binary.
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    // Pollute AFTER the fixture starts: startFixture strips PSModulePath from
    // its own child, so pollution set before the fixture would not prove the
    // PROBE's spawn does the same. The probe (below) is what must re-read the
    // signature correctly under the polluted parent environment.
    const original = process.env['PSModulePath'];
    process.env['PSModulePath'] = 'C:\\__toros_nonexistent_module_path__';
    try {
      const probe = fixtureProbe(fixture);
      const raw = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
      if (raw.session_state !== 'active') {
        throw new Error(`Desktop is not in active state (state=${raw.session_state}).`);
      }
      const fixtureWindow = raw.windows.find((w) => w.native_handle === String(fixture.hwnd));
      assert.ok(fixtureWindow, 'the fixture window must be enumerated');
      // The fixture is a renamed copy of the signed powershell.exe, so its real
      // signature status is 'valid' regardless of the polluted PSModulePath.
      assert.equal(fixtureWindow!.identity.signature, 'valid', 'a polluted PSModulePath must not change the reported signature status');
    } finally {
      if (original === undefined) delete process.env['PSModulePath'];
      else process.env['PSModulePath'] = original;
    }
  });

  it('a renamed copy allowlisted by its own image path is in scope; a wrong hash denies it', nativeDesktopTestOptions, async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);
    const ctx = fakeContext();

    // Allowlist the fixture by its own image path → in scope.
    const inScope = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [{ image_path: fixture.image_path }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });
    const inScopeTargets = await inScope.resolver!.resolve('state', {}, ctx);
    assert.equal(inScopeTargets.length, 1, 'the path-allowlisted fixture must resolve one target');

    // Allowlist by a WRONG hash → out of global bound, resolved as no target.
    const wrongHash = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [{ image_sha256: '0'.repeat(64) }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });
    const wrongTargets = await wrongHash.resolver!.resolve('state', {}, ctx);
    assert.equal(wrongTargets.length, 0, 'a wrong hash must not resolve the fixture as a target');
  });

  it('spoofing the basename does not pass the identity bound', nativeDesktopTestOptions, async () => {
    // The renamed fixture copy may share a basename family with Windows
    // PowerShell, but a basename-tolerance rule is gone. A path rule naming the
    // REAL powershell.exe image must NOT authorise the renamed copy.
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);
    const ctx = fakeContext();

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [{ image_path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });
    const targets = await adapter.resolver!.resolve('state', {}, ctx);
    // The fixture is a renamed copy in a temp dir, not the vendored powershell
    // image that the rule names, so it must not resolve despite the basename
    // family resemblance.
    assert.equal(targets.length, 0, 'a path rule naming the real powershell must not authorise the renamed copy');
  });

  // -------------------------------------------------------------------------
  // Restored F2 native tests (round 2): AR-01's native proof, adapted to the
  // F3b API (image_path/hash allowlist, session_scope 'interactive', resolver
  // flow). None of the F2 security assertions are weakened.
  // -------------------------------------------------------------------------

  it('acceptance 1 + P1: fixture-bound enumeration; none of the three canaries anywhere in output', nativeDesktopTestOptions, async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    // The locked-desktop precondition check runs AFTER the fixture starts, using
    // the fixture-bound probe. The PID filter makes the walk skip every other
    // window before any text is read, so the check never inspects the operator's
    // real applications.
    const deskState = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
    if (deskState.session_state !== 'active') {
      throw new Error(
        `Desktop is not in active state (state=${deskState.session_state}). AR-F2 requires an interactive, unlocked Windows desktop.`,
      );
    }

    // P1 binding at the raw layer: every enumerated window belongs to the
    // spawned child's PID and the fixture's own reported HWND. Nothing else was
    // enumerated, so no other process's window text was ever read.
    const raw = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
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
      assert.ok(
        raw.windows.some(
          (w) => w.identity.image_path.toLowerCase() === fixture.image_path.toLowerCase(),
        ),
        'the enumerated window must report the fixture image path',
      );
    }

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      // The allowlist names the fixture's own UNIQUE image (the renamed
      // PowerShell copy startFixture placed in its temp dir, never a generic
      // `powershell`), and because the probe is PID-bound to the fixture, no
      // other process's window can satisfy it.
      authorized_apps: [{ image_path: fixture.image_path }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const ctx = fakeContext();

    // Two-phase state: resolve, then invoke with every resolved key allowed.
    const stateTargets = await adapter.resolver!.resolve('state', {}, ctx);
    const stateKeys = stateTargets.map((t) => (t as { key: string }).key);
    const stateResult = await adapter.invoke('state', {}, { ...ctx, target_decisions: allowedDecisions(stateKeys) });
    const stateBody = JSON.parse(stateResult.output) as {
      freshness_token: string;
      windows: Array<{ window_id: string; title?: string }>;
    };

    assert.ok(stateBody.freshness_token, 'freshness_token must be present');
    // Binding at the public layer: only the fixture's window is enumerated.
    assert.strictEqual(stateBody.windows.length, 1, 'only the fixture window may be in state');
    const targetWindow = stateBody.windows.find((w) => w.title === fixture.title);
    assert.ok(targetWindow, `Fixture window with title "${fixture.title}" must be enumerated in state`);
    assert.strictEqual(targetWindow.title, fixture.title);

    // Two-phase inspect on the fresh handle.
    const inspectTargets = await adapter.resolver!.resolve(
      'inspect',
      { window_id: targetWindow.window_id, freshness_token: stateBody.freshness_token },
      ctx,
    );
    const inspectKeys = inspectTargets.map((t) => (t as { key: string }).key);
    const inspectResult = await adapter.invoke(
      'inspect',
      { window_id: targetWindow.window_id, freshness_token: stateBody.freshness_token },
      { ...ctx, target_decisions: allowedDecisions(inspectKeys) },
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

    // 3. No control has a "name" or "value" property
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
      authorized_apps: [{ image_path: fixture.image_path }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const ctx = fakeContext();

    // Each inspect is single-use, so each filter gets a fresh handle from a
    // fresh enumeration.
    const state1 = await enumerateState(adapter, ctx);
    const target1 = state1.windows.find((w) => w.title === fixture.title);
    assert.ok(target1, `Fixture window with title "${fixture.title}" must be enumerated in state`);

    // Filter by canary: must match nothing
    const canaryFilterBody = await inspectWindow(
      adapter,
      ctx,
      target1!.window_id,
      state1.freshness_token,
      { control_filter: fixture.canaryPwd },
    );
    assert.strictEqual(
      (canaryFilterBody.controls as unknown[]).length,
      0,
      'Canary as control_filter must match nothing',
    );

    // Filter by type: a fresh handle, then "Pane"
    const state2 = await enumerateState(adapter, ctx);
    const target2 = state2.windows.find((w) => w.title === fixture.title);
    assert.ok(target2, 'the fixture window must be enumerated again on a fresh handle');

    const typeFilterBody = await inspectWindow(
      adapter,
      ctx,
      target2!.window_id,
      state2.freshness_token,
      { control_filter: 'Pane' },
    );
    const typeControls = typeFilterBody.controls as Array<Record<string, unknown>>;
    assert.ok(typeControls.length > 0, 'Filter by type "Pane" should match at least one control');
    assert.ok(typeControls.every((c) => String(c['type']).toLowerCase().includes('pane')));
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
    const raw = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
    assert.strictEqual(raw.session_state, 'active');
    if (raw.session_state === 'active') {
      const rawWin = raw.windows.find((w) => w.native_handle === String(fixture.hwnd));
      assert.ok(rawWin, 'fixture window must appear in the PID-bound enumeration');
      assert.strictEqual(rawWin?.title, longTitle.slice(0, 256), 'the script must cap native window text at 256');
    }

    // In-scope adapter: authorized_apps is exactly the fixture's image path.
    const adapterInScope = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [{ image_path: fixture.image_path }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateInScope = await enumerateState(adapterInScope, fakeContext());
    const winInScope = stateInScope.windows.find((w) => w.title === longTitle.slice(0, 256));
    assert.ok(winInScope, 'in-scope window must carry its native title truncated to 256');
    assert.strictEqual(winInScope?.title, longTitle.slice(0, 256));

    // Out-of-scope adapter: authorized_apps EXCLUDES the fixture (a wrong hash).
    const adapterOutOfScope = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [{ image_sha256: 'f'.repeat(64) }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const stateOutOfScope = await enumerateState(adapterOutOfScope, fakeContext());
    // Finding 3: the PID-bound probe enumerates only the fixture, but the
    // fixture does not match the out-of-scope global bound, so it never becomes
    // a target and therefore never appears in output — its title is not leaked.
    assert.strictEqual(
      stateOutOfScope.windows.length,
      0,
      'an out-of-scope window must not appear in state (its title must not leak)',
    );
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

    const probeState = await probe.enumerateWindows({ max_windows: 1 }, signal);
    assert.strictEqual(probeState.session_state, 'active');
    if (probeState.session_state === 'active') {
      assert.strictEqual(probeState.windows.length, 1, 'Script must enumerate up to max_windows');
      assert.strictEqual(probeState.truncated, true, 'Script must report truncated=true when more fixture windows exist');
    }
  });

  it('static: the script binds restrict_to_pid before any native text is read (P1 regression guard)', nativeDesktopTestOptions, () => {
    // The PID guard must sit inside the enumerate walk BEFORE the native window
    // text read, so skipped windows are never read. `enumerate_windows` appears
    // before any window text read in that walk and after the TorosNative class.
    // F3b reads the title via `[TorosNative]::WindowText` (the wrapper that calls
    // GetWindowText), so the ordering is checked against that token.
    const enumerateBlock = DESKTOP_UIA_PS1.slice(DESKTOP_UIA_PS1.indexOf('enumerate_windows'));
    const pidGuard = enumerateBlock.indexOf('restrictPid');
    const titleRead = enumerateBlock.indexOf('WindowText');
    assert.ok(DESKTOP_UIA_PS1.includes('restrict_to_pid'), 'script must read restrict_to_pid from input.json');
    assert.ok(pidGuard >= 0, 'script must contain the restrictPid guard');
    assert.ok(titleRead >= 0, 'script must contain a WindowText read');
    assert.ok(pidGuard < titleRead, 'the PID guard must run before WindowText');

    const inspectBlock = DESKTOP_UIA_PS1.slice(DESKTOP_UIA_PS1.indexOf('inspect_window'));
    assert.ok(inspectBlock.indexOf('restrictPid') >= 0,
      'the PID guard must also run in the inspect window walk');
    assert.strictEqual(inspectBlock.indexOf('GetWindowText'), -1,
      'inspecting a window must never read native window text');
    assert.strictEqual(inspectBlock.indexOf('WindowText'), -1,
      'inspecting a window must never read native window text (WindowText wrapper)');
  });

  it('RR-06: control_filter matches by the automation_id the fixture actually exposes', nativeDesktopTestOptions, async () => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [{ image_path: fixture.image_path }],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });
    const ctx = fakeContext();

    // First inspect without a filter, to learn the automation_id the fixture's
    // controls actually expose (on WinForms this is the control's HWND string).
    const state1 = await enumerateState(adapter, ctx);
    const target1 = state1.windows.find((w) => w.title === fixture.title);
    assert.ok(target1, 'the fixture window must be enumerated');
    const unfiltered = await inspectWindow(adapter, ctx, target1!.window_id, state1.freshness_token);
    const withId = (unfiltered.controls as Array<Record<string, unknown>>).filter(
      (c) => typeof c['automation_id'] === 'string' && (c['automation_id'] as string).length > 0,
    );
    assert.ok(withId.length > 0, 'at least one control must expose an automation_id');
    const automationId = withId[0]!['automation_id'] as string;

    // Filter by that exact id on a fresh handle.
    const state2 = await enumerateState(adapter, ctx);
    const target2 = state2.windows.find((w) => w.title === fixture.title);
    assert.ok(target2, 'the fixture window must be enumerated again on a fresh handle');
    const filtered = await inspectWindow(adapter, ctx, target2!.window_id, state2.freshness_token, { control_filter: automationId });
    const filteredControls = filtered.controls as Array<Record<string, unknown>>;
    assert.ok(filteredControls.length > 0, 'filtering by the exposed automation_id must match at least one control');
    for (const c of filteredControls) {
      assert.equal(String(c['automation_id']).toLowerCase(), automationId.toLowerCase(),
        'every control matched by automation_id must carry that id');
    }
  });

  it('RR-07: an out-of-bound fixture title is absent and takes no max_windows slot', nativeDesktopTestOptions, async () => {
    const fixtureA = await startFixture({});
    activeFixtures.push(fixtureA);
    const fixtureB = await startFixture({});
    activeFixtures.push(fixtureB);

    // Unrestricted probe (no restrict_to_pid), so it walks the real desktop. The
    // authorized_apps bound — fixture A's unique image path — is evaluated in
    // PowerShell before any title read, so no other window's title is ever read.
    const probe = createPowerShellUiaProbe({ timeout_ms: 30_000 });
    const authorized = [{ image_path: fixtureA.image_path }];

    const raw = await probe.enumerateWindows(
      { max_windows: 200, authorized_apps: authorized },
      new AbortController().signal,
    );
    assert.strictEqual(raw.session_state, 'active');
    if (raw.session_state === 'active') {
      assert.ok(raw.windows.some((w) => w.title === fixtureA.title), 'fixture A title must be present');
      assert.ok(!raw.windows.some((w) => w.title === fixtureB.title), 'fixture B title must be absent');
      assert.ok(!raw.windows.some((w) => w.identity.image_path.toLowerCase() === fixtureB.image_path.toLowerCase()),
        'fixture B window must be absent entirely');
    }

    // max_windows slot: with a bound of 1 and authorized_apps=[A], A still
    // appears and B never consumes the slot.
    const rawOne = await probe.enumerateWindows(
      { max_windows: 1, authorized_apps: authorized },
      new AbortController().signal,
    );
    assert.strictEqual(rawOne.session_state, 'active');
    if (rawOne.session_state === 'active') {
      assert.strictEqual(rawOne.windows.length, 1, 'exactly one window must be enumerated');
      assert.ok(rawOne.windows.some((w) => w.title === fixtureA.title), 'the single enumerated window must be fixture A');
    }
  });
});