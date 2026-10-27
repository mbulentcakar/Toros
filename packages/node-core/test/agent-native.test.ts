/**
 * AT1 acceptance test 7 (native): the agent surface over the real desktop
 * pipeline with a fixture window, mirroring desktop-native-core.test.ts.
 *
 * Gated exactly like that suite — a plain `node --test` run must never execute
 * it; only an operator who sets `TOROS_REAL_TESTS=1` opts in. Skips are
 * findings.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
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
  NATIVE_DESKTOP_TEST_PREFLIGHT,
  type FixtureInstance,
} from '@toros/adapters-desktop/testing';

const CORE_TOKEN = 'toros-at1-native-core-token-0000000000000000';
const OPERATOR_TOKEN = 'toros-at1-native-operator-token-9999999999';
const CLAUDE_TOKEN = 'toros-at1-native-claude-token-1234567890123456';

const nativeDesktopTestOptions = { skip: NATIVE_DESKTOP_TEST_PREFLIGHT.skip };

interface NodeResponse {
  status: number;
  body: Record<string, unknown>;
}

function postJson(port: number, path: string, body: Record<string, unknown>, auth: string): Promise<NodeResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        agent: false,
        path,
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function agentInvoke(port: number, capability: string, parameters: Record<string, unknown>): Promise<NodeResponse> {
  return postJson(port, '/agent/invoke', { capability, parameters }, CLAUDE_TOKEN);
}

describe('AT1 Native Core Integration (agent surface over a real Core)', () => {
  const activeFixtures: FixtureInstance[] = [];

  after(async () => {
    while (activeFixtures.length > 0) {
      await stopFixture(activeFixtures.pop()!);
    }
  });

  it('desktop.state/inspect through a real Core for an agent grant: bound, redacted, single-use, forbidden, receipts carry agent:claude', nativeDesktopTestOptions, async (t) => {
    const fixture = await startFixture({});
    activeFixtures.push(fixture);
    const probe = fixtureProbe(fixture);

    const deskState = await probe.enumerateWindows({ max_windows: 200 }, new AbortController().signal);
    if (deskState.session_state !== 'active') {
      throw new Error(`Desktop is not active (state=${deskState.session_state}); AT1 native needs an interactive, unlocked desktop.`);
    }
    const fixtureWindow = deskState.windows.find((w) => w.native_handle === String(fixture.hwnd));
    assert.ok(fixtureWindow, 'the fixture window must be enumerated');
    const sessionId = fixtureWindow!.identity.session_id;

    const dir = await mkdtemp(join(tmpdir(), 'toros-at1-core-'));
    const dbPath = join(dir, 'node.sqlite');
    const jobId = '55555555-5555-4555-8555-555555555555';
    const forbiddenJobId = '66666666-6666-4666-8666-666666666666';

    const store = await openStore({ path: dbPath, nodeId: 'node' });
    await store.createJob(sealEnvelope({
      job_id: jobId,
      objective: 'AT1 agent native — state and inspect',
      allowed_capabilities: ['desktop.state', 'desktop.inspect'],
      allowed_workspaces: ['work'],
      acceptance: ['done'],
      forbidden: [],
      max_actions: 10,
      max_retries: 0,
      expires_at: '2999-01-01T00:00:00Z',
      allowed_apps: [{ image_path: fixture.image_path }],
    }));
    await store.createJob(sealEnvelope({
      job_id: forbiddenJobId,
      objective: 'AT1 agent native — forbidden inspect',
      allowed_capabilities: ['desktop.state', 'desktop.inspect'],
      allowed_workspaces: ['work'],
      acceptance: ['done'],
      forbidden: ['desktop inspect'],
      max_actions: 10,
      max_retries: 0,
      expires_at: '2999-01-01T00:00:00Z',
      allowed_apps: [{ image_path: fixture.image_path }],
    }));
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
      operator_token: OPERATOR_TOKEN,
      agent_tokens: { claude: CLAUDE_TOKEN },
      desktop_ar_gate_cleared: true,
      desktop_session_id: sessionId,
    });

    t.after(async () => {
      await core.stop();
      await rm(dir, { recursive: true, force: true });
    });

    const { port } = await core.start();

    const grant = (job: string): Promise<NodeResponse> =>
      postJson(port, '/operator/agent_grant_create', { job_id: job, agent: 'claude' }, OPERATOR_TOKEN);

    // 1. desktop.state returns the fixture window and nothing else.
    const created = await grant(jobId);
    assert.strictEqual(created.body.error, undefined, `grant failed: ${JSON.stringify(created.body)}`);

    const stateRes = await agentInvoke(port, 'desktop.state', {});
    assert.strictEqual(stateRes.status, 200, `state failed: ${JSON.stringify(stateRes.body)}`);
    assert.strictEqual(stateRes.body.error, undefined);
    const stateBody = JSON.parse(String(stateRes.body.output)) as {
      session: string;
      freshness_token: string;
      windows: Array<{ window_id: string; title?: string }>;
    };
    assert.strictEqual(stateBody.session, 'active');
    const target = stateBody.windows.find((w) => w.title === fixture.title);
    assert.ok(target, 'the fixture window must be enumerated in state');
    assert.strictEqual(stateBody.windows.length, 1, 'only the fixture window may be in state');

    // 2. desktop.inspect returns structure without names.
    const inspectRes = await agentInvoke(port, 'desktop.inspect', {
      session_scope: 'interactive',
      window_id: target.window_id,
      freshness_token: stateBody.freshness_token,
      depth: 3,
    });
    assert.strictEqual(inspectRes.status, 200, `inspect failed: ${JSON.stringify(inspectRes.body)}`);
    assert.strictEqual(inspectRes.body.error, undefined);
    const inspectBody = JSON.parse(String(inspectRes.body.output)) as { status: string; controls: Array<Record<string, unknown>> };
    assert.strictEqual(inspectBody.status, 'ok');
    for (const ctrl of inspectBody.controls) {
      assert.strictEqual(ctrl['name'], undefined, 'No control may possess a "name" property');
      assert.strictEqual(ctrl['value'], undefined, 'No control may possess a "value" property');
    }

    // 3. a reused handle gives refresh_required.
    const reused = await agentInvoke(port, 'desktop.inspect', {
      session_scope: 'interactive',
      window_id: target.window_id,
      freshness_token: stateBody.freshness_token,
      depth: 3,
    });
    assert.strictEqual(reused.status, 200, `reused inspect failed: ${JSON.stringify(reused.body)}`);
    assert.strictEqual(reused.body.error, undefined);
    const reusedBody = JSON.parse(String(reused.body.output)) as { status: string };
    assert.strictEqual(reusedBody.status, 'refresh_required');

    // 4. a forbidden job refuses inspect with E_FORBIDDEN.
    const forbiddenGrant = await grant(forbiddenJobId);
    assert.strictEqual(forbiddenGrant.body.error, undefined, `forbidden grant failed: ${JSON.stringify(forbiddenGrant.body)}`);
    const denied = await agentInvoke(port, 'desktop.inspect', { session_scope: 'interactive' });
    assert.strictEqual(denied.body.error, 'E_FORBIDDEN', `expected E_FORBIDDEN, got ${JSON.stringify(denied.body)}`);

    // 5. receipts carry agent:claude.
    const check = await openStore({ path: dbPath, nodeId: 'node' });
    const receipts = await check.listReceipts(jobId);
    await check.close();
    assert.ok(receipts.length >= 3, 'state + inspect + reused inspect must each write a closed receipt');
    for (const receipt of receipts) assert.strictEqual(receipt.actor, 'agent:claude');
  });
});