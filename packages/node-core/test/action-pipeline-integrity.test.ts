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
import { PRODUCTION_SETTLEMENT_TIMING, type SettlementTimingOptions } from '../src/action-pipeline.js';

/**
 * `pipeline_settlement` is an internal instance-scoped seam: NodeCoreOptions
 * does not declare it (production config can never set it), and a test that
 * needs short settlement timings constructs its OWN Core with it. This alias
 * types that seam without touching the public options interface.
 */
type CoreOptions = Parameters<typeof createNodeCore>[0] & { readonly pipeline_settlement?: SettlementTimingOptions };

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
  // controller, and left the process alive until then. Poll past the timeout
  // instead of a fixed sleep so a slow runner does not assert too early.
  const afterResponse = Date.now();
  await eventually(() => Date.now() > afterResponse + 500, 2_000);
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
// Round 4 helpers — the settlement retries that follow share the same job,
// receipt and timer bookkeeping, so the fixtures are factored out.
// ---------------------------------------------------------------------------

/** The store surface Round 4 fault injection needs, narrowed like the R3 tests. */
interface StoreShim {
  getReceipt: (id: string) => Promise<unknown>;
  putReceipt: (r: unknown) => Promise<unknown>;
  appendEvent: (input: { kind: string; payload: unknown }) => Promise<unknown>;
}
function coreStore(core: NodeCore): StoreShim {
  return (core as unknown as { store: StoreShim }).store;
}

/** The send-only settle manifest the injected-close tests share. */
function sendOnlySettleManifest(): AdapterManifest {
  return {
    id: 'settletest', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions: [
      { id: 'send', summary: 'send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    ],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 1000,
    cancellation: 'kill', receipt_fields: ['exchange_state'],
  };
}

function sendOnlySettleAdapter(): Adapter {
  return {
    manifest: sendOnlySettleManifest(),
    async init() {},
    async invoke(): Promise<ActionResult> {
      return { output: '', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
}

/** Create a job whose allowed set covers only `settletest.send`. */
async function createSettleSendJob(path: string, job: string, objective: string): Promise<void> {
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective, allowed_capabilities: ['settletest.send'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();
}

/** Seed one running `settletest.send` receipt, by default long past its deadline. */
async function seedRunningSend(path: string, job: string, receiptId: string, opts: { readonly session_id: string; readonly started_at?: string }): Promise<void> {
  const store = await openStore({ path, nodeId: 'node' });
  const envelopeDigest = (await store.getJob(job))!.envelope_digest;
  await store.putReceipt({
    receipt_id: receiptId, job_id: job, node_id: 'node', session_id: opts.session_id,
    actor: 'coordinator', capability: 'settletest.send',
    arguments_normalized: null, arguments_digest: receiptId,
    decision: { allow: true, reason: 'Allowed' }, envelope_digest: envelopeDigest,
    started_at: opts.started_at ?? new Date(Date.now() - 120_000).toISOString(),
    ended_at: null, outcome: 'running', artifact_refs: [], finding_refs: [],
    adapter_fields: { exchange_state: 'running' },
  } satisfies Receipt);
  await store.close();
}

/** Watch process-wide unhandled rejections for the duration of a test. */
function collectUnhandledRejections(t: { after(fn: () => void): void }): { readonly list: unknown[] } {
  const list: unknown[] = [];
  const handler = (reason: unknown): void => { list.push(reason); };
  process.on('unhandledRejection', handler);
  t.after(() => process.removeListener('unhandledRejection', handler));
  return { list };
}

/**
 * Construct a Core through the NodeCoreOptions-typed factory. `CoreOptions`
 * widens the public options with the instance-scoped `pipeline_settlement`
 * seam, so passing it through this helper avoids an excess-property error
 * while keeping the seam off the public options type.
 */
function createTestCore(options: CoreOptions): NodeCore {
  return createNodeCore(options);
}

/**
 * Poll `probe` until it returns true or `timeoutMs` elapses. The settlement
 * close runs fire-and-forget (the deadline timer and reconciliation both
 * `void` it), so a test must poll rather than assume the attempt has landed by
 * the time an awaited call returns.
 */
async function eventually(probe: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function receiptOutcome(path: string, receiptId: string): Promise<string | null> {
  const store = await openStore({ path, nodeId: 'node' });
  const receipt = await store.getReceipt(receiptId);
  await store.close();
  return receipt?.outcome ?? null;
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

  // Seed a running send receipt whose deadline (started_at + timeout_ms + the
  // production 30 s settle grace) is ~200 ms in the future, so the re-armed
  // timer has a small window to fire during the test. The adapter declares no
  // per-action timeout, so it inherits default_timeout_ms = 1000 from the
  // manifest.
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

    // Wait past the re-armed deadline so the timer fires. Poll instead of a
    // fixed sleep.
    await eventually(async () => {
      const s = await openStore({ path, nodeId: 'node' });
      const r = await s.getReceipt('future-deadline-send');
      await s.close();
      return r !== null && r.outcome === 'terminated';
    }, 5_000);

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

// ---------------------------------------------------------------------------
// Round 3 test 1 — one-shot putReceipt failure in read_cli settlement: the
// deadline timer stays armed after a failed settleCliExchange write, and the
// send receipt is still closed by its deadline without another read or restart.
// ---------------------------------------------------------------------------

const settleSessionManifest: AdapterManifest = {
  id: 'settletest', version: '1.0.0', platforms: [process.platform as NodePlatform],
  actions: [
    { id: 'start', summary: 'start', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'send', summary: 'send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'read', summary: 'read', input_schema: { type: 'object', properties: { cursor: { type: 'integer' } }, required: ['cursor'], additionalProperties: false }, path_fields: [], mutates: false, always_requires_approval: false },
  ] as const,
  required_permissions: [], allowed_resources: [], default_timeout_ms: 80,
  // `bytes_read` is part of the read result (read_cli returns it), so it must
  // be declared: declaredAdapterFields rejects any receipt_extra key the
  // manifest does not list (Round 4 item 3).
  cancellation: 'kill', receipt_fields: ['exchange_state', 'exchange_error', 'bytes_read'],
};

test('Round3: a failed putReceipt in read_cli settlement keeps the deadline timer armed and the receipt still closes', async (t) => {
  // Instance-scoped settlement timing. Grace is at least 5 s so the deadline
  // cannot race past the send → read → assertion steps on a slow CI runner.
  // The retry schedule is short so the bounded retry after a recovery still
  // fits in the test window.
const settleTiming: SettlementTimingOptions = {
    // Grace is at least 5 s so the deadline cannot race past the send → read →
    // assertion steps on a slow CI runner (Codex Round 7 finding 1).
    cli_settle_grace_ms: 5000,
    settle_retry_delays: [100, 500, 2000],
    settle_retry_max_delay: 5000,
  };

  const adapter: SessionAdapter = {
    manifest: settleSessionManifest,
    async init() {},
    async invoke(actionId: string): Promise<ActionResult> {
      if (actionId === 'send') {
        return { output: '', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'running', exchange_error: null } };
      }
      return { output: 'done', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'succeeded', exchange_error: null, bytes_read: 0 } };
    },
    async dispose() {},
    async start() { return { pid: -1 }; },
    async send() {},
    async read() { return { chunk: 'done', cursor: 0, exchange_state: 'succeeded', exchange_error: null }; },
    async interrupt() {},
    async stop() {},
  };

  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r3-1-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000001-0000-4000-8000-000000000001';
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'r3 settle write failure',
    allowed_capabilities: ['settletest.start', 'settletest.send', 'settletest.read'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  const coreOptions: CoreOptions = {
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  };
  const core = createNodeCore(coreOptions);
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });

  const { port } = await core.start();

  // start_cli → session
  const started = await http(port, 'start_cli', { job_id: job, cli_id: 'settletest', workspace_id: 'work' });
  const sessionId = String(started.body.receipt_id);
  assert.ok(sessionId.length > 0, `start_cli failed: ${JSON.stringify(started.body)}`);

  // send_cli → running, timer armed with short deadline (~timeout 80 + grace 200 = 280 ms)
  const sent = await http(port, 'send_cli', { job_id: job, session_id: sessionId, message: 'go' });
  assert.equal(sent.body.exchange_state, 'running');
  const sendReceiptId = String(sent.body.receipt_id);

  // Read back the send receipt to capture started_at before any settlement.
  const beforeStore = await openStore({ path, nodeId: 'node' });
  const beforeSend = await beforeStore.getReceipt(sendReceiptId);
  await beforeStore.close();
  assert.equal(beforeSend?.outcome, 'running');

  // Inject one-shot putReceipt failure to make settleCliExchange's write fail.
  const storeObj = (core as unknown as { store: { putReceipt: (r: unknown) => Promise<unknown> } }).store;
  const realPutReceipt = storeObj.putReceipt.bind(storeObj);
  let putFailed = false;
  storeObj.putReceipt = (r: unknown): Promise<unknown> => {
    const rObj = r as Record<string, unknown>;
    // Only fail the write of a terminal receipt (one with ended_at set) during
    // settleCliExchange — NOT the send_cli's running receipt earlier.
    if (!putFailed && rObj.receipt_id === sendReceiptId && rObj.ended_at !== null) {
      putFailed = true;
      return Promise.reject(new Error('one-shot settle receipt write failure'));
    }
    return realPutReceipt(r);
  };

  // read_cli returns 'succeeded', triggering settleCliExchange. The putReceipt
  // above fails once, so the deadline timer is NOT cleared.
  const readResult = await http(port, 'read_cli', { job_id: job, session_id: sessionId, cursor: 0 });
  // Round 4 item 3: the one-shot write failure must ACTUALLY fire during the
  // settlement (with `bytes_read` declared, settleCliExchange is reached at
  // all) and surface as the adapter failure the pipeline maps it to.
  assert.equal(putFailed, true, 'the injected settle receipt write failure never fired');
  assert.equal(readResult.body.error, ErrorCode.E_ADAPTER_FAILURE,
    `read_cli did not surface the injected write failure: ${JSON.stringify(readResult.body)}`);

  // After the failed settle the send receipt must still be running — the timer
  // was not cleared.
  const duringStore = await openStore({ path, nodeId: 'node' });
  const duringSend = await duringStore.getReceipt(sendReceiptId);
  await duringStore.close();
  assert.equal(duringSend?.outcome, 'running',
    'the send receipt was closed despite the settle write failing');
  // Restore putReceipt — storage has recovered.
  storeObj.putReceipt = realPutReceipt;

  // Wait for the deadline timer to fire (~5 s from send_cli start). Poll
  // every 25 ms up to 15 s instead of a fixed sleep — a slow CI runner may
  // need the full window, while a fast one completes early.
  await eventually(async () => (await receiptOutcome(path, sendReceiptId)) === 'terminated', 15_000);

  const afterStore = await openStore({ path, nodeId: 'node' });
  const afterSend = await afterStore.getReceipt(sendReceiptId);
  const finishedEvents = (await afterStore.listEvents(job)).filter((e) => e.kind === 'action.finished');
  await afterStore.close();

  assert.equal(afterSend?.outcome, 'terminated',
    'the send receipt was not closed by the deadline after the failed settle');
  assert.notEqual(afterSend?.ended_at, null);
  assert.equal((afterSend?.adapter_fields as Record<string, unknown>)['exchange_state'], 'unsettled_deadline');
  assert.ok(
    finishedEvents.some((e) => (e.payload as Record<string, unknown>).exchange_state === 'unsettled_deadline'),
    'no action.finished with unsettled_deadline was recorded after the deadline fired',
  );
});

// ---------------------------------------------------------------------------
// Round 3 test 2 — one-shot failure in the deadline closure: closeUnsettledCliReceipt
// fails, retries on the bounded schedule, and closes on retry.
// ---------------------------------------------------------------------------

test('Round3: a failed putReceipt in the deadline closure retries and closes on the next attempt', async (t) => {
  // Instance-scoped retry schedule. The first retry is at least 5 s so a slow
  // CI runner can assert the intermediate `running` state before the retry
  // fires (Codex Round 7 finding 1).
  const settleTiming: SettlementTimingOptions = {
    settle_retry_delays: [5000, 10000, 20000],
    settle_retry_max_delay: 30000,
  };

  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r3-2-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000002-0000-4000-8000-000000000002';

  // Create the job in the DB BEFORE starting the core, but do NOT seed the
  // running receipt yet — core.start() calls reconcileCliSettlements which
  // would close it before we can inject the failure.
  const preStore = await openStore({ path, nodeId: 'node' });
  await preStore.createJob(sealEnvelope({
    job_id: job, objective: 'r3 deadline closure retry',
    allowed_capabilities: ['settletest.send'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await preStore.close();

  const manifest: AdapterManifest = {
    id: 'settletest', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions: [
      { id: 'send', summary: 'send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    ],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 1000,
    cancellation: 'kill', receipt_fields: ['exchange_state'],
  };
  const adapter: Adapter = {
    manifest,
    async init() {},
    async invoke(): Promise<ActionResult> {
      return { output: '', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };

  const coreOptions: CoreOptions = {
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  };
  const core = createNodeCore(coreOptions);
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await core.start();

  // Now seed a running send receipt whose deadline has already passed. Do this
  // AFTER start() so the built-in reconcile at startup does not see it.
  const sendReceiptId = 'r3-retry-send';
  const seedStore = await openStore({ path, nodeId: 'node' });
  const envelopeDigest = (await seedStore.getJob(job))!.envelope_digest;
  const seeded: Receipt = {
    receipt_id: sendReceiptId, job_id: job, node_id: 'node',
    session_id: 'r3-retry-session', actor: 'coordinator',
    capability: 'settletest.send',
    arguments_normalized: null, arguments_digest: 'r3-retry',
    decision: { allow: true, reason: 'Allowed' },
    envelope_digest: envelopeDigest,
    started_at: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
    ended_at: null, outcome: 'running',
    artifact_refs: [], finding_refs: [],
    adapter_fields: { exchange_state: 'running' },
  };
  await seedStore.putReceipt(seeded);
  await seedStore.close();

  // Inject one-shot putReceipt failure for the closure write.
  const storeObj = (core as unknown as { store: { putReceipt: (r: unknown) => Promise<unknown> } }).store;
  const realPutReceipt = storeObj.putReceipt.bind(storeObj);
  let didFail = false;
  storeObj.putReceipt = (r: unknown): Promise<unknown> => {
    const rObj = r as Record<string, unknown>;
    if (!didFail && rObj.receipt_id === sendReceiptId && rObj.ended_at !== null) {
      didFail = true;
      return Promise.reject(new Error('one-shot deadline closure write failure'));
    }
    return realPutReceipt(r);
  };

  // Trigger reconciliation — closeUnsettledCliReceipt fires for the seeded
  // receipt, fails once, and schedules a retry.
  const pipeline = (core as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipeline.reconcileCliSettlements();
  await eventually(() => didFail, 2_000);
  assert.equal(didFail, true, 'the injected closure write failure never fired');

  // The receipt must still be running after the failed attempt.
  const duringStore = await openStore({ path, nodeId: 'node' });
  const during = await duringStore.getReceipt(sendReceiptId);
  await duringStore.close();
  assert.equal(during?.outcome, 'running',
    'the receipt was closed despite the injected write failure');

  // Restore putReceipt — storage recovers.
  storeObj.putReceipt = realPutReceipt;

  // Wait for the retry (5000 ms delay + margin). Poll instead of a fixed sleep.
  await eventually(async () => (await receiptOutcome(path, sendReceiptId)) === 'terminated', 25_000);

  const afterStore = await openStore({ path, nodeId: 'node' });
  const after = await afterStore.getReceipt(sendReceiptId);
  const finishedEvents = (await afterStore.listEvents(job)).filter((e) => e.kind === 'action.finished');
  await afterStore.close();

  assert.equal(after?.outcome, 'terminated',
    'the receipt was not closed by the retry after the deadline closure write failed');
  assert.notEqual(after?.ended_at, null);
  assert.ok(
    finishedEvents.some((e) => (e.payload as Record<string, unknown>).exchange_state === 'unsettled_deadline'),
    'no action.finished with unsettled_deadline was recorded after the retry',
  );
  // Only one action.finished must exist (the retry wrote it once).
  assert.equal(finishedEvents.length, 1,
    'more than one action.finished was recorded for a single receipt');
});

// ---------------------------------------------------------------------------
// Round 3 test 3 — reconciliation with one failing receipt: the others finish
// immediately, and the failing one closes on retry.
// ---------------------------------------------------------------------------

test('Round3: reconciliation closes multiple receipts even when one write fails; the failing one retries and eventually closes', async (t) => {
  // Instance-scoped retry schedule. First retry at least 5 s so the
  // intermediate `running` assertion holds before the retry fires.
  const settleTiming: SettlementTimingOptions = {
    settle_retry_delays: [5000, 10000, 20000],
    settle_retry_max_delay: 30000,
  };

  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r3-3-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000003-0000-4000-8000-000000000003';

  // Create the job BEFORE start, but do NOT seed the receipts yet.
  const preStore = await openStore({ path, nodeId: 'node' });
  await preStore.createJob(sealEnvelope({
    job_id: job, objective: 'r3 reconciliation partial failure',
    allowed_capabilities: ['settletest.send'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await preStore.close();

  const manifest: AdapterManifest = {
    id: 'settletest', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions: [
      { id: 'send', summary: 'send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    ],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 1000,
    cancellation: 'kill', receipt_fields: ['exchange_state'],
  };
  const adapter: Adapter = {
    manifest,
    async init() {},
    async invoke(): Promise<ActionResult> {
      return { output: '', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };

  const coreOptions: CoreOptions = {
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  };
  const core = createNodeCore(coreOptions);
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await core.start();

  // Seed three running send receipts with expired deadlines AFTER start, so
  // the built-in startup reconcile does not close them before we inject.
  const goodId1 = 'r3-rec-good-1';
  const goodId2 = 'r3-rec-good-2';
  const failId = 'r3-rec-fail';

  const seedStore = await openStore({ path, nodeId: 'node' });
  const envelopeDigest = (await seedStore.getJob(job))!.envelope_digest;
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  await seedStore.putReceipt({
    receipt_id: goodId1, job_id: job, node_id: 'node',
    session_id: 'r3-rec-session', actor: 'coordinator',
    capability: 'settletest.send',
    arguments_normalized: null, arguments_digest: 'r3-good-1',
    decision: { allow: true, reason: 'Allowed' },
    envelope_digest: envelopeDigest,
    started_at: startedAt,
    ended_at: null, outcome: 'running',
    artifact_refs: [], finding_refs: [],
    adapter_fields: { exchange_state: 'running' },
  } satisfies Receipt);
  await seedStore.putReceipt({
    receipt_id: goodId2, job_id: job, node_id: 'node',
    session_id: 'r3-rec-session-2', actor: 'coordinator',
    capability: 'settletest.send',
    arguments_normalized: null, arguments_digest: 'r3-good-2',
    decision: { allow: true, reason: 'Allowed' },
    envelope_digest: envelopeDigest,
    started_at: startedAt,
    ended_at: null, outcome: 'running',
    artifact_refs: [], finding_refs: [],
    adapter_fields: { exchange_state: 'running' },
  } satisfies Receipt);
  await seedStore.putReceipt({
    receipt_id: failId, job_id: job, node_id: 'node',
    session_id: 'r3-rec-session', actor: 'coordinator',
    capability: 'settletest.send',
    arguments_normalized: null, arguments_digest: 'r3-fail',
    decision: { allow: true, reason: 'Allowed' },
    envelope_digest: envelopeDigest,
    started_at: startedAt,
    ended_at: null, outcome: 'running',
    artifact_refs: [], finding_refs: [],
    adapter_fields: { exchange_state: 'running' },
  } satisfies Receipt);
  await seedStore.close();

  // Inject putReceipt to fail only for the specifically failing receipt.
  const storeObj = (core as unknown as { store: { putReceipt: (r: unknown) => Promise<unknown> } }).store;
  const realPutReceipt = storeObj.putReceipt.bind(storeObj);
  let failWritten = false;
  storeObj.putReceipt = (r: unknown): Promise<unknown> => {
    const rObj = r as Record<string, unknown>;
    if (!failWritten && rObj.receipt_id === failId && rObj.ended_at !== null) {
      failWritten = true;
      return Promise.reject(new Error('one-shot failure for the failing receipt'));
    }
    return realPutReceipt(r);
  };

  // Trigger reconciliation.
  const pipeline = (core as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipeline.reconcileCliSettlements();
  await eventually(() => failWritten, 2_000);
  assert.equal(failWritten, true, 'the injected failing-receipt write never fired');

  // The two good receipts must be closed immediately; the failing one is still running.
  const duringStore = await openStore({ path, nodeId: 'node' });
  const good1 = await duringStore.getReceipt(goodId1);
  const good2 = await duringStore.getReceipt(goodId2);
  const failDuring = await duringStore.getReceipt(failId);
  await duringStore.close();

  assert.equal(good1?.outcome, 'terminated', 'good receipt 1 was not closed by reconciliation');
  assert.notEqual(good1?.ended_at, null);
  assert.equal(good2?.outcome, 'terminated', 'good receipt 2 was not closed by reconciliation');
  assert.notEqual(good2?.ended_at, null);
  assert.equal(failDuring?.outcome, 'running',
    'the failing receipt was closed despite the injected write failure');

  // Restore putReceipt.
  storeObj.putReceipt = realPutReceipt;

  // Wait for the retry (5000 ms + margin). Poll instead of a fixed sleep.
  await eventually(async () => (await receiptOutcome(path, failId)) === 'terminated', 25_000);

  const afterStore = await openStore({ path, nodeId: 'node' });
  const failAfter = await afterStore.getReceipt(failId);
  const finishedEvents = (await afterStore.listEvents(job)).filter((e) => e.kind === 'action.finished');
  await afterStore.close();

  assert.equal(failAfter?.outcome, 'terminated',
    'the failing receipt was not closed on retry');
  assert.notEqual(failAfter?.ended_at, null);
  assert.equal(finishedEvents.length, 3,
    `expected 3 action.finished events, got ${finishedEvents.length} — reconciliation did not process all receipts`);
});

// ---------------------------------------------------------------------------
// Round 4 finding 1 (P2) — the WHOLE closure attempt is caught, including
// `store.getReceipt`. A one-shot getReceipt rejection must land on the bounded
// retry schedule for every caller (deadline timer, retry, reconciliation) — not
// on an unhandled rejection with the deadline entry already deleted.
// ---------------------------------------------------------------------------

test('Round4: a one-shot getReceipt rejection from reconciliation is caught, retried, and the receipt closes (no unhandled rejection)', async (t) => {
  const settleTiming: SettlementTimingOptions = { settle_retry_delays: [100, 500, 2000], settle_retry_max_delay: 5000 };
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r4-1-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000004-0000-4000-8000-000000000001';

  // Create the job BEFORE start, seed the running send AFTER start so the
  // startup reconcile does not see it.
  await createSettleSendJob(path, job, 'r4 getReceipt rejection on reconciliation');
  const core = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [sendOnlySettleAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await core.start();

  const sendReceiptId = 'r4-get-rejection-send';
  await seedRunningSend(path, job, sendReceiptId, { session_id: 'r4-session' });

  const unhandled = collectUnhandledRejections(t);

  // Reject the receipt read exactly once, then let storage recover.
  const storeObj = coreStore(core);
  const realGetReceipt = storeObj.getReceipt.bind(storeObj);
  let getFailed = false;
  storeObj.getReceipt = (id: string): Promise<unknown> => {
    if (id === sendReceiptId && !getFailed) {
      getFailed = true;
      return Promise.reject(new Error('one-shot getReceipt failure'));
    }
    return realGetReceipt(id);
  };

  const pipeline = (core as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipeline.reconcileCliSettlements();
  assert.equal(getFailed, true, 'the injected getReceipt failure never fired');
  // The first attempt failed on the read, so the receipt is untouched until
  // the bounded retry (100 ms) closes it. Poll rather than assume: the close
  // runs fire-and-forget.
  await eventually(async () => (await receiptOutcome(path, sendReceiptId)) === 'terminated');

  const afterStore = await openStore({ path, nodeId: 'node' });
  const after = await afterStore.getReceipt(sendReceiptId);
  const finishedEvents = (await afterStore.listEvents(job)).filter((e) => e.kind === 'action.finished');
  await afterStore.close();

  assert.notEqual(after?.ended_at, null);
  assert.equal((after?.adapter_fields as Record<string, unknown>)['exchange_state'], 'unsettled_deadline');
  assert.equal(finishedEvents.length, 1, 'more than one action.finished was recorded');
  // Let a (buggy) late rejection surface before the listener is removed.
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(unhandled.list, [], 'an unhandled rejection escaped the settlement close');
});

test('Round4: a one-shot getReceipt rejection on a retry attempt is caught and the receipt still closes (no unhandled rejection)', async (t) => {
  const settleTiming: SettlementTimingOptions = { settle_retry_delays: [100, 500, 2000], settle_retry_max_delay: 5000 };
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r4-2-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000004-0000-4000-8000-000000000002';

  await createSettleSendJob(path, job, 'r4 getReceipt rejection on the retry attempt');
  const core = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [sendOnlySettleAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await core.start();

  const sendReceiptId = 'r4-get-rejection-retry-send';
  await seedRunningSend(path, job, sendReceiptId, { session_id: 'r4-session' });

  const unhandled = collectUnhandledRejections(t);

  // Attempt 1 fails its terminal write (forcing a retry); attempt 2's read
  // then fails once; attempt 3 succeeds and closes the receipt.
  const storeObj = coreStore(core);
  const realGetReceipt = storeObj.getReceipt.bind(storeObj);
  const realPutReceipt = storeObj.putReceipt.bind(storeObj);
  let putFailed = false;
  let getFailedOnRetry = false;
  storeObj.putReceipt = (r: unknown): Promise<unknown> => {
    const rObj = r as Record<string, unknown>;
    if (!putFailed && rObj.receipt_id === sendReceiptId && rObj.ended_at !== null) {
      putFailed = true;
      return Promise.reject(new Error('one-shot deadline closure write failure'));
    }
    return realPutReceipt(r);
  };
  storeObj.getReceipt = (id: string): Promise<unknown> => {
    if (id === sendReceiptId && putFailed && !getFailedOnRetry) {
      getFailedOnRetry = true;
      return Promise.reject(new Error('one-shot getReceipt failure on the retry attempt'));
    }
    return realGetReceipt(id);
  };

  const pipeline = (core as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipeline.reconcileCliSettlements();
  // Attempt 1 fails its terminal write (putFailed) and schedules the first
  // retry; attempt 2 (100 ms later) fails its read (getFailedOnRetry) and
  // schedules attempt 3 (500 ms later), which closes the receipt. All three
  // runs are fire-and-forget, so poll for both flags and the final state.
  await eventually(() => putFailed && getFailedOnRetry, 2_000);
  await eventually(async () => (await receiptOutcome(path, sendReceiptId)) === 'terminated');
  assert.equal(putFailed, true, 'the injected closure write failure never fired');
  assert.equal(getFailedOnRetry, true, 'the injected retry getReceipt failure never fired');

  const afterStore = await openStore({ path, nodeId: 'node' });
  const after = await afterStore.getReceipt(sendReceiptId);
  const finishedEvents = (await afterStore.listEvents(job)).filter((e) => e.kind === 'action.finished');
  await afterStore.close();

  assert.notEqual(after?.ended_at, null);
  assert.equal(finishedEvents.length, 1, 'more than one action.finished was recorded');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(unhandled.list, [], 'an unhandled rejection escaped the settlement close');
});

test('Round4: a one-shot getReceipt rejection on the deadline timer path is caught and the receipt closes (no unhandled rejection)', async (t) => {
  // Short grace so the re-armed deadline fires within the test window while
  // the retry schedule stays short too.
  const settleTiming: SettlementTimingOptions = {
    cli_settle_grace_ms: 200,
    settle_retry_delays: [100, 500, 2000],
    settle_retry_max_delay: 5000,
  };
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r4-3-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000004-0000-4000-8000-000000000003';

  await createSettleSendJob(path, job, 'r4 getReceipt rejection on the deadline');
  const core = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [sendOnlySettleAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await core.start();

  // Seed a running send whose deadline (started_at + timeout 1000 + grace 200)
  // is ~5 s in the future; reconciliation re-arms its timer.
  const sendReceiptId = 'r4-deadline-get-rejection-send';
  const timeoutMs = 1000;
  const startedAt = new Date(Date.now() + 5000 - timeoutMs - 200).toISOString();
  await seedRunningSend(path, job, sendReceiptId, { session_id: 'r4-session', started_at: startedAt });

  const unhandled = collectUnhandledRejections(t);

  const storeObj = coreStore(core);
  const realGetReceipt = storeObj.getReceipt.bind(storeObj);
  let getFailed = false;
  storeObj.getReceipt = (id: string): Promise<unknown> => {
    if (id === sendReceiptId && !getFailed) {
      getFailed = true;
      return Promise.reject(new Error('one-shot getReceipt failure on the deadline'));
    }
    return realGetReceipt(id);
  };

  // Reconciliation re-arms the (not yet expired) deadline timer. The read
  // failure then fires when that timer closes the receipt.
  const pipeline = (core as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipeline.reconcileCliSettlements();
  assert.equal(getFailed, false, 'the getReceipt failure fired before the deadline');

  // Deadline fires at ~5 s; the retry lands 100 ms later. Poll instead of
  // a fixed sleep.
  await eventually(async () => (await receiptOutcome(path, sendReceiptId)) === 'terminated', 15_000);

  const store = await openStore({ path, nodeId: 'node' });
  const after = await store.getReceipt(sendReceiptId);
  const finishedEvents = (await store.listEvents(job)).filter((e) => e.kind === 'action.finished');
  await store.close();

  assert.equal(getFailed, true, 'the injected getReceipt failure never fired on the deadline');
  assert.equal(after?.outcome, 'terminated', 'the receipt was not closed after the deadline');
  assert.equal((after?.adapter_fields as Record<string, unknown>)['exchange_state'], 'unsettled_deadline');
  assert.equal(finishedEvents.length, 1, 'more than one action.finished was recorded');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(unhandled.list, [], 'an unhandled rejection escaped the deadline close');
});

// ---------------------------------------------------------------------------
// Round 4 finding 2 (P2) — a failed `action.finished` append after a
// successful terminal write is recovered. The retry checks BOTH durable
// steps: receipt still running → write then append; closed without the event →
// append only; both present → stop. Never a duplicate.
// ---------------------------------------------------------------------------

test('Round4: a one-shot action.finished append failure after a successful terminal write is recovered exactly once', async (t) => {
  const settleTiming: SettlementTimingOptions = { settle_retry_delays: [100, 500, 2000], settle_retry_max_delay: 5000 };
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r4-4-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000004-0000-4000-8000-000000000004';

  await createSettleSendJob(path, job, 'r4 finished-event append recovery');
  const core = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [sendOnlySettleAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await core.start();

  const sendReceiptId = 'r4-append-recovery-send';
  await seedRunningSend(path, job, sendReceiptId, { session_id: 'r4-session' });

  const unhandled = collectUnhandledRejections(t);

  // The terminal write succeeds; only the finished-event append fails once.
  const storeObj = coreStore(core);
  const realAppendEvent = storeObj.appendEvent.bind(storeObj);
  let appendFailed = false;
  storeObj.appendEvent = (input: { kind: string; payload: unknown }): Promise<unknown> => {
    const payload = input.payload as Record<string, unknown>;
    if (!appendFailed && input.kind === 'action.finished' && payload.receipt_id === sendReceiptId) {
      appendFailed = true;
      return Promise.reject(new Error('one-shot action.finished append failure'));
    }
    return realAppendEvent(input);
  };

  const pipeline = (core as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipeline.reconcileCliSettlements();
  // Attempt 1's terminal write lands and its event append fails; the retry
  // (100 ms, fire-and-forget) recovers the event. Poll for the fault, then for
  // the recovered event.
  await eventually(() => appendFailed, 2_000);
  await eventually(async () => {
    const store = await openStore({ path, nodeId: 'node' });
    const events = (await store.listEvents(job)).filter(
      (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
    );
    await store.close();
    return events.length >= 1;
  });
  assert.equal(appendFailed, true, 'the injected append failure never fired');

  // The retry (100 ms) recovers the event: the receipt is closed by then, so
  // the event is appended only — the receipt is never rewritten.
  await new Promise((r) => setTimeout(r, 150));

  const store = await openStore({ path, nodeId: 'node' });
  const after = await store.getReceipt(sendReceiptId);
  const finishedEvents = (await store.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await store.close();

  assert.equal(after?.outcome, 'terminated');
  assert.equal((after?.adapter_fields as Record<string, unknown>)['exchange_state'], 'unsettled_deadline');
  assert.equal(finishedEvents.length, 1, 'the finished event was not recovered exactly once');
  assert.equal((finishedEvents[0]?.payload as Record<string, unknown>).exchange_state, 'unsettled_deadline');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(unhandled.list, [], 'an unhandled rejection escaped the append recovery');
});

test('Round4: an action.finished append that persists then rejects is never duplicated by the retry', async (t) => {
  const settleTiming: SettlementTimingOptions = { settle_retry_delays: [100, 500, 2000], settle_retry_max_delay: 5000 };
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r4-4b-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000004-0000-4000-8000-000000000044';

  await createSettleSendJob(path, job, 'r4 finished-event no-duplicate recovery');
  const core = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [sendOnlySettleAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await core.start();

  const sendReceiptId = 'r4-append-persists-then-rejects-send';
  await seedRunningSend(path, job, sendReceiptId, { session_id: 'r4-session' });

  const storeObj = coreStore(core);
  const realGetReceipt = storeObj.getReceipt.bind(storeObj);
  const realAppendEvent = storeObj.appendEvent.bind(storeObj);
  let appendFailed = false;
  // Count how many times getReceipt is called for this receipt AFTER the
  // injected append failure. The retry in closeUnsettledCliReceipt calls
  // getReceipt once; waiting until this counter reaches 1 proves the retry
  // re-entered the closure code and performed its event-presence check.
  let postAppendGetReceiptCalls = 0;

  storeObj.appendEvent = (input: { kind: string; payload: unknown }): Promise<unknown> => {
    const payload = input.payload as Record<string, unknown>;
    if (!appendFailed && input.kind === 'action.finished' && payload.receipt_id === sendReceiptId) {
      appendFailed = true;
      // The row is persisted and THEN the call rejects — the hard case: a
      // retry that checks "event present?" must find it and stop.
      return realAppendEvent(input).then(() => { throw new Error('one-shot append failure after persisting'); });
    }
    return realAppendEvent(input);
  };

  // Instrument getReceipt to detect when the retry re-enters the closure code.
  storeObj.getReceipt = (id: string): Promise<unknown> => {
    if (id === sendReceiptId && appendFailed) {
      postAppendGetReceiptCalls++;
    }
    return realGetReceipt(id);
  };

  const pipeline = (core as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipeline.reconcileCliSettlements();
  await eventually(() => appendFailed, 2_000);
  assert.equal(appendFailed, true, 'the injected append failure never fired');

  // Wait for the retry to actually re-enter closeUnsettledCliReceipt. The
  // retry's getReceipt call increments postAppendGetReceiptCalls. Waiting
  // for this proves the retry ran; without it the event-has-existed check
  // might never have executed.
  await eventually(() => postAppendGetReceiptCalls >= 1, 5_000);
  assert.ok(postAppendGetReceiptCalls >= 1, 'the retry never re-entered closeUnsettledCliReceipt');

  // Now assert that the event was never duplicated: exactly one
  // action.finished exists, and the receipt is unchanged.
  const store = await openStore({ path, nodeId: 'node' });
  const receipt = await store.getReceipt(sendReceiptId);
  const finishedEvents = (await store.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await store.close();

  assert.equal(finishedEvents.length, 1, 'the persisted event was duplicated by the retry');
  assert.notEqual(receipt, null);
  assert.equal(receipt!.outcome, 'terminated', 'the receipt outcome changed after the retry');
  assert.notEqual(receipt!.ended_at, null);
});

// ---------------------------------------------------------------------------
// Round 4 finding 2 (read_cli settlement) — the settlement deadline is cleared
// only after the terminal receipt AND its finished event are durable. A failed
// event append leaves the timer armed; the deadline recovers the missing event
// without rewriting the closed receipt.
// ---------------------------------------------------------------------------

test('Round4: a one-shot finished-event append failure in read_cli settlement is recovered by the deadline without rewriting the receipt', async (t) => {
  const settleTiming: SettlementTimingOptions = {
    cli_settle_grace_ms: 5000,
    settle_retry_delays: [100, 500, 2000],
    settle_retry_max_delay: 5000,
  };
  const dir = await mkdtemp(join(tmpdir(), 'toros-f4-r4-5-'));
  const path = join(dir, 'node.sqlite');
  const job = 'a0000004-0000-4000-8000-000000000005';

  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'r4 read settlement event recovery',
    allowed_capabilities: ['settletest.start', 'settletest.send', 'settletest.read'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  const adapter: SessionAdapter = {
    manifest: settleSessionManifest,
    async init() {},
    async invoke(actionId: string): Promise<ActionResult> {
      if (actionId === 'send') {
        return { output: '', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'running', exchange_error: null } };
      }
      return { output: 'done', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'succeeded', exchange_error: null, bytes_read: 0 } };
    },
    async dispose() {},
    async start() { return { pid: -1 }; },
    async send() {},
    async read() { return { chunk: 'done', cursor: 0, exchange_state: 'succeeded', exchange_error: null }; },
    async interrupt() {},
    async stop() {},
  };
  const core = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const started = await http(port, 'start_cli', { job_id: job, cli_id: 'settletest', workspace_id: 'work' });
  const sessionId = String(started.body.receipt_id);
  assert.ok(sessionId.length > 0, `start_cli failed: ${JSON.stringify(started.body)}`);

  const sent = await http(port, 'send_cli', { job_id: job, session_id: sessionId, message: 'go' });
  assert.equal(sent.body.exchange_state, 'running');
  const sendReceiptId = String(sent.body.receipt_id);

  const unhandled = collectUnhandledRejections(t);

  // Fail the settlement's finished-event append exactly once, leaving the
  // deadline timer armed.
  const storeObj = coreStore(core);
  const realAppendEvent = storeObj.appendEvent.bind(storeObj);
  let appendFailed = false;
  storeObj.appendEvent = (input: { kind: string; payload: unknown }): Promise<unknown> => {
    const payload = input.payload as Record<string, unknown>;
    if (!appendFailed && input.kind === 'action.finished' && payload.receipt_id === sendReceiptId) {
      appendFailed = true;
      return Promise.reject(new Error('one-shot read-settlement append failure'));
    }
    return realAppendEvent(input);
  };

  // read_cli settles the send as 'succeeded': the terminal receipt write
  // lands, the event append fails, and read_cli surfaces the failure.
  const readResult = await http(port, 'read_cli', { job_id: job, session_id: sessionId, cursor: 0 });
  assert.equal(appendFailed, true, 'the injected append failure never fired');
  assert.equal(readResult.body.error, ErrorCode.E_ADAPTER_FAILURE,
    `read_cli did not surface the injected append failure: ${JSON.stringify(readResult.body)}`);

  const midStore = await openStore({ path, nodeId: 'node' });
  const midSend = await midStore.getReceipt(sendReceiptId);
  await midStore.close();
  assert.equal(midSend?.outcome, 'succeeded', 'the terminal receipt write did not land before the append failed');

  // The deadline (send + 80 ms timeout + 5 s grace) fires and recovers the
  // missing event; the closed receipt is not rewritten. Poll instead of a fixed
  // sleep with a wider window for a slow runner.
  await eventually(async () => {
    const s = await openStore({ path, nodeId: 'node' });
    const events = (await s.listEvents(job)).filter(
      (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
    );
    await s.close();
    return events.length >= 1;
  }, 15_000);

  const afterStore = await openStore({ path, nodeId: 'node' });
  const after = await afterStore.getReceipt(sendReceiptId);
  const finishedEvents = (await afterStore.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await afterStore.close();

  assert.equal(after?.outcome, 'succeeded', 'the deadline rewrote the closed receipt');
  assert.equal(after?.ended_at, midSend?.ended_at, 'the deadline changed the settlement timestamp');
  assert.equal(finishedEvents.length, 1, 'the recovered event was not appended exactly once');
  const recovered = finishedEvents[0]?.payload as Record<string, unknown>;
  assert.equal(recovered.exchange_state, 'succeeded', 'the recovered event lost the settlement state');
  assert.equal(recovered.outcome, 'succeeded');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(unhandled.list, [], 'an unhandled rejection escaped the read-settlement recovery');
});

// ---------------------------------------------------------------------------
// Round 4 finding 4 (P3) — instance-scoped, validated settlement timing with
// immutable production defaults: 1 s, 5 s, 30 s, then every 60 s.
// ---------------------------------------------------------------------------

test('Round4: production settlement timing defaults to a 1s, 5s, 30s, then 60s retry schedule after a 30s grace', () => {
  assert.equal(PRODUCTION_SETTLEMENT_TIMING.cli_settle_grace_ms, 30_000, 'production grace must be 30 s');
  assert.deepEqual(
    [...PRODUCTION_SETTLEMENT_TIMING.settle_retry_delays, PRODUCTION_SETTLEMENT_TIMING.settle_retry_max_delay],
    [1_000, 5_000, 30_000, 60_000],
    'production retry schedule must be 1 s, 5 s, 30 s, then every 60 s',
  );
  assert.equal(Object.isFrozen(PRODUCTION_SETTLEMENT_TIMING), true, 'production timing must be immutable');
  assert.equal(Object.isFrozen(PRODUCTION_SETTLEMENT_TIMING.settle_retry_delays), true, 'production retry schedule must be immutable');
});

test('Round4: invalid settlement timing options are rejected when the Core is constructed', () => {
  const base = {
    node_id: 'node', db_path: ':memory:', workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [], observer: null, approval_required: [],
  };
  assert.throws(
    () => createTestCore({ ...base, pipeline_settlement: { settle_retry_delays: [] } }),
    /non-empty/,
    'an empty retry schedule was accepted',
  );
  assert.throws(
    () => createTestCore({ ...base, pipeline_settlement: { cli_settle_grace_ms: -1 } }),
    /non-negative/,
    'a negative grace was accepted',
  );
  assert.throws(
    () => createTestCore({ ...base, pipeline_settlement: { settle_retry_delays: [100, Number.NaN] } }),
    /finite/,
    'a NaN retry delay was accepted',
  );
  assert.throws(
    () => createTestCore({ ...base, pipeline_settlement: { settle_retry_max_delay: Number.POSITIVE_INFINITY } }),
    /finite/,
    'an infinite retry cap was accepted',
  );
  assert.throws(
    () => createTestCore({ ...base, pipeline_settlement: { settle_retry_delays: [100], settle_retry_max_delay: -5 } }),
    /non-negative/,
    'a negative retry cap was accepted',
  );
});

// ---------------------------------------------------------------------------
// Round 5 item 1 — restart reconciliation also recovers closed send receipts
// missing their action.finished event, event-only, no rewrite, no duplicates,
// same retry schedule.
// ---------------------------------------------------------------------------

/**
 * Seed a closed (non-running) `settletest.send` receipt without an
 * `action.finished` event, modeling the state after a process restart where
 * the terminal receipt write succeeded but the event append failed before the
 * retry could fire.
 */
async function seedClosedSendWithoutEvent(
  path: string, job: string, receiptId: string, outcome: Receipt['outcome'],
  adapterFields: Record<string, unknown> = {},
): Promise<string> {
  const store = await openStore({ path, nodeId: 'node' });
  const envelopeDigest = (await store.getJob(job))!.envelope_digest;
  const endedAt = new Date().toISOString();
  await store.putReceipt({
    receipt_id: receiptId, job_id: job, node_id: 'node',
    session_id: 'r5-restart-session', actor: 'coordinator',
    capability: 'settletest.send',
    arguments_normalized: null, arguments_digest: receiptId,
    decision: { allow: true, reason: 'Allowed' },
    envelope_digest: envelopeDigest,
    started_at: new Date(Date.now() - 120_000).toISOString(),
    ended_at: endedAt,
    outcome,
    artifact_refs: [], finding_refs: [],
    adapter_fields: { exchange_state: 'running', ...adapterFields },
  } satisfies Receipt);
  await store.close();
  return endedAt;
}

test('Round5: restart reconciliation recovers a missing finished event for a deadline-closed send (terminated) via a fresh Core restart', async (t) => {
  // Produce the missing-event state through the real deadline closure path in
  // Core A: a running send receipt whose deadline fires, writes a terminated
  // receipt, but the event append fails (one-shot). Stop Core A before the
  // retry fires. Start Core B against the same database and assert that its
  // startup reconciliation alone recovers the event — without rewriting the
  // receipt or duplicating the event.
  //
  // Adequate deadline (~80 ms default + 5 000 ms grace), long first retry (5 s)
  // so we can stop Core A before the retry fires.
  const settleTiming: SettlementTimingOptions = {
    cli_settle_grace_ms: 5000,
    settle_retry_delays: [5000, 10000, 20000],
    settle_retry_max_delay: 30000,
  };

  const dir = await mkdtemp(join(tmpdir(), 'toros-f5-real-restart-deadline-'));
  const path = join(dir, 'node.sqlite');
  const job = 'b0000001-0000-4000-8000-000000000001';

  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'r5 real restart deadline recovery',
    allowed_capabilities: ['settletest.start', 'settletest.send', 'settletest.read'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  function makeSessionAdapter(): SessionAdapter {
    return {
      manifest: settleSessionManifest,
      async init() {},
      async invoke(actionId: string): Promise<ActionResult> {
        if (actionId === 'send') {
          return { output: '', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'running', exchange_error: null } };
        }
        return { output: 'done', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'succeeded', exchange_error: null, bytes_read: 0 } };
      },
      async dispose() {},
      async start() { return { pid: -1 }; },
      async send() {},
      async read() { return { chunk: 'done', cursor: 0, exchange_state: 'succeeded', exchange_error: null }; },
      async interrupt() {},
      async stop() {},
    };
  }

  // --- Core A: produce the missing-event state via the deadline closure ---
  const coreA = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [makeSessionAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  const { port: portA } = await coreA.start();

  // start_cli → session
  const started = await http(portA, 'start_cli', { job_id: job, cli_id: 'settletest', workspace_id: 'work' });
  const sessionId = String(started.body.receipt_id);
  assert.ok(sessionId.length > 0, `start_cli failed: ${JSON.stringify(started.body)}`);

  // Install the injector BEFORE send_cli so the deadline timer cannot fire
  // before the injector is in place. Use a mutable variable to capture the
  // send receipt_id after it becomes known.
  const storeObjA = coreStore(coreA);
  const realAppendEventA = storeObjA.appendEvent.bind(storeObjA);
  let appendFailed = false;
  let deadlineSendId: string | undefined;
  storeObjA.appendEvent = (input: { kind: string; payload: unknown }): Promise<unknown> => {
    const payload = input.payload as Record<string, unknown>;
    if (!appendFailed && deadlineSendId !== undefined && input.kind === 'action.finished' && payload.receipt_id === deadlineSendId) {
      appendFailed = true;
      return Promise.reject(new Error('one-shot deadline append failure'));
    }
    return realAppendEventA(input);
  };

  // send_cli → running send receipt with deadline timer armed
  const sent = await http(portA, 'send_cli', { job_id: job, session_id: sessionId, message: 'go' });
  assert.equal(sent.body.exchange_state, 'running');
  const sendReceiptId = String(sent.body.receipt_id);
  deadlineSendId = sendReceiptId; // now the injector knows which receipt to fail

  // Wait for the deadline timer to fire (~5080 ms from send). The deadline
  // close writes the terminated receipt, then fails on the event append.
  await eventually(() => appendFailed, 15_000);
  assert.equal(appendFailed, true, 'the deadline-driven event append never fired');

  // The receipt must be terminated (closed by the deadline) but no event yet.
  const midStore = await openStore({ path, nodeId: 'node' });
  const midReceipt = await midStore.getReceipt(sendReceiptId);
  const midEvents = (await midStore.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await midStore.close();
  assert.equal(midReceipt?.outcome, 'terminated', 'the deadline did not close the receipt');
  assert.notEqual(midReceipt?.ended_at, null, 'the terminated receipt has no ended_at');
  assert.equal((midReceipt?.adapter_fields as Record<string, unknown>)['exchange_state'], 'unsettled_deadline');
  assert.equal(midEvents.length, 0, 'an action.finished event exists before the restart');

  // Stop Core A before the retry (5 s delay) fires. The injected failure stays
  // in place so the retry cannot accidentally recover the event.
  await coreA.stop();

  // --- Core B: fresh start against the same database. Startup reconciliation
  // must recover the missing event without rewriting the receipt.
  const coreB = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [makeSessionAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await coreB.stop(); await rm(dir, { recursive: true, force: true }); });
  await coreB.start(); // ← triggers reconcileCliSettlements → recovers the event

  // The event must be recovered exactly once by Core B's startup.
  const afterStore = await openStore({ path, nodeId: 'node' });
  const afterReceipt = await afterStore.getReceipt(sendReceiptId);
  const afterEvents = (await afterStore.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await afterStore.close();

  assert.equal(afterReceipt?.outcome, 'terminated', 'Core B rewrote the closed receipt');
  assert.notEqual(afterReceipt?.ended_at, null);
  assert.equal((afterReceipt?.adapter_fields as Record<string, unknown>)['exchange_state'], 'unsettled_deadline');
  assert.equal(afterEvents.length, 1, 'the finished event was not recovered exactly once by Core B');
  assert.equal((afterEvents[0]?.payload as Record<string, unknown>).exchange_state, 'unsettled_deadline');
  assert.equal((afterEvents[0]?.payload as Record<string, unknown>).outcome, 'terminated');

  // The receipt itself must be unchanged by Core B's startup.
  assert.deepEqual(afterReceipt, midReceipt, 'Core B rewrote the closed receipt fields');

  // A second reconciliation must not duplicate the event or rewrite the receipt.
  const pipelineB = (coreB as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipelineB.reconcileCliSettlements();
  const finalStore = await openStore({ path, nodeId: 'node' });
  const finalReceipt = await finalStore.getReceipt(sendReceiptId);
  const finalEvents = (await finalStore.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await finalStore.close();

  assert.equal(finalEvents.length, 1, 'a second reconciliation duplicated the finished event');
  assert.deepEqual(finalReceipt, midReceipt, 'the second reconciliation rewrote the receipt');
});

test('Round5: restart reconciliation recovers a missing finished event for a read_cli-settled send (succeeded) via a fresh Core restart', async (t) => {
  // Produce the missing-event state through the read_cli settlement path in
  // Core A: start_cli → send_cli → read_cli with a one-shot appendEvent
  // failure. settleCliExchange writes the 'succeeded' receipt but fails on the
  // event append. The deadline timer is not cleared (settleCliExchange failed
  // before clearing it), but with a long grace the deadline cannot race past
  // the stop/start sequence. Stop Core A before the retry fires, then start
  // Core B and assert its startup reconciliation alone recovers the event.
  //
  // Long grace (5 s) ensures the deadline timer cannot fire before we stop
  // Core A and start Core B. Long first retry (5 s) gives time to stop Core A.
  const settleTiming: SettlementTimingOptions = {
    cli_settle_grace_ms: 5000,
    settle_retry_delays: [5000, 10000, 20000],
    settle_retry_max_delay: 30000,
  };

  const dir = await mkdtemp(join(tmpdir(), 'toros-f5-real-restart-read-'));
  const path = join(dir, 'node.sqlite');
  const job = 'b0000002-0000-4000-8000-000000000002';

  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'r5 real restart read settlement recovery',
    allowed_capabilities: ['settletest.start', 'settletest.send', 'settletest.read'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  function makeSessionAdapter(): SessionAdapter {
    return {
      manifest: settleSessionManifest,
      async init() {},
      async invoke(actionId: string): Promise<ActionResult> {
        if (actionId === 'send') {
          return { output: '', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'running', exchange_error: null } };
        }
        return { output: 'done', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'succeeded', exchange_error: null, bytes_read: 0 } };
      },
      async dispose() {},
      async start() { return { pid: -1 }; },
      async send() {},
      async read() { return { chunk: 'done', cursor: 0, exchange_state: 'succeeded', exchange_error: null }; },
      async interrupt() {},
      async stop() {},
    };
  }

  // --- Core A: produce the missing-event state via read_cli settlement ---
  const coreA = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [makeSessionAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  const { port: portA } = await coreA.start();

  const started = await http(portA, 'start_cli', { job_id: job, cli_id: 'settletest', workspace_id: 'work' });
  const sessionId = String(started.body.receipt_id);
  assert.ok(sessionId.length > 0, `start_cli failed: ${JSON.stringify(started.body)}`);

  const sent = await http(portA, 'send_cli', { job_id: job, session_id: sessionId, message: 'go' });
  assert.equal(sent.body.exchange_state, 'running');
  const sendReceiptId = String(sent.body.receipt_id);

  // Inject one-shot appendEvent failure for the settlement's action.finished.
  const storeObjA = coreStore(coreA);
  const realAppendEventA = storeObjA.appendEvent.bind(storeObjA);
  let appendFailed = false;
  storeObjA.appendEvent = (input: { kind: string; payload: unknown }): Promise<unknown> => {
    const payload = input.payload as Record<string, unknown>;
    if (!appendFailed && input.kind === 'action.finished' && payload.receipt_id === sendReceiptId) {
      appendFailed = true;
      return Promise.reject(new Error('one-shot read-settlement append failure'));
    }
    return realAppendEventA(input);
  };

  // read_cli triggers settleCliExchange: receipt becomes 'succeeded', event
  // append fails, read_cli surfaces the error.
  const readResult = await http(portA, 'read_cli', { job_id: job, session_id: sessionId, cursor: 0 });
  assert.equal(appendFailed, true, 'the injected read-settlement append failure never fired');
  assert.equal(readResult.body.error, ErrorCode.E_ADAPTER_FAILURE,
    `read_cli did not surface the injected append failure: ${JSON.stringify(readResult.body)}`);

  // The send receipt must be 'succeeded' (set by settleCliExchange before the
  // failure) but no event exists.
  const midStore = await openStore({ path, nodeId: 'node' });
  const midReceipt = await midStore.getReceipt(sendReceiptId);
  const midEvents = (await midStore.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await midStore.close();
  assert.equal(midReceipt?.outcome, 'succeeded', 'the settlement write did not land before the append failed');
  assert.notEqual(midReceipt?.ended_at, null);
  assert.equal(midEvents.length, 0, 'an action.finished event exists before the restart');

  // Stop Core A before the retry (5 s) fires.
  await coreA.stop();

  // --- Core B: fresh start against the same database ---
  const coreB = createTestCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [makeSessionAdapter()], observer: null, approval_required: [],
    pipeline_settlement: settleTiming,
  });
  t.after(async () => { await coreB.stop(); await rm(dir, { recursive: true, force: true }); });
  await coreB.start(); // ← triggers reconcileCliSettlements → recovers the event

  // The event must be recovered exactly once by Core B's startup.
  const afterStore = await openStore({ path, nodeId: 'node' });
  const afterReceipt = await afterStore.getReceipt(sendReceiptId);
  const afterEvents = (await afterStore.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await afterStore.close();

  assert.equal(afterReceipt?.outcome, 'succeeded', 'Core B rewrote the closed receipt');
  assert.notEqual(afterReceipt?.ended_at, null);
  assert.equal(afterEvents.length, 1, 'the finished event was not recovered exactly once by Core B');
  assert.equal((afterEvents[0]?.payload as Record<string, unknown>).exchange_state, 'succeeded');
  assert.equal((afterEvents[0]?.payload as Record<string, unknown>).outcome, 'succeeded');

  // The receipt itself must be unchanged by Core B's startup.
  assert.deepEqual(afterReceipt, midReceipt, 'Core B rewrote the closed receipt fields');

  // A second reconciliation must not duplicate the event or rewrite the receipt.
  const pipelineB = (coreB as unknown as { actionPipeline: { reconcileCliSettlements: () => Promise<void> } }).actionPipeline;
  await pipelineB.reconcileCliSettlements();
  const finalStore = await openStore({ path, nodeId: 'node' });
  const finalReceipt = await finalStore.getReceipt(sendReceiptId);
  const finalEvents = (await finalStore.listEvents(job)).filter(
    (e) => e.kind === 'action.finished' && (e.payload as Record<string, unknown>).receipt_id === sendReceiptId,
  );
  await finalStore.close();

  assert.equal(finalEvents.length, 1, 'a second reconciliation duplicated the finished event');
  assert.deepEqual(finalReceipt, midReceipt, 'the second reconciliation rewrote the receipt');
});

// End of all tests for this file