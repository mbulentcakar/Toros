/**
 * Acceptance tests for amendment A8 two-phase resolve in the action pipeline.
 *
 * Uses a fake resolving adapter — no PowerShell, no Windows — and drives the
 * real Core over its loopback HTTP surface, exactly like the AR-F4 pipeline
 * integrity tests the resolve step slots into.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ErrorCode,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AdapterManifest,
  type AppIdentity,
  type NodePlatform,
  type ResolvedTarget,
  type TargetResolver,
} from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';
import { createNodeCore, type NodeCore } from '../src/index.js';

const token = 'test-token';

function appIdentity(overrides: Partial<AppIdentity> = {}): AppIdentity {
  return {
    pid: 1234,
    created_at: '2026-01-01T00:00:00Z',
    image_path: 'C:\\Program Files\\Contoso\\app.exe',
    image_sha256: 'a'.repeat(64),
    signature: 'valid',
    signer: 'Contoso Corp',
    product_name: 'Contoso Editor',
    session_id: 7,
    ...overrides,
  };
}

function fulfillableManifest(extra: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    id: 'mock', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions: [{ id: 'run', summary: 'run', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: false, always_requires_approval: false }],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 30_000,
    cancellation: 'graceful', receipt_fields: [], ...extra,
  };
}

interface Fixture {
  core: NodeCore;
  path: string;
  job: string;
  port: number;
  dir: string;
}

async function fixture(adapter: Adapter, envelopeOverrides: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-f3a-'));
  const path = join(dir, 'node.sqlite');
  const job = '55555555-5555-4555-8555-555555555555';
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'f3a two-phase resolve', allowed_capabilities: ['mock.run'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z', ...envelopeOverrides,
  }));
  await store.close();
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
    desktop_session_id: 7,
  });
  const { port } = await core.start();
  return { core, path, job, port, dir };
}

async function finish(f: Fixture): Promise<void> {
  await f.core.stop();
  await rm(f.dir, { recursive: true, force: true });
}

async function http(port: number, tool: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method: 'POST', agent: false, path: `/tools/${tool}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(args));
  });
}

function invoke(port: number, job: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return http(port, 'invoke_app_action', { job_id: job, app_id: 'mock', action_id: 'run', workspace_id: 'work' });
}

// ---------------------------------------------------------------------------
// Test 1 — a well-formed resolve flows decisions and counts through the receipt.
// ---------------------------------------------------------------------------

test('a resolver receives actor, invoke receives target_decisions, and the receipt holds counts only', async (t) => {
  let capturedActor: string | undefined;
  let capturedDecisions: ReadonlyMap<string, string> | undefined;
  const adapter: Adapter = {
    manifest: fulfillableManifest(),
    resolver: {
      async resolve(): Promise<readonly ResolvedTarget[]> {
        return [
          { kind: 'app', key: 'keep', identity: appIdentity() },
          { kind: 'app', key: 'drop', identity: appIdentity({ image_sha256: 'b'.repeat(64) }) },
          { kind: 'capability', key: 'cap', capability: 'mock.run' },
        ];
      },
    },
    async init() {},
    async invoke(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<ActionResult> {
      capturedActor = ctx.actor;
      capturedDecisions = ctx.target_decisions;
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const f = await fixture(adapter, { allowed_apps: [{ image_sha256: 'a'.repeat(64) }] });
  t.after(() => finish(f));

  const response = await invoke(f.port, f.job);
  assert.equal(response.body.error, undefined, `invoke failed: ${JSON.stringify(response.body)}`);

  assert.equal(capturedActor, 'coordinator');
  assert.deepEqual(capturedDecisions, new Map([
    ['keep', 'allowed'],
    ['drop', 'denied'],
    ['cap', 'allowed'],
  ]));

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  const events = await store.listEvents(f.job);
  await store.close();

  assert.equal(receipts.length, 1);
  const fields = receipts[0]!.adapter_fields as Record<string, unknown>;
  assert.equal(fields['targets_allowed'], 2);
  assert.equal(fields['targets_denied'], 1);

  // Counts only — no identity string may appear in any receipt or event.
  const receiptsText = JSON.stringify(receipts);
  const eventsText = JSON.stringify(events);
  assert.equal(receiptsText.includes(appIdentity().image_sha256), false, 'an identity sha leaked into a receipt');
  assert.equal(eventsText.includes(appIdentity().image_sha256), false, 'an identity sha leaked into an event');
  assert.equal(receiptsText.includes('Contoso'), false, 'a signer/product name leaked into a receipt');
  assert.equal(eventsText.includes('Contoso'), false, 'a signer/product name leaked into an event');
});

// ---------------------------------------------------------------------------
// Test 2 — malformed resolve output is E_ADAPTER_FAILURE with a closed receipt.
// ---------------------------------------------------------------------------

async function expectMalformedFailure(envelopeOverrides: Record<string, unknown>, resolver: TargetResolver): Promise<void> {
  const adapter: Adapter = {
    manifest: fulfillableManifest(),
    resolver,
    async init() {},
    async invoke(): Promise<ActionResult> { return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} }; },
    async dispose() {},
  };
  const f = await fixture(adapter, envelopeOverrides);
  try {
    const response = await invoke(f.port, f.job);
    assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE, `expected E_ADAPTER_FAILURE, got ${JSON.stringify(response.body)}`);

    const store = await openStore({ path: f.path, nodeId: 'node' });
    const receipts = await store.listReceipts(f.job);
    const events = await store.listEvents(f.job);
    const job = await store.getJob(f.job);
    await store.close();

    assert.equal(receipts.length, 1);
    assert.notEqual(receipts[0]?.ended_at, null);
    assert.equal(receipts[0]?.outcome, 'failed');
    assert.equal(job?.actions_used, 1, 'a resolve failure must spend budget exactly like an invoke failure');
    assert.ok(events.some((e) => e.kind === 'action.finished'));
  } finally {
    await f.core.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
}

test('a resolver returning duplicate keys closes the receipt with E_ADAPTER_FAILURE', () => {
  return expectMalformedFailure({}, {
    async resolve(): Promise<readonly ResolvedTarget[]> {
      return [appTarget('x'), appTarget('x'), appTarget('y')];
    },
  });
});

test('a resolver returning more than 1,000 targets closes the receipt with E_ADAPTER_FAILURE', () => {
  return expectMalformedFailure({}, {
    async resolve(): Promise<readonly ResolvedTarget[]> {
      return Array.from({ length: 1001 }, (_, i) => appTarget(`t${i}`));
    },
  });
});

test('a resolver returning an unknown kind closes the receipt with E_ADAPTER_FAILURE', () => {
  return expectMalformedFailure({}, {
    async resolve(): Promise<readonly ResolvedTarget[]> {
      // Deliberately malformed: an unknown kind, not one of the contract shapes.
      return [{ kind: 'window', key: 'x' }] as unknown as readonly ResolvedTarget[];
    },
  });
});

function appTarget(key: string): ResolvedTarget {
  return { kind: 'app', key, identity: appIdentity() };
}

// ---------------------------------------------------------------------------
// Test 3 — a resolve that never settles is timed out exactly like invoke.
// ---------------------------------------------------------------------------

test('a never-resolving adapter is timed out with a terminated receipt and an aborted signal', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const adapter: Adapter = {
    manifest: fulfillableManifest({ default_timeout_ms: 80 }),
    resolver: {
      async resolve(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<readonly ResolvedTarget[]> {
        capturedSignal = ctx.signal;
        return new Promise<readonly ResolvedTarget[]>(() => { /* never settles */ });
      },
    },
    async init() {},
    async invoke(): Promise<ActionResult> { return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} }; },
    async dispose() {},
  };
  const f = await fixture(adapter, { allowed_apps: [{ image_sha256: 'a'.repeat(64) }] });
  t.after(() => finish(f));

  const response = await invoke(f.port, f.job);
  assert.equal(response.body.error, ErrorCode.E_TIMEOUT, `expected E_TIMEOUT, got ${JSON.stringify(response.body)}`);
  assert.equal(capturedSignal?.aborted, true, 'the resolver signal was not aborted on timeout');

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  await store.close();
  assert.equal(receipts[0]?.outcome, 'terminated');
  assert.notEqual(receipts[0]?.ended_at, null);
});

// ---------------------------------------------------------------------------
// Test 4 — a manifest declaring a Core-reserved receipt field is refused.
// ---------------------------------------------------------------------------

test('a manifest declaring a Core-reserved receipt field is refused at registration', async (t) => {
  const adapter: Adapter = {
    manifest: fulfillableManifest({ receipt_fields: ['targets_allowed'] }),
    async init() {},
    async invoke(): Promise<ActionResult> { return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} }; },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));

  // Refused registration means the capability never appears in the registered set.
  const { registered_capabilities } = await f.core.start();
  assert.equal(registered_capabilities.includes('mock.run'), false, 'a manifest declaring a Core-reserved receipt field was still registered');
});