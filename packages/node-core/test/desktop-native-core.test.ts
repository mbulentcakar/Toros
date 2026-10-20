import { describe, it, after } from 'node:test';
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

const CORE_TOKEN = 'toros-f3b-native-core-token';

// Round 5: this suite starts a real WinForms window and walks the live desktop,
// so a plain `npm test` must never run it. It runs only when the operator opts
// in with TOROS_REAL_TESTS=1. See the preflight in native-utils.
const nativeDesktopTestOptions = { skip: NATIVE_DESKTOP_TEST_PREFLIGHT.skip };

describe('AR-F3b Native Core Integration (two-phase over a real Core)', () => {
  const activeFixtures: FixtureInstance[] = [];

  after(async () => {
    while (activeFixtures.length > 0) {
      await stopFixture(activeFixtures.pop()!);
    }
  });

  it('desktop.state and desktop.inspect through a real Core: identity bound, no canary leak', nativeDesktopTestOptions, async (t) => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    // Read the fixture's session id first: Node Core requires a resolved app to
    // live in its own session, and in a native run both processes share the
    // interactive session, so the fixture's own session id IS the node's.
    const deskState = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
    if (deskState.session_state !== 'active') {
      throw new Error(
        `Desktop is not in active state (state=${deskState.session_state}). AR-F3b requires an interactive, unlocked Windows desktop.`,
      );
    }
    const fixtureWindow = deskState.windows.find((w) => w.native_handle === String(fixture.hwnd));
    assert.ok(fixtureWindow, 'the fixture window must be enumerated');
    const sessionId = fixtureWindow!.identity.session_id;

    const dir = await mkdtemp(join(tmpdir(), 'toros-f3b-core-'));
    const dbPath = join(dir, 'node.sqlite');
    const jobId = '55555555-5555-4555-8555-555555555555';

    const store = await openStore({ path: dbPath, nodeId: 'node' });
    await store.createJob(
      sealEnvelope({
        job_id: jobId,
        objective: 'AR-F3b identity bound — receipts and events through Core',
        allowed_capabilities: ['desktop.state', 'desktop.inspect'],
        allowed_workspaces: ['work'],
        acceptance: ['done'],
        forbidden: [],
        max_actions: 10,
        max_retries: 0,
        expires_at: '2999-01-01T00:00:00Z',
        // The envelope names the fixture by its image path, so Core's own
        // authorizeTargets allows the resolved app target (global bound + envelope).
        allowed_apps: [{ image_path: fixture.image_path }],
      }),
    );
    await store.close();

    const adapter = createDesktopAdapter({
      node_platform: 'win32',
      authorized_apps: [{ image_path: fixture.image_path }],
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
      desktop_session_id: sessionId,
    });

    t.after(async () => {
      await core.stop();
      await rm(dir, { recursive: true, force: true });
    });

    const { port } = await core.start();

    // desktop.state through the real pipeline.
    const stateRes = await tools(port, 'invoke_app_action', {
      job_id: jobId,
      app_id: 'desktop',
      action_id: 'state',
      workspace_id: 'work',
      parameters: { session_scope: 'interactive' },
    }, CORE_TOKEN);
    assert.strictEqual(stateRes.status, 200, `state failed: ${JSON.stringify(stateRes.body)}`);
    assert.strictEqual(stateRes.body.error, undefined, `state failed: ${JSON.stringify(stateRes.body)}`);
    const stateBody = JSON.parse(String(stateRes.body.output)) as {
      session: string;
      freshness_token: string;
      windows: Array<{ window_id: string; title?: string }>;
    };
    assert.strictEqual(stateBody.session, 'active');
    const target = stateBody.windows.find((w) => w.title === fixture.title);
    assert.ok(target, 'the fixture window must be enumerated in state');
    assert.strictEqual(stateBody.windows.length, 1, 'only the fixture window may be in state');

    // desktop.inspect through the real pipeline.
    const inspectRes = await tools(port, 'invoke_app_action', {
      job_id: jobId,
      app_id: 'desktop',
      action_id: 'inspect',
      workspace_id: 'work',
      parameters: {
        session_scope: 'interactive',
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

    // No canary may appear in any action output or persisted receipt/event.
    const actionOutputText = JSON.stringify({ state: stateRes.body, inspect: inspectRes.body });
    const check = await openStore({ path: dbPath, nodeId: 'node' });
    const receipts = await check.listReceipts(jobId);
    const events = await check.listEvents(jobId);
    await check.close();
    const persistedText = JSON.stringify({ receipts, events });

    for (const canary of [fixture.canaryPwd, fixture.canaryTxt, fixture.canaryLbl]) {
      assert.ok(!actionOutputText.includes(canary), `canary "${canary}" must NOT appear in any action output`);
      assert.ok(!persistedText.includes(canary), `canary "${canary}" must NOT appear in any persisted receipt or event`);
    }
    for (const ctrl of inspectBody.controls) {
      assert.strictEqual(ctrl['name'], undefined, 'No control may possess a "name" property');
      assert.strictEqual(ctrl['value'], undefined, 'No control may possess a "value" property');
    }
  });
});