import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, type ActionResult, type Adapter, type AdapterContext, type AdapterManifest, type CorrelationRetraction, type JsonValue, type NodePlatform, type Receipt, type SessionAdapter } from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';
import { createNodeCore, type NodeCore, type ObserverDeps } from '../src/index.js';

const token = 'test-token';
const manifest: AdapterManifest = { id: 'mock', version: '1.0.0', platforms: [process.platform as NodePlatform], actions: [{ id: 'run', summary: 'run', input_schema: { type: 'object', properties: { path: { type: 'string' }, value: { type: 'number' } }, additionalProperties: false }, path_fields: ['path'], mutates: false, always_requires_approval: false }], required_permissions: [], allowed_resources: [], default_timeout_ms: 1000, cancellation: 'graceful', receipt_fields: ['audit_id'] };
function makeAdapter(seen: string[], observedActionsUsed: number[], storePath: string, delay = 0, fail = false, withArtifact = false, record?: { args?: Readonly<Record<string, JsonValue>> }, failInvoke = false, receiptExtra: Readonly<Record<string, JsonValue>> = {}): Adapter { return { manifest, async init() { if (fail) throw new Error('unavailable'); }, async invoke(_a: string, _b: Readonly<Record<string, JsonValue>>, c: AdapterContext): Promise<ActionResult> { const store = await openStore({ path: storePath, nodeId: 'node' }); observedActionsUsed.push((await store.getJob(c.job_id))?.actions_used ?? -1); await store.close(); if (record) record.args = _b; seen.push(c.job_id); if (failInvoke) throw new Error('adapter failed on purpose'); if (delay) await new Promise((r) => setTimeout(r, delay)); return { output: 'ok', truncated: false, artifacts: withArtifact ? [{ path: join(tmpdir(), 'toros-test-artifact.txt'), sha256: 'artifact-hash', bytes: 4 }] : [], receipt_extra: receiptExtra }; }, async dispose() {} }; }
interface Fixture { core: NodeCore; path: string; job: string; seen: string[]; observedActionsUsed: number[]; lastArgs?: Readonly<Record<string, JsonValue>>; }
async function fixture(overrides: Record<string, unknown> = {}, delay = 0, fail = false, withArtifact = false, failInvoke = false, receiptExtra: Readonly<Record<string, JsonValue>> = {}): Promise<Fixture> { const dir = await mkdtemp(join(tmpdir(), 'toros-core-')); const path = join(dir, 'node.sqlite'); const job = '11111111-1111-4111-8111-111111111111'; const sealed = sealEnvelope({ job_id: job, objective: 'test', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [], max_actions: 3, max_retries: 0, expires_at: '2999-01-01T00:00:00Z', ...overrides }); const store = await openStore({ path, nodeId: 'node' }); await store.createJob(sealed); await store.close(); const seen: string[] = []; const observedActionsUsed: number[] = []; const record: { args?: Readonly<Record<string, JsonValue>> } = {}; const f: Fixture = { core: createNodeCore({ node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }], port: 0, token, adapters: [makeAdapter(seen, observedActionsUsed, path, delay, fail, withArtifact, record, failInvoke, receiptExtra)], observer: null, approval_required: [] }), path, job, seen, observedActionsUsed }; Object.defineProperty(f, 'lastArgs', { get: () => record.args }); return f; }
/**
 * Node's global http agent has kept sockets alive since Node 19, so a
 * keep-alive socket outlives the request and `node --test` never exits — the
 * suite looks hung when it has already finished. `agent: false` gives each
 * request its own socket that closes with the response.
 */
async function http(port: number, tool: string, args: Record<string, unknown>, auth = token, origin?: string): Promise<{ status: number; body: Record<string, unknown> }> { return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, method: 'POST', agent: false, path: `/tools/${tool}`, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) } }, (res) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> })); }); req.on('error', reject); req.end(JSON.stringify(args)); }); }
/**
 * Tear down a fixture. Callers MUST invoke this from `t.after`, not inline at
 * the end of the test body: a failing assertion throws before an inline call
 * is reached, the HTTP server stays bound, and `node --test` then hangs
 * forever instead of reporting the failure. That cost a full diagnosis pass —
 * the suite looked like it was stuck when it had simply failed.
 */
async function finish(f: Fixture): Promise<void> { await f.core.stop(); await rm(f.path, { force: true }); await rm(join(f.path, '..'), { recursive: true, force: true }); }
async function action(f: Fixture, port: number): Promise<{ status: number; body: Record<string, unknown> }> { return http(port, 'invoke_app_action', { job_id: f.job, app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} }); }

test('a denied action writes a receipt with outcome denied and both events', async (t) => { const f = await fixture({ allowed_capabilities: [] }); t.after(() => finish(f));; const p = await f.core.start(); const r = await action(f, p.port); assert.equal(r.body.error, ErrorCode.E_CAP_NOT_ALLOWED); const s = await openStore({ path: f.path, nodeId: 'node' }); assert.equal((await s.listReceipts(f.job))[0]?.outcome, 'denied'); assert.deepEqual((await s.listEvents(f.job)).map((e) => e.kind), ['action.requested', 'action.decided']); await s.close(); }); 
test('a denied action never reaches the adapter', async (t) => { const f = await fixture({ allowed_capabilities: [] }); t.after(() => finish(f));; const p = await f.core.start(); await action(f, p.port); assert.equal(f.seen.length, 0); }); 
test('actions_used increments before the adapter is invoked', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); await action(f, p.port); assert.deepEqual(f.observedActionsUsed, [1]); }); 
test('a successful action writes request, decided, started and finished events in order', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); await action(f, p.port); const s = await openStore({ path: f.path, nodeId: 'node' }); assert.deepEqual((await s.listEvents(f.job)).map((e) => e.kind), ['action.requested', 'action.decided', 'action.started', 'action.finished']); await s.close(); }); 
test('the receipt records the envelope digest the job was created with', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); await action(f, p.port); const s = await openStore({ path: f.path, nodeId: 'node' }); assert.equal((await s.listReceipts(f.job))[0]?.envelope_digest, (await s.getJob(f.job))?.envelope_digest); await s.close(); }); 

test('declared adapter receipt fields are persisted', async (t) => {
  const f = await fixture({}, 0, false, false, false, { audit_id: 'trace-1' });
  t.after(() => finish(f));
  const p = await f.core.start();
  await action(f, p.port);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipt = (await store.listReceipts(f.job))[0];
  await store.close();
  assert.deepEqual(receipt?.adapter_fields, { audit_id: 'trace-1' });
});

test('an undeclared adapter receipt field fails instead of disappearing', async (t) => {
  const f = await fixture({}, 0, false, false, false, { hidden: 'not-allowlisted' });
  t.after(() => finish(f));
  const p = await f.core.start();
  const response = await action(f, p.port);
  assert.equal(response.body.error, ErrorCode.E_ADAPTER_FAILURE);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipt = (await store.listReceipts(f.job))[0];
  await store.close();
  assert.equal(receipt?.outcome, 'failed');
  assert.deepEqual(receipt?.adapter_fields, {});
});
test('job_complete sets proposed and never accepted', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); await http(p.port, 'job_complete', { job_id: f.job, summary: 'done' }); assert.equal((await http(p.port, 'job_status', { job_id: f.job })).body.state, 'proposed'); }); 
test('no tool sequence reaches the accepted state', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); const tools: readonly string[] = ['job_status', 'job_complete', 'job_block', 'list_capabilities', 'list_sessions', 'start_cli', 'send_cli', 'read_cli', 'interrupt_cli', 'stop_cli', 'inspect_app', 'invoke_app_action', 'create_checkpoint', 'create_local_relay', 'list_activity']; const responses: Array<{ status: number; body: Record<string, unknown> }> = []; for (const tool of tools) responses.push(await http(p.port, tool, { job_id: f.job, summary: 'done' })); assert.equal(responses.every((response) => !JSON.stringify(response.body).includes('accepted')), true); });
test('an action against a completed job returns E_JOB_TERMINAL', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); await http(p.port, 'job_complete', { job_id: f.job, summary: 'done' }); assert.equal((await action(f, p.port)).body.error, ErrorCode.E_JOB_TERMINAL); }); 
test('list_capabilities returns only capabilities in allowed_capabilities', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); assert.deepEqual((await http(p.port, 'list_capabilities', { job_id: f.job })).body.capabilities, ['mock.run']); }); 
test('a session id from another job returns E_SESSION_UNKNOWN', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); assert.equal((await http(p.port, 'read_cli', { job_id: f.job, cli_id: 'mock', session_id: 'other', cursor: 0 })).body.error, ErrorCode.E_SESSION_UNKNOWN); }); 
test('list_activity returns only the requested job\'s rows', async (t) => { const f = await fixture(); t.after(() => finish(f)); const p = await f.core.start(); await action(f, p.port); const rows = (await http(p.port, 'list_activity', { job_id: f.job })).body.events as Array<{ job_id: string }>; assert.equal(rows.every((row) => row.job_id === f.job), true); });
test('binds to 127.0.0.1 and not to another interface', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); assert.ok(p.port > 0); assert.equal((await http(p.port, 'job_status', { job_id: f.job })).status, 200); await new Promise<void>((resolve, reject) => { const socket = connect({ host: '127.0.0.2', port: p.port }); socket.once('connect', () => { socket.destroy(); reject(new Error('Node Core accepted a non-127.0.0.1 loopback connection')); }); socket.once('error', () => { socket.destroy(); resolve(); }); }); });
test('rejects a missing token with 401', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); assert.equal((await http(p.port, 'job_status', { job_id: f.job }, '')).status, 401); }); 
test('rejects a wrong token with 401 and an identical body', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); const a = await http(p.port, 'job_status', { job_id: f.job }, 'bad'); const b = await http(p.port, 'job_status', { job_id: f.job }, 'x'); assert.deepEqual(a.body, b.body); }); 
test('rejects a request carrying an Origin header', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); assert.equal((await http(p.port, 'job_status', { job_id: f.job }, token, 'http://evil')).status, 403); }); 
test('rejects a body over the size cap with 413', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); const result = await new Promise<number>((resolve, reject) => { const r = request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/tools/job_status', headers: { authorization: `Bearer ${token}`, 'content-length': 1048577 } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); }); r.on('error', reject); r.end(); }); assert.equal(result, 413); }); 
test('never includes the token in any response body', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); assert.equal(JSON.stringify((await http(p.port, 'job_status', { job_id: f.job }, 'bad')).body).includes(token), false); }); 
test('a second concurrent action for one job is refused with E_PARALLEL_ACTION', async (t) => { const f = await fixture({}, 100); t.after(() => finish(f));; const p = await f.core.start(); const first = action(f, p.port); await new Promise((r) => setTimeout(r, 10)); assert.equal((await action(f, p.port)).body.error, ErrorCode.E_PARALLEL_ACTION); await first; }); 
test('two different jobs act concurrently', async (t) => { const f = await fixture({}, 20); t.after(() => finish(f));; const s = await openStore({ path: f.path, nodeId: 'node' }); await s.createJob(sealEnvelope({ job_id: '22222222-2222-4222-8222-222222222222', objective: 'test', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [], max_actions: 3, max_retries: 0, expires_at: '2999-01-01T00:00:00Z' })); await s.close(); const p = await f.core.start(); await Promise.all([action(f, p.port), http(p.port, 'invoke_app_action', { job_id: '22222222-2222-4222-8222-222222222222', app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} })]); assert.equal(f.seen.length, 2); }); 
test('a checkpointed job is resumable after stop and start', async (t) => { const f = await fixture(); t.after(() => finish(f));; const p = await f.core.start(); await http(p.port, 'create_checkpoint', { job_id: f.job, description: 'pause' }); await f.core.stop(); const again = await f.core.start(); assert.equal((await http(again.port, 'job_status', { job_id: f.job })).body.state, 'checkpoint'); }); 
test('receipts, artifacts and the event chain survive a restart', async (t) => { const f = await fixture({}, 0, false, true); t.after(() => finish(f));; const p = await f.core.start(); await action(f, p.port); const before = await openStore({ path: f.path, nodeId: 'node' }); const artifactsBefore = await before.listArtifacts(f.job); await before.close(); assert.equal(artifactsBefore.length, 1); await f.core.stop(); await f.core.start(); const s = await openStore({ path: f.path, nodeId: 'node' }); assert.equal((await s.listReceipts(f.job)).length, 1); assert.deepEqual(await s.listArtifacts(f.job), artifactsBefore); assert.equal((await s.verifyChain('node')).ok, true); await s.close(); });
test('startup verifies the chain and logs the result', async (t) => { const f = await fixture(); t.after(() => finish(f));; const originalInfo = console.info; const lines: string[] = []; console.info = (...args: Parameters<typeof console.info>) => { lines.push(args.map(String).join(' ')); }; try { assert.ok((await f.core.start()).port > 0); } finally { console.info = originalInfo; } assert.equal(lines.some((line) => line.includes('event chain verification')), true); });
test('startup succeeds when one adapter fails to register', async (t) => { const f = await fixture({}, 0, true); t.after(() => finish(f));; assert.ok((await f.core.start()).port > 0); }); 

// ---------------------------------------------------------------------------
// Regressions from the second independent review.
// ---------------------------------------------------------------------------

test('create_checkpoint refuses a terminal job', async (t) => {
  // job_complete then create_checkpoint moved a `proposed` job back to
  // `checkpoint` — a resumable state — and re-enabled adapter actions on a job
  // that was over. A terminal state any tool can undo is not terminal.
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  await http(p.port, 'job_complete', { job_id: f.job, summary: 'done' });
  const r = await http(p.port, 'create_checkpoint', { job_id: f.job, description: 'reopen me' });
  assert.equal(r.body.error, ErrorCode.E_JOB_TERMINAL);
  const after = await http(p.port, 'job_status', { job_id: f.job });
  assert.equal(after.body.state, 'proposed');
});

test('create_local_relay refuses a terminal job', async () => {
  // The guard above was added to create_checkpoint and stopped there. Its
  // sibling had the same hole: a `proposed` or `blocked` job could still read
  // selected files off disk and write a capsule whose manifest declares
  // `state: "relay"` — a resumable handoff asserted for work that is over.
  for (const [tool, expected] of [['job_complete', 'proposed'], ['job_block', 'blocked']] as const) {
    const f = await fixture();
    try {
      const p = await f.core.start();
      await http(p.port, tool, { job_id: f.job, summary: 'done', reason: 'stuck' });
      const r = await http(p.port, 'create_local_relay', { job_id: f.job, selected_files: [], selected_outputs: [] });
      assert.equal(r.body.error, ErrorCode.E_JOB_TERMINAL, `create_local_relay was allowed on a ${expected} job`);
      const after = await http(p.port, 'job_status', { job_id: f.job });
      assert.equal(after.body.state, expected);
    } finally {
      await finish(f);
    }
  }
});

test('the adapter receives the resolved path policy approved, not the relative one', async (t) => {
  // Policy contains `book.xlsx` as <workspace>/book.xlsx. Passing the original
  // relative string on let the adapter resolve it again against Node Core's own
  // process directory, so what ran was not what was authorised.
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  await http(p.port, 'invoke_app_action', {
    job_id: f.job, app_id: 'mock', action_id: 'run', workspace_id: 'work',
    parameters: { path: 'book.xlsx' },
  });
  const seenPath = f.lastArgs?.path;
  assert.equal(typeof seenPath, 'string');
  assert.ok(isAbsolute(String(seenPath)), `adapter saw a relative path: ${String(seenPath)}`);
  assert.equal(String(seenPath), resolve(tmpdir(), 'book.xlsx'));
});

test('a caller cannot attribute its action to the operator', async (t) => {
  // `operator` means a human acted at the console. Nothing arriving over the
  // HTTP surface qualifies, so a request asking for it must not get it —
  // that is the one attribution nobody should be able to forge.
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  for (const claimed of ['operator', 'OPERATOR', '  Operator  ']) {
    await http(p.port, 'invoke_app_action', {
      job_id: f.job, app_id: 'mock', action_id: 'run', workspace_id: 'work',
      parameters: {}, model: claimed,
    });
  }
  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  await store.close();
  assert.ok(receipts.length >= 3);
  assert.equal(receipts.every((r) => r.actor !== 'operator'), true,
    `a receipt was attributed to the operator: ${receipts.map((r) => r.actor).join(',')}`);
});

test('a supplied model identifier is preserved as the actor', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  await http(p.port, 'invoke_app_action', {
    job_id: f.job, app_id: 'mock', action_id: 'run', workspace_id: 'work',
    parameters: {}, model: 'openrouter/z-ai/glm-5.2',
  });
  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(f.job);
  await store.close();
  assert.equal(receipts[0]?.actor, 'openrouter/z-ai/glm-5.2');
});

test('budget is spent before action.started is recorded', async (t) => {
  // Normative pipeline steps 7 then 8. If the increment failed, the log must
  // not already contain a started action that never spent budget.
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  await action(f, p.port);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  const events = (await store.listEvents(f.job)).map((e) => e.kind);
  const job = await store.getJob(f.job);
  await store.close();
  assert.deepEqual(events, ['action.requested', 'action.decided', 'action.started', 'action.finished']);
  assert.equal(job?.actions_used, 1);
  // The adapter observed the counter already incremented — proving the order,
  // which asserting the final value alone cannot.
  assert.deepEqual(f.observedActionsUsed, [1]);
});

test('retries are counted from the receipts, so E_RETRIES_EXHAUSTED is reachable', async (t) => {
  // retries_used was hardcoded to 0, which made a failing action re-requestable
  // until max_actions ran out no matter what max_retries said.
  const f = await fixture({ max_retries: 1, max_actions: 10 }, 0, false, false, /* failInvoke */ true);
  t.after(() => finish(f));
  const p = await f.core.start();
  // max_retries: 1 means two attempts in total — the first try, then one retry.
  const first = await action(f, p.port);   // first attempt, fails in the adapter
  const second = await action(f, p.port);  // the one permitted retry, fails
  const third = await action(f, p.port);   // a second retry — over budget
  assert.notEqual(first.body.error, ErrorCode.E_RETRIES_EXHAUSTED);
  assert.notEqual(second.body.error, ErrorCode.E_RETRIES_EXHAUSTED);
  assert.equal(third.body.error, ErrorCode.E_RETRIES_EXHAUSTED);
});

// ---------------------------------------------------------------------------
// Observer integration (SPEC §8.2)
//
// Both of these hold in the OBSERVER's own unit tests, against a hand-written
// resolver and a hand-registered handler. Neither held in the assembled
// service: `main.ts` passed `resolveSession: () => null`, and Node Core never
// called `onRetraction` at all. So these exercise the wiring, which is the only
// place the defect lived.
// ---------------------------------------------------------------------------

const cliManifest: AdapterManifest = {
  id: 'mockcli', version: '1.0.0', platforms: [process.platform as NodePlatform],
  actions: [{ id: 'start', summary: 'start', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false }],
  required_permissions: [], allowed_resources: [], default_timeout_ms: 1000, cancellation: 'kill', receipt_fields: [],
};

function makeSessionAdapter(): SessionAdapter {
  return {
    manifest: cliManifest,
    async init() {},
    async invoke(): Promise<ActionResult> { return { output: '', truncated: false, artifacts: [], receipt_extra: {} }; },
    async dispose() {},
    async start() { return { pid: 4242 }; },
    async send() {},
    async read() { return { chunk: '', cursor: 0 }; },
    async interrupt() {},
    async stop() {},
  };
}
test('CLI settlement selects only the newest exact running send and exposes declared exchange fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-exchange-state-'));
  const path = join(dir, 'node.sqlite');
  const job = '44444444-4444-4444-8444-444444444444';
  const actions = [
    { id: 'start', summary: 'start', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'send', summary: 'send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'read', summary: 'read', input_schema: { type: 'object', properties: { cursor: { type: 'integer' } }, required: ['cursor'], additionalProperties: false }, path_fields: [], mutates: false, always_requires_approval: false },
  ] as const;
  const exchangeManifest: AdapterManifest = {
    id: 'exchangecli', version: '1.0.0', platforms: [process.platform as NodePlatform],
    actions, required_permissions: [], allowed_resources: [], default_timeout_ms: 1000,
    cancellation: 'kill', receipt_fields: ['bytes_read', 'exchange_state', 'exchange_error'],
  };
  const adapter: SessionAdapter = {
    manifest: exchangeManifest,
    async init() {},
    async invoke(actionId): Promise<ActionResult> {
      return actionId === 'read'
        ? { output: 'done', truncated: false, artifacts: [], receipt_extra: { bytes_read: 4, exchange_state: 'succeeded', exchange_error: null } }
        : { output: '', truncated: false, artifacts: [], receipt_extra: { bytes_read: 0, exchange_state: 'running', exchange_error: null } };
    },
    async dispose() {}, async start() { return { pid: -1 }; }, async send() {},
    async read() { return { chunk: 'done', cursor: 4, exchange_state: 'succeeded', exchange_error: null }; },
    async interrupt() {}, async stop() {},
  };
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: job, objective: 'test exchange state',
    allowed_capabilities: ['exchangecli.start', 'exchangecli.send', 'exchangecli.read'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    // Room for start + send + two reads, so the post-restart idempotence read
    // (Round 2 item 2) is not refused by the action budget.
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }],
    port: 0, token, adapters: [adapter], observer: null, approval_required: [],
  });
  try {
    const { port } = await core.start();
    const started = await http(port, 'start_cli', { job_id: job, cli_id: 'exchangecli', workspace_id: 'work' });
    const sessionId = String(started.body.receipt_id);
    const seedStore = await openStore({ path, nodeId: 'node' });
    const seeded: Receipt[] = [
      { receipt_id: 'older-running-send', job_id: job, node_id: 'node', session_id: sessionId, actor: 'coordinator', capability: 'exchangecli.send', arguments_normalized: null, arguments_digest: 'older', decision: { allow: true, reason: 'Allowed' }, envelope_digest: (await seedStore.getJob(job))!.envelope_digest, started_at: '2000-01-01T00:00:01.000Z', ended_at: null, outcome: 'running', artifact_refs: [], finding_refs: [], adapter_fields: { exchange_state: 'running' } },
      { receipt_id: 'other-session-send', job_id: job, node_id: 'node', session_id: 'other-session', actor: 'coordinator', capability: 'exchangecli.send', arguments_normalized: null, arguments_digest: 'other-session', decision: { allow: true, reason: 'Allowed' }, envelope_digest: (await seedStore.getJob(job))!.envelope_digest, started_at: '2990-01-01T00:00:02.000Z', ended_at: null, outcome: 'running', artifact_refs: [], finding_refs: [], adapter_fields: { exchange_state: 'running' } },
      { receipt_id: 'other-job-send', job_id: 'other-job', node_id: 'node', session_id: sessionId, actor: 'coordinator', capability: 'exchangecli.send', arguments_normalized: null, arguments_digest: 'other-job', decision: { allow: true, reason: 'Allowed' }, envelope_digest: 'b'.repeat(64), started_at: '2990-01-01T00:00:03.000Z', ended_at: null, outcome: 'running', artifact_refs: [], finding_refs: [], adapter_fields: { exchange_state: 'running' } },
      { receipt_id: 'other-capability-send', job_id: job, node_id: 'node', session_id: sessionId, actor: 'coordinator', capability: 'other.send', arguments_normalized: null, arguments_digest: 'other-capability', decision: { allow: true, reason: 'Allowed' }, envelope_digest: (await seedStore.getJob(job))!.envelope_digest, started_at: '2990-01-01T00:00:04.000Z', ended_at: null, outcome: 'running', artifact_refs: [], finding_refs: [], adapter_fields: { exchange_state: 'running' } },
      { receipt_id: 'already-settled-send', job_id: job, node_id: 'node', session_id: sessionId, actor: 'coordinator', capability: 'exchangecli.send', arguments_normalized: null, arguments_digest: 'settled', decision: { allow: true, reason: 'Allowed' }, envelope_digest: (await seedStore.getJob(job))!.envelope_digest, started_at: '2990-01-01T00:00:05.000Z', ended_at: '2990-01-01T00:00:06.000Z', outcome: 'succeeded', artifact_refs: [], finding_refs: [], adapter_fields: { exchange_state: 'succeeded' } },
    ];
    for (const receipt of seeded) await seedStore.putReceipt(receipt);
    // Running sends passed `action.started`; seed that event so restart
    // reconciliation still sees them as genuinely started (RR-04).
    for (const receiptId of ['older-running-send', 'other-session-send', 'other-capability-send', 'already-settled-send']) {
      await seedStore.appendEvent({ node_id: 'node', job_id: job, kind: 'action.started', payload: { receipt_id: receiptId } });
    }
    await seedStore.close();
    const sent = await http(port, 'send_cli', { job_id: job, session_id: sessionId, message: 'go' });
    assert.equal(sent.body.exchange_state, 'running');
    assert.equal(sent.body.exchange_error, null);
    const sentReceiptId = String(sent.body.receipt_id);
    const during = await openStore({ path, nodeId: 'node' });
    assert.equal((await during.getReceipt(sentReceiptId))?.outcome, 'running');
    await during.close();

    const read = await http(port, 'read_cli', { job_id: job, session_id: sessionId, cursor: 0 });
    assert.equal(read.body.output, 'done');
    assert.equal(read.body.exchange_state, 'succeeded');
    assert.equal(read.body.exchange_error, null);
    const after = await openStore({ path, nodeId: 'node' });
    assert.equal(read.body.cursor, 4);
    const sendReceipt = await after.getReceipt(sentReceiptId);
    const untouched = await Promise.all(seeded.map((receipt) => after.getReceipt(receipt.receipt_id)));
    await after.close();
    assert.equal(sendReceipt?.outcome, 'succeeded');
    assert.ok(sendReceipt?.ended_at !== null);
    assert.deepEqual(untouched, seeded);

    // Round 2 item 2 (operator decision): the receipt is still `running` right
    // after the send — the exchange-settlement design is unchanged — but a
    // send left open is NEVER open-ended. A settlement deadline derived from
    // started_at + the action timeout + 30 s closes it, and after a restart the
    // same closing runs for any running send whose deadline has already passed.
    const deadlineStore = await openStore({ path, nodeId: 'node' });
    const expirySeeded: Receipt = {
      receipt_id: 'unsettled-deadline-send', job_id: job, node_id: 'node', session_id: sessionId,
      actor: 'coordinator', capability: 'exchangecli.send', arguments_normalized: null,
      arguments_digest: 'unsettled', decision: { allow: true, reason: 'Allowed' },
      envelope_digest: (await deadlineStore.getJob(job))!.envelope_digest,
      started_at: '2020-01-01T00:00:00.000Z', ended_at: null, outcome: 'running',
      artifact_refs: [], finding_refs: [], adapter_fields: { exchange_state: 'running' },
    };
    await deadlineStore.putReceipt(expirySeeded);
    await deadlineStore.appendEvent({ node_id: 'node', job_id: job, kind: 'action.started', payload: { receipt_id: 'unsettled-deadline-send' } });
    await deadlineStore.close();

    await core.stop();
    const restarted = await core.start();
    const settled = await openStore({ path, nodeId: 'node' });
    const expired = await settled.getReceipt('unsettled-deadline-send');
    const older = await settled.getReceipt('older-running-send');
    const opening = await settled.getReceipt(sentReceiptId);
    const finishedEvents = (await settled.listEvents(job)).filter((e) => e.kind === 'action.finished');
    await settled.close();

    assert.equal(expired?.outcome, 'terminated', 'the expired running send was not closed at restart');
    assert.notEqual(expired?.ended_at, null);
    assert.equal(expired?.adapter_fields['exchange_state'], 'unsettled_deadline');
    assert.equal(older?.outcome, 'terminated', 'an older running send past its deadline was not closed at restart');
    assert.equal(opening?.outcome, 'succeeded', 'the restart disturbed the already-settled send');
    assert.ok(
      finishedEvents.some((e) => (e.payload as Record<string, unknown>).exchange_state === 'unsettled_deadline'),
      'the deadline close appended no action.finished with exchange_state unsettled_deadline',
    );

    // Idempotence: a settlement arriving later (read_cli) neither reopens nor
    // rewrites a receipt the deadline already closed.
    const readAgain = await http(restarted.port, 'read_cli', { job_id: job, session_id: sessionId, cursor: 0 });
    assert.equal(readAgain.body.exchange_state, 'succeeded');
    const afterRestart = await openStore({ path, nodeId: 'node' });
    const expiredAfter = await afterRestart.getReceipt('unsettled-deadline-send');
    const firstAfter = await afterRestart.getReceipt(sentReceiptId);
    await afterRestart.close();
    assert.equal(expiredAfter?.outcome, 'terminated', 'a later read_cli reopened the deadline-closed receipt');
    assert.equal(expiredAfter?.ended_at, expired?.ended_at, 'a later read_cli rewrote the deadline-closed receipt');
    assert.equal(firstAfter?.outcome, 'succeeded');
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});


/** Poll the event log until `kind` appears, or fail after `timeoutMs`. */
async function waitForEvent(path: string, jobId: string, kind: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const store = await openStore({ path, nodeId: 'node' });
    const row = (await store.listEvents(jobId)).find((e) => e.kind === kind);
    await store.close();
    if (row !== undefined) return row as unknown as Record<string, unknown>;
    if (Date.now() > deadline) assert.fail(`no ${kind} event within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('the observer is given correlation lookups that resolve real sessions and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-obs-'));
  const path = join(dir, 'node.sqlite');
  const job = '22222222-2222-4222-8222-222222222222';
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({ job_id: job, objective: 'test', allowed_capabilities: ['mockcli.start'], allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [], max_actions: 3, max_retries: 0, expires_at: '2999-01-01T00:00:00Z' }));
  await store.close();

  let deps: ObserverDeps | null = null;
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }], port: 0, token,
    adapters: [makeSessionAdapter()], approval_required: [],
    observer: (d: ObserverDeps) => {
      deps = d;
      return { id: 'fake', async start() {}, onFinding() {}, onRetraction() {}, async stop() {} };
    },
  });

  try {
    const p = await core.start();
    const d = deps as ObserverDeps | null;
    assert.ok(d !== null, 'Node Core never called the observer factory');

    // Nothing resolves before a session exists — in particular the resolver
    // must not echo back whatever id it is handed, or any observed path
    // segment could mint an attribution.
    assert.equal(d!.resolveSession('11111111-1111-4111-8111-111111111111'), null);

    const started = await http(p.port, 'start_cli', { job_id: job, cli_id: 'mockcli', workspace_id: 'work' });
    const sessionId = started.body.receipt_id as string;
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0, `start_cli failed: ${JSON.stringify(started.body)}`);

    // The adapter names its per-session directory after this same id, so this
    // is exactly what route 1 sees as the last segment of an observed path.
    assert.equal(d!.resolveSession(sessionId), sessionId);
    assert.equal(d!.jobForSession(sessionId), job);
    assert.equal(d!.resolveSession(`${sessionId}-not`), null);
    assert.equal(d!.jobForSession('never-created'), null);
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a correlation retraction is appended to the log against the retracted session job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-ret-'));
  const path = join(dir, 'node.sqlite');
  const job = '33333333-3333-4333-8333-333333333333';
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({ job_id: job, objective: 'test', allowed_capabilities: ['mockcli.start'], allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [], max_actions: 3, max_retries: 0, expires_at: '2999-01-01T00:00:00Z' }));
  await store.close();

  let emit: ((r: CorrelationRetraction) => void) | null = null;
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }], port: 0, token,
    adapters: [makeSessionAdapter()], approval_required: [],
    observer: () => ({
      id: 'fake', async start() {}, onFinding() {},
      onRetraction(h: (r: CorrelationRetraction) => void) { emit = h; },
      async stop() {},
    }),
  });

  try {
    const p = await core.start();
    // The handler must be registered by start(), not by the first finding:
    // every retraction emitted before that would be dropped.
    assert.ok((emit as ((r: CorrelationRetraction) => void) | null) !== null, 'Node Core never registered an onRetraction handler');

    const started = await http(p.port, 'start_cli', { job_id: job, cli_id: 'mockcli', workspace_id: 'work' });
    const sessionId = started.body.receipt_id as string;

    emit!({
      run_id: 'run-7',
      retracted_session_id: sessionId,
      retracted_finding_keys: ['finding-a', 'finding-b'],
      observed_at: '2026-01-01T00:00:00Z',
      reason: 'route-3 run binding invalidated by a conflicting exact resolution',
    });

    const row = await waitForEvent(path, job, 'finding.correlation_retracted');
    const payload = row.payload as Record<string, unknown>;
    assert.equal(payload.run_id, 'run-7');
    assert.equal(payload.retracted_session_id, sessionId);
    assert.deepEqual(payload.retracted_finding_keys, ['finding-a', 'finding-b']);
    assert.equal(payload.reason, 'route-3 run binding invalidated by a conflicting exact resolution');

    // Appended, never an edit: the earlier attribution is still in the log.
    const s = await openStore({ path, nodeId: 'node' });
    const kinds = (await s.listEvents(job)).map((e) => e.kind);
    await s.close();
    assert.ok(kinds.includes('action.finished'), 'the original action events were removed');
    assert.equal(kinds.filter((k) => k === 'finding.correlation_retracted').length, 1);
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Approvals (SPEC §8.1 rule 12)
//
// The gate used to accept any non-empty string, and no tool issued real
// approvals, so `approval_token: "yes"` cleared it. What follows exercises the
// assembled path: a gated action is refused, the operator — and only the
// operator — grants it, and the grant covers exactly one action once.
// ---------------------------------------------------------------------------

const operatorToken = 'operator-token-at-least-32-chars-long';

/** POST a body exactly as written, without a JSON.stringify round trip. */
async function rawPost(port: number, tool: string, body: string, auth = token): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', agent: false, path: `/tools/${tool}`, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** POST to the operator surface, which is not the coordinator's tool surface. */
async function operator(port: number, operation: string, args: Record<string, unknown>, auth = operatorToken): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', agent: false, path: `/operator/${operation}`, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(args));
  });
}

interface GatedFixture { core: NodeCore; path: string; job: string; dir: string; seen: string[] }

async function gatedFixture(overrides: Record<string, unknown> = {}): Promise<GatedFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-appr-'));
  const path = join(dir, 'node.sqlite');
  const job = '44444444-4444-4444-8444-444444444444';
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({ job_id: job, objective: 'test', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [], max_actions: 9, max_retries: 3, expires_at: '2999-01-01T00:00:00Z' }));
  await store.close();
  const seen: string[] = [];
  const core = createNodeCore({
    node_id: 'node', db_path: path, workspaces: [{ id: 'work', root: tmpdir() }], port: 0, token,
    adapters: [makeAdapter(seen, [], path)], observer: null,
    approval_required: ['mock.run'], operator_token: operatorToken,
    ...overrides,
  });
  return { core, path, job, dir, seen };
}

async function finishGated(f: GatedFixture): Promise<void> {
  await f.core.stop();
  await rm(f.dir, { recursive: true, force: true });
}

function gatedAction(f: GatedFixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { job_id: f.job, app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {}, ...extra };
}

test('a made-up approval token does not open the gate', async (t) => {
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  for (const forged of ['yes', 'true', 'approved', '1']) {
    const r = await http(p.port, 'invoke_app_action', gatedAction(f, { approval_token: forged }));
    assert.equal(r.body.error, ErrorCode.E_APPROVAL_INVALID, `the gate opened for approval_token ${JSON.stringify(forged)}`);
  }
  assert.equal(f.seen.length, 0, 'a gated action reached the adapter without an approval');
});

test('a gated action names the pending approval so the operator can find it', async (t) => {
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  assert.equal(denied.body.error, ErrorCode.E_APPROVAL_REQUIRED);
  const approvalId = denied.body.approval_id;
  assert.ok(typeof approvalId === 'string' && approvalId.length > 0, 'the denial carried no approval id');

  const listed = await operator(p.port, 'approvals', {});
  const pending = listed.body.pending as Array<Record<string, unknown>>;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.approval_id, approvalId);

  // Retrying does not queue a second decision for the same action.
  await http(p.port, 'invoke_app_action', gatedAction(f));
  assert.equal(((await operator(p.port, 'approvals', {})).body.pending as unknown[]).length, 1);

  const s = await openStore({ path: f.path, nodeId: 'node' });
  assert.ok((await s.listEvents(f.job)).some((e) => e.kind === 'approval.requested'));
  await s.close();
});

test('the coordinator cannot approve its own action', async (t) => {
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  const approvalId = denied.body.approval_id as string;

  // The coordinator's own bearer, against the operator surface.
  const attempt = await operator(p.port, 'approve', { approval_id: approvalId }, token);
  assert.equal(attempt.status, 401, 'the coordinator token was accepted by the operator surface');

  const stillDenied = await http(p.port, 'invoke_app_action', gatedAction(f, { approval_token: approvalId }));
  assert.equal(stillDenied.body.error, ErrorCode.E_APPROVAL_INVALID);
  assert.equal(f.seen.length, 0);
});

test('an operator approval lets exactly one action through, once', async (t) => {
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  const approvalId = denied.body.approval_id as string;

  const granted = await operator(p.port, 'approve', { approval_id: approvalId });
  assert.equal(granted.status, 200);

  const allowed = await http(p.port, 'invoke_app_action', gatedAction(f, { approval_token: approvalId }));
  assert.equal(allowed.body.error, undefined, `approved action was refused: ${JSON.stringify(allowed.body)}`);
  assert.equal(f.seen.length, 1);

  // Spent. Replaying the same id must not authorise a second action.
  const replay = await http(p.port, 'invoke_app_action', gatedAction(f, { approval_token: approvalId }));
  assert.equal(replay.body.error, ErrorCode.E_APPROVAL_INVALID, 'an approval was spent twice');
  assert.equal(f.seen.length, 1);

  const s = await openStore({ path: f.path, nodeId: 'node' });
  assert.ok((await s.listEvents(f.job)).some((e) => e.kind === 'approval.resolved'));
  await s.close();
});

test('an approval does not carry to a different set of arguments', async (t) => {
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  // Approve the action with NO parameters.
  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  const approvalId = denied.body.approval_id as string;
  await operator(p.port, 'approve', { approval_id: approvalId });

  // Present it for the same capability with DIFFERENT parameters. The operator
  // approved doing one thing; this is another.
  const swapped = await http(p.port, 'invoke_app_action', gatedAction(f, { parameters: { path: 'elsewhere.txt' }, approval_token: approvalId }));
  assert.equal(swapped.body.error, ErrorCode.E_APPROVAL_INVALID, 'an approval was reused for different arguments');
  assert.equal(f.seen.length, 0);
});

test('a node that gates a capability refuses to start without a usable operator token', async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['absent', { operator_token: undefined }],
    ['too short', { operator_token: 'short' }],
    ['equal to the coordinator token', { operator_token: token }],
  ];
  for (const [label, override] of cases) {
    const f = await gatedFixture(override);
    try {
      await assert.rejects(f.core.start(), /operator_token/, `a gated node started with an operator token that was ${label}`);
    } finally {
      await finishGated(f);
    }
  }
});

test('answers a non-POST method with 405 and an Allow header, not 404', async (t) => {
  // 404 says the path does not exist, which is not what went wrong and leaves
  // the caller no way to learn what did. The resource is there; the method is
  // the problem, and HTTP has a code that says so.
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const result = await new Promise<{ status: number; allow: string | undefined }>((resolve, reject) => {
      const r = request(
        { host: '127.0.0.1', port: p.port, method, agent: false, path: '/tools/job_status', headers: { authorization: `Bearer ${token}` } },
        (response) => {
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode ?? 0, allow: response.headers.allow }));
        },
      );
      r.on('error', reject);
      r.end();
    });
    assert.equal(result.status, 405, `${method} was answered ${result.status}`);
    assert.equal(result.allow, 'POST', `${method} carried no usable Allow header`);
  }
});

test('an unknown tool is still 404', async (t) => {
  // The counterpart: 405 must not swallow the case where the path really is
  // wrong.
  const f = await fixture();
  t.after(() => finish(f));
  const p = await f.core.start();
  assert.equal((await http(p.port, 'no_such_tool', {})).status, 404);
});

// ---------------------------------------------------------------------------
// Approval hardening — the four weaknesses the security review found
// ---------------------------------------------------------------------------

test('the operator is shown the arguments, not only their digest', async (t) => {
  // A digest binds the decision but does not inform it. With only a hash on
  // screen the only account of what the action does comes from the coordinator
  // that requested it — the party the gate exists to constrain.
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  await http(p.port, 'invoke_app_action', gatedAction(f, { parameters: { path: 'quarterly.xlsx' } }));

  const listed = await operator(p.port, 'approvals', {});
  const pending = (listed.body.pending as Array<Record<string, unknown>>)[0];
  assert.ok(pending, 'nothing pending');
  assert.deepEqual(pending.arguments, { path: 'quarterly.xlsx' },
    'the operator surface did not carry the arguments being approved');
  // And the digest is still there, so the display and the binding agree.
  const binding = pending.binding as Record<string, unknown>;
  assert.equal(typeof binding.arguments_digest, 'string');
});

test('an action executes the arguments that were digested, including negative zero', async (t) => {
  // RFC 8785 serialises -0 as 0, but JSON.parse preserves the sign, so
  // {"v":-0} and {"v":0} shared a digest while an adapter could tell them
  // apart. One approval covered both, and the receipt attested to both.
  const f = await fixture({ allowed_capabilities: ['mock.run'] });
  t.after(() => finish(f));
  const p = await f.core.start();
  // The body must be RAW text. `JSON.stringify({value:-0})` emits `{"value":0}`,
  // so a test that builds its request through the normal helper cannot carry a
  // negative zero at all and passes whatever the server does. Only the literal
  // token `-0` survives to `JSON.parse`, which does preserve the sign.
  await rawPost(p.port, 'invoke_app_action',
    `{"job_id":"${f.job}","app_id":"mock","action_id":"run","workspace_id":"work","parameters":{"value":-0}}`);

  const seen = f.lastArgs?.value;
  assert.equal(typeof seen, 'number');
  assert.equal(Object.is(seen, -0), false, 'the adapter received -0, which no digest can distinguish from 0');
  assert.equal(seen, 0);
});

test('the coordinator cannot displace an approval the operator has granted', async (t) => {
  // Denied actions never reach incrementActionsUsed, so opening approval
  // requests is free. The registry used to evict its oldest entry whatever its
  // state, which let a coordinator push out the very decision the operator had
  // just made.
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();

  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  const approvalId = denied.body.approval_id as string;
  await operator(p.port, 'approve', { approval_id: approvalId });

  // Flood with distinct arguments, well past both caps.
  for (let i = 0; i < 60; i += 1) {
    await http(p.port, 'invoke_app_action', gatedAction(f, { parameters: { path: `f${i}.xlsx` } }));
  }

  // The granted approval is still spendable.
  const allowed = await http(p.port, 'invoke_app_action', gatedAction(f, { approval_token: approvalId }));
  assert.notEqual(allowed.body.error, ErrorCode.E_APPROVAL_INVALID,
    'a granted approval was evicted by the coordinator');
  assert.equal(f.seen.length, 1);
});

test('an approval is not granted when its audit entry cannot be written', async (t) => {
  // approve() used to flip the flag and then append. A failed append returned
  // an error to the operator but left the approval spendable, so the action
  // could run with no approval.resolved in the log.
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  const approvalId = denied.body.approval_id as string;

  // Break the log for the duration of the grant.
  const store = (f.core as unknown as { store: { appendEvent: (i: unknown) => Promise<unknown> } }).store;
  const realAppend = store.appendEvent.bind(store);
  store.appendEvent = () => Promise.reject(new Error('disk full'));
  const attempt = await operator(p.port, 'approve', { approval_id: approvalId });
  store.appendEvent = realAppend;

  assert.notEqual(attempt.status, 200, 'the grant reported success despite a failed audit write');
  const afterwards = await http(p.port, 'invoke_app_action', gatedAction(f, { approval_token: approvalId }));
  assert.equal(afterwards.body.error, ErrorCode.E_APPROVAL_INVALID,
    'an approval whose audit entry failed was still spendable');
  assert.equal(f.seen.length, 0);
});

test('granting the same approval twice records one decision', async (t) => {
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  const approvalId = denied.body.approval_id as string;

  await operator(p.port, 'approve', { approval_id: approvalId });
  const again = await operator(p.port, 'approve', { approval_id: approvalId });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_approved, true);

  const s = await openStore({ path: f.path, nodeId: 'node' });
  const resolved = (await s.listEvents(f.job)).filter((e) => e.kind === 'approval.resolved');
  await s.close();
  assert.equal(resolved.length, 1, 'a repeated grant wrote a second approval.resolved');
});

test('stopping the node clears pending approvals and session correlations', async (t) => {
  // Both are documented as process-scoped: DEPLOY.md states a restart clears
  // pending decisions, and the ObserverDeps contract says a correlation id from
  // a previous run resolves to nothing because its CLI child did not survive.
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const p = await f.core.start();
  const denied = await http(p.port, 'invoke_app_action', gatedAction(f));
  const approvalId = denied.body.approval_id as string;
  await operator(p.port, 'approve', { approval_id: approvalId });

  await f.core.stop();
  const again = await f.core.start();

  assert.equal(((await operator(again.port, 'approvals', {})).body.pending as unknown[]).length, 0);
  const afterRestart = await http(again.port, 'invoke_app_action', gatedAction(f, { approval_token: approvalId }));
  assert.equal(afterRestart.body.error, ErrorCode.E_APPROVAL_INVALID,
    'an approval survived a restart that is documented to clear it');
});

test('only the operator can list findings, and the result is job-scoped', async (t) => {
  const f = await gatedFixture();
  t.after(() => finishGated(f));
  const store = await openStore({ path: f.path, nodeId: 'node' });
  await store.putFinding({
    finding_id: 'finding-visible', receipt_id: null, job_id: f.job, session_id: null,
    correlation: 'none', rule_id: 'test.monitor_only', severity: 'medium',
    title: '<img src=x onerror=alert(1)>', observed_at: '2026-08-09T00:00:00.000Z',
    detail: { source: 'numbat' },
  });
  await store.close();

  const p = await f.core.start();
  const listed = await operator(p.port, 'findings', { job_id: f.job });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (listed.body.findings as Array<Record<string, unknown>>).map((finding) => finding.finding_id),
    ['finding-visible'],
  );

  const other = await operator(p.port, 'findings', { job_id: '55555555-5555-4555-8555-555555555555' });
  assert.deepEqual(other.body.findings, []);

  const coordinator = await operator(p.port, 'findings', { job_id: f.job }, token);
  assert.equal(coordinator.status, 401);

  const actionResult = await http(p.port, 'invoke_app_action', gatedAction(f));
  assert.equal(actionResult.body.error, ErrorCode.E_APPROVAL_REQUIRED,
    'reading findings changed enforcement behaviour');
});
