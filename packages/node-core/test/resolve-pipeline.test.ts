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
  type SessionAdapter,
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
    original_filename: 'app.exe',
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
  let capturedResolveActor: string | undefined;
  let capturedActor: string | undefined;
  let capturedDecisions: ReadonlyMap<string, string> | undefined;
  const adapter: Adapter = {
    manifest: fulfillableManifest(),
    resolver: {
      async resolve(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<readonly ResolvedTarget[]> {
        // The actor must reach the RESOLVE phase too, not only invoke (round 2
        // item 6): the resolver mints per-(job, actor) handles, so it needs the
        // caller identity as much as invoke does.
        capturedResolveActor = ctx.actor;
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

  assert.equal(capturedResolveActor, 'coordinator');
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

function appTarget(key: string, identity: AppIdentity = appIdentity()): ResolvedTarget {
  return { kind: 'app', key, identity };
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

// ---------------------------------------------------------------------------
// Test 5 — strict identity validation (round 2 item 2): one test per rule.
// ---------------------------------------------------------------------------

async function expectIdentityFailure(identity: AppIdentity): Promise<void> {
  const adapter: Adapter = {
    manifest: fulfillableManifest(),
    resolver: {
      async resolve(): Promise<readonly ResolvedTarget[]> {
        return [appTarget('x', identity)];
      },
    },
    async init() {},
    async invoke(): Promise<ActionResult> { return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} }; },
    async dispose() {},
  };
  const f = await fixture(adapter, { allowed_apps: [{ image_sha256: 'a'.repeat(64) }] });
  try {
    const response = await invoke(f.port, f.job);
    assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE, `expected E_ADAPTER_FAILURE, got ${JSON.stringify(response.body)}`);
    const store = await openStore({ path: f.path, nodeId: 'node' });
    const receipts = await store.listReceipts(f.job);
    await store.close();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.outcome, 'failed');
  } finally {
    await f.core.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
}

test('an identity with a non-positive or non-safe-integer pid is refused', async () => {
  await expectIdentityFailure(appIdentity({ pid: 0 }));
  await expectIdentityFailure(appIdentity({ pid: -1 }));
  await expectIdentityFailure(appIdentity({ pid: 1.5 }));
});

test('an identity with a negative or non-safe-integer session_id is refused', async () => {
  await expectIdentityFailure(appIdentity({ session_id: -1 }));
  await expectIdentityFailure(appIdentity({ session_id: 1.5 }));
});

test('an identity with a non-UTC or non-ISO-8601 created_at is refused', async () => {
  await expectIdentityFailure(appIdentity({ created_at: 'garbage' }));
  await expectIdentityFailure(appIdentity({ created_at: '2026-01-01T00:00:00+05:00' })); // offset, not Z
  await expectIdentityFailure(appIdentity({ created_at: '2026-02-30T00:00:00Z' }));    // not a real calendar instant
});

test('an identity with a non-canonical image_path is refused', async () => {
  await expectIdentityFailure(appIdentity({ image_path: 'app.exe' }));                          // relative
  await expectIdentityFailure(appIdentity({ image_path: 'C:/Program Files/Contoso/app.exe' })); // forward slash
  await expectIdentityFailure(appIdentity({ image_path: '\\\\server\\share\\app.exe' }));       // UNC root
  await expectIdentityFailure(appIdentity({ image_path: 'C:\\PROGRA~1\\app.exe' }));            // 8.3 short name
  await expectIdentityFailure(appIdentity({ image_path: 'C:\\Program Files.\\app.exe' }));      // segment ending in a dot
  await expectIdentityFailure(appIdentity({ image_path: 'C:\\Program Files \\app.exe' }));      // segment ending in a space
});

test('an identity whose signature and signer disagree is refused', async () => {
  await expectIdentityFailure(appIdentity({ signature: 'valid', signer: null }));
  await expectIdentityFailure(appIdentity({ signature: 'valid', signer: '' }));
  await expectIdentityFailure(appIdentity({ signature: 'unsigned', signer: 'Contoso Corp' }));
  await expectIdentityFailure(appIdentity({ signature: 'invalid', signer: 'Contoso Corp' }));
});

test('an identity with a malformed image_sha256 is refused', async () => {
  await expectIdentityFailure(appIdentity({ image_sha256: 'zzz' }));
  await expectIdentityFailure(appIdentity({ image_sha256: 'A'.repeat(64) }));
  await expectIdentityFailure(appIdentity({ image_sha256: 'a'.repeat(63) }));
});

test('an identity with a malformed original_filename is refused (amendment A9)', async () => {
  await expectIdentityFailure(appIdentity({ original_filename: 'dir\\app.exe' }));
  await expectIdentityFailure(appIdentity({ original_filename: 'dir/app.exe' }));
  await expectIdentityFailure(appIdentity({ original_filename: 'x'.repeat(261) }));
});

test('an identity with a null original_filename is accepted (amendment A9)', async (t) => {
  const adapter: Adapter = {
    manifest: fulfillableManifest(),
    resolver: {
      async resolve(): Promise<readonly ResolvedTarget[]> {
        return [appTarget('x', appIdentity({ original_filename: null }))];
      },
    },
    async init() {},
    async invoke(): Promise<ActionResult> { return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} }; },
    async dispose() {},
  };
  const f = await fixture(adapter, { allowed_apps: [{ image_sha256: 'a'.repeat(64) }] });
  t.after(() => finish(f));
  const response = await invoke(f.port, f.job);
  assert.equal(response.body.error, undefined, `invoke failed: ${JSON.stringify(response.body)}`);
});

// ---------------------------------------------------------------------------
// Test 6 — one shared deadline for resolve and invoke (round 2 item 1).
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('resolve and invoke share ONE deadline: 60ms resolve + 60ms invoke exceeds an 80ms ceiling', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const adapter: Adapter = {
    manifest: fulfillableManifest({ default_timeout_ms: 80 }),
    resolver: {
      async resolve(): Promise<readonly ResolvedTarget[]> {
        await sleep(60);
        return [appTarget('x')];
      },
    },
    async init() {},
    async invoke(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<ActionResult> {
      capturedSignal = ctx.signal;
      await sleep(60);
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const f = await fixture(adapter, { allowed_apps: [{ image_sha256: 'a'.repeat(64) }] });
  t.after(() => finish(f));

  const response = await invoke(f.port, f.job);
  assert.equal(response.body.error, ErrorCode.E_TIMEOUT, `expected E_TIMEOUT, got ${JSON.stringify(response.body)}`);
  assert.equal(capturedSignal?.aborted, true, 'the shared resolve/invoke signal was not aborted on the combined deadline');

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  await store.close();
  assert.equal(receipts[0]?.outcome, 'terminated');
  assert.notEqual(receipts[0]?.ended_at, null);
});

// ---------------------------------------------------------------------------
// Test 7 — counts survive an invoke failure, and invoke is still reached when
// every target is denied (round 2 item 3 and item 6).
// ---------------------------------------------------------------------------

test('an invoke that throws after two allowed targets closes the receipt with the counts intact', async (t) => {
  const adapter: Adapter = {
    manifest: fulfillableManifest(),
    resolver: {
      async resolve(): Promise<readonly ResolvedTarget[]> {
        return [
          appTarget('a'),
          appTarget('b'),
          appTarget('c', appIdentity({ image_sha256: 'b'.repeat(64) })), // denied
        ];
      },
    },
    async init() {},
    async invoke(): Promise<ActionResult> {
      throw new Error('boom');
    },
    async dispose() {},
  };
  const f = await fixture(adapter, { allowed_apps: [{ image_sha256: 'a'.repeat(64) }] });
  t.after(() => finish(f));

  const response = await invoke(f.port, f.job);
  assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE, `expected E_ADAPTER_FAILURE, got ${JSON.stringify(response.body)}`);

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  await store.close();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'failed');
  const fields = receipts[0]!.adapter_fields as Record<string, unknown>;
  assert.equal(fields['targets_allowed'], 2);
  assert.equal(fields['targets_denied'], 1);
});

test('invoke is still called when every resolved target is denied', async (t) => {
  let invokeCalled = false;
  const adapter: Adapter = {
    manifest: fulfillableManifest(),
    resolver: {
      async resolve(): Promise<readonly ResolvedTarget[]> {
        return [appTarget('x')];
      },
    },
    async init() {},
    async invoke(): Promise<ActionResult> {
      invokeCalled = true;
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  // No allowed_apps on the envelope → every app target is denied.
  const f = await fixture(adapter, {});
  t.after(() => finish(f));

  const response = await invoke(f.port, f.job);
  assert.equal(response.body.error, undefined, `invoke failed: ${JSON.stringify(response.body)}`);
  assert.equal(invokeCalled, true, 'invoke was skipped when every resolved target was denied');

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  await store.close();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'succeeded');
  const fields = receipts[0]!.adapter_fields as Record<string, unknown>;
  assert.equal(fields['targets_allowed'], 0);
  assert.equal(fields['targets_denied'], 1);
});

// ---------------------------------------------------------------------------
// Test 8 — the CLI send/read settlement path keeps the send receipt's counts
// (round 2 item 3): a later read action must not overwrite the Core-reserved
// keys the send action already recorded.
// ---------------------------------------------------------------------------

test('the CLI send/read path keeps the send receipt counts', async (t) => {
  const manifest: AdapterManifest = {
    id: 'cli', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions: [
      { id: 'start', summary: 'start', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
      { id: 'send', summary: 'send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
      { id: 'read', summary: 'read', input_schema: { type: 'object', properties: { cursor: { type: 'integer' } }, required: ['cursor'], additionalProperties: false }, path_fields: [], mutates: false, always_requires_approval: false },
    ],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 30_000,
    cancellation: 'kill', receipt_fields: ['exchange_state', 'exchange_error', 'bytes_read'],
  };
  const adapter: SessionAdapter = {
    manifest,
    resolver: {
      async resolve(actionId: string): Promise<readonly ResolvedTarget[]> {
        // Only the send action resolves targets (two allowed); read resolves
        // none, so its counts (0/0) must not overwrite the send receipt's 2/0.
        return actionId === 'send' ? [appTarget('a'), appTarget('b')] : [];
      },
    },
    async init() {},
    async invoke(actionId: string): Promise<ActionResult> {
      if (actionId === 'send') return { output: '', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'running', exchange_error: null } };
      return { output: 'done', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'succeeded', exchange_error: null, bytes_read: 0 } };
    },
    async dispose() {},
    async start() { return { pid: -1 }; },
    async send() {},
    async read() { return { chunk: 'done', cursor: 0, exchange_state: 'succeeded', exchange_error: null }; },
    async interrupt() {},
    async stop() {},
  };

  const dir = await mkdtemp(join(tmpdir(), 'toros-f3a-cli-'));
  const path = join(dir, 'node.sqlite');
  const job = '66666666-6666-4666-8666-666666666666';
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'cli counts', allowed_capabilities: ['cli.start', 'cli.send', 'cli.read'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
    allowed_apps: [{ image_sha256: 'a'.repeat(64) }],
  }));
  await store.close();
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
    desktop_session_id: 7,
  });
  const { port } = await core.start();
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });

  const started = await http(port, 'start_cli', { job_id: job, cli_id: 'cli', workspace_id: 'work' });
  const sessionId = String(started.body.receipt_id);
  assert.ok(sessionId.length > 0, `start_cli failed: ${JSON.stringify(started.body)}`);

  const sent = await http(port, 'send_cli', { job_id: job, session_id: sessionId, message: 'go' });
  assert.equal(sent.body.exchange_state, 'running');
  const sendReceiptId = String(sent.body.receipt_id);

  const read = await http(port, 'read_cli', { job_id: job, session_id: sessionId, cursor: 0 });
  assert.equal(read.body.error, undefined, `read_cli failed: ${JSON.stringify(read.body)}`);

  const checkStore = await openStore({ path, nodeId: 'node' });
  const sendReceipt = await checkStore.getReceipt(sendReceiptId);
  await checkStore.close();
  assert.equal(sendReceipt?.outcome, 'succeeded');
  const fields = sendReceipt!.adapter_fields as Record<string, unknown>;
  assert.equal(fields['targets_allowed'], 2, 'the send receipt lost its targets_allowed count to a later read');
  assert.equal(fields['targets_denied'], 0);
});

// ---------------------------------------------------------------------------
// Test 9 — a synchronous resolver throw must not leak an unhandled rejection
// (round 3 item 1). The resolver throws BEFORE `withinTimeout` constructs its
// `Promise.race`, so `deadline` never gets a handler from the race. With the
// failure-persistence write delayed past the action timeout, the deadline timer
// fires mid-catch; without `void deadline.catch(() => {})` its rejection is
// unhandled and would terminate Core under `--unhandled-rejections=throw`.
// ---------------------------------------------------------------------------

test('a resolver that throws synchronously, with a slow failure write, produces no unhandled rejection and clears the deadline timer', async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  // 80 ms is the action's timeout; nothing else in this fixture arms an 80 ms
  // timer, so the handles recorded here are exactly the deadline timers. Capture
  // both the armed handle and the clear to prove the `finally` really cleared it.
  const deadlineTimeoutMs = 80;
  const armedDeadlines = new Set<NodeJS.Timeout>();
  const clearedHandles = new Set<NodeJS.Timeout>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(handler as (...args: never[]) => void, delay, ...args as never[]);
    if (delay === deadlineTimeoutMs) armedDeadlines.add(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: NodeJS.Timeout) => {
    clearedHandles.add(handle);
    realClearTimeout(handle);
  }) as unknown as typeof clearTimeout;
  t.after(() => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; });

  const adapter: Adapter = {
    manifest: fulfillableManifest({ default_timeout_ms: deadlineTimeoutMs }),
    resolver: {
      // NOT `async`: throwing without awaiting is the synchronous throw the
      // round-3 finding is about (an `async` function would return a rejected
      // promise instead, which the race would already have handled).
      resolve(): Promise<readonly ResolvedTarget[]> {
        throw new Error('synchronous resolver boom');
      },
    },
    async init() {},
    async invoke(): Promise<ActionResult> { return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} }; },
    async dispose() {},
  };
  const f = await fixture(adapter, { allowed_apps: [{ image_sha256: 'a'.repeat(64) }] });
  t.after(() => finish(f));

  // Delay the failure-persistence write past the 80 ms deadline, so the timer
  // fires while the catch path awaits the store (the exact window the finding
  // describes: SQLite busy retries yield the event loop).
  const storeObj = (f.core as unknown as { store: { putReceipt: (r: unknown) => Promise<unknown> } }).store;
  const realPutReceipt = storeObj.putReceipt.bind(storeObj);
  storeObj.putReceipt = (r: unknown): Promise<unknown> => {
    if ((r as { readonly outcome?: string }).outcome === 'failed') return sleep(200).then(() => realPutReceipt(r));
    return realPutReceipt(r);
  };

  const response = await invoke(f.port, f.job);
  assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE, `expected E_ADAPTER_FAILURE, got ${JSON.stringify(response.body)}`);

  // Let any stray rejection surface and the (already-cleared) timer's window pass.
  await sleep(150);
  assert.equal(unhandled.length, 0, `unhandled rejections observed: ${unhandled.map(String).join(' | ')}`);

  const checkStore = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await checkStore.listReceipts(f.job);
  await checkStore.close();
  assert.equal(receipts.length, 1, 'a closed receipt was not written');
  assert.equal(receipts[0]?.outcome, 'failed');
  assert.notEqual(receipts[0]?.ended_at, null, 'the receipt was left running');

  assert.ok(armedDeadlines.size >= 1, 'the shared deadline timer was never armed');
  assert.ok(
    [...armedDeadlines].some((handle) => clearedHandles.has(handle)),
    'the deadline timer was not cleared in the finally block',
  );
});