import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';
import { createNodeCore, type NodeCore } from '@toros/node-core';

import { createDesktopAdapter } from '@toros/adapters-desktop';
import {
  fixtureProbe,
  startFixture,
  stopFixture,
  tools,
  NATIVE_DESKTOP_TEST_PREFLIGHT,
  type FixtureInstance,
} from '@toros/adapters-desktop/testing';

const CORE_TOKEN = 'toros-f2-native-core-token';

// Round 5: this suite starts a real WinForms window and walks the live
// desktop, so a plain `npm test` must never run it. It runs only when the
// operator opts in with TOROS_REAL_TESTS=1; with that set, a missing
// prerequisite (no interactive desktop, a locked desktop) fails loudly inside
// the test rather than skipping. See the preflight in native-utils.
const nativeDesktopTestOptions = { skip: NATIVE_DESKTOP_TEST_PREFLIGHT.skip };

describe('AR-F2 Native Core Integration (finding 2)', () => {
  const activeFixtures: FixtureInstance[] = [];

  after(async () => {
    while (activeFixtures.length > 0) {
      const f = activeFixtures.pop()!;
      await stopFixture(f);
    }
  });

  it('desktop.state and desktop.inspect through a real Core: no canary in output, persisted receipts, or events', nativeDesktopTestOptions, async (t) => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    // Round 4, item 2: the locked-desktop precondition check runs after the
    // fixture starts, using the fixture-bound probe. The PID filter makes the
    // walk skip every other window before any text is read, so the check never
    // inspects the operator's real applications.
    const deskState = await probe.enumerateWindows(
      'default',
      { max_windows: 200 },
      new AbortController().signal,
    );
    if (deskState.session_state !== 'active') {
      throw new Error(
        `Desktop is not in active state (state=${deskState.session_state}). AR-F2 requires an interactive, unlocked Windows desktop.`,
      );
    }

    // A real Core with the desktop adapter, a fixture-bound probe, and a
    // temporary store.
    const dir = await mkdtemp(join(tmpdir(), 'toros-f2-core-'));
    const dbPath = join(dir, 'node.sqlite');
    const jobId = '55555555-5555-4555-8555-555555555555';

    const store = await openStore({ path: dbPath, nodeId: 'node' });
    await store.createJob(
      sealEnvelope({
        job_id: jobId,
        objective: 'AR-F2 no UIA names — receipts and events through Core',
        allowed_capabilities: ['desktop.state', 'desktop.inspect'],
        allowed_workspaces: ['work'],
        acceptance: ['done'],
        forbidden: [],
        max_actions: 10,
        max_retries: 0,
        expires_at: '2999-01-01T00:00:00Z',
      }),
    );
    await store.close();

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      // Only the fixture's unique process name (the renamed PowerShell copy in
      // the fixture's own temp dir) is authorized — never a generic `powershell`.
      authorized_apps: [fixture.process_name],
      probe,
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    });

    const core: NodeCore = createNodeCore({
      node_id: 'node',
      db_path: dbPath,
      workspaces: [{ id: 'work', root: tmpdir() }],
      port: 0,
      token: CORE_TOKEN,
      adapters: [adapter],
      observer: null,
      approval_required: [],
    });

    t.after(async () => {
      await core.stop();
      await rm(dir, { recursive: true, force: true });
    });

    const { port } = await core.start();

    // Run desktop.state through the real action pipeline.
    const stateRes = await tools(port, 'invoke_app_action', {
      job_id: jobId,
      app_id: 'desktop',
      action_id: 'state',
      workspace_id: 'work',
      parameters: { session_scope: 'default' },
    }, CORE_TOKEN);
    assert.strictEqual(stateRes.status, 200, `state failed: ${JSON.stringify(stateRes.body)}`);
    assert.strictEqual(stateRes.body.error, undefined, `state failed: ${JSON.stringify(stateRes.body)}`);
    const stateBody = JSON.parse(String(stateRes.body.output)) as {
      freshness_token: string;
      windows: Array<{ window_id: string; title?: string; app_in_scope: boolean }>;
    };

    const target = stateBody.windows.find((w) => w.title === fixture.title);
    assert.ok(target, 'the fixture window must be enumerated in state');
    assert.strictEqual(target.app_in_scope, true);
    assert.strictEqual(stateBody.windows.length, 1, 'only the fixture window may be in state');

    // Run desktop.inspect through the real action pipeline.
    const inspectRes = await tools(port, 'invoke_app_action', {
      job_id: jobId,
      app_id: 'desktop',
      action_id: 'inspect',
      workspace_id: 'work',
      parameters: {
        window_id: target.window_id,
        freshness_token: stateBody.freshness_token,
        depth: 3,
      },
    }, CORE_TOKEN);
    assert.strictEqual(inspectRes.status, 200, `inspect failed: ${JSON.stringify(inspectRes.body)}`);
    assert.strictEqual(inspectRes.body.error, undefined, `inspect failed: ${JSON.stringify(inspectRes.body)}`);
    const inspectBody = JSON.parse(String(inspectRes.body.output)) as { status: string; controls: Array<Record<string, unknown>> };
    assert.strictEqual(inspectBody.status, 'ok');
    assert.ok(inspectBody.controls.length > 0, 'must inspect at least one control');

    // The three canaries must not appear in either action's output.
    const actionOutputText = JSON.stringify({ state: stateRes.body, inspect: inspectRes.body });
    for (const canary of [fixture.canaryPwd, fixture.canaryTxt, fixture.canaryLbl]) {
      assert.ok(!actionOutputText.includes(canary), `canary "${canary}" must NOT appear in any action output`);
    }

    // The three canaries must not appear in any persisted receipt or any event
    // row for the job.
    const check = await openStore({ path: dbPath, nodeId: 'node' });
    const receipts = await check.listReceipts(jobId);
    const events = await check.listEvents(jobId);
    await check.close();

    assert.ok(receipts.length >= 2, `state and inspect must each persist a receipt, got ${receipts.length}`);
    assert.ok(
      events.some((e) => e.kind === 'action.finished'),
      `expected action.finished events, got ${events.map((e) => e.kind).join(',')}`,
    );

    const persistedText = JSON.stringify({ receipts, events });
    for (const canary of [fixture.canaryPwd, fixture.canaryTxt, fixture.canaryLbl]) {
      assert.ok(
        !persistedText.includes(canary),
        `canary "${canary}" must NOT appear in any persisted receipt or event row`,
      );
    }

    // The inspected output shape is the F2 public shape — no name/value leak.
    for (const ctrl of inspectBody.controls) {
      assert.strictEqual(ctrl['name'], undefined, 'No control may possess a "name" property');
      assert.strictEqual(ctrl['value'], undefined, 'No control may possess a "value" property');
    }
  });
});