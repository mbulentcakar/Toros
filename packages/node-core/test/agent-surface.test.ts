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
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
  const desktop: Adapter = {
    manifest: desktopManifest(),
    async init() {},
    async invoke(actionId, args, ctx): Promise<ActionResult> {
      if (actionId === 'state') return record('desktop.state', args, ctx, JSON.stringify({ session: 'active', freshness_token: 'tok', windows: [] }));
      return record('desktop.inspect', args, ctx, JSON.stringify({ status: 'ok', controls: [] }));
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
  grants.create('claude', f.jobId, '2020-01-01T00:00:00Z');
  grants.close();
  const result = await post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken);
  assert.equal(result.body.error, ErrorCode.E_EXPIRED);
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

test('a string "true" flag leaves the gate closed (strict === true)', async (t) => {
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken } });
  // Cast through an unknown-typed option to simulate the hand-edited config.
  (f.core as unknown as { options: { desktop_ar_gate_cleared: unknown } }).options.desktop_ar_gate_cleared = ('true' as unknown);
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined);
  const denied = await post(f.port, '/agent/invoke', { capability: 'desktop.state', parameters: {} }, claudeToken);
  assert.equal(denied.body.error, ErrorCode.E_MODE_DENIED);
  assert.equal(denied.body.reason, 'ar_gate');
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
  const f = await makeFixture({ operatorToken, agentTokens: { claude: claudeToken }, desktopArGateCleared: true, slowMs: 300 });
  t.after(() => finish(f));
  const created = await grant(f, 'claude');
  assert.equal(created.body.error, undefined, JSON.stringify(created.body));

  const [a, b] = await Promise.all([
    post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken),
    post(f.port, '/agent/invoke', { capability: 'machine.inventory', parameters: {} }, claudeToken),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `expected one 200 and one 409, got ${JSON.stringify(statuses)}`);
  const conflicted = a.status === 409 ? a : b;
  assert.equal(conflicted.body.error, ErrorCode.E_PARALLEL_ACTION);
});