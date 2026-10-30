import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ErrorCode,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AdapterManifest,
  type JsonValue,
  type SealedEnvelope,
  type SessionAdapter,
  type Store,
} from '@toros/contracts';
import { openStore } from '@toros/store';
import {
  createNodeCore,
  type CoordinatorControl,
  type CoordinatorRun,
  type CoordinatorStartInput,
} from '../src/index.js';
import { deriveJobId } from '../src/draft.js';
import { MODEL_PROFILES } from '../src/model-profiles.js';

const coordinatorToken = 'coordinator-token-for-operator-workspace';
const operatorToken = 'operator-token-for-operator-workspace-1234';

const manifest: AdapterManifest = {
  id: 'mock',
  version: '1.0.0',
  platforms: [process.platform as 'win32' | 'linux' | 'darwin'],
  actions: [{
    id: 'run', summary: 'Run', input_schema: { type: 'object', additionalProperties: false },
    path_fields: [], mutates: false, always_requires_approval: false,
  }],
  required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000,
  cancellation: 'graceful', receipt_fields: [],
};

const adapter: Adapter = {
  manifest,
  async init() {},
  async invoke(_action: string, _args: Readonly<Record<string, JsonValue>>, _context: AdapterContext): Promise<ActionResult> {
    return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
  },
  async dispose() {},
};

let runCounter = 0;

const cliManifest: AdapterManifest = {
  id: 'codex',
  version: '1.0.0',
  platforms: [process.platform as 'win32' | 'linux' | 'darwin'],
  actions: ['start', 'send', 'read', 'interrupt', 'stop'].map((id) => ({
    id,
    summary: id,
    input_schema: { type: 'object', additionalProperties: true },
    path_fields: [],
    mutates: id === 'send',
    always_requires_approval: false,
  })),
  required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000,
  cancellation: 'graceful', receipt_fields: [],
};

const cliAdapter: SessionAdapter = {
  manifest: cliManifest,
  async init() {},
  async invoke() { return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} }; },
  async dispose() {},
  async start() { return { pid: 1 }; },
  async send() {},
  async read(_sessionId, cursor) { return { chunk: '', cursor }; },
  async interrupt() {},
  async stop() {},
};

function fakeRun(jobId: string): CoordinatorRun {
  runCounter += 1;
  // Distinct per run: revocation is generation-scoped, so a fake that reused
  // one id could not tell a live replacement from the corpse it replaced.
  return {
    run_id: `run-${runCounter}`, job_id: jobId, state: 'running',
    started_at: '2026-08-09T00:00:00.000Z', ended_at: null, exit_code: null, messages: [],
  };
}

/** The extra handle lets a test end a run the way a real child exiting would. */
type FakeCoordinator = CoordinatorControl & {
  endRun(key: string): void;
  endRunId(runId: string): void;
  runIdFor(key: string): string | undefined;
};

function fakeCoordinator(starts: Array<{ jobId: string; input?: CoordinatorStartInput }>): FakeCoordinator {
  const runs = new Map<string, CoordinatorRun>();
  const ended: Array<(key: string) => void> = [];
  return {
    onRunEnded(listener) { ended.push(listener); },
    /** End the run stored under `key`, announcing the run id a real one would. */
    endRun(key) {
      const run = runs.get(key);
      if (run === undefined) return;
      for (const listener of ended) listener(run.run_id);
    },
    endRunId(runId) { for (const listener of ended) listener(runId); },
    runIdFor(key) { return runs.get(key)?.run_id; },
    async start(jobId, input) {
      starts.push({ jobId, ...(input === undefined ? {} : { input }) });
      const run = fakeRun(jobId);
      runs.set(jobId, run);
      return run;
    },
    status(jobId) { return runs.get(jobId) ?? null; },
    async stop(jobId) {
      const current = runs.get(jobId);
      if (current === undefined) return null;
      const stopped: CoordinatorRun = { ...current, state: 'stopped', ended_at: '2026-08-09T00:00:01.000Z' };
      runs.set(jobId, stopped);
      return stopped;
    },
    async stopAll() { runs.clear(); },
  };
}

async function post(
  port: number,
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      }));
    });
req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** The seq and agreement digest of the conversation's live proposal turn. */
async function liveProposalSeqAndDigest(port: number, conversationId: string): Promise<{ seq: number; agreement_digest: string }> {
  const turns = (await post(port, '/operator/conversation_turns', { conversation_id: conversationId }, operatorToken))
    .body.turns as Array<Record<string, unknown>>;
  const last = turns.at(-1);
  assert(last !== undefined, 'expected a proposal turn');
  const parsed = JSON.parse(String(last.content)) as Record<string, unknown>;
  const agreement_digest = parsed['agreement_digest'];
  assert.equal(typeof agreement_digest, 'string');
  return { seq: last.seq as number, agreement_digest: agreement_digest as string };
}

test('operator creates, lists, starts, and stops only registered bounded jobs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-operator-workspace-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const catalog = await post(port, '/operator/catalog', {}, operatorToken);
  assert.deepEqual(catalog.body, { capabilities: ['mock.run'], workspaces: ['work'], agents: [], models: MODEL_PROFILES });
  assert.equal((await post(port, '/operator/catalog', {}, coordinatorToken)).status, 401);

  const envelope = {
    objective: 'bounded task', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: ['push'], max_actions: 3, max_retries: 1,
    expires_in_hours: 24,
  };
  const created = await post(port, '/operator/create_job', envelope, operatorToken);
  assert.equal(created.status, 200);
  assert.match(String(created.body.job_id), /^[0-9a-f-]{36}$/i);
  assert.equal(typeof created.body.envelope_digest, 'string');

  const listed = await post(port, '/operator/jobs', {}, operatorToken);
  assert.equal((listed.body.jobs as unknown[]).length, 1);

  const jobId = String(created.body.job_id);
  const started = await post(port, '/operator/hermes_start', { job_id: jobId, operator_message: 'Use B1.' }, operatorToken);
  assert.equal(started.status, 200);
  // Node Core mints the run credential and the conversation; the operator
  // supplies neither, so both are checked for shape rather than value.
  assert.equal(starts.length, 1);
  const start = starts[0];
  assert(start !== undefined);
  assert(start.input !== undefined);
  assert.equal(start.jobId, jobId);
  assert.equal(start.input.operator_message, 'Use B1.');
  assert.equal(typeof start.input.run_token, 'string');
  assert.equal(typeof start.input.conversation_id, 'string');
  assert.equal((await post(port, '/operator/hermes_status', { job_id: jobId }, operatorToken)).body.run !== null, true);
  assert.equal(((await post(port, '/operator/hermes_stop', { job_id: jobId }, operatorToken)).body.run as Record<string, unknown>).state, 'stopped');
  const checkpoint = await post(port, '/operator/checkpoint', { job_id: jobId, description: 'pause' }, operatorToken);
  assert.equal(checkpoint.status, 200);
  const checkpointed = await post(port, '/tools/job_status', { job_id: jobId }, coordinatorToken);
  assert.equal(checkpointed.body.state, 'checkpoint');


  const unknown = await post(port, '/operator/create_job', { ...envelope, allowed_capabilities: ['shell.exec'] }, operatorToken);
  assert.equal(unknown.body.error, ErrorCode.E_NOT_REGISTERED);
});

test('operator create_job converts expires_in_hours using the server clock and rejects expires_at', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-operator-expiry-'));
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator([]),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const created = await post(port, '/operator/create_job', {
    objective: 'bounded task', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 1, max_retries: 0,
    expires_in_hours: 24,
  }, operatorToken);
  assert.equal(created.status, 200);
  const expiresAt = new Date(String((created.body.envelope as Record<string, unknown>).expires_at));
  const roughlyOneDay = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  assert.ok(Math.abs(expiresAt.getTime() - roughlyOneDay.getTime()) < 5_000, 'expiry was not computed from the server clock');

  const direct = await post(port, '/operator/create_job', {
    objective: 'bounded task', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 1, max_retries: 0,
    expires_at: '2999-01-01T00:00:00.000Z',
  }, operatorToken);
  assert.equal(direct.status, 400);
  assert.equal(direct.body.error, ErrorCode.E_SCHEMA);
});

test('operator cannot start Hermes for a terminal job', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-operator-terminal-'));
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator([]),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  const created = await post(port, '/operator/create_job', {
    objective: 'bounded task', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 1, max_retries: 0,
    expires_in_hours: 24,
  }, operatorToken);
  const jobId = String(created.body.job_id);
  await post(port, '/tools/job_complete', { job_id: jobId, summary: 'done' }, coordinatorToken);
  const start = await post(port, '/operator/hermes_start', { job_id: jobId }, operatorToken);
  assert.equal(start.body.error, ErrorCode.E_JOB_TERMINAL);
});

test('a run reaches its own conversation and no other', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-run-scope-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const envelope = {
    objective: 'bounded task', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 3, max_retries: 1, expires_in_hours: 24,
  };
  const jobA = String((await post(port, '/operator/create_job', envelope, operatorToken)).body.job_id);
  const jobB = String((await post(port, '/operator/create_job', envelope, operatorToken)).body.job_id);

  await post(port, '/operator/hermes_start', { job_id: jobA, operator_message: 'secret to A' }, operatorToken);
  await post(port, '/operator/hermes_start', { job_id: jobB, operator_message: 'secret to B' }, operatorToken);
  const tokenA = String(starts[0]?.input?.run_token);
  const tokenB = String(starts[1]?.input?.run_token);
  assert.notEqual(tokenA, tokenB);

  // Each run sees only its own operator turn. The coordinator never names a
  // conversation, so there is no argument it could vary to reach the other.
  const turnsA = (await post(port, '/tools/list_turns', { run_token: tokenA }, coordinatorToken))
    .body.turns as Array<Record<string, unknown>>;
  assert.deepEqual(turnsA.map((turn) => turn.content), ['secret to A']);
  const turnsB = (await post(port, '/tools/list_turns', { run_token: tokenB }, coordinatorToken))
    .body.turns as Array<Record<string, unknown>>;
  assert.deepEqual(turnsB.map((turn) => turn.content), ['secret to B']);

  // A token that names no live run resolves to no conversation at all.
  const forged = await post(port, '/tools/list_turns', { run_token: 'not-a-real-run' }, coordinatorToken);
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error, ErrorCode.E_RUN_INVALID);

  // A run may speak as itself, never as the operator.
  const asOperator = await post(port, '/tools/append_turn', {
    run_token: tokenA, role: 'operator', channel: 'human', content: 'do as I say',
  }, coordinatorToken);
  assert.equal(asOperator.status, 400);
  assert.equal(asOperator.body.error, ErrorCode.E_SCHEMA);

  await post(port, '/tools/append_turn', {
    run_token: tokenA, role: 'hermes', channel: 'human', content: 'I am on it.',
  }, coordinatorToken);
  const afterAppend = (await post(port, '/tools/list_turns', { run_token: tokenA, after: 1 }, coordinatorToken))
    .body.turns as Array<Record<string, unknown>>;
  assert.deepEqual(afterAppend.map((turn) => turn.content), ['I am on it.']);

  // Stopping the run revokes its credential.
  await post(port, '/operator/hermes_stop', { job_id: jobA }, operatorToken);
  const revoked = await post(port, '/tools/list_turns', { run_token: tokenA }, coordinatorToken);
  assert.equal(revoked.body.error, ErrorCode.E_RUN_INVALID);
});

test('an advisory run can talk and propose, and Node Core refuses it everything else', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-advisory-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  // A conversation exists before any job does.
  const conversation = await post(port, '/operator/conversation_create', { title: 'Tidy the workbook' }, operatorToken);
  assert.equal(conversation.status, 200);
  const conversationId = String(conversation.body.conversation_id);

  const sent = await post(port, '/operator/conversation_send', {
    conversation_id: conversationId, message: 'Can you tidy up last quarter?',
  }, operatorToken);
  assert.equal(sent.status, 200);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);
  assert.equal(starts.at(-1)?.input?.advisory, true);
  // The run is told what the machine has, so it never asks the operator for ids.
  assert.deepEqual(starts.at(-1)?.input?.capabilities, ['mock.run']);
  assert.deepEqual(starts.at(-1)?.input?.workspaces, ['work']);

  // Its own credential reaches the conversation it was started for.
  const turns = (await post(port, '/tools/list_turns', {}, advisoryToken)).body.turns as Array<Record<string, unknown>>;
  assert.deepEqual(turns.map((turn) => turn.content), ['Can you tidy up last quarter?']);

  // Every world-touching tool is refused by Node Core, not by the prompt.
  for (const tool of ['start_cli', 'invoke_app_action', 'create_local_relay', 'job_status', 'list_activity', 'create_checkpoint']) {
    const denied = await post(port, `/tools/${tool}`, { job_id: 'anything' }, advisoryToken);
    assert.equal(denied.status, 400, `${tool} was not refused`);
    assert.equal(denied.body.error, ErrorCode.E_MODE_DENIED, `${tool} was not refused for the right reason`);
  }

  // A proposal is checked against what the node actually has.
  const draft = {
    objective: 'Tidy the Q4 workbook', plan: ['Open the Q4 workbook', 'Correct the totals'], acceptance: ['totals reconcile'],
    capabilities: [{ id: 'mock.run', why: 'to read and rewrite the sheet' }],
    workspaces: ['work'], forbidden: ['push'], max_actions: 5, max_retries: 1, expires_in_hours: 8,
  };
  const withoutPlan = await post(port, '/tools/propose_job', { ...draft, plan: [] }, advisoryToken);
  assert.equal(withoutPlan.body.error, ErrorCode.E_SCHEMA);
  const unknown = await post(port, '/tools/propose_job', { ...draft, capabilities: [{ id: 'shell.exec', why: 'no' }] }, advisoryToken);
  assert.equal(unknown.body.error, ErrorCode.E_NOT_REGISTERED);

  const proposed = await post(port, '/tools/propose_job', draft, advisoryToken);
  assert.equal(proposed.status, 200);
  assert.equal((proposed.body.proposal as Record<string, unknown>).objective, 'Tidy the Q4 workbook');

  // A proposal is NOT a job: nothing was sealed and no budget exists.
  assert.equal(((await post(port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 0);

  // The recorded proposal is authoritative; extra envelope fields are ignored.
  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  const accepted = await post(port, '/operator/accept_proposal', {
    conversation_id: conversationId,
    seq,
    agreement_digest,
    objective: 'A client-authored widening attempt',
    allowed_capabilities: ['anything.at.all'],
  }, operatorToken);
  assert.equal(accepted.status, 200);
  assert.equal((accepted.body.envelope as Record<string, unknown>).objective, 'Tidy the Q4 workbook');
  assert.deepEqual((accepted.body.envelope as Record<string, unknown>).allowed_capabilities, ['mock.run']);
  assert.equal(accepted.body.conversation_id, conversationId);
  assert.equal(((await post(port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 1);

  // The job it created is visible in the conversation that produced it.
  const after = (await post(port, '/operator/conversation_turns', { conversation_id: conversationId }, operatorToken))
    .body.turns as Array<Record<string, unknown>>;
  assert.equal(after.some((turn) => String(turn.content).startsWith('Job created:')), true);

  // The coordinator bearer cannot propose: proposing is for runs with no job.
  const wrongMode = await post(port, '/tools/propose_job', draft, coordinatorToken);
  assert.equal(wrongMode.body.error, ErrorCode.E_MODE_DENIED);
});


test('a CLI proposal is completed before review, the agent is pinned, and the recorded proposal seals', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-cli-bundle-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const coordinator = fakeCoordinator(starts);
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [cliAdapter], observer: null, approval_required: [], coordinator,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const conversation = await post(port, '/operator/conversation_create', { title: 'Codex task' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  assert.deepEqual((await post(port, '/operator/catalog', {}, operatorToken)).body.agents, ['codex']);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'write a script', agent: 'codex' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);
  assert.equal(starts.at(-1)?.input?.agent, 'codex');

  const draft = {
    objective: 'Write a script',
    plan: ['Open a Codex session', 'Write and verify the script'],
    acceptance: ['script runs'],
    capabilities: [{ id: 'codex.start', why: 'to open Codex' }],
    workspaces: ['work'],
    forbidden: [],
    max_actions: 8, max_retries: 1, expires_in_hours: 8,
  };
  const proposed = await post(port, '/tools/propose_job', draft, advisoryToken);
  assert.equal(proposed.status, 200);
  const proposal = proposed.body.proposal as Record<string, unknown>;
  const capabilities = proposal.capabilities as Array<Record<string, unknown>>;
  assert.deepEqual(capabilities.map((capability) => capability.id), ['codex.start', 'codex.send', 'codex.read', 'codex.stop']);
  assert.equal(capabilities.some((capability) => capability.id === 'codex.interrupt'), false);

  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  const completed = await post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest }, operatorToken);
  assert.equal(completed.status, 200);
  assert.deepEqual((completed.body.envelope as Record<string, unknown>).allowed_capabilities, capabilities.map((capability) => capability.id));
});

test('a run pinned to one agent may not propose another', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agent-pin-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const claudeAdapter: SessionAdapter = { ...cliAdapter, manifest: { ...cliManifest, id: 'claude' } };
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [cliAdapter, claudeAdapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  const conversation = await post(port, '/operator/conversation_create', { title: 'pinned' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'write a script', agent: 'codex' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);

  const denied = await post(port, '/tools/propose_job', {
    objective: 'Write a script', plan: ['Open Claude', 'Write the script'], acceptance: ['script runs'],
    capabilities: [{ id: 'claude.start', why: 'to open Claude' }], workspaces: ['work'],
    forbidden: [], max_actions: 8, max_retries: 1, expires_in_hours: 8,
  }, advisoryToken);
  assert.equal(denied.body.error, ErrorCode.E_CAP_NOT_ALLOWED);
  assert.match(String(denied.body.message), /set to codex; claude\.start belongs to claude/);
});

test('one proposal accepted twice concurrently still yields one job', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-proposal-race-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  const conversation = await post(port, '/operator/conversation_create', { title: 'race' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'do it' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);
  await post(port, '/tools/propose_job', {
    objective: 'Do it', plan: ['Run the bounded operation'], acceptance: ['done'],
    capabilities: [{ id: 'mock.run', why: 'to do it' }], workspaces: ['work'],
    forbidden: [], max_actions: 2, max_retries: 1, expires_in_hours: 8,
  }, advisoryToken);

  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  const results = await Promise.all([
    post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest }, operatorToken),
    post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest }, operatorToken),
  ]);
  // Both accepts succeed (idempotent), but only one job is ever sealed.
  assert.equal(results.filter((result) => result.status === 200).length, 2);
  assert.equal(results[0]?.body.job_id, results[1]?.body.job_id);
  assert.equal(((await post(port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 1);
});

test('a run credential dies when its process ends, and never reaches the store', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-revocation-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const coordinator = fakeCoordinator(starts);
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const conversation = await post(port, '/operator/conversation_create', { title: 'advisory' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'hello' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);

  // A credential that never reaches the durable store, even when the run
  // deliberately writes it: the coordinator is the untrusted party, so a rule
  // only it enforces is not enforced.
  await post(port, '/tools/append_turn', {
    role: 'hermes', channel: 'human', content: `my bearer is ${advisoryToken} and the node's is ${coordinatorToken}`,
  }, advisoryToken);
  const stored = (await post(port, '/operator/conversation_turns', { conversation_id: conversationId }, operatorToken))
    .body.turns as Array<Record<string, unknown>>;
  const written = stored.map((turn) => String(turn.content)).join('\n');
  assert.equal(written.includes(advisoryToken), false, 'a run credential was persisted');
  assert.equal(written.includes(coordinatorToken), false, 'the node bearer was persisted');
  assert.match(written, /\[redacted\]/);

  // The advisory process exits on its own — no operator stop is involved.
  coordinator.endRun(conversationId);

  const afterExit = await post(port, '/tools/list_turns', {}, advisoryToken);
  assert.equal(afterExit.status, 401, 'the credential outlived the run it was issued to');
});

test('a revoked run credential is still redacted out of what is persisted afterwards', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-revoked-redaction-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const coordinator = fakeCoordinator(starts);
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const conversation = await post(port, '/operator/conversation_create', { title: 'advisory' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'hello' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);

  // The run ends, so the credential is revoked and authenticates nothing.
  coordinator.endRun(conversationId);
  assert.equal((await post(port, '/tools/list_turns', {}, advisoryToken)).status, 401);

  // Redaction enumerated the LIVE credentials, so from this moment the dead
  // token stopped being recognised and was written out in clear text. It is
  // expired, so this is disclosure of a spent secret -- but the durable
  // conversation is rehydrated into later model context, and it persists.
  //
  // Quoted into a SECOND conversation, because the first still has a run the
  // fake supervisor reports as answering and would refuse the message.
  // Redaction is node-wide, so the conversation it lands in is immaterial.
  const next = await post(port, '/operator/conversation_create', { title: 'later' }, operatorToken);
  const laterId = String(next.body.conversation_id);
  const written = await post(port, '/operator/conversation_send', {
    conversation_id: laterId, message: `the last run used ${advisoryToken}`,
  }, operatorToken);
  assert.equal(written.status, 200);

  const stored = (await post(port, '/operator/conversation_turns', { conversation_id: laterId }, operatorToken))
    .body.turns as Array<Record<string, unknown>>;
  const text = stored.map((turn) => String(turn.content)).join(' | ');
  assert.equal(text.includes(advisoryToken), false, 'a revoked run credential was persisted in clear text');
  assert.match(text, /\[redacted\]/);
});

test('a second message is refused and not persisted while Hermes is still answering', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-conversation-busy-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const coordinator = fakeCoordinator(starts);
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator,
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const conversation = await post(port, '/operator/conversation_create', { title: 'advisory' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);

  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'first' }, operatorToken);
  const second = await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'second' }, operatorToken);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, ErrorCode.E_PARALLEL_ACTION);

  const turns = (await post(port, '/operator/conversation_turns', { conversation_id: conversationId }, operatorToken))
    .body.turns as Array<Record<string, unknown>>;
  assert.deepEqual(turns.map((turn) => turn.content), ['first']);
  assert.equal(starts.length, 1);
});

test('a credential pasted into a proposal objective is redacted before it is sealed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-seal-redact-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const conversation = await post(port, '/operator/conversation_create', { title: 'x' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'tidy the sheet' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);

  const proposed = await post(port, '/tools/propose_job', {
    objective: `Tidy the sheet using ${coordinatorToken} and ${operatorToken}`,
    plan: [`Read the sheet with ${coordinatorToken}`],
    acceptance: [`done with ${coordinatorToken}`],
    capabilities: [{ id: 'mock.run', why: 'to inspect it' }],
    workspaces: ['work'],
    forbidden: [], max_actions: 3, max_retries: 1, expires_in_hours: 8,
  }, advisoryToken);
  assert.equal(proposed.status, 200);
  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  const accepted = await post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest }, operatorToken);
  assert.equal(accepted.status, 200);

  // Neither credential survives in the sealed envelope...
  const envelope = accepted.body.envelope as Record<string, unknown>;
  assert.equal(String(envelope.objective).includes(coordinatorToken), false);
  assert.equal(String(envelope.objective).includes(operatorToken), false);
  assert.equal(JSON.stringify(envelope.acceptance).includes(coordinatorToken), false);
  assert.match(String(envelope.objective), /\[redacted\]/);

  // ...nor in the conversation turn that announces the job.
  const turns = (await post(port, '/operator/conversation_turns', { conversation_id: conversationId }, operatorToken))
    .body.turns as Array<Record<string, unknown>>;
  const written = turns.map((turn) => String(turn.content)).join('\n');
  assert.equal(written.includes(coordinatorToken), false);
  assert.equal(written.includes(operatorToken), false);
});

test('fixed stage graph pauses on a missing handoff and seeds a valid handoff into the next stage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-stage-graph-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [cliAdapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  const stage = (stage_id: string) => ({
    stage_id, adapter_id: 'codex', max_actions: 8, max_action_retries: 1, timeout_minutes: 30, max_attempts: 2,
  });
  const createBody = {
    objective: 'Build a bounded sample', workspace_id: 'work', deadline_minutes: 180,
    stages: ['specification', 'implementation', 'code_review', 'security_review'].map(stage),
  };

  const missing = await post(port, '/operator/pipeline_create', createBody, operatorToken);
  assert.equal(missing.status, 200);
  const missingId = String(missing.body.pipeline_id);
  const missingStage = (missing.body.stages as Array<Record<string, unknown>>)[0];
  assert(missingStage !== undefined);
  const missingJobId = String(missingStage.job_id);
  const missingComplete = await post(port, '/tools/job_complete', { job_id: missingJobId, summary: 'claimed done' }, coordinatorToken);
  assert.equal(missingComplete.body.state, 'blocked');
  const afterMissing = await post(port, '/operator/pipelines', {}, operatorToken);
  const paused = (afterMissing.body.pipelines as Array<Record<string, unknown>>).find((item) => item.pipeline_id === missingId);
  assert.equal(paused?.state, 'paused');
  assert.match(String(paused?.error), /did not produce|created no/);

  const created = await post(port, '/operator/pipeline_create', createBody, operatorToken);
  assert.equal(created.status, 200);
  const pipelineId = String(created.body.pipeline_id);
  const firstStage = (created.body.stages as Array<Record<string, unknown>>)[0];
  assert(firstStage !== undefined);
  const specJobId = String(firstStage.job_id);
  const started = await post(port, '/tools/start_cli', { job_id: specJobId, cli_id: 'codex', workspace_id: 'work' }, coordinatorToken);
  assert.equal(started.status, 200);
  const specSessionId = String(started.body.receipt_id);
  await mkdir(join(dir, specSessionId, 'handoff'), { recursive: true });
  await writeFile(join(dir, specSessionId, 'handoff', 'SPEC.md'), '# Versioned specification\n', 'utf8');

  const completed = await post(port, '/tools/job_complete', { job_id: specJobId, summary: 'spec complete' }, coordinatorToken);
  assert.equal(completed.body.state, 'proposed');
  const afterComplete = await post(port, '/operator/pipelines', {}, operatorToken);
  const running = (afterComplete.body.pipelines as Array<Record<string, unknown>>).find((item) => item.pipeline_id === pipelineId);
  assert.equal(running?.state, 'running');
  assert.equal(running?.current_stage, 1);
  const implementation = (running?.stages as Array<Record<string, unknown>>)[1];
  assert(implementation !== undefined);
  const implementationJobId = String(implementation.job_id);
  const implementationStart = await post(port, '/tools/start_cli', { job_id: implementationJobId, cli_id: 'codex', workspace_id: 'work' }, coordinatorToken);
  assert.equal(implementationStart.status, 200);
  const implementationSessionId = String(implementationStart.body.receipt_id);
  const seeded = await readFile(join(dir, implementationSessionId, 'input', 'specification', 'SPEC.md'), 'utf8');
  assert.equal(seeded, '# Versioned specification\n');
  await writeFile(join(dir, '.toros-stage-graphs', pipelineId, 'specification', 'v1', 'SPEC.md'), 'tampered\n', 'utf8');
  const tamperedStart = await post(port, '/tools/start_cli', { job_id: implementationJobId, cli_id: 'codex', workspace_id: 'work' }, coordinatorToken);
  assert.equal(tamperedStart.status, 400);
  assert.equal(tamperedStart.body.error, ErrorCode.E_SCHEMA);
  assert.match(String(tamperedStart.body.message), /integrity check failed/);
  const sessions = (await post(port, '/tools/list_sessions', { job_id: implementationJobId }, coordinatorToken)).body.sessions as Array<Record<string, unknown>>;
  assert.ok(sessions.some((session) => session.stopped_at !== null), 'failed seed left a live persisted session');
  assert.ok(starts.some((entry) => entry.jobId === implementationJobId), 'next stage coordinator was not started');
});

test('a running stage graph survives restart as paused work requiring operator review', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-stage-graph-restart-'));
  const dbPath = join(dir, 'node.sqlite');
  const options = (coordinator: CoordinatorControl) => ({
    node_id: 'node', db_path: dbPath, workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [cliAdapter], observer: null, approval_required: [] as readonly string[], coordinator,
  });
  const first = createNodeCore(options(fakeCoordinator([])));
  const firstPort = (await first.start()).port;
  const stage = (stage_id: string) => ({ stage_id, adapter_id: 'codex', max_actions: 4, max_action_retries: 0, timeout_minutes: 30, max_attempts: 2 });
  const created = await post(firstPort, '/operator/pipeline_create', {
    objective: 'Persist this graph', workspace_id: 'work', deadline_minutes: 120,
    stages: ['specification', 'implementation', 'code_review', 'security_review'].map(stage),
  }, operatorToken);
  assert.equal(created.body.state, 'running');
  const pipelineId = String(created.body.pipeline_id);
  await first.stop();

  const second = createNodeCore(options(fakeCoordinator([])));
  t.after(async () => { await second.stop(); await rm(dir, { recursive: true, force: true }); });
  const secondPort = (await second.start()).port;
  const listed = await post(secondPort, '/operator/pipelines', {}, operatorToken);
  const restored = (listed.body.pipelines as Array<Record<string, unknown>>).find((item) => item.pipeline_id === pipelineId);
  assert.equal(restored?.state, 'paused');
  assert.match(String(restored?.error), /restarted/i);
});

// ---------------------------------------------------------------------------
// Agreement-first acceptance (spec AS, slice AF)
// ---------------------------------------------------------------------------

interface ProposalFixture {
  readonly port: number;
  readonly conversationId: string;
  readonly seq: number;
  readonly agreement_digest: string;
}

/**
 * `store` is an internal instance-scoped seam: NodeCoreOptions does not declare
 * it, and a test that needs a wrapped (failing) store constructs its own Core
 * with it. This alias types the seam without touching the public interface.
 */
type CoreOptions = Parameters<typeof createNodeCore>[0] & { readonly store?: Store };

/**
 * Wrap a real store so the FIRST appendEvent that follows a createJob throws.
 * That is exactly the `job.created` event, so the accept seals a bound job and
 * then errors out — the failure the round-1 check-2 test used to fake by hand.
 */
function wrapFailingStore(real: Store): { store: Store; armed: () => boolean; spent: () => boolean } {
  let armed = false;
  let spent = false;
  const store: Store = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'createJob') {
        return async (sealed: SealedEnvelope, options?: { conversation_id?: string }) => {
          const job = await (value as Store['createJob']).call(target, sealed, options);
          armed = true;
          return job;
        };
      }
      if (prop === 'appendEvent') {
        return (input: Parameters<Store['appendEvent']>[0]) => {
          if (armed && !spent) {
            spent = true;
            armed = false;
            return Promise.reject(new Error('injected failure right after createJob'));
          }
          return (value as Store['appendEvent']).call(target, input);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store, armed: () => armed, spent: () => spent };
}

/** Start a node, open a conversation, propose one mock job, and return its live proposal. */
async function proposeFixture(t: { after: (hook: () => Promise<void>) => void }): Promise<ProposalFixture & { core: ReturnType<typeof createNodeCore>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agreement-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  const conversation = await post(port, '/operator/conversation_create', { title: 'agreement' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'do the bounded thing' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);
  await post(port, '/tools/propose_job', {
    objective: 'Do the bounded thing',
    plan: ['Run the bounded operation', 'Report the result'],
    acceptance: ['done'],
    capabilities: [{ id: 'mock.run', why: 'to do it' }],
    workspaces: ['work'],
    forbidden: ['push'],
    max_actions: 2, max_retries: 1, expires_in_hours: 8,
  }, advisoryToken);
  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  return { core, dir, port, conversationId, seq, agreement_digest };
}

test('check 1: accepting the same proposal twice yields one job, one turn, one event', async (t) => {
  const f = await proposeFixture(t);
  const acceptBody = { conversation_id: f.conversationId, seq: f.seq, agreement_digest: f.agreement_digest };
  const first = await post(f.port, '/operator/accept_proposal', acceptBody, operatorToken);
  assert.equal(first.status, 200);
  const jobId = String(first.body.job_id);
  const second = await post(f.port, '/operator/accept_proposal', acceptBody, operatorToken);
  assert.equal(second.status, 200);
  assert.equal(second.body.job_id, jobId);

  assert.equal(((await post(f.port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 1);
  const turns = (await post(f.port, '/operator/conversation_turns', { conversation_id: f.conversationId }, operatorToken)).body.turns as Array<Record<string, unknown>>;
  assert.equal(turns.filter((turn) => String(turn.content).startsWith('Job created:')).length, 1);
  const events = (await post(f.port, '/tools/list_activity', { job_id: jobId }, coordinatorToken)).body.events as Array<Record<string, unknown>>;
  assert.equal(events.filter((event) => event.kind === 'job.created').length, 1);
});

test('check 2: a retry after createJob returns the same bound job and completes the missing turn and event', async (t) => {
  // The real accept_proposal path, with a store that throws once right after
  // the durable createJob insert. No job is pre-created by hand: the failure
  // happens inside the accept itself, so a create-then-bind regression (a job
  // sealed without conversation_id and bound later by setJobConversation)
  // would leave the job unbound and fail the assertion below.
  const dir = await mkdtemp(join(tmpdir(), 'toros-agreement-crash-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const realStore = await openStore({ path: join(dir, 'node.sqlite'), nodeId: 'node' });
  // Fail the first appendEvent that follows a createJob: that is the
  // job.created event, so the accept seals a bound job and then errors out.
  const { store } = wrapFailingStore(realStore);
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
    store,
  } as CoreOptions);
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  // Open a conversation and propose exactly as the real flow does.
  const conversation = await post(port, '/operator/conversation_create', { title: 'crash' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'do the bounded thing' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);
  await post(port, '/tools/propose_job', {
    objective: 'Do the bounded thing',
    plan: ['Run the bounded operation', 'Report the result'],
    acceptance: ['done'],
    capabilities: [{ id: 'mock.run', why: 'to do it' }],
    workspaces: ['work'],
    forbidden: ['push'],
    max_actions: 2, max_retries: 1, expires_in_hours: 8,
  }, advisoryToken);

  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  const derivedId = deriveJobId(conversationId, seq);
  const acceptBody = { conversation_id: conversationId, seq, agreement_digest };

  // First accept hits the injected failure after createJob.
  const first = await post(port, '/operator/accept_proposal', acceptBody, operatorToken);
  assert.notEqual(first.status, 200, 'the injected failure did not surface as an error');

  // The job was durably created AND bound in the same insert, even though the
  // event and turn never got written.
  const failed = await realStore.getJob(derivedId);
  assert(failed !== null, 'the failed accept did not create the job');
  assert.equal(failed.conversation_id, conversationId);
  assert.equal((await realStore.listJobs()).length, 1);

  // The retry returns the SAME job id and completes the missing event and turn.
  const accepted = await post(port, '/operator/accept_proposal', acceptBody, operatorToken);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.job_id, derivedId);
  assert.equal(accepted.body.conversation_id, conversationId);
  assert.equal(((await post(port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 1);

  const events = (await post(port, '/tools/list_activity', { job_id: derivedId }, coordinatorToken)).body.events as Array<Record<string, unknown>>;
  assert.equal(events.filter((event) => event.kind === 'job.created').length, 1);
  const turns = (await post(port, '/operator/conversation_turns', { conversation_id: conversationId }, operatorToken)).body.turns as Array<Record<string, unknown>>;
  assert.equal(turns.filter((turn) => String(turn.content).startsWith('Job created:')).length, 1);

  // Starting it never invents a second conversation: the job is already bound.
  const started = await post(port, '/operator/hermes_start', { job_id: derivedId }, operatorToken);
  assert.equal(started.status, 200);
  assert.equal(((await post(port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 1);
});

test('check 3: a stale seq or a wrong digest is refused and creates no job', async (t) => {
  const f = await proposeFixture(t);

  // A wrong digest is refused.
  const wrongDigest = await post(f.port, '/operator/accept_proposal', { conversation_id: f.conversationId, seq: f.seq, agreement_digest: '0'.repeat(64) }, operatorToken);
  assert.equal(wrongDigest.status, 400);
  assert.equal(wrongDigest.body.error, ErrorCode.E_SCHEMA);
  assert.equal(wrongDigest.body.message, 'the proposal changed; review it again');
  assert.equal(((await post(f.port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 0);

  // A newer turn advances the tail, making the old seq stale.
  await post(f.port, '/operator/reject_proposal', { conversation_id: f.conversationId }, operatorToken);
  const stale = await post(f.port, '/operator/accept_proposal', { conversation_id: f.conversationId, seq: f.seq, agreement_digest: f.agreement_digest }, operatorToken);
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error, ErrorCode.E_SCHEMA);
  assert.equal(stale.body.message, 'the proposal changed; review it again');
  assert.equal(((await post(f.port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 0);
});

test('check 3b: a malformed seq or digest is refused with E_SCHEMA', async (t) => {
  const f = await proposeFixture(t);
  const badSeq = await post(f.port, '/operator/accept_proposal', { conversation_id: f.conversationId, seq: -1, agreement_digest: f.agreement_digest }, operatorToken);
  assert.equal(badSeq.status, 400);
  assert.equal(badSeq.body.error, ErrorCode.E_SCHEMA);
  const badDigest = await post(f.port, '/operator/accept_proposal', { conversation_id: f.conversationId, seq: f.seq, agreement_digest: 'NOT-HEX' }, operatorToken);
  assert.equal(badDigest.status, 400);
  assert.equal(badDigest.body.error, ErrorCode.E_SCHEMA);
});

test('check 1b: a retry after a completed accept with a wrong digest is refused and never re-records', async (t) => {
  const f = await proposeFixture(t);
  const acceptBody = { conversation_id: f.conversationId, seq: f.seq, agreement_digest: f.agreement_digest };
  const first = await post(f.port, '/operator/accept_proposal', acceptBody, operatorToken);
  assert.equal(first.status, 200);
  const jobId = String(first.body.job_id);

  // A retry that supplies a different, well-formed digest must be refused: the
  // retry path trusts the immutable turn's stored digest, not the caller's.
  const wrong = await post(f.port, '/operator/accept_proposal', { conversation_id: f.conversationId, seq: f.seq, agreement_digest: 'f'.repeat(64) }, operatorToken);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, ErrorCode.E_SCHEMA);
  assert.equal(wrong.body.message, 'the proposal changed; review it again');

  // Nothing was re-recorded: still one job, one turn, and one event carrying the TRUE digest.
  assert.equal(((await post(f.port, '/operator/jobs', {}, operatorToken)).body.jobs as unknown[]).length, 1);
  const events = (await post(f.port, '/tools/list_activity', { job_id: jobId }, coordinatorToken)).body.events as Array<Record<string, unknown>>;
  const created = events.filter((event) => event.kind === 'job.created');
  assert.equal(created.length, 1);
  assert.equal((created[0]!.payload as Record<string, unknown>).agreement_digest, f.agreement_digest);
});

test('check 1c: a retry after an injected failure records the true digest, and a wrong digest is refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agreement-retry-digest-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const realStore = await openStore({ path: join(dir, 'node.sqlite'), nodeId: 'node' });
  const { store } = wrapFailingStore(realStore);
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
    store,
  } as CoreOptions);
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  const conversation = await post(port, '/operator/conversation_create', { title: 'retry' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'do the bounded thing' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);
  await post(port, '/tools/propose_job', {
    objective: 'Do the bounded thing',
    plan: ['Run the bounded operation', 'Report the result'],
    acceptance: ['done'],
    capabilities: [{ id: 'mock.run', why: 'to do it' }],
    workspaces: ['work'],
    forbidden: ['push'],
    max_actions: 2, max_retries: 1, expires_in_hours: 8,
  }, advisoryToken);

  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  const derivedId = deriveJobId(conversationId, seq);

  // First accept fails after createJob, leaving a bound job with no event/turn.
  const first = await post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest }, operatorToken);
  assert.notEqual(first.status, 200);

  // A wrong digest on the retry is refused and records nothing.
  const wrong = await post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest: 'f'.repeat(64) }, operatorToken);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, ErrorCode.E_SCHEMA);
  assert.equal(wrong.body.message, 'the proposal changed; review it again');
  assert.equal((await realStore.listEvents(derivedId)).length, 0, 'a wrong-digest retry wrote an event');

  // The correct digest completes the recovery and the event carries the TRUE digest.
  const accepted = await post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest }, operatorToken);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.job_id, derivedId);
  const events = await realStore.listEvents(derivedId);
  const created = events.filter((event) => event.kind === 'job.created');
  assert.equal(created.length, 1);
  assert.equal((created[0]!.payload as Record<string, unknown>).agreement_digest, agreement_digest);
});

test('check 4: the three agreement fields are validated, kept off the envelope, and an unknown capability is still refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agreement-fields-'));
  const starts: Array<{ jobId: string; input?: CoordinatorStartInput }> = [];
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator(starts),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  const conversation = await post(port, '/operator/conversation_create', { title: 'fields' }, operatorToken);
  const conversationId = String(conversation.body.conversation_id);
  await post(port, '/operator/conversation_send', { conversation_id: conversationId, message: 'tidy the sheet' }, operatorToken);
  const advisoryToken = String(starts.at(-1)?.input?.run_token);

  const draft = {
    objective: 'Tidy the sheet', plan: ['Open it', 'Correct it'], acceptance: ['corrected'],
    capabilities: [{ id: 'mock.run', why: 'to edit it' }], workspaces: ['work'],
    forbidden: [], max_actions: 3, max_retries: 1, expires_in_hours: 8,
    intent: 'Tidy the Q4 sheet per our conversation',
    target: 'The Q4 workbook',
    changes: 'Correct totals; do not touch other sheets',
  };
  const proposed = await post(port, '/tools/propose_job', draft, advisoryToken);
  assert.equal(proposed.status, 200);
  const proposal = proposed.body.proposal as Record<string, unknown>;
  assert.equal(proposal.intent, draft.intent);
  assert.equal(proposal.target, draft.target);
  assert.equal(proposal.changes, draft.changes);

  // A too-long field is refused.
  const tooLong = await post(port, '/tools/propose_job', { ...draft, intent: 'x'.repeat(2001) }, advisoryToken);
  assert.equal(tooLong.body.error, ErrorCode.E_SCHEMA);
  // A non-string field is refused.
  const notString = await post(port, '/tools/propose_job', { ...draft, changes: 42 }, advisoryToken);
  assert.equal(notString.body.error, ErrorCode.E_SCHEMA);
  // An unknown capability is still refused at proposal time.
  const unknown = await post(port, '/tools/propose_job', { ...draft, capabilities: [{ id: 'shell.exec', why: 'no' }] }, advisoryToken);
  assert.equal(unknown.body.error, ErrorCode.E_NOT_REGISTERED);

  // Accepting puts none of the three fields on the sealed envelope.
  const { seq, agreement_digest } = await liveProposalSeqAndDigest(port, conversationId);
  const accepted = await post(port, '/operator/accept_proposal', { conversation_id: conversationId, seq, agreement_digest }, operatorToken);
  assert.equal(accepted.status, 200);
  const envelope = accepted.body.envelope as Record<string, unknown>;
  assert.equal('intent' in envelope, false);
  assert.equal('target' in envelope, false);
  assert.equal('changes' in envelope, false);
});

test('check 5: the job.created event carries ids and digests only, never free text', async (t) => {
  const f = await proposeFixture(t);
  const accepted = await post(f.port, '/operator/accept_proposal', { conversation_id: f.conversationId, seq: f.seq, agreement_digest: f.agreement_digest }, operatorToken);
  assert.equal(accepted.status, 200);
  const jobId = String(accepted.body.job_id);
  const events = (await post(f.port, '/tools/list_activity', { job_id: jobId }, coordinatorToken)).body.events as Array<Record<string, unknown>>;
  const created = events.find((event) => event.kind === 'job.created');
  assert(created !== undefined);
  const payload = created.payload as Record<string, unknown>;
  assert.equal(payload.agreement_digest, f.agreement_digest);
  assert.equal(payload.conversation_id, f.conversationId);
  assert.equal(payload.proposal_seq, f.seq);
  // No free text: the objective and plan never appear in the payload.
  assert.equal(typeof payload.objective, 'undefined');
  assert.equal(typeof payload.plan, 'undefined');
});

test('check 6: create_job without a conversation behaves exactly as before', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-direct-create-'));
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [], coordinator: fakeCoordinator([]),
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  const created = await post(port, '/operator/create_job', {
    objective: 'direct task', allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 1, max_retries: 0, expires_in_hours: 24,
  }, operatorToken);
  assert.equal(created.status, 200);
  assert.equal(created.body.conversation_id, null);
  const jobId = String(created.body.job_id);
  const events = (await post(port, '/tools/list_activity', { job_id: jobId }, coordinatorToken)).body.events as Array<Record<string, unknown>>;
  const createdEvent = events.find((event) => event.kind === 'job.created');
  assert(createdEvent !== undefined);
  const payload = createdEvent.payload as Record<string, unknown>;
  assert.equal(typeof payload.envelope_digest, 'string');
  assert.equal('agreement_digest' in payload, false);
  assert.equal('conversation_id' in payload, false);
  assert.equal('proposal_seq' in payload, false);
});
