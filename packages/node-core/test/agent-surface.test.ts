/**
 * AT1 acceptance tests 1–6a, 8 and the parallel-call guarantee, over a real
 * Core on loopback with a temp database and fake adapters, following the style
 * of operator-credential.test.ts and resolve-pipeline.test.ts.
 *
 * The three discovery capabilities are faked (`desktop.state`,
 * `desktop.inspect`, `machine.inventory`) plus `excel.read_range` for the mode
 * test. No PowerShell, no Windows, no real desktop.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  ErrorCode,
  digest,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AdapterManifest,
  type JsonValue,
  type NodePlatform,
} from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';
import { createNodeCore, type NodeCore } from '../src/index.js';
import type { ToolRouteSurface } from '../src/http.js';

// Synthetic credential strings, all >= 32 printable-ASCII characters and
// pairwise distinct. None of them is a real secret.
const nodeToken = 'node-token-for-agent-surface-suite-1234567890-aa';
const operatorToken = 'operator-token-for-agent-surface-suite-9876';
const claudeToken = 'claude-token-for-agent-surface-suite-1234567890';
const codexToken = 'codex-token-for-agent-surface-suite-1234567890';

function platform(): NodePlatform {
  return process.platform as NodePlatform;
}

function desktopManifest(): AdapterManifest {
  return {
    id: 'desktop', version: '1.0.0', platforms: [platform()],
    actions: [
      {
        id: 'state', summary: 'state',
        input_schema: {
          type: 'object', additionalProperties: false, required: ['session_scope'],
          properties: { session_scope: { type: 'string', enum: ['interactive'] } },
        },
        path_fields: [], mutates: false, always_requires_approval: false,
      },
      {
        id: 'inspect', summary: 'inspect',
        input_schema: {
          type: 'object', additionalProperties: false,
          properties: {
            session_scope: { type: 'string' },
            window_id: { type: 'string' },
            freshness_token: { type: 'string' },
            depth: { type: 'integer' },
            continuation_token: { type: 'string' },
          },
        },
        path_fields: [], mutates: false, always_requires_approval: false,
      },
    ],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000,
    cancellation: 'graceful', receipt_fields: ['session'],
  };
}

function machineManifest(): AdapterManifest {
  return {
    id: 'machine', version: '1.0.0', platforms: [platform()],
    actions: [{
      id: 'inventory', summary: 'inventory',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: { capability_filter: { type: 'string' } },
      },
      path_fields: [], mutates: false, always_requires_approval: false,
    }],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000,
    cancellation: 'graceful', receipt_fields: [],
  };
}

function excelManifest(): AdapterManifest {
  return {
    id: 'excel', version: '1.0.0', platforms: [platform()],
    actions: [{
      id: 'read_range', summary: 'read',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: { range: { type: 'string' } },
      },
      path_fields: [], mutates: false, always_requires_approval: false,
    }],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000,
    cancellation: 'graceful', receipt_fields: [],
  };
}

interface FakeCall {
  capability: string;
  args: Readonly<Record<string, JsonValue>>;
  actor: string;
}

function makeAdapters(calls: FakeCall[], slowMs = 0): Adapter[] {
  const record = (capability: string, args: Readonly<Record<string, JsonValue>>, ctx: AdapterContext, output: string, fields: Readonly<Record<string, JsonValue>> = {}): Promise<ActionResult> => {
    calls.push({ capability, args, actor: ctx.actor });
    const work = async (): Promise<ActionResult> => ({ output, truncated: false, artifacts: [], receipt_extra: fields });
    if (slowMs > 0) return new Promise((resolve) => setTimeout(() => { void work().then(resolve); }, slowMs));
    return work();
  };
  // Mirror the real desktop adapter's (job, actor) handle binding: desktop.state
  // mints a single-use freshness token bound to the caller's (job, actor), and
  // desktop.inspect spends it exactly once, refusing a token minted for a
  // different (job, actor) — or a reused one — with refresh_required. This is
  // the handle half of the agent: prefix reservation the acceptance tests prove.
  const handles = new Map<string, { job_id: string; actor: string; consumed: boolean }>();
  const desktop: Adapter = {
    manifest: desktopManifest(),
    async init() {},
    async invoke(actionId, args, ctx): Promise<ActionResult> {
      if (actionId === 'state') {
        const token = randomUUID();
        handles.set(token, { job_id: ctx.job_id, actor: ctx.actor, consumed: false });
        return record('desktop.state', args, ctx, JSON.stringify({ session: 'active', freshness_token: token, windows: [] }));
      }
      const supplied = typeof args['freshness_token'] === 'string' ? args['freshness_token'] : null;
      const handle = supplied === null ? undefined : handles.get(supplied);
      const valid = handle !== undefined && handle.job_id === ctx.job_id && handle.actor === ctx.actor && !handle.consumed;
      if (!valid) {
        return record('desktop.inspect', args, ctx, JSON.stringify({ status: 'refresh_required', controls: [] }));
      }
      handle.consumed = true;
      return record('desktop.inspect', args, ctx, JSON.stringify({ status: 'ok', controls: [{ kind: 'text' }] }));
    },
    async dispose() {},
  };
  const machine: Adapter = {
    manifest: machineManifest(),
    async init() {},
    async invoke(_actionId, args, ctx): Promise<ActionResult> {
      return record('machine.inventory', args, ctx, JSON.stringify({ entries: [] }));
    },
    async dispose() {},
  };
  const excel: Adapter = {
    manifest: excelManifest(),
    async init() {},
    async invoke(_actionId, args, ctx): Promise<ActionResult> {
      return record('excel.read_range', args, ctx, 'cells');
    },
    async dispose() {},
  };
  return [desktop, machine, excel];
}

interface Fixture {
  core: NodeCore;
  port: number;
  dbPath: string;
  dir: string;
  jobId: string;
  calls: FakeCall[];
}

interface FixtureOptions {
  envelope?: Record<string, unknown>;
  jobId?: string;
  operatorToken?: string;
  agentTokens?: { readonly claude?: string; readonly codex?: string };
  desktopArGateCleared?: boolean;
  slowMs?: number;
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agent-'));
  const dbPath = join(dir, 'node.sqlite');
  const jobId = options.jobId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const store = await openStore({ path: dbPath, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: jobId,
    objective: 'agent surface suite',
    allowed_capabilities: ['desktop.state', 'desktop.inspect', 'machine.inventory'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 10,
    max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
    ...(options.envelope ?? {}),
  }));
  await store.close();
  const calls: FakeCall[] = [];
  const core = createNodeCore({
    node_id: 'node',
    db_path: dbPath,
    workspaces: [{ id: 'work', root: dir }],
    port: 0,
    token: nodeToken,
    adapters: makeAdapters(calls, options.slowMs),
    observer: null,
    approval_required: [],
    ...(options.operatorToken === undefined ? {} : { operator_token: options.operatorToken }),
    ...(options.agentTokens === undefined ? {} : { agent_tokens: options.agentTokens }),
    ...(options.desktopArGateCleared === undefined ? {} : { desktop_ar_gate_cleared: options.desktopArGateCleared }),
  });
  const { port } = await core.start();
  return { core, port, dbPath, dir, jobId, calls };
}

async function finish(f: Fixture): Promise<void> {
  await f.core.stop();
  await rm(f.dir, { recursive: true, force: true });
}

async function post(port: number, path: string, body: Record<string, unknown>, auth: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** POST a raw string body (for non-object / oversized bodies `post` cannot express). */
async function postRaw(port: number, path: string, body: string, auth: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...extraHeaders },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function grant(f: Fixture, agent: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return post(f.port, '/operator/agent_grant_create', { job_id: f.jobId, agent, ...extra }, operatorToken);
}

async function receiptsFor(f: Fixture, jobId: string): Promise<readonly import('@toros/contracts').Receipt[]> {
  const store = await openStore({ path: f.dbPath, nodeId: 'node' });
  const receipts = await store.listReceipts(jobId);
  await store.close();
  return receipts;
}

// ---------------------------------------------------------------------------
// Test 1 — start-up refusals for agent tokens.
// ---------------------------------------------------------------------------

test('a short agent token refuses to start', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agent-short-'));
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'),
    workspaces: [{ id: 'work', root: dir }], port: 0,
    token: nodeToken, adapters: makeAdapters([]), observer: null, approval_required: [],
    agent_tokens: { claude: 'too-short' },
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /at least 32 characters/.test(error.message));
});

test('an agent token with whitespace refuses to start and names the shape rule', async (t) => {
  const bad = [
    `${claudeToken} `,
    ` ${claudeToken}`,
    `claude agent-token-with-inner-space-1234567890`,
    `${claudeToken}\t`,
    `${claudeToken}\n`,
    `${operatorToken} `, // operator_token + " " (the round-2 shape)
  ];
  for (const value of bad) {
    const dir = await mkdtemp(join(tmpdir(), 'toros-agent-token-shape-'));
    const core = createNodeCore({
      node_id: 'node', db_path: join(dir, 'node.sqlite'),
      workspaces: [{ id: 'work', root: dir }], port: 0,
      token: nodeToken, adapters: makeAdapters([]), observer: null, approval_required: [],
      operator_token: operatorToken,
      agent_tokens: { claude: value },
    });
    t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
    await assert.rejects(
      core.start(),
      (error: unknown) => error instanceof Error && /printable ASCII/.test(error.message),
      `agent token ${JSON.stringify(value)}`,
    );
  }
});

test('an agent token equal to token, operator_token, or the other agent refuses to start', async (t) => {
  const equalToToken = async (): Promise<void> => {
    const core = createNodeCore({
      node_id: 'node', db_path: join(await mkdtemp(join(tmpdir(), 'toros-agent-eq-token-')), 'node.sqlite'),
      workspaces: [{ id: 'work', root: tmpdir() }], port: 0,
      token: nodeToken, adapters: makeAdapters([]), observer: null, approval_required: [],
      agent_tokens: { claude: nodeToken },
    });
    await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /differ from token/.test(error.message));
  };
  const equalToOperator = async (): Promise<void> => {
    const core = createNodeCore({
      node_id: 'node', db_path: join(await mkdtemp(join(tmpdir(), 'toros-agent-eq-op-')), 'node.sqlite'),
      workspaces: [{ id: 'work', root: tmpdir() }], port: 0,
      token: nodeToken, operator_token: operatorToken, adapters: makeAdapters([]), observer: null, approval_required: [],
      agent_tokens: { codex: operatorToken },
    });
    await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /differ from operator_token/.test(error.message));
  };
  const equalToOtherAgent = async (): Promise<void> => {
    const core = createNodeCore({
      node_id: 'node', db_path: join(await mkdtemp(join(tmpdir(), 'toros-agent-eq-other-')), 'node.sqlite'),
      workspaces: [{ id: 'work', root: tmpdir() }], port: 0,
      token: nodeToken, adapters: makeAdapters([]), observer: null, approval_required: [],
      agent_tokens: { claude: claudeToken, codex: claudeToken },
    });
    await assert.rejects(core.start(), (error: unknown) => error instanceof Error && /agents\.claude\.token must differ from agents\.codex\.token/.test(error.message));
  };
  await equalToToken();
  await equalToOperator();
  await equalToOtherAgent();
});

// ---------------------------------------------------------------------------
// Test 2 — each bearer is refused on every other surface.
// ---------------------------------------------------------------------------

test('token and operator_token are 401 on /agent/*, agent tokens are 401 on /tools/* and /operator/*', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken, codex: codexToken } });
  t.after(() => finish(f));

  // node and operator bearers on the agent surface.
  assert.equal((await post(f.port, '/agent/status', {}, nodeToken)).status, 401);
  assert.equal((await post(f.port, '/agent/status', {}, operatorToken)).status, 401);
  // agent bearers on the tools and operator surfaces.
  assert.equal((await post(f.port, '/tools/list_capabilities', { job_id: f.jobId }, claudeToken)).status, 401);
  assert.equal((await post(f.port, '/tools/job_status', { job_id: f.jobId }, codexToken)).status, 401);
  assert.equal((await post(f.port, '/operator/jobs', {}, claudeToken)).status, 401);
  assert.equal((await post(f.port, '/operator/agent_grants', {}, codexToken)).status, 401);
});

// ---------------------------------------------------------------------------
// Test 3 — the `agent:` actor prefix is reserved.
// ---------------------------------------------------------------------------

test('an agent: model label over HTTP and in-process dispatch records actor coordinator', async (t) => {
  const f = await makeFixture({});
  t.after(() => finish(f));

  const viaHttp = async (model: string): Promise<void> => {
    const result = await post(f.port, '/tools/invoke_app_action', {
      job_id: f.jobId, app_id: 'machine', action_id: 'inventory', workspace_id: 'work', model,
    }, nodeToken);
    assert.equal(result.body.error, undefined, `invoke failed: ${JSON.stringify(result.body)}`);
  };
  await viaHttp('agent:claude');
  await viaHttp(' AGENT:Codex ');

  const tools = (f.core as unknown as { tools: ToolRouteSurface }).tools;
  await tools.dispatch('invoke_app_action', {
    job_id: f.jobId, app_id: 'machine', action_id: 'inventory', workspace_id: 'work', model: 'agent:claude',
  });

  const receipts = await receiptsFor(f, f.jobId);
  assert.equal(receipts.length, 3, 'one receipt per invocation');
  for (const receipt of receipts) assert.equal(receipt.actor, 'coordinator');
});

test('a coordinator-minted handle presented through the agent surface is refresh_required', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, desktopArGateCleared: true });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));

  // A coordinator labels its model "agent:claude"; the reservation records the
  // actor as coordinator, so the handle the coordinator mints is bound to
  // (job, coordinator).
  const stateRes = await post(f.port, '/tools/invoke_app_action', {
    job_id: f.jobId, app_id: 'desktop', action_id: 'state', workspace_id: 'work',
    parameters: { session_scope: 'interactive' }, model: 'agent:claude',
  }, nodeToken);
  assert.equal(stateRes.body.error, undefined, `state failed: ${JSON.stringify(stateRes.body)}`);
  const coordinatorHandle = (JSON.parse(String(stateRes.body.output)) as { freshness_token: string }).freshness_token;

  // The same handle presented by the agent bearer (actor agent:claude) belongs
  // to a different (job, actor): the fake adapter mirrors the real adapter's
  // binding and answers refresh_required, proving an agent cannot replay a
  // coordinator's handle.
  const inspectRes = await post(f.port, '/agent/invoke', {
    capability: 'desktop.inspect',
    parameters: { freshness_token: coordinatorHandle, session_scope: 'interactive' },
  }, claudeToken);
  assert.equal(inspectRes.body.error, undefined, `inspect failed: ${JSON.stringify(inspectRes.body)}`);
  const inspectBody = JSON.parse(String(inspectRes.body.output)) as { status: string };
  assert.equal(inspectBody.status, 'refresh_required');
});

test('an agent-minted handle presented on the tools surface is refresh_required', async (t) => {
  // The reverse half of acceptance test 3: a coordinator's handle is refused on
  // the agent surface (previous test), and an agent's handle is refused on the
  // tools surface. The agent mints its desktop.state handle with actor
  // `agent:claude`; the tools surface records `model: "agent:claude"` as actor
  // `coordinator`, so the fake adapter's (job, actor) binding answers
  // refresh_required — proving neither party can replay the other's handle.
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, desktopArGateCleared: true });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));

  // The agent mints its handle through /agent/invoke (actor agent:claude).
  const stateRes = await post(f.port, '/agent/invoke', {
    capability: 'desktop.state',
    parameters: { session_scope: 'interactive' },
  }, claudeToken);
  assert.equal(stateRes.body.error, undefined, `state failed: ${JSON.stringify(stateRes.body)}`);
  const agentHandle = (JSON.parse(String(stateRes.body.output)) as { freshness_token: string }).freshness_token;

  // The same handle presented through the tools surface by a coordinator (actor
  // coordinator) belongs to a different (job, actor): the fake adapter mirrors
  // the real adapter's binding and answers refresh_required.
  const inspectRes = await post(f.port, '/tools/invoke_app_action', {
    job_id: f.jobId, app_id: 'desktop', action_id: 'inspect', workspace_id: 'work',
    parameters: { freshness_token: agentHandle, session_scope: 'interactive' }, model: 'agent:claude',
  }, nodeToken);
  assert.equal(inspectRes.body.error, undefined, `inspect failed: ${JSON.stringify(inspectRes.body)}`);
  const inspectBody = JSON.parse(String(inspectRes.body.output)) as { status: string };
  assert.equal(inspectBody.status, 'refresh_required');
});

// ---------------------------------------------------------------------------
// Test 4 — grant lifecycle.
// ---------------------------------------------------------------------------

test('no grant → E_GRANT_INVALID (no_grant)', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));
  const result = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, ErrorCode.E_GRANT_INVALID);
  assert.equal(result.body.reason, 'no_grant');
});

test('a revoked grant → E_GRANT_INVALID (revoked)', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, `grant failed: ${JSON.stringify(created.body)}`);
  const grantId = String(created.body.grant_id);
  const revoked = await post(f.port, '/operator/agent_grant_revoke', { grant_id: grantId }, operatorToken);
  assert.equal(revoked.status, 200);
  const result = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(result.body.error, ErrorCode.E_GRANT_INVALID);
  assert.equal(result.body.reason, 'revoked');
});

test('a grant whose expires_at has passed → E_EXPIRED', async (t) => {
  const f = await makeFixture({ agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));
  const grants = (await import('../src/agent-grants.js')).openAgentGrants(f.dbPath);
  await grants.create('claude', f.jobId, '2020-01-01T00:00:00Z');
  grants.close();
  const result = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(result.body.error, ErrorCode.E_EXPIRED);
});

test('a grant create that violates the job foreign key rolls back and surfaces the original error', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));
  const grants = (await import('../src/agent-grants.js')).openAgentGrants(f.dbPath);

  // `agent_grants.job_id` references `jobs(job_id)` and `foreign_keys` is ON:
  // the INSERT fails, the half-open transaction must roll back (leaving no live
  // grant), and the surfaced error is the constraint violation — not a
  // "ROLLBACK without transaction" masking it.
  await assert.rejects(
    grants.create('claude', 'no-such-job-id', '2999-01-01T00:00:00Z'),
    /FOREIGN KEY|constraint/i,
  );
  assert.equal(grants.live('claude'), null, 'a failed create must not leave a live grant behind');
  grants.close();
});

test('retryGrantWrite retries SQLITE_BUSY and gives up only after the deadline', async () => {
  const { retryGrantWrite } = await import('../src/agent-grants.js');

  // Mirror of `store.test.ts` "retries fast SQLITE_BUSY failures beyond the
  // former 750ms ceiling": a writer whose `BEGIN IMMEDIATE` surfaces SQLITE_BUSY
  // must queue and succeed once the contention clears. Without the retry loop
  // (`retryGrantWrite` reduced to a single `operation()` call) the very first
  // throw propagates and this assertion fails.
  let attempts = 0;
  const grant = await retryGrantWrite(() => {
    attempts += 1;
    if (attempts < 5) throw new Error('database is locked (SQLITE_BUSY)');
    return { grant_id: 'g', agent: 'claude' };
  });
  assert.equal(attempts, 5, `expected five attempts before success, saw ${attempts}`);
  assert.equal(grant.grant_id, 'g');

  // A non-busy error is not retried: it surfaces immediately, in one attempt.
  let nonBusy = 0;
  await assert.rejects(
    retryGrantWrite(() => { nonBusy += 1; throw new Error('FOREIGN KEY constraint failed'); }),
    /FOREIGN KEY/,
  );
  assert.equal(nonBusy, 1, 'a non-busy error must not be retried');
});

test('a grant create queues behind a competing BEGIN EXCLUSIVE holder and still succeeds', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agent-busy-'));
  const dbPath = join(dir, 'node.sqlite');
  const store = await openStore({ path: dbPath, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    objective: 'sqlite busy queue',
    allowed_capabilities: ['machine.inventory'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 10,
    max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A second connection holds the write lock (`BEGIN EXCLUSIVE`) for a short
  // delay, the way a store writer would. The grants connection's `busy_timeout`
  // makes its own `BEGIN IMMEDIATE` wait rather than fail, so `create()` must
  // queue behind the holder and come back with exactly one live grant — the
  // "queue rather than fail a second create" guarantee.
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    import { workerData, parentPort } from 'node:worker_threads';
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); parentPort.postMessage('released'); }, workerData.holdMs);
  `;
  const locker = new Worker(source, { eval: true, workerData: { dbPath, holdMs: 600 } });
  await new Promise<void>((resolve, reject) => {
    locker.on('message', (m) => m === 'locked' && resolve());
    locker.once('error', reject);
  });

  const started = Date.now();
  const grants = (await import('../src/agent-grants.js')).openAgentGrants(dbPath);
  await grants.create('claude', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2999-01-01T00:00:00Z');
  const elapsed = Date.now() - started;
  assert.equal(grants.live('claude')?.job_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  grants.close();
  await new Promise<void>((resolve, reject) => {
    locker.on('message', (m) => m === 'released' && resolve());
    locker.once('error', reject);
  });
  assert.ok(elapsed >= 500, `create returned before the lock cleared (${elapsed}ms)`);
});

test('a terminal job → E_JOB_TERMINAL', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined);
  // Make the granted job terminal after the grant exists.
  const archived = await post(f.port, '/operator/job_archive', { job_id: f.jobId }, operatorToken);
  assert.equal(archived.status, 200);
  const result = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(result.body.error, ErrorCode.E_JOB_TERMINAL);
});

test('two overlapping grant_create calls leave exactly one live grant', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));
  const [a, b] = await Promise.all([grant(f, 'claude'), grant(f, 'claude')]);
  assert.equal(a.body.error, undefined, `first grant failed: ${JSON.stringify(a.body)}`);
  assert.equal(b.body.error, undefined, `second grant failed: ${JSON.stringify(b.body)}`);
  const list = await post(f.port, '/operator/agent_grants', {}, operatorToken);
  const rows = (list.body.grants as Array<Record<string, unknown>>).filter((g) => g['revoked_at'] === null);
  assert.equal(rows.length, 1, 'exactly one live grant');
});

test('list() orders same-millisecond grants by insertion order (rowid), not grant_id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agent-list-order-'));
  const dbPath = join(dir, 'node.sqlite');
  const store = await openStore({ path: dbPath, nodeId: 'node' });
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await store.createJob(sealEnvelope({
    job_id: jobId, objective: 'list order', allowed_capabilities: ['machine.inventory'],
    allowed_workspaces: ['work'], acceptance: ['done'], forbidden: [],
    max_actions: 10, max_retries: 0, expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { openAgentGrants } = await import('../src/agent-grants.js');
  const grants = openAgentGrants(dbPath);
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath);

  // Two rows share one created_at. Insert 'b…' FIRST and 'a…' SECOND, so the
  // grant_id sort ('a…' < 'b…') would flip them while the insertion order
  // (implicit rowid) keeps 'b…' first. The fix (ORDER BY created_at, rowid)
  // returns insertion order; (created_at, grant_id) returns random-UUID order,
  // which here deterministically disagrees with the insertion order.
  const created = '2026-01-01T00:00:00.000Z';
  const expires = '2999-01-01T00:00:00Z';
  const first = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const second = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const insert = raw.prepare(
    'INSERT INTO agent_grants (grant_id, agent, job_id, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?)',
  );
  // Both revoked so the partial unique index (one live grant) is not tripped.
  insert.run(first, 'claude', jobId, created, expires, created);
  insert.run(second, 'claude', jobId, created, expires, created);
  raw.close();

  const order = grants.list().map((grant) => grant.grant_id);
  assert.deepEqual(order, [first, second], 'same-created_at grants must keep insertion order');
  grants.close();
});

test('a revoke landing while the body is being read refuses the call and leaves no receipt', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));

  const first = await grant(f, 'claude');
  assert.equal(first.body.error, undefined);

  // Give the agent a SECOND job to be granted after revocation, so the re-read
  // sees a *replaced* grant rather than a plain revocation.
  const secondJobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const store = await openStore({ path: f.dbPath, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: secondJobId,
    objective: 'second agent surface job',
    allowed_capabilities: ['machine.inventory'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 10,
    max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  // Start a slow invoke against the live grant, revoke + re-grant while the
  // body is still arriving.
  const full = JSON.stringify({ capability: 'machine.inventory', parameters: {} });
  const responsePromise = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: f.port, path: '/agent/invoke', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${claudeToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(full) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.write(full.slice(0, 20));
    // Let the server receive the first chunk and begin awaiting the rest.
    setTimeout(() => {
      void (async () => {
        await post(f.port, '/operator/agent_grant_revoke', { grant_id: String(first.body.grant_id) }, operatorToken);
        await post(f.port, '/operator/agent_grant_create', { job_id: secondJobId, agent: 'claude' }, operatorToken);
        req.end(full.slice(20));
      })().catch(reject);
    }, 50);
  });

  const response = await responsePromise;
  assert.equal(response.body.error, ErrorCode.E_GRANT_INVALID, `expected denial, got ${JSON.stringify(response.body)}`);
  assert.equal(response.body.reason, 'revoked');

  const firstReceipts = await receiptsFor(f, f.jobId);
  const secondReceipts = await receiptsFor(f, secondJobId);
  assert.equal(firstReceipts.length, 0, 'no receipt was created under the old grant');
  assert.equal(secondReceipts.length, 0, 'no receipt was created on the second job under the old grant');
});

test('a grant created while the body is read does not upgrade a no-grant invoke', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));

  // The agent has NO live grant at request start. The call body is written
  // slowly, and a grant is created while the first half is still arriving. The
  // re-read after `readBody` must refuse with "no_grant" rather than run the
  // call against the grant that appeared mid-flight.
  const full = JSON.stringify({ capability: 'machine.inventory', parameters: {} });
  const responsePromise = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: f.port, path: '/agent/invoke', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${claudeToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(full) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.write(full.slice(0, 20));
    // Let the server receive the first chunk and begin awaiting the rest.
    setTimeout(() => {
      void (async () => {
        await grant(f, 'claude');
        req.end(full.slice(20));
      })().catch(reject);
    }, 50);
  });

  const response = await responsePromise;
  assert.equal(response.body.error, ErrorCode.E_GRANT_INVALID, `expected denial, got ${JSON.stringify(response.body)}`);
  assert.equal(response.body.reason, 'no_grant');
  assert.equal(f.calls.length, 0, 'the adapter must never be called for an upgraded no-grant invoke');
});

test('a job with zero or two workspaces cannot be granted (workspace_count)', async (t) => {
  const f0 = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, envelope: { allowed_workspaces: [] } });
  t.after(() => finish(f0));
  const r0 = await grant(f0, 'claude');
  assert.equal(r0.body.error, ErrorCode.E_GRANT_INVALID, JSON.stringify(r0.body));
  assert.equal(r0.body.reason, 'workspace_count');

  const f2 = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, envelope: { allowed_workspaces: ['work', 'work2'] } });
  t.after(() => finish(f2));
  const r2 = await grant(f2, 'claude');
  assert.equal(r2.body.error, ErrorCode.E_GRANT_INVALID, JSON.stringify(r2.body));
  assert.equal(r2.body.reason, 'workspace_count');
});

test('a job listing no discovery capability cannot be granted (no_discovery_capability)', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, envelope: { allowed_capabilities: ['excel.read_range'] } });
  t.after(() => finish(f));
  const result = await grant(f, 'claude');
  assert.equal(result.body.error, ErrorCode.E_GRANT_INVALID, JSON.stringify(result.body));
  assert.equal(result.body.reason, 'no_discovery_capability');
});

// ---------------------------------------------------------------------------
// Test 5 — capabilities.
// ---------------------------------------------------------------------------

test('a capability outside the three is E_MODE_DENIED with a denied receipt', async (t) => {
  const f = await makeFixture({
    operatorToken, agentTokens: { claude: claudeToken }, desktopArGateCleared: true,
    envelope: { allowed_capabilities: ['machine.inventory', 'excel.read_range'] },
  });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));
  const result = await post(f.port, '/agent/invoke', { capability: 'excel.read_range', parameters: { range: 'A1' } }, claudeToken);
  assert.equal(result.body.error, ErrorCode.E_MODE_DENIED, JSON.stringify(result.body));
  const receipts = await receiptsFor(f, f.jobId);
  assert.ok(receipts.some((r) => r.outcome === 'denied' && r.decision.allow === false && r.decision.code === ErrorCode.E_MODE_DENIED), 'a denied receipt was not recorded');
});

test('a discovery capability not listed in the job is E_CAP_NOT_ALLOWED with a denied receipt', async (t) => {
  const f = await makeFixture({
    operatorToken, agentTokens: { claude: claudeToken }, desktopArGateCleared: true,
    envelope: { allowed_capabilities: ['machine.inventory'] },
  });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));
  const result = await post(f.port, '/agent/invoke', { capability: 'desktop.inspect', parameters: { session_scope: 'interactive' } }, claudeToken);
  assert.equal(result.body.error, ErrorCode.E_CAP_NOT_ALLOWED, JSON.stringify(result.body));
  const receipts = await receiptsFor(f, f.jobId);
  assert.ok(receipts.some((r) => r.outcome === 'denied' && r.decision.allow === false && r.decision.code === ErrorCode.E_CAP_NOT_ALLOWED), 'a denied receipt was not recorded');
});

// ---------------------------------------------------------------------------
// Test 6 — the AR gate flag.
// ---------------------------------------------------------------------------

test('desktop.* is E_MODE_DENIED (ar_gate) unless the flag is exactly true', async (t) => {
  for (const gate of [undefined, false]) {
    const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, ...(gate === undefined ? {} : { desktopArGateCleared: gate }) });
    t.after(() => finish(f));
    const created = await grant(f, 'claude');
    assert.equal(created.body.error, undefined, JSON.stringify(created.body));
    const denied = await post(f.port, '/agent/invoke', { capability: 'desktop.state', parameters: {} }, claudeToken);
    assert.equal(denied.body.error, ErrorCode.E_MODE_DENIED, `gate=${String(gate)}: ${JSON.stringify(denied.body)}`);
    assert.equal(denied.body.reason, 'ar_gate');
    const inventory = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
    assert.equal(inventory.body.error, undefined, `machine.inventory must work with the gate closed: ${JSON.stringify(inventory.body)}`);
    await finish(f);
  }
});

test('the ar_gate refusal is audited: one denied receipt, no adapter call, budget unchanged, reason "ar_gate"', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));

  // The AR gate is not cleared (default), so desktop.state is refused — but
  // now through the pipeline, so the refusal leaves an audited denied receipt
  // exactly like the capability-outside-the-three E_MODE_DENIED path.
  const denied = await post(f.port, '/agent/invoke', { capability: 'desktop.state', parameters: {} }, claudeToken);
  assert.equal(denied.body.error, ErrorCode.E_MODE_DENIED, JSON.stringify(denied.body));
  assert.equal(denied.body.reason, 'ar_gate');

  // The adapter is never reached.
  assert.equal(f.calls.filter((call) => call.capability === 'desktop.state').length, 0, 'the adapter must not be called');

  // Exactly one denied receipt with E_MODE_DENIED.
  const receipts = await receiptsFor(f, f.jobId);
  const deniedReceipts = receipts.filter((r) => r.outcome === 'denied' && r.decision.allow === false && r.decision.code === ErrorCode.E_MODE_DENIED);
  assert.equal(deniedReceipts.length, 1, 'exactly one denied receipt with E_MODE_DENIED');

  // A refusal before the adapter runs must not spend the budget.
  const store = await openStore({ path: f.dbPath, nodeId: 'node' });
  const job = await store.getJob(f.jobId);
  await store.close();
  assert.equal(job?.actions_used, 0, 'actions_used must be unchanged by the ar_gate refusal');
});

// ---------------------------------------------------------------------------
// Test 6a — smuggling.
// ---------------------------------------------------------------------------

test('smuggled job_id/workspace_id/model/actor/parameters are dropped', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, desktopArGateCleared: true });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));

  const result = await post(f.port, '/agent/invoke', {
    capability: 'desktop.state',
    parameters: { session_scope: 'any', job_id: '99999999-9999-4999-8999-999999999999', workspace_id: 'work2' },
    job_id: '99999999-9999-4999-8999-999999999999',
    workspace_id: 'work2',
    model: 'claude-opus-4',
    actor: 'operator',
  }, claudeToken);
  assert.equal(result.body.error, undefined, `invoke failed: ${JSON.stringify(result.body)}`);

  const invoked = f.calls.find((call) => call.capability === 'desktop.state');
  assert.ok(invoked, 'the fake desktop adapter was not invoked');
  assert.equal(invoked.actor, 'agent:claude');
  assert.deepEqual(invoked.args, { session_scope: 'interactive' }, 'the adapter saw smuggled or un-overridden parameters');

  const receipts = await receiptsFor(f, f.jobId);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.equal(receipt.job_id, f.jobId);
  assert.equal(receipt.actor, 'agent:claude');
  assert.equal(receipt.arguments_digest, digest({ session_scope: 'interactive' }));
});

// ---------------------------------------------------------------------------
// Test 8 — budgets.
// ---------------------------------------------------------------------------

test('agent calls spend max_actions, then E_BUDGET_EXHAUSTED', async (t) => {
  const f = await makeFixture({
    operatorToken, agentTokens: { claude: claudeToken }, desktopArGateCleared: true,
    envelope: { max_actions: 1, allowed_capabilities: ['machine.inventory'] },
  });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));

  const first = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(first.body.error, undefined, `first invoke failed: ${JSON.stringify(first.body)}`);

  const second = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(second.body.error, ErrorCode.E_BUDGET_EXHAUSTED, JSON.stringify(second.body));
});

// ---------------------------------------------------------------------------
// Parallel calls — one action at a time per agent.
// ---------------------------------------------------------------------------

test('a second concurrent call for the same agent is 409 E_PARALLEL_ACTION', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, slowMs: 300 });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));

  // A SECOND job, so the second invoke targets a different job than the first:
  // `runPrepared` keys its lock on `job_id` (action-pipeline.ts:469), so if the
  // 409 relied on that lock it could not fire here — the two invokes would
  // carry different job ids. The 409 must therefore come from the per-agent
  // lock in routes-agent.ts alone.
  const secondJobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const store = await openStore({ path: f.dbPath, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: secondJobId,
    objective: 'second job for the parallel-call test',
    allowed_capabilities: ['machine.inventory'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 10,
    max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  // Start a slow invoke that holds the per-agent lock, then replace the grant
  // while it is mid-flight so the next invoke resolves to the second job.
  const firstPromise = post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const revoked = await post(f.port, '/operator/agent_grant_revoke', { grant_id: String(created.body.grant_id) }, operatorToken);
  assert.equal(revoked.status, 200);
  const regrant = await post(f.port, '/operator/agent_grant_create', { job_id: secondJobId, agent: 'claude' }, operatorToken);
  assert.equal(regrant.body.error, undefined, JSON.stringify(regrant.body));

  const second = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(second.status, 409, `expected 409, got ${JSON.stringify(second.body)}`);
  assert.equal(second.body.error, ErrorCode.E_PARALLEL_ACTION);

  const first = await firstPromise;
  assert.equal(first.body.error, undefined, `first invoke failed: ${JSON.stringify(first.body)}`);
});

// ---------------------------------------------------------------------------
// Redaction — an agent bearer pasted into an objective is sealed as [redacted].
// ---------------------------------------------------------------------------

test('an agent token pasted into a job objective is redacted before it is sealed', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));

  const created = await post(f.port, '/operator/create_job', {
    objective: `Build the report with bearer ${claudeToken}`,
    acceptance: ['done'],
    forbidden: [],
    allowed_capabilities: ['machine.inventory'],
    allowed_workspaces: ['work'],
    max_actions: 3,
    max_retries: 1,
    expires_in_hours: 8,
  }, operatorToken);
  assert.equal(created.body.error, undefined, `create_job failed: ${JSON.stringify(created.body)}`);

  const envelope = (created.body as Record<string, unknown>)['envelope'] as Record<string, unknown>;
  const objective = String(envelope['objective']);
  assert.equal(objective.includes(claudeToken), false, 'the agent bearer survived into the sealed objective');
  assert.match(objective, /\[redacted\]/, 'the agent bearer was not replaced with [redacted]');
});

// ---------------------------------------------------------------------------
// Start-up failure — a throw after the try has started workers must stop them
// in reverse order (http server, observer, browser acquisitions, stage graphs)
// and close grants + store, so a retry does not leak a timer, a server, or a
// database handle, and binds a real port.
// ---------------------------------------------------------------------------

test('a start that fails after the grants connection opens stops the observer and rebinds a real port', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-agent-start-fail-'));
  const dbPath = join(dir, 'node.sqlite');
  const store = await openStore({ path: dbPath, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    objective: 'start-failure cleanup',
    allowed_capabilities: ['machine.inventory'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 10,
    max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  // The observer's start() throws — after stageGraphs.start() armed its interval
  // and openAgentGrants ran, but before http.start(). It throws only once: the
  // recovery start below must succeed. stop() calls and the id are recorded so
  // the test observes that the catch actually stopped the observer (and does not
  // merely re-close grants/store).
  let observerStarts = 0;
  let observerStops = 0;
  const observerFactory = (): import('@toros/contracts').SecurityObserver => ({
    id: 'flaky',
    async start(): Promise<void> {
      observerStarts += 1;
      if (observerStarts === 1) throw new Error('observer start boom');
    },
    onFinding(): void {},
    onRetraction(): void {},
    async stop(): Promise<void> { observerStops += 1; },
  });

  const core = createNodeCore({
    node_id: 'node', db_path: dbPath,
    workspaces: [{ id: 'work', root: dir }], port: 0,
    token: nodeToken, operator_token: operatorToken,
    adapters: makeAdapters([]), observer: observerFactory,
    approval_required: [], agent_tokens: { claude: claudeToken },
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });

  // First start fails after stage graphs started and the grants connection
  // opened; the catch must stop the observer and close both connections.
  await assert.rejects(core.start(), /observer start boom/);

  // The observer's stop() must have run: if the catch body stopped only grants
  // and store (finding 4's "partially closed"), this stays zero and fails.
  assert.equal(observerStops, 1, 'the failed start must stop the observer it started');

  // The observable that the failed start released its handles AND cleared the
  // half-started HTTP/stage-graph state: a subsequent start on the SAME Core
  // instance binds a real, non-zero port. If the first start leaked
  // `this.http.server` (http.start assigns `server` before `listen`), the second
  // start returns `{ port: 0 }` without reopening the store; and if it leaked
  // `this.stageGraphs`' interval, a new controller replaces the reference while
  // the first keeps running. node:sqlite exposes no connection count, so this
  // recovery start — which reopens and exercises the same database file on a
  // real port — is the strongest black-box assertion available.
  const { port } = await core.start();
  assert.ok(port > 0, `the recovery start must bind a real port, got ${port}`);
  const created = await post(port, '/operator/agent_grant_create', { job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agent: 'claude' }, operatorToken);
  assert.equal(created.body.error, undefined, `grant failed: ${JSON.stringify(created.body)}`);
  const invoke = await post(port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(invoke.body.error, undefined, `invoke failed: ${JSON.stringify(invoke.body)}`);
});

test('a start that fails after http.start assigns its server clears it and rebinds', async (t) => {
  // A failure AFTER `http.start` has assigned its `server` but before `listen`
  // resolves: occupy a port, then start Core on that exact port. http.start
  // assigns `server` and `listen` rejects (EADDRINUSE). The catch must call
  // http.stop() to clear `server`; otherwise the recovery start returns
  // `{ port: 0 }` (core.start treats a non-null server as already up).
  const dir = await mkdtemp(join(tmpdir(), 'toros-agent-start-eaddrinuse-'));
  const dbPath = join(dir, 'node.sqlite');
  const store = await openStore({ path: dbPath, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    objective: 'listen-failure cleanup',
    allowed_capabilities: ['machine.inventory'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 10,
    max_retries: 0,
    expires_at: '2999-01-01T00:00:00Z',
  }));
  await store.close();

  // Occupy an ephemeral port, then reuse its number for the Core start.
  const blocker = await new Promise<import('node:net').Server>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== 'string', 'blocker must bind a TCP port');
  const takenPort = address.port;
  t.after(async () => { blocker.close(); });

  const core = createNodeCore({
    node_id: 'node', db_path: dbPath,
    workspaces: [{ id: 'work', root: dir }], port: takenPort,
    token: nodeToken, operator_token: operatorToken,
    adapters: makeAdapters([]), observer: null,
    approval_required: [], agent_tokens: { claude: claudeToken },
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });

  await assert.rejects(core.start());

  // Release the occupied port so the recovery start can bind it. The recovery
  // start must bind a real port: if the catch body is emptied (finding 4), the
  // server assigned by the failed http.start survives and http.port() returns 0,
  // so core.start returns `{ port: 0 }` without reopening the store.
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  const { port } = await core.start();
  assert.ok(port > 0, `the recovery start must bind a real port, got ${port}`);
});

// ---------------------------------------------------------------------------
// /agent/status — body validation and the 200 success paths.
// ---------------------------------------------------------------------------

test('POST /agent/status validates the body exactly like invoke', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));

  // Oversized body: content-length over the 1 MiB cap is refused before reading.
  const oversized = await new Promise<number>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: f.port, path: '/agent/status', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${claudeToken}`, 'content-length': 1048577 },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(oversized, 413, 'an oversized /agent/status body must be 413');

  // A non-object JSON body gets the same E_SCHEMA refusal invoke would produce.
  const nonObject = await postRaw(f.port, '/agent/status', '[1,2,3]', claudeToken);
  assert.equal(nonObject.status, 400);
  assert.equal(nonObject.body.error, ErrorCode.E_SCHEMA);
  assert.equal(nonObject.body.message, 'Arguments must be an object');
});

test('POST /agent/status returns 200 with no grant (nulls) and with a live grant', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  t.after(() => finish(f));

  // No grant: everything the agent would otherwise see is null.
  const noGrant = await post(f.port, '/agent/status', {}, claudeToken);
  assert.equal(noGrant.status, 200, JSON.stringify(noGrant.body));
  assert.equal(noGrant.body.agent, 'claude');
  assert.equal(noGrant.body.grant, null);
  assert.equal(noGrant.body.objective, null);
  assert.equal(noGrant.body.allowed_capabilities, null);
  assert.equal(noGrant.body.desktop_enabled, false);

  // A live grant fills in the binding and the granted job's envelope.
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));
  const withGrant = await post(f.port, '/agent/status', {}, claudeToken);
  assert.equal(withGrant.status, 200, JSON.stringify(withGrant.body));
  const binding = withGrant.body.grant as Record<string, unknown>;
  assert.equal(binding.grant_id, String(created.body.grant_id));
  assert.equal(binding.job_id, f.jobId);
  assert.equal(binding.expires_at, String(created.body.expires_at));
  assert.equal(withGrant.body.objective, 'agent surface suite');
  assert.deepEqual(withGrant.body.allowed_capabilities, ['desktop.state', 'desktop.inspect', 'machine.inventory']);
  assert.equal(withGrant.body.desktop_enabled, false);
});