import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  ErrorCode,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AdapterManifest,
  type JsonValue,
  type SessionAdapter,
} from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';

import {
  approvalTtlMinutes,
  createApprovalRegistry,
  type ApprovalReplayAction,
} from '../src/approvals.js';
import {
  createNodeCore,
  type CoordinatorControl,
  type CoordinatorRun,
  type CoordinatorStartInput,
  type NodeCore,
} from '../src/index.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const otherJobId = '22222222-2222-4222-8222-222222222222';
const token = 'node-core-replay-test-token';
const operatorToken = 'operator-token-that-is-at-least-32-characters';

const manifest: AdapterManifest = {
  id: 'mock',
  version: '1.0.0',
  platforms: ['linux', 'win32', 'darwin'],
  actions: [{
    id: 'run',
    summary: 'Run an exact mock action',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        nested: { type: 'object', additionalProperties: true },
      },
      required: ['path', 'nested'],
      additionalProperties: false,
    },
    path_fields: ['path'],
    mutates: true,
    always_requires_approval: false,
  }],
  required_permissions: [],
  allowed_resources: [],
  default_timeout_ms: 1_000,
  cancellation: 'graceful',
  receipt_fields: [],
};

const cliManifest: AdapterManifest = {
  id: 'mockcli', version: '1.0.0', platforms: ['linux', 'win32', 'darwin'],
  actions: [
    { id: 'start', summary: 'Start', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'send', summary: 'Send', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
    { id: 'read', summary: 'Read', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: false, always_requires_approval: false },
    { id: 'stop', summary: 'Stop', input_schema: { type: 'object', additionalProperties: false }, path_fields: [], mutates: true, always_requires_approval: false },
  ],
  required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000,
  cancellation: 'kill', receipt_fields: ['exchange_state', 'exchange_error'],
};

interface Invocation {
  readonly actionId: string;
  readonly args: Readonly<Record<string, JsonValue>>;
  readonly context: AdapterContext;
}

interface Fixture {
  readonly core: NodeCore;
  readonly dir: string;
  readonly path: string;
  readonly port: number;
  readonly invocations: Invocation[];
  readonly cliInvocations: Invocation[];
  readonly starts: CoordinatorStartInput[];
  readonly startJobIds: string[];
}

type StartHook = (jobId: string, input: CoordinatorStartInput) => Promise<void>;

function coordinator(starts: CoordinatorStartInput[], startJobIds: string[], onStart?: StartHook, trackStatus = false): CoordinatorControl {
  const active = new Map<string, CoordinatorRun>();
  const endedListeners: Array<(runId: string) => void> = [];
  return {
    async start(startedJobId, input = {}) {
      await onStart?.(startedJobId, input);
      starts.push(input);
      startJobIds.push(startedJobId);
      const run: CoordinatorRun = {
        run_id: `run-${starts.length}`,
        job_id: startedJobId,
        state: 'running',
        started_at: new Date().toISOString(),
        ended_at: null,
        exit_code: null,
        messages: [],
      };
      if (trackStatus) active.set(startedJobId, run);
      return run;
    },
    status(startedJobId) { return trackStatus ? active.get(startedJobId) ?? null : null; },
    async stop(startedJobId) {
      if (!trackStatus) return null;
      const run = active.get(startedJobId);
      if (run === undefined) return null;
      active.delete(startedJobId);
      const stopped: CoordinatorRun = { ...run, state: 'stopped', ended_at: new Date().toISOString(), exit_code: 0 };
      for (const listener of endedListeners) listener(run.run_id);
      return stopped;
    },
    async stopAll() {
      if (!trackStatus) return;
      for (const run of active.values()) for (const listener of endedListeners) listener(run.run_id);
      active.clear();
    },
    onRunEnded(listener) { endedListeners.push(listener); },
  };
}

async function fixture(options: {
  readonly maxActions?: number;
  readonly approvalTtlMinutes?: number;
  readonly expiresAt?: string;
  readonly invokeDelayMs?: number;
  readonly onInvoke?: () => void | Promise<void>;
  readonly onCliInvoke?: () => void | Promise<void>;
  readonly onStart?: StartHook;
  readonly trackCoordinatorStatus?: boolean;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-approval-replay-'));
  const path = join(dir, 'node.sqlite');
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: jobId,
    objective: 'Replay one exact action',
    allowed_capabilities: ['mock.run', 'mockcli.start', 'mockcli.send'],
    allowed_workspaces: ['primary', 'alternate'],
    acceptance: ['The approved action runs exactly once'],
    forbidden: [],
    max_actions: options.maxActions ?? 3,
    max_retries: 1,
    expires_at: options.expiresAt ?? '2999-01-01T00:00:00Z',
  }));
  await store.createJob(sealEnvelope({
    job_id: otherJobId,
    objective: 'Wrong-job replay target',
    allowed_capabilities: ['mock.run'],
    allowed_workspaces: ['alternate'],
    acceptance: ['No wrong-job approval executes'],
    forbidden: [], max_actions: 3, max_retries: 1, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  const invocations: Invocation[] = [];
  const cliInvocations: Invocation[] = [];
  const adapter: Adapter = {
    manifest,
    async init() {},
    async invoke(actionId, args, context): Promise<ActionResult> {
      await options.onInvoke?.();
      if ((options.invokeDelayMs ?? 0) > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, options.invokeDelayMs));
      invocations.push({ actionId, args, context });
      return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const cliAdapter: SessionAdapter = {
    manifest: cliManifest,
    async init() {},
    async invoke(actionId, args, context): Promise<ActionResult> {
      await options.onCliInvoke?.();
      cliInvocations.push({ actionId, args, context });
      return { output: 'sent', truncated: false, artifacts: [], receipt_extra: { exchange_state: 'succeeded', exchange_error: null } };
    },
    async dispose() {},
    async start() { return { pid: -1 }; },
    async send() {},
    async read() { return { chunk: '', cursor: 0 }; },
    async interrupt() {},
    async stop() {},
  };
  const starts: CoordinatorStartInput[] = [];
  const startJobIds: string[] = [];
  await mkdir(join(dir, 'primary'), { recursive: true });
  await mkdir(join(dir, 'alternate'), { recursive: true });
  const core = createNodeCore({
    node_id: 'node',
    db_path: path,
    workspaces: [
      { id: 'primary', root: join(dir, 'primary') },
      { id: 'alternate', root: join(dir, 'alternate') },
    ],
    port: 0,
    token,
    operator_token: operatorToken,
    adapters: [adapter, cliAdapter],
    observer: null,
    approval_required: ['mock.run', 'mockcli.send'],
    approval_ttl_minutes: options.approvalTtlMinutes ?? 60,
    coordinator: coordinator(starts, startJobIds, options.onStart, options.trackCoordinatorStatus ?? false),
  });
  const started = await core.start();
  return { core, dir, path, port: started.port, invocations, cliInvocations, starts, startJobIds };
}

async function finish(value: Fixture): Promise<void> {
  await value.core.stop();
  await rm(value.dir, { recursive: true, force: true });
}

async function post(port: number, surface: 'tools' | 'operator', operation: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/${surface}/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${surface === 'operator' ? operatorToken : token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function signal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolveSignal!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolveSignal = resolvePromise; });
  return { promise, resolve: resolveSignal };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const exactParameters: Readonly<Record<string, JsonValue>> = {
  path: 'nested/result.txt',
  nested: { order: [3, 1, 2], flags: { enabled: true, note: 'exact' } },
};

async function gate(value: Fixture): Promise<string> {
  const denied = await post(value.port, 'tools', 'invoke_app_action', {
    job_id: jobId,
    app_id: 'mock',
    action_id: 'run',
    workspace_id: 'alternate',
    parameters: exactParameters,
    model: 'original-model',
  });
  assert.equal(denied.body['error'], ErrorCode.E_APPROVAL_REQUIRED);
  assert.equal(typeof denied.body['approval_id'], 'string');
  return denied.body['approval_id'] as string;
}

async function grant(value: Fixture, approvalId: string): Promise<void> {
  const granted = await post(value.port, 'operator', 'approve', { approval_id: approvalId });
  assert.equal(granted.status, 200);
}

test('operator start replays the exact approved action and spends it before coordinator start', async (t) => {
  let checkedBeforeStart = false;
  let current: Fixture | null = null;
  const f = await fixture({
    onStart: async () => {
      assert.ok(current);
      const store = await openStore({ path: current.path, nodeId: 'node' });
      const receipts = await store.listReceipts(jobId);
      const replay = receipts.find((receipt) => receipt.outcome === 'succeeded');
      assert.ok(replay, 'successful replay receipt was not durable before coordinator start');
      const events = await store.listEvents(jobId);
      for (const kind of ['action.requested', 'action.started', 'action.finished']) {
        assert.equal(events.some((event) => event.kind === kind
          && (event.payload as Readonly<Record<string, JsonValue>>)['receipt_id'] === replay.receipt_id), true, `${kind} missing before coordinator start`);
      }
      assert.equal(events.some((event) => event.kind === 'action.decided'
        && (event.payload as Readonly<Record<string, JsonValue>>)['allow'] === true), true, 'allowed action.decided missing before coordinator start');
      await store.close();
      checkedBeforeStart = true;
    },
  });
  current = f;
  t.after(() => finish(f));

  const approvalId = await gate(f);
  await grant(f, approvalId);
  const started = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(checkedBeforeStart, true);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0]?.actionId, 'run');
  assert.deepEqual(f.invocations[0]?.args, { ...exactParameters, path: resolve(f.dir, 'alternate', 'nested/result.txt') });
  assert.equal(f.invocations[0]?.context.workspace.id, 'alternate');

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(jobId);
  const replay = receipts.find((receipt) => receipt.outcome === 'succeeded');
  assert.ok(replay);
  assert.equal(replay.actor, 'original-model');
  const resolved = (await store.listEvents(jobId)).find((event) => event.kind === 'approval.resolved');
  assert.ok(resolved);
  const resolvedPayload = resolved.payload as Readonly<Record<string, JsonValue>>;
  assert.equal(replay.arguments_digest, resolvedPayload['arguments_digest']);
  assert.equal(replay.capability, resolvedPayload['capability']);
  await store.close();
  assert.equal(Object.prototype.hasOwnProperty.call(f.starts[0] ?? {}, 'approval_id'), false);

  const second = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  assert.equal(second.body['error'], ErrorCode.E_APPROVAL_INVALID);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.starts.length, 1);
});

test('unknown, pending, and wrong-job ids are invalid without consuming the correct grant', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const approvalId = await gate(f);
  for (const [candidate, requestedJob] of [
    ['unknown-approval', jobId],
    [approvalId, jobId],
  ] as const) {
    const result = await post(f.port, 'operator', 'hermes_start', { job_id: requestedJob, approval_id: candidate });
    assert.equal(result.body['error'], ErrorCode.E_APPROVAL_INVALID);
  }
  assert.equal(f.invocations.length, 0);
  assert.equal(f.starts.length, 0);
  await grant(f, approvalId);
  const wrongJob = await post(f.port, 'operator', 'hermes_start', { job_id: otherJobId, approval_id: approvalId });
  assert.equal(wrongJob.body['error'], ErrorCode.E_APPROVAL_INVALID);
  const correct = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  assert.equal(correct.status, 200, JSON.stringify(correct.body));
  assert.equal(f.invocations.length, 1, 'wrong-job lookup consumed the valid grant');
});

test('existing-session CLI replay retains the exact session, workspace, and actor', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const started = await post(f.port, 'tools', 'start_cli', {
    job_id: jobId, cli_id: 'mockcli', workspace_id: 'alternate', model: 'session-creator',
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const sessionId = started.body['receipt_id'];
  assert.equal(typeof sessionId, 'string');
  const denied = await post(f.port, 'tools', 'send_cli', {
    job_id: jobId, session_id: sessionId, message: 'exact session message', model: 'original-cli-model',
  });
  assert.equal(denied.body['error'], ErrorCode.E_APPROVAL_REQUIRED);
  const approvalId = denied.body['approval_id'];
  assert.equal(typeof approvalId, 'string');
  await grant(f, approvalId as string);
  const replayed = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(f.cliInvocations.length, 1);
  assert.deepEqual(f.cliInvocations[0]?.args, { message: 'exact session message' });
  assert.equal(f.cliInvocations[0]?.context.session_id, sessionId);
  assert.equal(f.cliInvocations[0]?.context.workspace.id, 'alternate');
  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipt = (await store.listReceipts(jobId)).find((item) => item.capability === 'mockcli.send' && item.outcome === 'succeeded');
  assert.ok(receipt);
  assert.equal(receipt.session_id, sessionId);
  assert.equal(receipt.actor, 'original-cli-model');
  await store.close();
});

test('overlapping starts cannot execute one approval twice', async (t) => {
  const replayEntered = signal();
  const f = await fixture({ invokeDelayMs: 50, onInvoke: () => replayEntered.resolve() });
  t.after(() => finish(f));
  const approvalId = await gate(f);
  await grant(f, approvalId);
  const firstStart = post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  await replayEntered.promise;
  const secondStart = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  const firstResult = await firstStart;
  assert.equal(firstResult.status, 200, JSON.stringify(firstResult.body));
  assert.equal(secondStart.status, 409);
  assert.equal(secondStart.body['error'], ErrorCode.E_PARALLEL_ACTION);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.starts.length, 1);
});

test('ordinary start cannot overtake a slow approved replay for the same job', async (t) => {
  const replayEntered = signal();
  let checkedBeforeStart = false;
  let current: Fixture | null = null;
  const f = await fixture({
    invokeDelayMs: 150,
    onInvoke: () => replayEntered.resolve(),
    onStart: async (startedJobId) => {
      assert.equal(startedJobId, jobId);
      assert.ok(current);
      const store = await openStore({ path: current.path, nodeId: 'node' });
      const replay = (await store.listReceipts(jobId)).find((receipt) => receipt.outcome === 'succeeded');
      assert.ok(replay, 'successful replay receipt was not durable before coordinator start');
      const events = await store.listEvents(jobId);
      for (const kind of ['action.requested', 'action.started', 'action.finished']) {
        assert.equal(events.some((event) => event.kind === kind
          && (event.payload as Readonly<Record<string, JsonValue>>)['receipt_id'] === replay.receipt_id), true, `${kind} missing before coordinator start`);
      }
      assert.equal(events.some((event) => event.kind === 'action.decided'
        && (event.payload as Readonly<Record<string, JsonValue>>)['allow'] === true), true, 'allowed action.decided missing before coordinator start');
      await store.close();
      checkedBeforeStart = true;
    },
  });
  current = f;
  t.after(() => finish(f));

  const approvalId = await gate(f);
  await grant(f, approvalId);
  const approvedStart = post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  await replayEntered.promise;
  await delay(25);
  const ordinaryStart = post(f.port, 'operator', 'hermes_start', { job_id: jobId });
  const [approved, ordinary] = await Promise.all([approvedStart, ordinaryStart]);

  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((approved.body['run'] as Readonly<Record<string, unknown>> | undefined)?.['run_id'], 'run-1');
  assert.notEqual(approved.body['error'], ErrorCode.E_ADAPTER_FAILURE);
  assert.equal(ordinary.status, 409);
  assert.equal(ordinary.body['error'], ErrorCode.E_PARALLEL_ACTION);
  assert.equal(checkedBeforeStart, true);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.starts.length, 1);

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const boundJob = await store.getJob(jobId);
  assert.ok(boundJob?.conversation_id);
  assert.equal(boundJob.conversation_id, f.starts[0]?.conversation_id);
  await store.close();
});

test('pipeline resume cannot bypass an approved operator start and repairs the real stage graph', async (t) => {
  const replayEntered = signal();
  const releaseReplay = signal();
  let current: Fixture | null = null;
  let pipelineJobId: string | null = null;
  let verifyApprovedStart = false;
  let receiptChainChecked = false;
  const f = await fixture({
    trackCoordinatorStatus: true,
    onCliInvoke: async () => {
      replayEntered.resolve();
      await releaseReplay.promise;
    },
    onStart: async (startedJobId) => {
      if (!verifyApprovedStart || startedJobId !== pipelineJobId) return;
      verifyApprovedStart = false;
      assert.ok(current);
      const store = await openStore({ path: current.path, nodeId: 'node' });
      const replay = (await store.listReceipts(startedJobId)).find((receipt) => receipt.capability === 'mockcli.send' && receipt.outcome === 'succeeded');
      assert.ok(replay, 'successful replay receipt was not durable before the approved coordinator start');
      const events = await store.listEvents(startedJobId);
      for (const kind of ['action.requested', 'action.started', 'action.finished']) {
        assert.equal(events.some((event) => event.kind === kind
          && (event.payload as Readonly<Record<string, JsonValue>>)['receipt_id'] === replay.receipt_id), true, `${kind} missing before approved coordinator start`);
      }
      assert.equal(events.some((event) => event.kind === 'action.decided'
        && (event.payload as Readonly<Record<string, JsonValue>>)['allow'] === true), true, 'allowed action.decided missing before approved coordinator start');
      await store.close();
      receiptChainChecked = true;
    },
  });
  current = f;
  t.after(() => { releaseReplay.resolve(); });
  t.after(() => finish(f));
  const pipelineStages = ['specification', 'implementation', 'code_review', 'security_review'].map((stageId) => ({
    stage_id: stageId, adapter_id: 'mockcli', max_actions: 10,
    max_action_retries: 1, timeout_minutes: 30, max_attempts: 3,
  }));

  const created = await post(f.port, 'operator', 'pipeline_create', {
    objective: 'Exercise the shared coordinator-start guard',
    workspace_id: 'primary',
    deadline_minutes: 60,
    stages: pipelineStages,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const pipelineId = created.body['pipeline_id'];
  const createdStages = created.body['stages'] as Array<Record<string, unknown>> | undefined;
  assert.equal(typeof pipelineId, 'string');
  assert.ok(createdStages);
  pipelineJobId = createdStages[0]?.['job_id'] as string | null;
  assert.equal(typeof pipelineJobId, 'string');
  const stageJobId = pipelineJobId as string;
  const attempt = createdStages[0]?.['attempt'];
  const initialAStarts = f.startJobIds.filter((startedJobId) => startedJobId === stageJobId).length;
  assert.equal(initialAStarts, 1, 'pipeline creation should perform one initial coordinator start');

  const paused = await post(f.port, 'operator', 'pipeline_pause', { pipeline_id: pipelineId });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body['state'], 'paused');
  const pausedStages = paused.body['stages'] as Array<Record<string, unknown>>;
  assert.equal(pausedStages[0]?.['state'], 'paused');
  const originalStartedAt = pausedStages[0]?.['started_at'];

  const session = await post(f.port, 'tools', 'start_cli', {
    job_id: stageJobId, cli_id: 'mockcli', workspace_id: 'primary', model: 'pipeline-fixture',
  });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  const sessionId = session.body['receipt_id'];
  assert.equal(typeof sessionId, 'string');
  const gated = await post(f.port, 'tools', 'send_cli', {
    job_id: stageJobId, session_id: sessionId, message: 'approved exact pipeline action', model: 'pipeline-fixture',
  });
  assert.equal(gated.body['error'], ErrorCode.E_APPROVAL_REQUIRED);
  const approvalId = gated.body['approval_id'];
  assert.equal(typeof approvalId, 'string');
  await grant(f, approvalId as string);

  const storeBefore = await openStore({ path: f.path, nodeId: 'node' });
  const boundBefore = await storeBefore.getJob(stageJobId);
  assert.ok(boundBefore?.conversation_id);
  const turnsBefore = await storeBefore.listTurns(boundBefore.conversation_id);
  await storeBefore.close();

  verifyApprovedStart = true;
  const approvedStart = post(f.port, 'operator', 'hermes_start', { job_id: stageJobId, approval_id: approvalId });
  await replayEntered.promise;

  const losingResume = await Promise.race([
    post(f.port, 'operator', 'pipeline_resume', { pipeline_id: pipelineId, operator_message: 'losing resume must not persist' }),
    delay(1_000).then(() => null),
  ]);
  assert.ok(losingResume, 'same-job pipeline resume waited instead of failing fast');
  assert.equal(losingResume.status, 409, JSON.stringify(losingResume.body));
  assert.equal(losingResume.body['error'], ErrorCode.E_PARALLEL_ACTION);

  const independent = await Promise.race([
    post(f.port, 'operator', 'pipeline_create', {
      objective: 'Independent pipeline B', workspace_id: 'primary', deadline_minutes: 60,
      stages: pipelineStages,
    }),
    delay(1_000).then(() => null),
  ]);
  assert.ok(independent, 'different-job pipeline did not start while A replay was held');
  assert.equal(independent.status, 200, JSON.stringify(independent.body));
  assert.equal(independent.body['state'], 'running');
  assert.equal((independent.body['stages'] as Array<Record<string, unknown>>)[0]?.['state'], 'running');

  const listedWhileHeld = await post(f.port, 'operator', 'pipelines', {});
  const publicGraphs = listedWhileHeld.body['pipelines'] as Array<Record<string, unknown>>;
  const publicA = publicGraphs.find((graph) => graph['pipeline_id'] === pipelineId);
  assert.equal(publicA?.['state'], 'paused');
  assert.equal((publicA?.['stages'] as Array<Record<string, unknown>>)[0]?.['state'], 'paused');
  assert.equal((publicA?.['stages'] as Array<Record<string, unknown>>)[0]?.['started_at'], originalStartedAt);

  const persistedWhileHeld = JSON.parse(await readFile(`${f.path}.stage-graphs.json`, 'utf8')) as { pipelines: Array<Record<string, unknown>> };
  const persistedA = persistedWhileHeld.pipelines.find((graph) => graph['pipeline_id'] === pipelineId);
  assert.equal(persistedA?.['state'], 'paused');
  assert.equal((persistedA?.['stages'] as Array<Record<string, unknown>>)[0]?.['state'], 'paused');
  assert.equal((persistedA?.['stages'] as Array<Record<string, unknown>>)[0]?.['started_at'], originalStartedAt);

  releaseReplay.resolve();
  const approved = await approvedStart;
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(receiptChainChecked, true);
  assert.equal(f.cliInvocations.length, 1);
  assert.equal(f.startJobIds.filter((startedJobId) => startedJobId === stageJobId).length - initialAStarts, 1, 'critical window must contain exactly one A coordinator start');

  const listedAfterApproved = await post(f.port, 'operator', 'pipelines', {});
  const publicAfterApproved = (listedAfterApproved.body['pipelines'] as Array<Record<string, unknown>>).find((graph) => graph['pipeline_id'] === pipelineId);
  assert.equal(publicAfterApproved?.['state'], 'paused');
  assert.equal((publicAfterApproved?.['stages'] as Array<Record<string, unknown>>)[0]?.['state'], 'paused');
  const persistedAfterApproved = JSON.parse(await readFile(`${f.path}.stage-graphs.json`, 'utf8')) as { pipelines: Array<Record<string, unknown>> };
  const durableAfterApproved = persistedAfterApproved.pipelines.find((graph) => graph['pipeline_id'] === pipelineId);
  assert.equal(durableAfterApproved?.['state'], 'paused');
  assert.equal((durableAfterApproved?.['stages'] as Array<Record<string, unknown>>)[0]?.['state'], 'paused');

  const approvedStartIndex = f.startJobIds.lastIndexOf(stageJobId);
  const approvedInput = f.starts[approvedStartIndex];
  const storeAfter = await openStore({ path: f.path, nodeId: 'node' });
  const boundAfter = await storeAfter.getJob(stageJobId);
  assert.equal(boundAfter?.conversation_id, boundBefore.conversation_id);
  assert.equal(approvedInput?.conversation_id, boundBefore.conversation_id);
  const turnsAfter = await storeAfter.listTurns(boundBefore.conversation_id);
  assert.equal(turnsAfter.length, turnsBefore.length, 'losing resume appended an operator turn');
  const receipts = await storeAfter.listReceipts(stageJobId);
  const replay = receipts.find((receipt) => receipt.capability === 'mockcli.send' && receipt.outcome === 'succeeded');
  assert.ok(replay);
  const resolved = (await storeAfter.listEvents(stageJobId)).find((event) => event.kind === 'approval.resolved');
  assert.ok(resolved);
  assert.equal(replay.arguments_digest, (resolved.payload as Readonly<Record<string, JsonValue>>)['arguments_digest']);
  assert.equal(replay.capability, (resolved.payload as Readonly<Record<string, JsonValue>>)['capability']);
  await storeAfter.close();

  const stopped = await post(f.port, 'operator', 'hermes_stop', { job_id: stageJobId });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  const recovered = await post(f.port, 'operator', 'pipeline_resume', { pipeline_id: pipelineId, operator_message: 'recover the same paused attempt' });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body['state'], 'running');
  const recoveredStage = (recovered.body['stages'] as Array<Record<string, unknown>>)[0];
  assert.equal(recoveredStage?.['state'], 'running');
  assert.equal(recoveredStage?.['job_id'], stageJobId);
  assert.equal(recoveredStage?.['attempt'], attempt);
  assert.equal(f.cliInvocations.length, 1, 'recovery replayed the spent approved action');
  assert.equal(f.startJobIds.filter((startedJobId) => startedJobId === stageJobId).length - initialAStarts, 2, 'recovery should add exactly one later A start');
  const recoveryStartIndex = f.startJobIds.lastIndexOf(stageJobId);
  const recoveryToken = f.starts[recoveryStartIndex]?.run_token;
  assert.equal(typeof recoveryToken, 'string');
  const credentialCheck = await post(f.port, 'tools', 'list_turns', { run_token: recoveryToken });
  assert.equal(credentialCheck.status, 200, JSON.stringify(credentialCheck.body));
});

test('a guarded replay for one job does not block a start for another job', async (t) => {
  const replayEntered = signal();
  const releaseReplay = signal();
  const f = await fixture({
    onInvoke: async () => {
      replayEntered.resolve();
      await releaseReplay.promise;
    },
  });
  t.after(() => { releaseReplay.resolve(); });
  t.after(() => finish(f));
  const approvalId = await gate(f);
  await grant(f, approvalId);

  const approvedStart = post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  await replayEntered.promise;
  const independent = await Promise.race([
    post(f.port, 'operator', 'hermes_start', { job_id: otherJobId }),
    delay(1_000).then(() => null),
  ]);
  assert.ok(independent, 'different-job start did not complete while replay was held');
  assert.equal(independent.status, 200, JSON.stringify(independent.body));
  assert.equal((independent.body['run'] as Readonly<Record<string, unknown>> | undefined)?.['job_id'], otherJobId);
  releaseReplay.resolve();
  const approved = await approvedStart;
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(f.invocations.length, 1);
  assert.equal(f.starts.length, 2);
});

test('the start guard releases after an invalid approval', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const invalid = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: 'unknown-approval' });
  assert.equal(invalid.body['error'], ErrorCode.E_APPROVAL_INVALID);
  const retry = await post(f.port, 'operator', 'hermes_start', { job_id: jobId });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(f.starts.length, 1);
});

test('the start guard releases and the run credential unwinds after coordinator start rejection', async (t) => {
  let rejectNextStart = true;
  let rejectedRunToken: string | null = null;
  const f = await fixture({
    onStart: async (_startedJobId, input) => {
      if (!rejectNextStart) return;
      rejectNextStart = false;
      rejectedRunToken = input.run_token ?? null;
      throw new Error('fixture coordinator start rejection');
    },
  });
  t.after(() => finish(f));

  const failed = await post(f.port, 'operator', 'hermes_start', { job_id: jobId });
  assert.equal(failed.body['error'], ErrorCode.E_ADAPTER_FAILURE);
  assert.equal(typeof rejectedRunToken, 'string');
  const credentialCheck = await post(f.port, 'tools', 'list_turns', { run_token: rejectedRunToken });
  assert.equal(credentialCheck.body['error'], ErrorCode.E_RUN_INVALID);

  const retry = await post(f.port, 'operator', 'hermes_start', { job_id: jobId });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal((retry.body['run'] as Readonly<Record<string, unknown>> | undefined)?.['run_id'], 'run-1');
  assert.equal(f.starts.length, 1);
});

for (const scenario of ['terminal', 'budget'] as const) {
  test(`current policy denies ${scenario} replay with a denial receipt`, async (t) => {
    const f = await fixture({ maxActions: 1 });
    t.after(() => finish(f));
    const approvalId = await gate(f);
    await grant(f, approvalId);
    const store = await openStore({ path: f.path, nodeId: 'node' });
    if (scenario === 'terminal') await store.setJobState(jobId, 'cancelled');
    else await store.incrementActionsUsed(jobId);
    await store.close();

    const result = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
    assert.equal(result.body['error'], scenario === 'terminal' ? ErrorCode.E_JOB_TERMINAL : ErrorCode.E_BUDGET_EXHAUSTED);
    assert.equal(f.invocations.length, 0);
    assert.equal(f.starts.length, 0);
    const audit = await openStore({ path: f.path, nodeId: 'node' });
    const denial = (await audit.listReceipts(jobId)).at(-1);
    assert.equal(denial?.outcome, 'denied');
    assert.equal(denial?.decision.allow, false);
    if (denial?.decision.allow === false) assert.equal(denial.decision.code, result.body['error']);
    assert.notEqual(denial?.ended_at, null);
    await audit.close();
  });
}

test('a grant at the strict TTL boundary is invalid and executes nothing', async (t) => {
  const RealDate = Date;
  let clock = Date.parse('2026-08-22T00:00:00.000Z');
  class ControlledDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? clock : value instanceof RealDate ? value.getTime() : value);
    }
    static override now(): number { return clock; }
  }
  globalThis.Date = ControlledDate as DateConstructor;
  t.after(() => { globalThis.Date = RealDate; });
  const f = await fixture({ approvalTtlMinutes: 1 });
  t.after(() => finish(f));
  const approvalId = await gate(f);
  await grant(f, approvalId);
  clock += 60 * 1000;
  const result = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  assert.equal(result.body['error'], ErrorCode.E_APPROVAL_INVALID);
  assert.equal(f.invocations.length, 0);
  assert.equal(f.starts.length, 0);
});

test('an envelope that expires after grant is denied by policy with E_EXPIRED', async (t) => {
  const RealDate = Date;
  let clock = Date.parse('2026-08-22T00:00:00.000Z');
  class ControlledDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? clock : value instanceof RealDate ? value.getTime() : value);
    }
    static override now(): number { return clock; }
  }
  globalThis.Date = ControlledDate as DateConstructor;
  t.after(() => { globalThis.Date = RealDate; });
  const f = await fixture({ approvalTtlMinutes: 60, expiresAt: '2026-08-22T00:00:30.000Z' });
  t.after(() => finish(f));
  const approvalId = await gate(f);
  await grant(f, approvalId);
  clock += 31 * 1000;
  const result = await post(f.port, 'operator', 'hermes_start', { job_id: jobId, approval_id: approvalId });
  assert.equal(result.body['error'], ErrorCode.E_EXPIRED);
  assert.equal(f.invocations.length, 0);
  assert.equal(f.starts.length, 0);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  const denial = (await store.listReceipts(jobId)).at(-1);
  assert.equal(denial?.outcome, 'denied');
  assert.equal(denial?.decision.allow, false);
  if (denial?.decision.allow === false) assert.equal(denial.decision.code, ErrorCode.E_EXPIRED);
  await store.close();
});

test('approval TTL config validates bounds and defaults to sixty minutes', () => {
  assert.equal(approvalTtlMinutes(undefined), 60);
  assert.equal(approvalTtlMinutes(1), 1);
  assert.equal(approvalTtlMinutes(1440), 1440);
  for (const invalid of [0, -1, 1441, 1.5, '60', null]) {
    assert.throws(() => approvalTtlMinutes(invalid), /integer from 1 to 1440/);
  }

  const action: ApprovalReplayAction = {
    tool: 'invoke_app_action', job_id: jobId, capability: 'mock.run', action_id: 'run',
    arguments: exactParameters, workspace_id: 'alternate', session_id: null,
    session_adapter_id: null, actor: 'original-model',
  };
  const registry = createApprovalRegistry();
  const at = new Date(0);
  const request = registry.request({ job_id: jobId, capability: 'mock.run', arguments_digest: 'digest' }, exactParameters, action, at);
  assert.ok(request);
  assert.equal(Date.parse(request.expires_at) - at.getTime(), 60 * 60 * 1000);
  registry.approve(request.approval_id, at);
  assert.notEqual(registry.replay(request.approval_id, jobId, new Date(60 * 60 * 1000 - 1)), null);
  assert.equal(registry.replay(request.approval_id, jobId, new Date(60 * 60 * 1000)), null);
});
