import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, type ActionResult, type Adapter, type AdapterContext, type AdapterManifest, type JsonValue, type NodePlatform } from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';
import { createNodeCore, type NodeCore } from '../src/index.js';

// ---------------------------------------------------------------------------
// Replicated helpers — acceptance.test.ts does not export its fixture, so
// these mirror its patterns exactly: temp SQLite dir, sealEnvelope, mock
// adapter, ≥32-char token, createNodeCore WITHOUT a coordinator field.
// ---------------------------------------------------------------------------

const token = 'test-token-at-least-thirty-two-chars';
const operatorToken = 'operator-token-at-least-32-chars-long';

const manifest: AdapterManifest = {
  id: 'mock', version: '1.0.0', platforms: [process.platform as NodePlatform],
  actions: [{
    id: 'run', summary: 'run',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    path_fields: ['path'], mutates: false, always_requires_approval: false,
  }],
  required_permissions: [], allowed_resources: [], default_timeout_ms: 1000,
  cancellation: 'graceful', receipt_fields: ['audit_id'],
};

function makeAdapter(): Adapter {
  return {
    manifest,
    async init() {},
    async invoke(_actionId: string, _args: Readonly<Record<string, JsonValue>>, _ctx: AdapterContext): Promise<ActionResult> {
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: { audit_id: 'trace-1' } };
    },
    async dispose() {},
  };
}

interface Fixture { core: NodeCore; path: string; job: string; dir: string; }

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-no-coord-'));
  const path = join(dir, 'node.sqlite');
  const job = '11111111-1111-4111-8111-111111111111';
  const sealed = sealEnvelope({
    job_id: job, objective: 'test',
    allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 3, max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
  });
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealed);
  await store.close();
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [makeAdapter()], observer: null,
    approval_required: [],
    // No coordinator field — that is the whole test surface.
    operator_token: operatorToken,
  });
  return { core, path, job, dir };
}

async function finish(f: Fixture): Promise<void> {
  await f.core.stop();
  await rm(f.dir, { recursive: true, force: true });
}

/** POST to the tool surface (mirrors acceptance.test's `http` helper). */
async function http(port: number, tool: string, args: Record<string, unknown>, auth = token): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method: 'POST', agent: false,
      path: `/tools/${tool}`,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(args));
  });
}

/** POST to the operator surface. */
async function operator(port: number, operation: string, args: Record<string, unknown>, auth = operatorToken): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method: 'POST', agent: false,
      path: `/operator/${operation}`,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(args));
  });
}

/** Convenience: invoke the mock action on the tool surface. */
async function action(f: Fixture, port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return http(port, 'invoke_app_action', {
    job_id: f.job, app_id: 'mock', action_id: 'run',
    workspace_id: 'work', parameters: {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('starts and stops cleanly with no coordinator', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  assert.ok(p.port > 0);
  // Verify the service is actually reachable.
  assert.equal((await http(p.port, 'job_status', { job_id: f.job })).status, 200);
  await f.core.stop();
  // A second stop must be safe — Core.stop() guards double-stop internally,
  // but coordinator cleanup is just a no-op when it was never present.
  await f.core.stop();
});

test('discovery and typed execution work with no coordinator', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();

  // Discovery: list_capabilities returns only the allowed mock.run.
  const caps = await http(p.port, 'list_capabilities', { job_id: f.job });
  assert.deepEqual(caps.body.capabilities, ['mock.run']);

  // Typed execution: invoke the registered read-only mock action.
  const r = await action(f, p.port);
  assert.equal(r.body.error, undefined, `action returned an error: ${JSON.stringify(r.body)}`);

  // Read back the receipt from the event log.
  const activity = await http(p.port, 'list_activity', { job_id: f.job });
  const receipts = activity.body.receipts as Array<Record<string, unknown>>;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'succeeded');
  assert.equal(receipts[0]?.capability, 'mock.run');
});

test('coordinator_status resolves to null when coordinator is absent', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();

  // hermes_status on the operator surface delegates to coordinator?.status ?? null.
  const r = await operator(p.port, 'hermes_status', { job_id: f.job });
  assert.equal(r.status, 200);
  assert.equal(r.body.run, null);
});

test('starting a coordinator job fails with E_ADAPTER_FAILURE when coordinator is absent', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();

  // hermes_start on the operator surface throws when coordinator is undefined.
  const r = await operator(p.port, 'hermes_start', { job_id: f.job });
  assert.equal(r.body.error, ErrorCode.E_ADAPTER_FAILURE);
  assert.equal(r.body.message, 'Hermes coordinator is unavailable');
});

test('conversation_send fails with E_ADAPTER_FAILURE when coordinator is absent', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const conv = await store.createConversation({ conversation_id: 'conv-1', node_id: 'node', title: 'test', state: 'open' });
  await store.close();

  const r = await operator(p.port, 'conversation_send', {
    conversation_id: conv.conversation_id,
    message: 'hello',
  });
  assert.equal(r.body.error, ErrorCode.E_ADAPTER_FAILURE);
  assert.equal(r.body.message, 'Hermes coordinator is unavailable');
});

test('out-of-scope capability is denied deterministically', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();

  // Create a second job with no allowed_capabilities.  A mock.run invocation
  // against it must be denied with E_CAP_NOT_ALLOWED, independent of whether
  // a coordinator exists.
  const sealed = sealEnvelope({
    job_id: '22222222-2222-4222-8222-222222222222',
    objective: 'no-capabilities',
    allowed_capabilities: [], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 1, max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
  });
  const store = await openStore({ path: f.path, nodeId: 'node' });
  await store.createJob(sealed);
  await store.close();

  // Discovery must itself be envelope-gated, not just invoke-time deny: an
  // empty allowlist must yield an empty capability list, even though `mock.run`
  // is registered. This fails if list_capabilities ever returns the raw registry.
  const emptyCaps = await http(p.port, 'list_capabilities', {
    job_id: '22222222-2222-4222-8222-222222222222',
  });
  assert.deepEqual(emptyCaps.body.capabilities, []);

  const denied = await http(p.port, 'invoke_app_action', {
    job_id: '22222222-2222-4222-8222-222222222222',
    app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {},
  });
  assert.equal(denied.body.error, ErrorCode.E_CAP_NOT_ALLOWED);
});