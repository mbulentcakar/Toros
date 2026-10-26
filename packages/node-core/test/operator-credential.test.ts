/**
 * AR-F1: operator credential separation.
 *
 * AR-03 (docs/reviews/AR-adversarial-security-review.md) showed that the
 * start-up strength/distinctness checks for `operator_token` ran only when a
 * capability was gated, while the operator surface in http.ts is mounted
 * whenever `operator_token` is a non-empty string. With `operator_token` equal
 * to `token` and no gated capability, Core started and the ordinary bearer
 * could list jobs, create a job and run it through `/operator/*`.
 *
 * These tests pin the contract that the two conditions now agree on: whenever
 * an operator token is configured it must be strong and distinct, whether or
 * not anything is currently gated; absent or empty still means "no operator
 * surface"; and the operator route refuses the ordinary bearer even as a
 * defence in depth.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AdapterManifest,
  type JsonValue,
} from '@toros/contracts';
import {
  createNodeCore,
  type CoordinatorControl,
  type CoordinatorStartInput,
  type NodeCore,
} from '../src/index.js';

// Every credential here is a deliberately synthetic string, long enough to be
// unambiguous against the 32-character floor. None of them is a real secret.
const nodeToken = 'node-token-for-operator-credential-suite-1234567890';
const operatorToken = 'operator-token-for-operator-credential-suite-9999';

const manifest: AdapterManifest = {
  id: 'mock',
  version: '1.0.0',
  platforms: [process.platform as 'win32' | 'linux' | 'darwin'],
  actions: [{
    id: 'run', summary: 'Run',
    input_schema: { type: 'object', additionalProperties: false },
    path_fields: [], mutates: false, always_requires_approval: false,
  }],
  required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000,
  cancellation: 'graceful', receipt_fields: [],
};

const adapter: Adapter = {
  manifest,
  async init() {},
  async invoke(): Promise<ActionResult> {
    return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
  },
  async dispose() {},
};

/** A coordinator that only records what Node Core handed it, minting no run. */
function fakeCoordinator(starts: CoordinatorStartInput[]): CoordinatorControl {
  const listeners: Array<(runId: string) => void> = [];
  return {
    async start(jobId, input) {
      starts.push(input ?? {});
      return {
        run_id: `run-${starts.length}`, job_id: jobId, state: 'running',
        started_at: new Date().toISOString(), ended_at: null, exit_code: null, messages: [],
      };
    },
    status() { return null; },
    async stop() { return null; },
    async stopAll() { for (const listener of listeners) listener('shutdown'); },
    onRunEnded(listener) { listeners.push(listener); },
  };
}

interface CredentialOptions {
  readonly token: string;
  readonly operatorToken?: string;
  readonly approvalRequired: readonly string[];
  readonly coordinator?: CoordinatorControl;
}

function makeCore(dir: string, options: CredentialOptions): NodeCore {
  return createNodeCore({
    node_id: 'node',
    db_path: join(dir, 'node.sqlite'),
    workspaces: [{ id: 'work', root: dir }],
    port: 0,
    token: options.token,
    adapters: [adapter],
    observer: null,
    approval_required: options.approvalRequired,
    ...(options.operatorToken === undefined ? {} : { operator_token: options.operatorToken }),
    ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
  });
}

async function post(
  port: number,
  path: string,
  body: Record<string, unknown>,
  auth: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode ?? 0, body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('an operator token equal to token refuses to start even with no gated capability', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-equal-'));
  const shared = 'shared-operator-and-node-token-00000000000000';
  const core = makeCore(dir, { token: shared, operatorToken: shared, approvalRequired: [] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /differ from token/.test(error.message));
});

test('a short operator token refuses to start even with no gated capability', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-short-'));
  const core = makeCore(dir, { token: nodeToken, operatorToken: 'too-short', approvalRequired: [] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /at least 32 characters/.test(error.message));
});

test('a valid distinct operator token starts and gates the operator surface correctly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-valid-'));
  const core = makeCore(dir, { token: nodeToken, operatorToken, approvalRequired: [] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  assert.equal((await post(port, '/operator/jobs', {}, nodeToken)).status, 401);
  assert.equal((await post(port, '/operator/jobs', {}, operatorToken)).status, 200);
});

test('an absent operator token means no operator surface', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-absent-'));
  const core = makeCore(dir, { token: nodeToken, approvalRequired: [] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  for (const operation of ['jobs', 'catalog', 'create_job', 'approvals']) {
    assert.equal((await post(port, `/operator/${operation}`, {}, nodeToken)).status, 401, operation);
  }
});

test('an empty operator token means no operator surface', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-empty-'));
  const core = makeCore(dir, { token: nodeToken, operatorToken: '', approvalRequired: [] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  assert.equal((await post(port, '/operator/jobs', {}, nodeToken)).status, 401);
});

test('a gated capability with no operator token still refuses to start', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-gated-'));
  const core = makeCore(dir, { token: nodeToken, approvalRequired: ['mock.run'] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /operator_token/.test(error.message));
});

test('tokens differing only by case are treated as distinct', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-case-'));
  const caseToken = 'OperatorCredentialCaseProbe0123456789';
  const caseOperatorToken = 'operatorcredentialcaseprobe0123456789';
  const core = makeCore(dir, { token: caseToken, operatorToken: caseOperatorToken, approvalRequired: [] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  // Equality is exact-string, not case-folded, so this must start.
  const { port } = await core.start();
  assert.equal((await post(port, '/operator/jobs', {}, caseToken)).status, 401);
  assert.equal((await post(port, '/operator/jobs', {}, caseOperatorToken)).status, 200);
});

test('a token containing whitespace refuses to start and names the shape rule', async (t) => {
  const bad = [
    `${nodeToken} `,                                  // trailing space
    ` ${nodeToken}`,                                  // leading space
    'node-token with-inner-space-1234567890',         // inner space
    `${nodeToken}\t`,                                 // tab
    `${nodeToken}\n`,                                 // line break
  ];
  for (const value of bad) {
    const dir = await mkdtemp(join(tmpdir(), 'toros-cred-token-shape-'));
    const core = makeCore(dir, { token: value, approvalRequired: [] });
    t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
    await assert.rejects(
      core.start(),
      (error: unknown) => error instanceof Error && /printable ASCII/.test(error.message),
      `token ${JSON.stringify(value)}`,
    );
  }
});

test('an operator token containing whitespace refuses to start and names the shape rule', async (t) => {
  const bad = [
    `${operatorToken} `,                                  // trailing space
    ` ${operatorToken}`,                                  // leading space
    'operator-token for-operator-credential-suite-9999',  // inner space
    `${operatorToken}\t`,                                 // tab
    `${operatorToken}\n`,                                 // line break
  ];
  for (const value of bad) {
    const dir = await mkdtemp(join(tmpdir(), 'toros-cred-op-shape-'));
    const core = makeCore(dir, { token: nodeToken, operatorToken: value, approvalRequired: [] });
    t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
    await assert.rejects(
      core.start(),
      (error: unknown) => error instanceof Error && /printable ASCII/.test(error.message),
      `operator_token ${JSON.stringify(value)}`,
    );
  }
});

test('token = B + " " with operator_token = B refuses to start (round-2 regression)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-regression-'));
  // B is a deliberately synthetic ASCII string longer than 32 characters.
  const B = 'operator-regression-probe-0123456789-abcdef';
  const core = makeCore(dir, { token: `${B} `, operatorToken: B, approvalRequired: [] });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  // The trailing space is exactly what HTTP would strip before a comparison,
  // so this must refuse to start before the operator surface can ever answer
  // 200 to the ordinary bearer.
  await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /printable ASCII/.test(error.message));
});

test('a live advisory run credential is refused by the operator surface', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cred-advisory-'));
  const starts: CoordinatorStartInput[] = [];
  const core = makeCore(dir, {
    token: nodeToken, operatorToken, approvalRequired: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const conversation = await post(port, '/operator/conversation_create', {}, operatorToken);
  assert.equal(conversation.status, 200);
  const conversationId = String(conversation.body.conversation_id);

  const sent = await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'hello' }, operatorToken);
  assert.equal(sent.status, 200);

  const advisoryRun = starts[0];
  assert.ok(advisoryRun !== undefined, 'the advisory run was not started');
  const advisoryToken = advisoryRun.run_token;
  assert.ok(typeof advisoryToken === 'string' && advisoryToken.length > 0, 'no advisory run credential was minted');

  // Live: it reaches its own conversation on the tool surface.
  assert.equal((await post(port, '/tools/list_turns', {}, advisoryToken)).status, 200);
  // But the operator surface is the operator's alone.
  assert.equal((await post(port, '/operator/jobs', {}, advisoryToken)).status, 401);
});
