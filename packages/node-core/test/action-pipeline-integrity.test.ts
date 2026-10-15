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
  type NodePlatform,
  type Receipt,
  type SessionAdapter,
} from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';
import { createNodeCore, type NodeCore } from '../src/index.js';

// ---------------------------------------------------------------------------
// AR-F4 acceptance: the action pipeline never spends budget on an action that
// cannot start, closes every `running` receipt, and enforces timeouts itself.
// ---------------------------------------------------------------------------

const token = 'test-token';

interface Fixture {
  readonly core: NodeCore;
  readonly path: string;
  readonly job: string;
  readonly dir: string;
}

async function fixture(adapter: Adapter, overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-core-'));
  const path = join(dir, 'node.sqlite');
  const job = '55555555-5555-4555-8555-555555555555';
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'f4 pipeline integrity', allowed_capabilities: ['mock.run'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 5, max_retries: 0, expires_at: '2999-01-01T00:00:00Z', ...overrides,
  }));
  await store.close();
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
  });
  return { core, path, job, dir };
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

function invoke(port: number, job: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return http(port, 'invoke_app_action', { job_id: job, app_id: 'mock', action_id: 'run', ...extra });
}

function makeManifest(action: Partial<{ timeout_ms: number }> = {}): AdapterManifest {
  return {
    id: 'mock', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions: [{ id: 'run', summary: 'run', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: false, always_requires_approval: false, ...action }],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 30_000,
    cancellation: 'graceful', receipt_fields: [],
  };
}

// ---------------------------------------------------------------------------
// Acceptance 1 — a pathless action without workspace_id: E_WORKSPACE_DENIED,
// no budget spent, one closed failed receipt, action.finished present.
// ---------------------------------------------------------------------------

test('a pathless action without workspace_id never spends budget and closes a failed receipt', async (t) => {
  let invoked = false;
  const adapter: Adapter = {
    manifest: makeManifest(),
    async init() {},
    async invoke(): Promise<ActionResult> {
      invoked = true;
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const p = await f.core.start();

  const response = await invoke(p.port, f.job);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, ErrorCode.E_WORKSPACE_DENIED);
  // The adapter must never run for an action that cannot start.
  assert.equal(invoked, false);

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const job = await store.getJob(f.job);
  const receipts = await store.listReceipts(f.job);
  const events = await store.listEvents(f.job);
  await store.close();

  assert.equal(job?.actions_used, 0, 'budget was spent on an action that could not start');
  assert.equal(receipts.length, 1);
  assert.notEqual(receipts[0]?.ended_at, null, 'the receipt has no ended_at');
  assert.equal(receipts[0]?.outcome, 'failed');
  assert.equal(receipts.some((r) => r.outcome === 'running'), false, 'a running receipt remains');
  assert.deepEqual(events.map((e) => e.kind), ['action.requested', 'action.decided', 'action.finished'],
    'the audit trail is incomplete for a refused action');
  const finished = events.find((e) => e.kind === 'action.finished');
  assert.equal((finished?.payload as Record<string, unknown>).error, ErrorCode.E_WORKSPACE_DENIED);
});

// ---------------------------------------------------------------------------
// Acceptance 2 — a store failure injected after action.started closes the
// receipt as failed and the error propagates.
// ---------------------------------------------------------------------------

test('a store failure after action.started closes the running receipt as failed and propagates', async (t) => {
  let invoked = false;
  const adapter: Adapter = {
    manifest: makeManifest(),
    async init() {},
    async invoke(): Promise<ActionResult> {
      invoked = true;
      // Recording an artifact is pipeline code AFTER the adapter succeeded:
      // putArtifact runs post-start, so a failure there must still close the
      // `running` receipt.
      return { output: 'ok', truncated: false, artifacts: [{ path: join(tmpdir(), 'toros-f4-artifact.txt'), sha256: 'artifact-hash', bytes: 4 }], receipt_extra: {} };
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const p = await f.core.start();

  const storeObj = (f.core as unknown as { store: { putArtifact: (input: unknown) => Promise<unknown> } }).store;
  const realPutArtifact = storeObj.putArtifact.bind(storeObj);
  storeObj.putArtifact = () => Promise.reject(new Error('store failure injected'));
  try {
    const response = await invoke(p.port, f.job, { workspace_id: 'work' });
    assert.equal(invoked, true, 'the adapter never ran');
    assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE, 'the injected store failure did not propagate');
  } finally {
    storeObj.putArtifact = realPutArtifact;
  }

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  const events = await store.listEvents(f.job);
  await store.close();

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'failed', 'the receipt was not closed as failed');
  assert.notEqual(receipts[0]?.ended_at, null);
  assert.equal(receipts.some((r) => r.outcome === 'running'), false, 'a running receipt remains');
  const finished = events.find((e) => e.kind === 'action.finished');
  assert.equal((finished?.payload as Record<string, unknown>).error, ErrorCode.E_ADAPTER_FAILURE);
});

// ---------------------------------------------------------------------------
// Acceptance 3 — an adapter that never resolves is timed out by Core:
// E_TIMEOUT at the declared timeout, receipt `terminated`, the adapter's
// signal observed aborted, and a late resolution cannot rewrite the receipt.
// ---------------------------------------------------------------------------

test('a never-resolving adapter is timed out by Core with a terminated receipt and an aborted signal', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  let release: ((value: ActionResult) => void) | undefined;
  const adapter: Adapter = {
    manifest: makeManifest({ timeout_ms: 80 }),
    async init() {},
    async invoke(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<ActionResult> {
      capturedSignal = ctx.signal;
      return new Promise<ActionResult>((resolve) => { release = resolve; });
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const started = Date.now();
  const p = await f.core.start();

  const response = await invoke(p.port, f.job, { workspace_id: 'work' });
  const elapsed = Date.now() - started;
  assert.equal(response.body.error, ErrorCode.E_TIMEOUT);
  assert.ok(elapsed < 20_000, `the timeout did not fire at the declared timeout (took ${elapsed}ms)`);

  const receiptBefore = await readReceipt(f.path, f.job);
  assert.equal(receiptBefore?.outcome, 'terminated');
  assert.notEqual(receiptBefore?.ended_at, null);
  assert.equal(capturedSignal?.aborted, true, 'the adapter signal was not aborted on timeout');

  // A late adapter result must be ignored: hand it back and confirm the
  // already-closed receipt is untouched.
  release?.({ output: 'late', truncated: false, artifacts: [], receipt_extra: {} });
  await new Promise((r) => setTimeout(r, 100));
  const receiptAfter = await readReceipt(f.path, f.job);
  assert.equal(receiptAfter?.outcome, 'terminated');
  assert.equal(receiptAfter?.ended_at, receiptBefore?.ended_at, 'the late adapter result rewrote the closed receipt');
});

// ---------------------------------------------------------------------------
// Acceptance 4 — an adapter that resolves quickly leaves no timer armed: the
// controller is never aborted even after the timeout window passes, so the
// process has nothing keeping it alive.
// ---------------------------------------------------------------------------

test('a quick adapter leaves no timer armed: the signal is not aborted after the timeout window', async (t) => {
  const abortEvents: boolean[] = [];
  const adapter: Adapter = {
    manifest: makeManifest({ timeout_ms: 300 }),
    async init() {},
    async invoke(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<ActionResult> {
      abortEvents.push(ctx.signal.aborted);
      ctx.signal.addEventListener('abort', () => abortEvents.push(ctx.signal.aborted));
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const p = await f.core.start();

  const response = await invoke(p.port, f.job, { workspace_id: 'work' });
  assert.equal(response.body.error, undefined, `a quick action failed: ${JSON.stringify(response.body)}`);
  assert.equal(abortEvents[0], false);

  // Wait past the timeout window. A leaked timer would have fired, aborted the
  // controller, and left the process alive until then.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(abortEvents.length, 1, 'the controller was aborted after a successful run');
  assert.equal(abortEvents[0], false, 'the adapter signal was aborted on a successful run');
});

async function readReceipt(path: string, job: string): Promise<{ outcome: string; ended_at: string | null } | undefined> {
  const store = await openStore({ path, nodeId: 'node' });
  const receipts = await store.listReceipts(job);
  await store.close();
  const receipt = receipts[0];
  if (receipt === undefined) return undefined;
  return { outcome: receipt.outcome, ended_at: receipt.ended_at };
}

// ---------------------------------------------------------------------------
// Round 2 finding 1 (P1) — the Core timeout must WIN the race even when the
// adapter settles its own pending promise from its abort listener. Abort
// listeners run synchronously, so without deciding the timeout first, an
// adapter that resolves (or rejects) there would replace E_TIMEOUT with its
// own outcome.
// ---------------------------------------------------------------------------

test('an adapter that resolves from its own abort listener is still E_TIMEOUT with a terminated receipt', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const adapter: Adapter = {
    manifest: makeManifest({ timeout_ms: 60 }),
    async init() {},
    async invoke(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<ActionResult> {
      capturedSignal = ctx.signal;
      // The pending action resolves ONLY when the abort listener runs — which
      // queues its fulfillment before the timer can queue its rejection.
      return new Promise<ActionResult>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          resolve({ output: 'won-the-race', truncated: false, artifacts: [], receipt_extra: {} });
        });
      });
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const p = await f.core.start();

  const response = await invoke(p.port, f.job, { workspace_id: 'work' });
  assert.equal(response.body.error, ErrorCode.E_TIMEOUT, 'an abort-listener resolve replaced E_TIMEOUT with a success');

  const receipt = await readReceipt(f.path, f.job);
  assert.equal(receipt?.outcome, 'terminated');
  assert.equal(capturedSignal?.aborted, true, 'the adapter signal was not aborted on timeout');
});

test('an adapter that rejects from its own abort listener is still E_TIMEOUT, not the adapter error', async (t) => {
  const adapter: Adapter = {
    manifest: makeManifest({ timeout_ms: 60 }),
    async init() {},
    async invoke(_actionId: string, _args: Readonly<Record<string, unknown>>, ctx: AdapterContext): Promise<ActionResult> {
      // Rejecting from the abort listener queues the adapter's own error before
      // the timer's rejection — the timeout must still win.
      return new Promise<ActionResult>((_, reject) => {
        ctx.signal.addEventListener('abort', () => {
          reject(new Error('adapter own error'));
        });
      });
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const p = await f.core.start();

  const response = await invoke(p.port, f.job, { workspace_id: 'work' });
  assert.equal(response.body.error, ErrorCode.E_TIMEOUT, 'an abort-listener rejection replaced E_TIMEOUT with its own error');
  assert.notEqual(response.body.error, 'adapter own error');

  const receipt = await readReceipt(f.path, f.job);
  assert.equal(receipt?.outcome, 'terminated');
});

// ---------------------------------------------------------------------------
// Round 2 finding 3 (P2) — the whole post-start sequence lives inside the
// single closing path, INCLUDING the first receipt write. A store failure on
// that write — persisting then rejecting, or rejecting without persisting —
// must still close a receipt (failed) and append action.finished.
// ---------------------------------------------------------------------------

test('a first receipt write that rejects without persisting still closes a failed receipt and propagates', async (t) => {
  let invoked = false;
  const adapter: Adapter = {
    manifest: makeManifest(),
    async init() {},
    async invoke(): Promise<ActionResult> {
      invoked = true;
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const p = await f.core.start();

  const storeObj = (f.core as unknown as { store: { putReceipt: (r: unknown) => Promise<unknown> } }).store;
  const realPutReceipt = storeObj.putReceipt.bind(storeObj);
  let failedWrites = 0;
  try {
    storeObj.putReceipt = (r: unknown): Promise<unknown> => {
      if (failedWrites === 0) { failedWrites += 1; return Promise.reject(new Error('store failure injected')); }
      return realPutReceipt(r);
    };
    const response = await invoke(p.port, f.job, { workspace_id: 'work' });
    assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE, 'the injected first receipt write did not propagate');
    assert.equal(invoked, false, 'the adapter ran although the running receipt could not be written');
  } finally {
    storeObj.putReceipt = realPutReceipt;
  }

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  const events = await store.listEvents(f.job);
  await store.close();

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'failed', 'the receipt was not closed as failed');
  assert.notEqual(receipts[0]?.ended_at, null, 'the failed receipt has no ended_at');
  assert.equal(receipts.some((r) => r.outcome === 'running'), false, 'a running receipt remains');
  const finished = events.find((e) => e.kind === 'action.finished');
  assert.ok(finished !== undefined, 'no action.finished was recorded');
  assert.equal((finished?.payload as Record<string, unknown>).error, ErrorCode.E_ADAPTER_FAILURE);
});

test('a first receipt write that persists then rejects still closes a failed receipt and propagates', async (t) => {
  let invoked = false;
  const adapter: Adapter = {
    manifest: makeManifest(),
    async init() {},
    async invoke(): Promise<ActionResult> {
      invoked = true;
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const f = await fixture(adapter);
  t.after(() => finish(f));
  const p = await f.core.start();

  const storeObj = (f.core as unknown as { store: { putReceipt: (r: unknown) => Promise<unknown> } }).store;
  const realPutReceipt = storeObj.putReceipt.bind(storeObj);
  let failedWrites = 0;
  try {
    storeObj.putReceipt = (r: unknown): Promise<unknown> => {
      if (failedWrites === 0) {
        // The row is persisted and THEN the call fails — the worst case for a
        // closing path, because an unclosed `running` row now exists.
        failedWrites += 1;
        return realPutReceipt(r).then(() => { throw new Error('store failure injected'); });
      }
      return realPutReceipt(r);
    };
    const response = await invoke(p.port, f.job, { workspace_id: 'work' });
    assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE, 'the injected first receipt write did not propagate');
    assert.equal(invoked, false, 'the adapter ran although the running receipt could not be written');
  } finally {
    storeObj.putReceipt = realPutReceipt;
  }

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  const events = await store.listEvents(f.job);
  await store.close();

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'failed', 'the persisted running receipt was not overwritten by a closed failed one');
  assert.notEqual(receipts[0]?.ended_at, null);
  assert.equal(receipts.some((r) => r.outcome === 'running'), false, 'a running receipt remains');
  const finished = events.find((e) => e.kind === 'action.finished');
  assert.ok(finished !== undefined, 'no action.finished was recorded');
  assert.equal((finished?.payload as Record<string, unknown>).error, ErrorCode.E_ADAPTER_FAILURE);
});

// ---------------------------------------------------------------------------
// Round 2 follow-up 1 — restart with an unexpired running send: the
// settlement deadline is re-armed, so the receipt is still closed when the
// deadline passes, without needing another restart.
// ---------------------------------------------------------------------------

test('a restart re-arms the settlement deadline for an unexpired running send and closes it when the deadline passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-rearm-'));
  const path = join(dir, 'node.sqlite');
  const job = '66666666-6666-4666-8666-666666666666';
  const actions = [
    { id: 'start', summary: 'start', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'send', summary: 'send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'read', summary: 'read', input_schema: { type: 'object', properties: { cursor: { type: 'integer' } }, required: ['cursor'], additionalProperties: false }, path_fields: [], mutates: false, always_requires_approval: false },
  ] as const;
  const manifest: AdapterManifest = {
    id: 'rearmcli', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions, required_permissions: [], allowed_resources: [],
    default_timeout_ms: 1000, cancellation: 'kill', receipt_fields: ['exchange_state'],
  };
  const adapter: SessionAdapter = {
    manifest,
    async init() {},
    async invoke(): Promise<ActionResult> {
      return { output: '', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'running' } };
    },
    async dispose() {}, async start() { return { pid: -1 }; }, async send() {},
    async read() { return { chunk: 'done', cursor: 0, exchange_state: 'succeeded', exchange_error: null }; },
    async interrupt() {}, async stop() {},
  };

  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 're-arm settlement deadline',
    allowed_capabilities: ['rearmcli.start', 'rearmcli.send', 'rearmcli.read'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));

  // Seed a running send receipt whose deadline (started_at + timeout_ms +
  // CLI_SETTLE_GRACE_MS) is ~200 ms in the future, so the re-armed timer has a
  // small window to fire during the test. The adapter declares no per-action
  // timeout, so it inherits default_timeout_ms = 1000 from the manifest.
  const timeoutMs = 1000;
  const startedAt = new Date(Date.now() + 200 - timeoutMs - 30_000).toISOString();
  const seeded: Receipt = {
    receipt_id: 'future-deadline-send', job_id: job, node_id: 'node',
    session_id: 'rearm-session', actor: 'coordinator', capability: 'rearmcli.send',
    arguments_normalized: null, arguments_digest: 'future',
    decision: { allow: true, reason: 'Allowed' },
    envelope_digest: (await store.getJob(job))!.envelope_digest,
    started_at: startedAt, ended_at: null, outcome: 'running',
    artifact_refs: [], finding_refs: [], adapter_fields: { exchange_state: 'running' },
  };
  await store.putReceipt(seeded);
  await store.close();

  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
  });
  try {
    await core.start(); // calls reconcileCliSettlements → re-arms the timer

    // Wait past the re-armed deadline so the timer fires.
    await new Promise((r) => setTimeout(r, 500));

    const settled = await openStore({ path, nodeId: 'node' });
    const receipt = await settled.getReceipt('future-deadline-send');
    const finishedEvents = (await settled.listEvents(job)).filter((e) => e.kind === 'action.finished');
    await settled.close();

    assert.notEqual(receipt, null);
    assert.equal(receipt!.outcome, 'terminated', 'the re-armed deadline did not close the receipt');
    assert.notEqual(receipt!.ended_at, null);
    assert.equal((receipt!.adapter_fields as Record<string, unknown>)['exchange_state'], 'unsettled_deadline');
    assert.ok(
      finishedEvents.some((e) => (e.payload as Record<string, unknown>).exchange_state === 'unsettled_deadline'),
      'the deadline close appended no action.finished with exchange_state unsettled_deadline',
    );
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});