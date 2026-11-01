import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
} from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import {
  createNodeCore,
  type CoordinatorControl,
  type CoordinatorStartInput,
  type NodeCore,
} from '@toros/node-core';
import { openStore } from '@toros/store';

import {
  runAdvisory,
  boundedTurn,
  withinContextBudget,
  createModelTransport,
  loadCoordinatorConfig,
  runCoordinator,
  type CoordinatorConfig,
  type ModelMessage,
  type ModelTransport,
} from '../src/index.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const token = 'coordinator-test-token';
const modelId = 'openai/test-model';
const operatorToken = 'operator-token-that-is-at-least-32-characters';

const manifest: AdapterManifest = {
  id: 'mock',
  version: '1.0.0',
  platforms: ['linux', 'win32', 'darwin'],
  actions: [{
    id: 'run',
    summary: 'Run the mock action',
    input_schema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      additionalProperties: false,
    },
    path_fields: [],
    mutates: true,
    always_requires_approval: false,
  }],
  required_permissions: [],
  allowed_resources: [],
  default_timeout_ms: 1_000,
  cancellation: 'graceful',
  receipt_fields: [],
};

interface Invocation {
  readonly actionId: string;
  readonly args: Readonly<Record<string, JsonValue>>;
}

interface Fixture {
  readonly core: NodeCore;
  readonly dir: string;
  readonly path: string;
  readonly config: CoordinatorConfig;
  readonly invocations: Invocation[];
  readonly requests: Array<{ readonly tool: string; readonly body: unknown }>;
  readonly request: typeof fetch;
  /** Mint a run credential the way Node Core does, through the operator surface. */
  readonly mintRunToken: () => Promise<string>;
  readonly mintRunTokenWithReply: (operatorMessage?: string) => Promise<string>;
  readonly mintRunTokenWithApproval: (approvalId: string) => Promise<string>;
  readonly mintAdvisoryToken: (message: string) => Promise<string>;
}

interface FixtureOptions {
  readonly allowed?: boolean;
  readonly maxActions?: number;
  readonly state?: 'working' | 'proposed' | 'accepted' | 'blocked' | 'cancelled';
  readonly approvalRequired?: boolean;
  readonly adapterOutput?: string;
  /** Give the node an operator and a coordinator, so run credentials exist. */
  readonly withConversation?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A coordinator control that starts nothing. The test drives `runCoordinator`
 * itself; this exists only so Node Core will mint a run credential.
 */
function recordingCoordinator(starts: CoordinatorStartInput[]): CoordinatorControl {
  return {
    async start(startedJobId, input = {}) {
      starts.push(input);
      return {
        run_id: `run-${starts.length}`, job_id: startedJobId, state: 'running',
        started_at: '2026-08-10T00:00:00.000Z', ended_at: null, exit_code: null, messages: [],
      };
    },
    onRunEnded() {},
    status() { return null; },
    async stop() { return null; },
    async stopAll() {},
  };
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-coordinator-'));
  const path = join(dir, 'node.sqlite');
  const store = await openStore({ path, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: jobId,
    objective: 'Produce the bounded result',
    allowed_capabilities: options.allowed === false ? [] : ['mock.run'],
    allowed_workspaces: ['work'],
    acceptance: ['The result equals seven'],
    forbidden: ['push'],
    max_actions: options.maxActions ?? 10,
    max_retries: 2,
    expires_at: '2999-01-01T00:00:00Z',
  }));
  if (options.state !== undefined && options.state !== 'working') {
    await store.setJobState(jobId, options.state);
  }
  await store.close();

  const starts: CoordinatorStartInput[] = [];
  const invocations: Invocation[] = [];
  const adapter: Adapter = {
    manifest,
    async init() {},
    async invoke(actionId: string, args: Readonly<Record<string, JsonValue>>, _context: AdapterContext): Promise<ActionResult> {
      invocations.push({ actionId, args });
      return { output: options.adapterOutput ?? 'ok', truncated: false, artifacts: [], receipt_extra: {} };
    },
    async dispose() {},
  };
  const core = createNodeCore({
    node_id: 'node',
    db_path: path,
    workspaces: [{ id: 'work', root: dir }],
    port: 0,
    token,
    adapters: [adapter],
    observer: null,
    approval_required: options.approvalRequired === true ? ['mock.run'] : [],
    ...(options.approvalRequired === true || options.withConversation === true
      ? { operator_token: operatorToken } : {}),
    ...(options.withConversation === true ? { coordinator: recordingCoordinator(starts) } : {}),
  });
  const started = await core.start();
  const requests: Array<{ tool: string; body: unknown }> = [];
  const request: typeof fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const bodyText = input instanceof Request ? await input.clone().text() : typeof init?.body === 'string' ? init.body : '';
    requests.push({ tool: requestUrl.split('/').at(-1) ?? '', body: bodyText.length === 0 ? null : JSON.parse(bodyText) });
    return globalThis.fetch(input, init);
  };
  const config: CoordinatorConfig = {
    port: started.port,
    token,
    model: modelId,
    base_url: 'https://model.invalid/v1',
    api_key: 'provider-test-key',
    temperature: 0,
    max_turns: 40,
  };
  async function mintRunTokenWithReply(operatorMessage?: string): Promise<string> {
    const response = await globalThis.fetch(`http://127.0.0.1:${started.port}/operator/hermes_start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, ...(operatorMessage === undefined ? {} : { operator_message: operatorMessage }) }),
    });
    if (!response.ok) throw new Error(`hermes_start failed: ${response.status}`);
    const token = starts.at(-1)?.run_token;
    if (token === undefined) throw new Error('Node Core minted no run token');
    return token;
  }

  async function mintRunToken(): Promise<string> {
    return mintRunTokenWithReply();
  }

  async function mintRunTokenWithApproval(approvalId: string): Promise<string> {
    const response = await globalThis.fetch(`http://127.0.0.1:${started.port}/operator/hermes_start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, approval_id: approvalId }),
    });
    if (!response.ok) throw new Error(`approval replay failed: ${response.status} ${await response.text()}`);
    const runToken = starts.at(-1)?.run_token;
    if (runToken === undefined) throw new Error('Node Core minted no replay run token');
    return runToken;
  }

  /** Open a conversation and take the advisory credential Node Core issues for it. */
  async function mintAdvisoryToken(message: string): Promise<string> {
    const headers = { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' };
    const created = await globalThis.fetch(`http://127.0.0.1:${started.port}/operator/conversation_create`, {
      method: 'POST', headers, body: JSON.stringify({ title: 'advisory' }),
    });
    const conversation = await created.json() as { conversation_id: string };
    const sent = await globalThis.fetch(`http://127.0.0.1:${started.port}/operator/conversation_send`, {
      method: 'POST', headers,
      body: JSON.stringify({ conversation_id: conversation.conversation_id, message }),
    });
    if (!sent.ok) throw new Error(`conversation_send failed: ${sent.status}`);
    const token = starts.at(-1)?.run_token;
    if (token === undefined) throw new Error('Node Core minted no advisory token');
    return token;
  }

  return { core, dir, path, config, invocations, requests, request, mintRunToken, mintRunTokenWithReply, mintRunTokenWithApproval, mintAdvisoryToken };
}

async function finish(value: Fixture): Promise<void> {
  await value.core.stop();
  await rm(value.dir, { recursive: true, force: true });
}

class CannedModel implements ModelTransport {
  readonly seen: ModelMessage[][] = [];
  private cursor = 0;

  constructor(private readonly responses: readonly unknown[]) {}

  async respond(messages: readonly ModelMessage[]): Promise<unknown> {
    this.seen.push([...messages]);
    const response = this.responses[this.cursor];
    this.cursor += 1;
    return response;
  }
}

function response(state: 'complete' | 'blocked' | 'ask', reason: string): unknown {
  return { state, reason };
}

function action(tool: string, args: Readonly<Record<string, JsonValue>> = {}): unknown {
  return { state: 'act', reason: 'take one bounded action', action: { tool, arguments: args } };
}

async function run(value: Fixture, model: ModelTransport, maxTurns?: number): Promise<{ code: number; output: string[] }> {
  const output: string[] = [];
  const code = await runCoordinator({
    jobId,
    config: maxTurns === undefined ? value.config : { ...value.config, max_turns: maxTurns },
    model,
    request: value.request,
    output: { write: (line) => output.push(line) },
  });
  return { code, output };
}

function invalidApprovalRequest(value: Fixture): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/tools/invoke_app_action')) {
      return new Response(JSON.stringify({ error: ErrorCode.E_APPROVAL_INVALID }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return value.request(input, init);
  };
}

async function grant(value: Fixture, approvalId: string): Promise<void> {
  const response = await value.request(`http://127.0.0.1:${value.config.port}/operator/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ approval_id: approvalId }),
  });
  assert.equal(response.status, 200);
}

test('a first complete response proposes the job and exits 0', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  assert.equal((await run(f, new CannedModel([response('complete', 'done')]))).code, 0);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  assert.equal((await store.getJob(jobId))?.state, 'proposed');
  await store.close();
});

test('a first blocked response blocks the job and exits 0', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  assert.equal((await run(f, new CannedModel([response('blocked', 'cannot continue')]))).code, 0);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  assert.equal((await store.getJob(jobId))?.state, 'blocked');
  await store.close();
});

test('act invokes exactly the named tool once with the given arguments', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const model = new CannedModel([
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 } }),
    response('complete', 'done'),
  ]);
  assert.equal((await run(f, model)).code, 0);
  assert.deepEqual(f.invocations, [{ actionId: 'run', args: { value: 7 } }]);
  assert.equal(f.requests.filter((item) => item.tool === 'invoke_app_action').length, 1);
});

test('two actions in one response are rejected without invoking either', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const parallel = { state: 'act', reason: 'two', action: [
    { tool: 'invoke_app_action', arguments: {} },
    { tool: 'invoke_app_action', arguments: {} },
  ] };
  assert.equal((await run(f, new CannedModel([parallel, response('blocked', 'invalid response')]))).code, 0);
  assert.equal(f.invocations.length, 0);
  assert.equal(f.requests.some((item) => item.tool === 'invoke_app_action'), false);
});

test('E_CAP_NOT_ALLOWED is fed back and the loop continues', async (t) => {
  const f = await fixture({ allowed: false });
  t.after(() => finish(f));
  const model = new CannedModel([
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 } }),
    response('blocked', 'denial is final'),
  ]);
  assert.equal((await run(f, model)).code, 0);
  assert.equal(model.seen.length, 2);
  assert.match(model.seen[1]?.at(-1)?.content ?? '', new RegExp(ErrorCode.E_CAP_NOT_ALLOWED));
  assert.equal(f.invocations.length, 0);
});

test('E_APPROVAL_REQUIRED exits 6 and prints the approval id and exact arguments', async (t) => {
  const f = await fixture({ approvalRequired: true });
  t.after(() => finish(f));
  const arguments_: Readonly<Record<string, JsonValue>> = {
    app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 },
  };
  const result = await run(f, new CannedModel([action('invoke_app_action', arguments_)]));
  assert.equal(result.code, 6);
  const approvalSay = result.output.find(line => line.includes('Approval required'));
  assert.match(approvalSay ?? '', /Approval required: [0-9a-f-]+/i);
  // The arguments are carried in the machine channel's `done` object, not
  // stringified into a human `say` line. Every stdout line is one JSON object.
  const doneLine = result.output.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((obj) => Object.prototype.hasOwnProperty.call(obj, 'done'));
  assert.ok(doneLine, 'no done object emitted');
  const done = doneLine!['done'] as Record<string, unknown>;
  assert.equal(done['outcome'], 'approval_required');
  assert.equal(typeof done['approval_id'], 'string');
  assert.match(done['approval_id'] as string, /[0-9a-f-]+/);
  assert.deepEqual(done['arguments'], arguments_);
  assert.equal(f.invocations.length, 0);
});

test('E_BUDGET_EXHAUSTED exits 0 without asking for another turn', async (t) => {
  const f = await fixture({ maxActions: 0 });
  t.after(() => finish(f));
  const model = new CannedModel([
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} }),
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} }),
  ]);
  assert.equal((await run(f, model)).code, 0);
  assert.equal(model.seen.length, 1);
  assert.equal(f.invocations.length, 0);
});

test('an already terminal job exits 0 without model or action invocation', async (t) => {
  const f = await fixture({ state: 'proposed' });
  t.after(() => finish(f));
  const model = new CannedModel([action('invoke_app_action')]);
  assert.equal((await run(f, model)).code, 0);
  assert.equal(model.seen.length, 0);
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(f.requests.map((item) => item.tool), ['job_status']);
});

test('max_turns blocks the job with the mandated reason and exits 4', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const result = await run(f, new CannedModel([action('list_sessions'), action('list_sessions')]), 2);
  assert.equal(result.code, 4);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  assert.equal((await store.getJob(jobId))?.state, 'blocked');
  await store.close();
  const blockRequest = f.requests.find((item) => item.tool === 'job_block');
  assert.ok(isRecord(blockRequest?.body));
  assert.equal(blockRequest.body['reason'], 'turn limit reached');
});

test('two consecutive unparseable responses exit 5 without changing job state', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  assert.equal((await run(f, new CannedModel(['not json', { state: 'invalid' }]))).code, 5);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  assert.equal((await store.getJob(jobId))?.state, 'working');
  await store.close();
});

test('the actual system message sent to the model contains no credential', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const model = new CannedModel([response('blocked', 'done')]);
  await run(f, model);
  const actualSystemMessage = model.seen[0]?.find((message) => message.role === 'system')?.content ?? '';
  assert.equal(actualSystemMessage.includes(f.config.token), false);
  assert.equal(actualSystemMessage.includes(f.config.api_key), false);
  assert.match(actualSystemMessage, /Produce the bounded result/);
  assert.match(actualSystemMessage, /The result equals seven/);
});

test('an operator clarification reply is included in the first user message only', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const model = new CannedModel([response('blocked', 'done')]);
  const operatorMessage = 'Use option B1 and remain inside the envelope.';
  const code = await runCoordinator({
    jobId,
    config: f.config,
    model,
    request: f.request,
    operatorMessage,
    output: { write() {} },
  });
  assert.equal(code, 0);
  const first = model.seen[0] ?? [];
  const system = first.find((message) => message.role === 'system')?.content ?? '';
  const user = first.find((message) => message.role === 'user')?.content ?? '';
  assert.equal(system.includes(operatorMessage), false);
  assert.equal(user.includes(operatorMessage), true);
  assert.equal(user.includes(f.config.token), false);
  assert.equal(user.includes(f.config.api_key), false);
});
test('a credential appearing in tool output is redacted before the next model request', async (t) => {
  const f = await fixture({ adapterOutput: `output contains ${token} and provider-test-key` });
  t.after(() => finish(f));
  const model = new CannedModel([
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} }),
    response('blocked', 'done'),
  ]);
  await run(f, model);
  const secondRequest = model.seen[1]?.map((message) => message.content).join('\n') ?? '';
  assert.equal(secondRequest.includes(token), false);
  assert.equal(secondRequest.includes(f.config.api_key), false);
  assert.match(secondRequest, /\[redacted credential\]/);
});

test('a credential appearing in job state stops before any model request', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const colliding = new CannedModel([]);
  const code = await runCoordinator({
    jobId,
    config: { ...f.config, api_key: 'Produce the bounded result' },
    model: colliding,
    request: f.request,
    output: { write() {} },
  });
  assert.equal(code, 7);
  assert.equal(colliding.seen.length, 0);
});

test('a configured credential never appears on stdout in any shape', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const arguments_: Readonly<Record<string, JsonValue>> = {
    app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 }
  };
  const result = await run(f, new CannedModel([
    { state: 'act', reason: `here is a secret: ${f.config.token}`, action: { tool: 'invoke_app_action', arguments: arguments_ } },
    response('complete', 'done'),
  ]));
  assert.equal(result.code, 0);
  assert.equal(result.output.some(line => line.includes(f.config.token)), false);
  assert.equal(result.output.some(line => line.includes('[redacted credential]')), true);
});

test('tool results are at most 4 KiB including a truncation marker', async (t) => {
  const f = await fixture({ adapterOutput: '🙂'.repeat(2_000) });
  t.after(() => finish(f));
  const model = new CannedModel([
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} }),
    response('blocked', 'done'),
  ]);
  await run(f, model);
  const toolResult = model.seen[1]?.at(-1)?.content ?? '';
  assert.equal(Buffer.byteLength(toolResult) <= 4 * 1024, true);
  assert.match(toolResult, /\.\.\.\[truncated at 4 KiB\]$/);
  assert.equal(toolResult.includes('\uFFFD'), false);
});

test('configuration reads only coordinator.json and production imports no store', async () => {
  const paths: string[] = [];
  const config = await loadCoordinatorConfig({
    localAppData: join('C:', 'Users', 'operator', 'AppData', 'Local'),
    read: async (path) => {
      paths.push(path);
      return JSON.stringify({ port: 8787, token, model: modelId, base_url: 'https://model.invalid', api_key: 'key' });
    },
  });
  assert.equal(config.temperature, 0);
  assert.equal(config.max_turns, 40);
  assert.deepEqual(paths, [join('C:', 'Users', 'operator', 'AppData', 'Local', 'Toros', 'coordinator.json')]);

  const sourceDir = join(process.cwd(), 'packages', 'coordinator', 'src');
  const sources = (await readdir(sourceDir)).filter((name) => name.endsWith('.ts'));
  for (const source of sources) {
    assert.equal((await readFile(join(sourceDir, source), 'utf8')).includes('@toros/store'), false, `${source} imports the store`);
  }
});

test('every HTTP tool call carries the configured model id', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  await run(f, new CannedModel([action('list_sessions'), response('complete', 'done')]));
  assert.ok(f.requests.length >= 4);
  for (const request of f.requests) {
    assert.ok(isRecord(request.body), `${request.tool} did not receive an object body`);
    assert.equal(request.body['model'], modelId, `${request.tool} omitted the configured model id`);
  }

  const store = await openStore({ path: f.path, nodeId: 'node' });
  const receipts = await store.listReceipts(jobId);
  await store.close();
  assert.equal(receipts.every((receipt) => receipt.actor === modelId), true);
});

test('ask prints the question and exits 3 without blocking the job', async (t) => {
  const f = await fixture();
  t.after(() => finish(f));
  const result = await run(f, new CannedModel([response('ask', 'Which workbook?')]));
  assert.equal(result.code, 3);
  assert.deepEqual(result.output, [JSON.stringify({ ask: 'Which workbook?' })]);
  const store = await openStore({ path: f.path, nodeId: 'node' });
  assert.equal((await store.getJob(jobId))?.state, 'working');
  await store.close();
});

test('a Node Core 5xx is a transport failure and exits 7 without retrying', async () => {
  const config: CoordinatorConfig = {
    port: 8787, token, model: modelId, base_url: 'https://model.invalid', api_key: 'key', temperature: 0, max_turns: 40,
  };
  let calls = 0;
  const code = await runCoordinator({
    jobId,
    config,
    model: new CannedModel([]),
    request: async () => { calls += 1; return new Response('{}', { status: 500 }); },
    output: { write() {} },
  });
  assert.equal(code, 7);
  assert.equal(calls, 1);
});

test('approval-required output retires the coordinator approval-token workaround', async (t) => {
  const f = await fixture({ approvalRequired: true });
  t.after(() => finish(f));
  const arguments_: Readonly<Record<string, JsonValue>> = {
    app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 },
  };

  const first = await run(f, new CannedModel([action('invoke_app_action', arguments_)]));
  assert.equal(first.code, 6);
  const approvalSay = first.output.find(line => line.includes('Approval required'));
  const approvalId = /Approval required: ([0-9a-f-]+)/i.exec(approvalSay ?? '')?.[1];
  assert.ok(approvalId, `no approval id in ${approvalSay}`);
  assert.equal(f.invocations.length, 0);

  assert.equal(first.output.some((line) => line.includes('--approval')), false);
  assert.equal(first.output.some((line) => line.includes('operator control surface')), true);
  const actionBody = f.requests.find((request) => request.tool === 'invoke_app_action')?.body as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(actionBody, 'approval_token'), false);
});

test('a fresh resumed model sees replay in already_performed and does not execute twice', async (t) => {
  const f = await fixture({ approvalRequired: true, withConversation: true });
  t.after(() => finish(f));
  const arguments_: Readonly<Record<string, JsonValue>> = {
    app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 },
  };
  const first = await run(f, new CannedModel([action('invoke_app_action', arguments_)]));
  assert.equal(first.code, 6);
  const doneLine = first.output.map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => Object.prototype.hasOwnProperty.call(line, 'done'));
  const approvalId = (doneLine?.['done'] as Record<string, unknown> | undefined)?.['approval_id'];
  assert.equal(typeof approvalId, 'string');
  await grant(f, approvalId as string);

  const runToken = await f.mintRunTokenWithApproval(approvalId as string);
  assert.equal(f.invocations.length, 1, 'Node Core did not replay before starting the resumed run');
  const seen: ModelMessage[][] = [];
  const model: ModelTransport = {
    async respond(messages) {
      seen.push([...messages]);
      const context = messages.map((message) => message.content).join('\n');
      return context.includes('already_performed') && context.includes('mock.run')
        ? response('complete', 'Replay already completed the action')
        : action('invoke_app_action', arguments_);
    },
  };
  assert.equal(await runCoordinator({
    jobId, config: f.config, model, request: f.request, runToken, output: { write() {} },
  }), 0);
  const context = seen[0]?.map((message) => message.content).join('\n') ?? '';
  assert.match(context, /already_performed/);
  assert.match(context, /mock\.run/);
  assert.equal(f.invocations.length, 1, 'the resumed model re-executed the replayed action');
});

test('an approval that does not authorise the action exits 6 rather than retrying', async (t) => {
  // E_APPROVAL_INVALID used to be fed back to the model as an ordinary result,
  // so it would retry with the same dead id until the turn limit. The id is
  // spent, expired, or bound to different arguments — none of which the model
  // can fix.
  const f = await fixture({ approvalRequired: true });
  t.after(() => finish(f));
  const arguments_: Readonly<Record<string, JsonValue>> = {
    app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 },
  };
  const model = new CannedModel([
    action('invoke_app_action', arguments_),
    action('invoke_app_action', arguments_),
  ]);
  const output: string[] = [];
  const code = await runCoordinator({
    jobId, config: f.config, model, request: invalidApprovalRequest(f),
    output: { write: (line) => output.push(line) },
  });
  assert.equal(code, 6);
  assert.equal(model.seen.length, 1, 'the model was asked for another turn after an invalid approval');
  assert.equal(f.invocations.length, 0);
});

test('the approval id is not sent when none was supplied', async (t) => {
  // It must be absent, not empty-string: policy treats a present token as a
  // claim to be checked, and an empty one would be an E_APPROVAL_INVALID where
  // E_APPROVAL_REQUIRED is the honest answer.
  const f = await fixture({ approvalRequired: true });
  t.after(() => finish(f));
  const result = await run(f, new CannedModel([
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} }),
  ]));
  assert.equal(result.code, 6);
  assert.match(result.output.find(line => line.includes('Approval required')) ?? '', /Approval required/);
});

test('a failing job_complete produces exactly one done carrying the failure', async (t) => {
  // Finding 1: `done` must be emitted only after the terminal tool call has
  // succeeded. If job_complete fails, the outer catch emits the single `done`
  // for the run — never two, and never a success followed by a failure.
  const f = await fixture();
  t.after(() => finish(f));
  const wrappedRequest: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/tools/job_complete')) {
      return new Response('{"error":"internal"}', { status: 500 });
    }
    return f.request(input, init);
  };
  const result = await run({ ...f, request: wrappedRequest }, new CannedModel([response('complete', 'done')]));
  assert.equal(result.code, 7);
  const doneObjects = result.output
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((obj) => Object.prototype.hasOwnProperty.call(obj, 'done'));
  assert.equal(doneObjects.length, 1, `expected exactly one done, got ${doneObjects.length}: ${JSON.stringify(doneObjects)}`);
  const done = doneObjects[0]!['done'] as Record<string, unknown>;
  assert.equal(done['outcome'], 'error');
  assert.ok(typeof done['summary'] === 'string' && done['summary'].length > 0);
});

test('every exit path maps onto exactly one declared RunOutcome member', async (t) => {
  // Finding 2: done.outcome has one fixed vocabulary. Every run that emits a
  // done carries one of these members, and every member is reachable. An ask
  // is not an outcome and emits no done, so 'asked' is absent from the set.
  const declared: ReadonlySet<string> = new Set([
    'already_terminal', 'parse_error', 'complete', 'blocked', 'stopped',
    'approval_required', 'approval_invalid', 'turn_limit', 'error',
  ]);
  const seen = new Set<string>();

  // already_terminal — exit 0, terminal job at start
  {
    const f = await fixture({ state: 'proposed' });
    t.after(() => finish(f));
    const r = await run(f, new CannedModel([response('complete', 'done')]));
    assert.equal(r.code, 0);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'already_terminal');
    seen.add('already_terminal');
  }
  // parse_error — exit 5, two consecutive invalid responses
  {
    const f = await fixture();
    t.after(() => finish(f));
    const r = await run(f, new CannedModel(['not json', { state: 'invalid' }]));
    assert.equal(r.code, 5);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'parse_error');
    seen.add('parse_error');
  }
  // complete — exit 0
  {
    const f = await fixture();
    t.after(() => finish(f));
    const r = await run(f, new CannedModel([response('complete', 'done')]));
    assert.equal(r.code, 0);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'complete');
    seen.add('complete');
  }
  // blocked — exit 0
  {
    const f = await fixture();
    t.after(() => finish(f));
    const r = await run(f, new CannedModel([response('blocked', 'stuck')]));
    assert.equal(r.code, 0);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'blocked');
    seen.add('blocked');
  }
  // stopped — exit 0, STOP_ERRORS from a tool call (max_actions: 0 → E_BUDGET_EXHAUSTED)
  {
    const f = await fixture({ maxActions: 0 });
    t.after(() => finish(f));
    const r = await run(f, new CannedModel([action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} })]));
    assert.equal(r.code, 0);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'stopped');
    seen.add('stopped');
  }
  // approval_required — exit 6
  {
    const f = await fixture({ approvalRequired: true });
    t.after(() => finish(f));
    const r = await run(f, new CannedModel([action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 } })]));
    assert.equal(r.code, 6);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'approval_required');
    seen.add('approval_required');
  }
  // approval_invalid — exit 6
  {
    const f = await fixture({ approvalRequired: true });
    t.after(() => finish(f));
    const output: string[] = [];
    const code = await runCoordinator({
      jobId, config: f.config,
      model: new CannedModel([action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: { value: 7 } })]),
      request: invalidApprovalRequest(f), output: { write: (line) => output.push(line) },
    });
    const r = { code, output };
    assert.equal(r.code, 6);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'approval_invalid');
    seen.add('approval_invalid');
  }
  // turn_limit — exit 4
  {
    const f = await fixture();
    t.after(() => finish(f));
    const r = await run(f, new CannedModel([action('list_sessions'), action('list_sessions')]), 2);
    assert.equal(r.code, 4);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'turn_limit');
    seen.add('turn_limit');
  }
  // error — exit 7, transport failure on job_status
  {
    const f = await fixture();
    t.after(() => finish(f));
    const failingRequest: typeof fetch = async () => new Response('{"error":"internal"}', { status: 500 });
    const r = await run({ ...f, request: failingRequest }, new CannedModel([response('complete', 'done')]));
    assert.equal(r.code, 7);
    const done = doneOf(r.output);
    assert.equal(done['outcome'], 'error');
    seen.add('error');
  }

  // Every outcome produced is a declared member.
  for (const outcome of seen) {
    assert.ok(declared.has(outcome), `produced undeclared outcome: ${outcome}`);
  }
  // Every declared member was produced by some path — the mapping is total.
  assert.deepEqual([...declared].sort(), [...seen].sort(), 'declared and produced outcome sets differ');
});

/** Parse the single `done` object out of a run's stdout lines. */
function doneOf(output: readonly string[]): Record<string, unknown> {
  const dones = output
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((obj) => Object.prototype.hasOwnProperty.call(obj, 'done'));
  assert.equal(dones.length, 1, `expected exactly one done, got ${dones.length}`);
  return dones[0]!['done'] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The model transport
//
// This had NO coverage, and that is how a request the provider refuses outright
// reached a live run. Every loop test above drives a CannedModel, which
// implements ModelTransport directly and never exercises the HTTP request the
// real transport builds.
//
// Be clear about what these can and cannot do: they lock in the request shape
// and the diagnosability of a failure. They CANNOT tell you a provider will
// accept that shape — only calling one does. The strict-mode incompatibility
// below was found by a live run, not by a test, and a test written before it
// would have asserted the broken shape just as confidently.
// ---------------------------------------------------------------------------

function transportConfig(): CoordinatorConfig {
  return {
    port: 1, token: 't', model: modelId,
    base_url: 'https://model.invalid/v1', api_key: 'provider-test-key',
    temperature: 0, max_turns: 40,
  };
}

test('the transport does not ask for a strict json_schema it cannot satisfy', async () => {
  // `strict: true` requires additionalProperties:false on EVERY nested object,
  // including an action's `arguments` — which is open by nature, since its
  // shape is whatever the target capability declares. The provider rejects the
  // whole request:
  //   "In context=(... 'arguments'), 'additionalProperties' is required to be
  //    supplied and to be false."
  let sent: Record<string, unknown> | null = null;
  const request: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"state":"complete","reason":"ok"}' } }] }), { status: 200 });
  };
  await createModelTransport(transportConfig(), request).respond([{ role: 'user', content: 'hi' }]);

  const body = sent as unknown as Record<string, unknown>;
  assert.deepEqual(body['response_format'], { type: 'json_object' });
  assert.equal(JSON.stringify(body).includes('"strict"'), false, 'the request still asks for strict mode');
  // `parallel_tool_calls` is a tool-calling parameter and this loop does not use
  // tool calling. One action per turn is enforced by the response contract,
  // which has a single `action` field, so two actions are unrepresentable.
  assert.equal('parallel_tool_calls' in body, false);
  assert.equal(body['model'], modelId);
});

test('a provider error carries the provider reason, not just a status', async () => {
  // `model HTTP 400` alone cannot distinguish a schema the provider will not
  // accept from a typo in the model id, and both are things an operator has to
  // fix differently.
  const request: typeof fetch = async () => new Response(
    '{"error":{"message":"Invalid schema for response_format"}}',
    { status: 400 },
  );
  await assert.rejects(
    createModelTransport(transportConfig(), request).respond([{ role: 'user', content: 'hi' }]),
    (error: unknown) => error instanceof Error
      && error.message.includes('400')
      && error.message.includes('Invalid schema for response_format'),
  );
});

test('the transport returns the parsed content of the first choice', async () => {
  const request: typeof fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: '{"state":"blocked","reason":"stuck"}' } }] }),
    { status: 200 },
  );
  const result = await createModelTransport(transportConfig(), request).respond([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(result, { state: 'blocked', reason: 'stuck' });
});

test('the transport exposes provider-reported tokens and cost once', async () => {
  const request: typeof fetch = async () => new Response(JSON.stringify({
    model: 'provider-snapshot',
    choices: [{ message: { content: '{"state":"complete","reason":"ok"}' } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.0006 },
  }), { status: 200 });
  const transport = createModelTransport(transportConfig(), request);
  await transport.respond([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(transport.takeUsage?.(), {
    provider: 'model.invalid', model: modelId, prompt_tokens: 120,
    completion_tokens: 30, total_tokens: 150, cost_usd: 0.0006,
  });
  assert.equal(transport.takeUsage?.(), null);
});

test('a resumed run rehydrates its conversation and does not repeat an executed action', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  // First run: execute one action, then ask the operator a question.
  const firstToken = await f.mintRunToken();
  const firstModel = new CannedModel([
    action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} }),
    response('ask', 'Which bounded option should I use?'),
  ]);
  assert.equal(await runCoordinator({
    jobId, config: f.config, model: firstModel, request: f.request,
    runToken: firstToken, output: { write() {} },
  }), 3);
  assert.equal(f.invocations.length, 1);

  // Second run: a fresh process, a fresh model, the operator's answer.
  const secondToken = await f.mintRunToken();
  const secondModel = new CannedModel([response('complete', 'Done')]);
  assert.equal(await runCoordinator({
    jobId, config: f.config, model: secondModel, request: f.request,
    runToken: secondToken, operatorMessage: 'Use option B1.', output: { write() {} },
  }), 0);

  const context = secondModel.seen[0] ?? [];
  const text = context.map((message) => message.content).join('\n');

  // It remembers what it said.
  assert.match(text, /Which bounded option should I use\?/);
  assert.match(text, /take one bounded action/);
  // It knows what it already did, so it has no reason to do it again.
  assert.match(text, /already_performed/);
  assert.match(text, /mock\.run/);
  // And the operator's answer is present exactly once, in the final message.
  assert.equal(context.at(-1)?.content.includes('Use option B1.'), true);
  assert.equal(f.invocations.length, 1, 'the resumed run repeated an action it had already executed');
});

test('a run persists each turn before the next model request', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const runToken = await f.mintRunToken();
  const model = new CannedModel([response('ask', 'One question first.')]);
  await runCoordinator({
    jobId, config: f.config, model, request: f.request, runToken, output: { write() {} },
  });

  // Read the conversation back the way a later run would.
  const response_ = await globalThis.fetch(`http://127.0.0.1:${f.config.port}/tools/list_turns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ run_token: runToken }),
  });
  const body = await response_.json() as { turns: Array<Record<string, unknown>> };
  const asked = body.turns.filter((turn) => String(turn.content).includes('One question first.'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.role, 'hermes');
  assert.equal(asked[0]?.channel, 'human', 'an ask belongs to the human channel');
});

test('an advisory run drafts the envelope so the operator never has to', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const runToken = await f.mintAdvisoryToken('Tidy up last quarter for me');
  const advisoryConfig: CoordinatorConfig = { ...f.config, token: runToken };
  const model = new CannedModel([{
    propose: {
      objective: 'Tidy the Q4 workbook',
      plan: ['Open the Q4 workbook', 'Correct the totals column'],
      acceptance: ['totals reconcile'],
      capabilities: [{ id: 'mock.run', why: 'to read and rewrite the sheet' }],
      workspaces: ['work'],
      forbidden: ['push'],
      max_actions: 5,
      max_retries: 1,
      expires_in_hours: 8,
    },
  }]);

  assert.equal(await runAdvisory({
    config: advisoryConfig, model, request: f.request, runToken,
    capabilities: ['mock.run'], workspaces: ['work'], agent: 'codex', output: { write() {} },
  }), 3);

  // It was told what the machine has, and it saw the operator's own words.
  const context = model.seen[0] ?? [];
  const system = context.find((message) => message.role === 'system')?.content ?? '';
  assert.match(system, /mock\.run/);
  assert.match(system, /no JSON/i);
  assert.match(system, /plan is what the operator reads and approves/i);
  assert.match(system, /chose the codex agent/);
  assert.equal(context.some((message) => message.content.includes('Tidy up last quarter for me')), true);

  // The proposal reached Node Core and was recorded, but no job exists yet.
  const proposed = f.requests.filter((entry) => entry.tool === 'propose_job');
  assert.equal(proposed.length, 1);
  const jobs = await globalThis.fetch(`http://127.0.0.1:${f.config.port}/operator/jobs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const listed = await jobs.json() as { jobs: unknown[] };
  // Only the fixture's own job; the proposal added nothing.
  assert.equal(listed.jobs.length, 1);
});

test('the advisory prompt describes the three optional agreement fields', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const runToken = await f.mintAdvisoryToken('Tidy up last quarter for me');
  const advisoryConfig: CoordinatorConfig = { ...f.config, token: runToken };
  const model = new CannedModel([{ say: 'On it.' }]);

  await runAdvisory({
    config: advisoryConfig, model, request: f.request, runToken,
    capabilities: ['mock.run'], workspaces: ['work'], output: { write() {} },
  });

  const system = model.seen[0]?.find((message) => message.role === 'system')?.content ?? '';
  assert.match(system, /intent/);
  assert.match(system, /target/);
  assert.match(system, /changes/);
  assert.match(system, /optional/);
});

test('an advisory run that only talks records a human turn and asks for the operator', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const runToken = await f.mintAdvisoryToken('What can you do here?');
  const advisoryConfig: CoordinatorConfig = { ...f.config, token: runToken };
  const lines: string[] = [];
  const model = new CannedModel([{ ask: 'Which workbook did you have in mind?' }]);

  assert.equal(await runAdvisory({
    config: advisoryConfig, model, request: f.request, runToken,
    capabilities: ['mock.run'], workspaces: ['work'],
    output: { write(line) { lines.push(line); } },
  }), 3);

  assert.deepEqual(lines, ['{"ask":"Which workbook did you have in mind?"}']);
  const appended = f.requests.filter((entry) => entry.tool === 'append_turn');
  assert.equal(appended.length, 1);
  assert.equal((appended[0]?.body as Record<string, unknown>).channel, 'human');
});

test('a reply persisted by Node Core reaches the model exactly once', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const reply = 'Use option B1 and stay inside the envelope.';
  // Drive the REAL Node Core path: hermes_start persists the reply as an
  // operator turn and hands the same text to the run. The previous version of
  // this test appended an unrelated hermes turn, so it passed against the very
  // double-rehydration bug it was named for.
  const runToken = await f.mintRunTokenWithReply(reply);

  const model = new CannedModel([response('complete', 'Done')]);
  await runCoordinator({
    jobId, config: f.config, model, request: f.request,
    runToken, operatorMessage: reply, output: { write() {} },
  });

  const context = model.seen[0] ?? [];
  const occurrences = context.filter((message) => message.content.includes(reply)).length;
  assert.equal(occurrences, 1, 'the operator reply was duplicated or lost');
  // It arrives as the persisted operator turn, not as a synthetic re-statement.
  assert.equal(context.at(-1)?.content.includes(reply), false);
});

test('a run that cannot persist a turn stops instead of continuing blind', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const runToken = await f.mintRunToken();
  // A request the store will refuse: append_turn rejects the operator role.
  const refusing: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/append_turn')) {
      return new Response(JSON.stringify({ error: 'E_SCHEMA', message: 'refused' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    return f.request(input, init);
  };

  const model = new CannedModel([response('ask', 'A question the store will not keep.')]);
  const code = await runCoordinator({
    jobId, config: f.config, model, request: refusing, runToken, output: { write() {} },
  });

  // 7, not 3: the turn is not durable, so the run must not report a normal pause.
  assert.equal(code, 7);
});

test('rehydration drops the oldest turns when the conversation outgrows its budget', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const runToken = await f.mintRunToken();
  const headers = { authorization: `Bearer ${f.config.token}`, 'content-type': 'application/json' };
  for (let index = 0; index < 12; index += 1) {
    await globalThis.fetch(`http://127.0.0.1:${f.config.port}/tools/append_turn`, {
      method: 'POST', headers,
      body: JSON.stringify({
        run_token: runToken, role: 'hermes', channel: 'human',
        content: `turn-${index}-${'x'.repeat(7000)}`,
      }),
    });
  }

  const model = new CannedModel([response('complete', 'Done')]);
  await runCoordinator({
    jobId, config: f.config, model, request: f.request, runToken, output: { write() {} },
  });

  const context = model.seen[0] ?? [];
  const text = context.map((message) => message.content).join('\n');
  // Newest kept, oldest gone, and the model is told the record is partial
  // rather than left to assume it is complete.
  assert.match(text, /turn-11-/);
  assert.equal(text.includes('turn-0-'), false);
  assert.match(text, /elided_turns/);

  // The kept turns, INCLUDING the notice that announces the elision, fit the
  // budget. Reporting that a context was bounded must not be what unbounds it.
  const rehydrated = context.filter((message) => /turn-\d+-|elided_turns/.test(message.content));
  const bytes = rehydrated.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
  assert.ok(bytes <= 64 * 1024, `rehydrated context was ${bytes} bytes, over budget`);

  // Order is preserved among what was kept.
  const order = rehydrated
    .map((message) => /turn-(\d+)-/.exec(message.content)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'kept turns were reordered');
});

test('the newest turn survives even when it alone exceeds the context budget', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));

  const runToken = await f.mintRunToken();
  const headers = { authorization: `Bearer ${f.config.token}`, 'content-type': 'application/json' };
  // Fill well past the budget, so the newest turn is competing with history.
  for (let index = 0; index < 10; index += 1) {
    await globalThis.fetch(`http://127.0.0.1:${f.config.port}/tools/append_turn`, {
      method: 'POST', headers,
      body: JSON.stringify({
        run_token: runToken, role: 'hermes', channel: 'human',
        content: `old-${index}-${'y'.repeat(7000)}`,
      }),
    });
  }
  await globalThis.fetch(`http://127.0.0.1:${f.config.port}/tools/append_turn`, {
    method: 'POST', headers,
    body: JSON.stringify({
      run_token: runToken, role: 'hermes', channel: 'human',
      content: `NEWEST-${'z'.repeat(7000)}`,
    }),
  });

  const model = new CannedModel([response('complete', 'Done')]);
  await runCoordinator({
    jobId, config: f.config, model, request: f.request, runToken, output: { write() {} },
  });

  // A context without the newest turn answers the wrong question. It is cut if
  // it must be, but never dropped.
  const text = (model.seen[0] ?? []).map((message) => message.content).join('\n');
  assert.match(text, /NEWEST-/);
});

// --- Direct unit tests for the two budget/truncation primitives. Boundary
// behaviour a small budget produces cannot be reached through runCoordinator,
// whose budget is the fixed 64 KiB default. ---

test('withinContextBudget cuts an oversized newest turn to the budget, not the store cap', () => {
  const newest = { role: 'operator', content: `NEWEST-${'z'.repeat(7000)}` };
  const older = { role: 'hermes', content: `OLD-${'y'.repeat(7000)}` };
  const budget = 1024;
  const kept = withinContextBudget([older, newest], budget);

  // The newest turn is kept, cut, and it alone fills the budget: no older turn,
  // no elision notice pushing the total past the bound.
  const total = kept.reduce((sum, turn) => sum + Buffer.byteLength(turn.content), 0);
  assert.ok(total <= budget, `kept ${total} bytes against a ${budget} budget`);
  assert.equal(kept.length, 1);
  assert.match(kept[0]!.content, /^NEWEST-/);
  assert.match(kept[0]!.content, /…\[cut\]$/);
});

test('withinContextBudget charges the elision notice against the budget', () => {
  // Several turns, each comfortably under budget, that together overrun so the
  // notice must be inserted. The returned total, notice included, still fits.
  const turns = Array.from({ length: 8 }, (_unused, index) => ({
    role: 'hermes',
    content: `turn-${index}-${'x'.repeat(300)}`,
  }));
  const budget = 1024;
  const kept = withinContextBudget(turns, budget);
  const total = kept.reduce((sum, turn) => sum + Buffer.byteLength(turn.content), 0);
  assert.ok(total <= budget, `kept ${total} bytes against a ${budget} budget`);
  assert.match(kept.map((turn) => turn.content).join('\n'), /elided_turns/);
  // Newest survives; oldest is gone.
  assert.match(kept.map((turn) => turn.content).join('\n'), /turn-7-/);
  assert.equal(kept.some((turn) => turn.content.includes('turn-0-')), false);
});

test('boundedTurn honours a caller-supplied limit and never orphans a surrogate', () => {
  const text = `${'a'.repeat(20)}${'🙂'.repeat(50)}`;
  const cut = boundedTurn(text, 64);
  assert.ok(Buffer.byteLength(cut) <= 64);
  // No U+FFFD: a lone surrogate would have encoded to the replacement char.
  assert.equal(cut.includes('�'), false);
});

test('a malformed but successful list_activity aborts the run rather than reporting no work', async (t) => {
  const f = await fixture({ withConversation: true });
  t.after(() => finish(f));
  const runToken = await f.mintRunToken();

  // 200 OK whose body has no receipts array — an unreadable success.
  const malformed: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/list_activity')) {
      return new Response(JSON.stringify({ unexpected: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return f.request(input, init);
  };

  const model = new CannedModel([action('invoke_app_action', { app_id: 'mock', action_id: 'run', workspace_id: 'work', parameters: {} })]);
  const code = await runCoordinator({
    jobId, config: f.config, model, request: malformed, runToken, output: { write() {} },
  });

  // The run must not proceed to dispatch an action on a history it could not read.
  assert.equal(code, 7);
  assert.equal(f.invocations.length, 0);
});
