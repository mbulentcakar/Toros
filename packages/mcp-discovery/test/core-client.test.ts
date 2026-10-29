/**
 * Process + Core layer tests for `packages/mcp-discovery` (spec AT acceptance
 * tests 9 and 10): real child processes for argv refusals and the full stdio
 * path against a test HTTP stand-in, plus the MCP server driven against a real
 * Node Core created with `createNodeCore`, following the fixtures of
 * `packages/node-core/test/agent-surface.test.ts`. No native desktop, no
 * Windows.
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ErrorCode,
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AdapterManifest,
  type JsonValue,
  type NodePlatform,
  type Receipt,
} from '@toros/contracts';
import { sealEnvelope } from '@toros/envelope';
import { openStore } from '@toros/store';
import { createNodeCore, type NodeCore } from '@toros/node-core';

import { createCoreClient, createMcpServer, RESULT_CAP_BYTES, FRAME_CAP_BYTES } from '../src/index.js';

/** The compiled launch entry, as a native path usable by `spawn`. */
const MAIN_JS = fileURLToPath(new URL('../src/main.js', import.meta.url));

const nodeToken = 'node-token-for-mcp-discovery-suite-123456789-ab';
const operatorToken = 'operator-token-for-mcp-discovery-suite-98765';
const claudeToken = 'claude-token-for-mcp-discovery-suite-1234567890';
const codexToken = 'codex-token-for-mcp-discovery-suite-1234567890';

function platform(): NodePlatform {
  return process.platform as NodePlatform;
}

function desktopManifest(): AdapterManifest {
  return {
    id: 'desktop', version: '1.0.0', platforms: [platform()],
    actions: [
      { id: 'state', summary: 'state', input_schema: { type: 'object', additionalProperties: false, required: ['session_scope'], properties: { session_scope: { type: 'string', enum: ['interactive'] } } }, path_fields: [], mutates: false, always_requires_approval: false },
      { id: 'inspect', summary: 'inspect', input_schema: { type: 'object', additionalProperties: false, properties: { session_scope: { type: 'string' }, window_id: { type: 'string' }, freshness_token: { type: 'string' }, depth: { type: 'integer' }, continuation_token: { type: 'string' }, page_size: { type: 'integer' }, control_filter: { type: 'string' } } }, path_fields: [], mutates: false, always_requires_approval: false },
    ],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 1_000, cancellation: 'graceful', receipt_fields: ['session'],
  };
}

function machineManifest(): AdapterManifest {
  return {
    id: 'machine', version: '1.0.0', platforms: [platform()],
    actions: [{ id: 'inventory', summary: 'inventory', input_schema: { type: 'object', additionalProperties: false, properties: { capability_filter: { type: 'string' } } }, path_fields: [], mutates: false, always_requires_approval: false }],
    required_permissions: [], allowed_resources: [], default_timeout_ms: 30_000, cancellation: 'graceful', receipt_fields: [],
  };
}

interface FakeCall { capability: string; args: Readonly<Record<string, JsonValue>>; actor: string; }

function makeAdapters(calls: FakeCall[], options: { hang?: string } = {}): Adapter[] {
  const record = (capability: string, args: Readonly<Record<string, JsonValue>>, ctx: AdapterContext, output: string, fields: Readonly<Record<string, JsonValue>> = {}): Promise<ActionResult> => {
    calls.push({ capability, args, actor: ctx.actor });
    return Promise.resolve({ output, truncated: false, artifacts: [], receipt_extra: fields });
  };

  const handles = new Map<string, { job_id: string; actor: string; consumed: boolean }>();
  const continuations = new Map<string, string>(); // `${job}:${actor}` -> minted continuation token
  const desktop: Adapter = {
    manifest: desktopManifest(),
    async init() {},
    async invoke(actionId, args, ctx): Promise<ActionResult> {
      if (options.hang === 'desktop.state') {
        return new Promise((_resolve) => { /* never settles; Core's timeout closes the receipt */ });
      }
      if (actionId === 'state') {
        const token = randomUUID();
        handles.set(token, { job_id: ctx.job_id, actor: ctx.actor, consumed: false });
        return record('desktop.state', args, ctx, JSON.stringify({ session: 'active', freshness_token: token, windows: [] }));
      }
      // Page N+1: continuation_token alone, minted by the previous page and
      // bound to this (job, actor) exactly as the real adapter binds it.
      const continuation = typeof args['continuation_token'] === 'string' ? args['continuation_token'] : null;
      if (continuation !== null) {
        const minted = continuations.get(`${ctx.job_id}:${ctx.actor}`);
        if (minted !== continuation) return record('desktop.inspect', args, ctx, JSON.stringify({ status: 'refresh_required', controls: [] }));
        return record('desktop.inspect', args, ctx, JSON.stringify({ status: 'ok', page: 2, controls: [{ kind: 'group' }] }));
      }
      // Page 1: a valid, unconsumed freshness_token handle.
      const supplied = typeof args['freshness_token'] === 'string' ? args['freshness_token'] : null;
      const handle = supplied === null ? undefined : handles.get(supplied);
      const valid = handle !== undefined && handle.job_id === ctx.job_id && handle.actor === ctx.actor && !handle.consumed;
      if (!valid) return record('desktop.inspect', args, ctx, JSON.stringify({ status: 'refresh_required', controls: [] }));
      handle.consumed = true;
      continuations.set(`${ctx.job_id}:${ctx.actor}`, 'ct-1');
      return record('desktop.inspect', args, ctx, JSON.stringify({ status: 'ok', page: 1, continuation_token: 'ct-1', controls: [{ kind: 'text' }] }));
    },
    async dispose() {},
  };
  const machine: Adapter = {
    manifest: machineManifest(),
    async init() {},
    async invoke(_actionId, args, ctx): Promise<ActionResult> {
      if (options.hang === 'machine.inventory') {
        return new Promise((_resolve) => { /* never settles; Core's timeout closes the receipt */ });
      }
      return record('machine.inventory', args, ctx, JSON.stringify({ entries: [] }));
    },
    async dispose() {},
  };
  return [desktop, machine];
}

interface Fixture {
  core: NodeCore; port: number; dbPath: string; dir: string; jobId: string; calls: FakeCall[];
}

async function makeFixture(options: { envelope?: Record<string, unknown>; desktopArGateCleared?: boolean; hang?: string } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-'));
  const dbPath = join(dir, 'node.sqlite');
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const store = await openStore({ path: dbPath, nodeId: 'node' });
  await store.createJob(sealEnvelope({
    job_id: jobId,
    objective: 'mcp discovery suite',
    allowed_capabilities: ['desktop.state', 'desktop.inspect', 'machine.inventory'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: [],
    max_actions: 20,
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
    adapters: makeAdapters(calls, options.hang === undefined ? {} : { hang: options.hang }),
    observer: null,
    approval_required: [],
    operator_token: operatorToken,
    agent_tokens: { claude: claudeToken, codex: codexToken },
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
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown> }); });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function grant(f: Fixture, agent: string): Promise<void> {
  const r = await post(f.port, '/operator/agent_grant_create', { job_id: f.jobId, agent }, operatorToken);
  assert.equal(r.body.error, undefined, `grant failed: ${JSON.stringify(r.body)}`);
}

/** Drive the MCP server directly against the real Core client. */
interface McpHarness {
  frames: Array<Record<string, unknown>>;
  receive: (line: string) => void;
}

function mcpHarness(port: number, token: string): McpHarness {
  const frames: Array<Record<string, unknown>> = [];
  const server = createMcpServer({
    call: createCoreClient({ port, token }),
    write: (frame) => frames.push(JSON.parse(frame) as Record<string, unknown>),
    log: () => {},
  });
  return { frames, receive: (line) => server.receive(line) };
}

function init(h: McpHarness): void {
  h.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
}

function callTool(h: McpHarness, id: number, name: string, args: Record<string, unknown> = {}): void {
  h.receive(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
}

function resultFor(h: McpHarness, id: number): Record<string, unknown> {
  const frame = h.frames[h.frames.length - 1]!;
  assert.equal(frame['id'], id, `expected the latest frame to answer id ${id}`);
  return frame['result'] as Record<string, unknown>;
}

/** Poll until a frame answering `id` arrives (or the timeout elapses). */
async function waitForFrame(frames: Array<Record<string, unknown>>, id: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const frame = frames.find((f) => f['id'] === id);
    if (frame !== undefined) return frame;
    if (Date.now() - started >= timeoutMs) {
      assert.fail(`no frame answering id ${id} within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Real child process — argv refusals.
// ---------------------------------------------------------------------------

function spawnMain(args: string[], env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [MAIN_JS, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
}

function collect(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on('data', (c: Buffer) => stdout.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.join(''), stderr: stderr.join('') }); });
  });
}

test('argv refusals: no argv, --agent x, --agent claude extra, --agent=claude all exit 2', async () => {
  const cases: Array<{ args: string[]; label: string }> = [
    { args: [], label: 'no argv' },
    { args: ['--agent', 'x'], label: '--agent x' },
    { args: ['--agent', 'claude', 'extra'], label: '--agent claude extra' },
    { args: ['--agent=claude'], label: '--agent=claude' },
  ];
  for (const c of cases) {
    const out = await collect(spawnMain(c.args), 10_000);
    assert.equal(out.code, 2, `${c.label}: exit code ${out.code}`);
    assert.equal(out.stdout, '', `${c.label}: stdout must be empty`);
    assert.equal(out.stderr.trim().split('\n').length, 1, `${c.label}: exactly one stderr line (${JSON.stringify(out.stderr)})`);
  }
});

// ---------------------------------------------------------------------------
// In-test HTTP stand-in that records requests and can refuse to answer.
// ---------------------------------------------------------------------------

interface StandIn {
  server: Server;
  port: number;
  requests: Array<{ path: string; auth: string }>;
  closedCount: () => number;
}

interface StandInOptions {
  neverAnswer?: boolean;
  /** Build the raw HTTP response bytes (headers + body) for a request. */
  respond?: (path: string) => Buffer | null;
}

function startStandIn(options: StandInOptions = {}): Promise<StandIn> {
  const requests: Array<{ path: string; auth: string }> = [];
  let closed = 0;
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let parsed = false;
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (parsed) return;
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd === -1) return;
        const head = buffer.subarray(0, headEnd).toString('utf8');
        const firstLine = head.split('\r\n')[0] ?? '';
        const path = firstLine.split(' ')[1] ?? '';
        const authMatch = /authorization:\s*(Bearer [^\r\n]+)/i.exec(head);
        const auth = authMatch?.[1] ?? '';
        requests.push({ path, auth });
        parsed = true;
        if (options.neverAnswer === true) return; // accept and never respond
        if (options.respond !== undefined) {
          const custom = options.respond(path);
          if (custom !== null) {
            socket.write(custom);
            socket.end();
            return;
          }
        }
        const body = JSON.stringify({ agent: 'claude', grant: null, objective: null, allowed_capabilities: null, desktop_enabled: true });
        socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        socket.end();
      });
      socket.on('close', () => { closed += 1; });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, port, requests, closedCount: () => closed });
    });
  });
}

// ---------------------------------------------------------------------------
// Real child process — the full stdio path.
// ---------------------------------------------------------------------------

async function writeConfig(dir: string, port: number, token: string): Promise<void> {
  await mkdir(join(dir, 'Toros'), { recursive: true });
  await writeFile(join(dir, 'Toros', 'config.json'), JSON.stringify({
    node_id: 'node', db_path: join(dir, 'node.sqlite'),
    port, token: nodeToken, workspaces: [{ id: 'work', root: dir }],
    agents: { claude: { token } },
  }));
}

test('full path: --agent claude against a stand-in records POST /agent/status with the bearer; stdout only frames', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const standIn = await startStandIn();
  t.after(() => void closeServer(standIn.server));
  // A generated test token; never a real config.
  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, standIn.port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const stdoutLines: string[] = [];
  const rl = createInterface({ input: child.stdout ?? process.stdout });
  rl.on('line', (line: string) => stdoutLines.push(line));

  await new Promise((r) => setTimeout(r, 300)); // let it start and read config
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }) + '\n');

  await new Promise((r) => setTimeout(r, 800));
  rl.close();
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('close', () => resolve(null)));

  const statusRequests = standIn.requests.filter((r) => r.path === '/agent/status');
  assert.ok(statusRequests.length >= 1, 'stand-in did not see /agent/status');
  assert.equal(statusRequests[0]!.auth, `Bearer ${token}`);

  // Both the id:1 initialize result and the id:2 toros_status result must be
  // present, not merely "some frames".
  const parsed = stdoutLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const initFrame = parsed.find((f) => f['id'] === 1 && f['result'] !== undefined);
  assert.ok(initFrame !== undefined, 'missing id:1 initialize result');
  assert.equal(((initFrame!['result'] as Record<string, unknown>)['protocolVersion']), '2025-06-18');
  const statusFrame = parsed.find((f) => f['id'] === 2 && f['result'] !== undefined);
  assert.ok(statusFrame !== undefined, 'missing id:2 toros_status result');
  assert.equal((statusFrame!['result'] as Record<string, unknown>)['isError'], false);
  for (const line of stdoutLines) {
    const p = JSON.parse(line) as Record<string, unknown>;
    assert.equal(p['jsonrpc'], '2.0');
  }
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Round 2 — item 4: connection failure is a tool result (real child process).
// ---------------------------------------------------------------------------

test('a port with nothing listening answers a tool result isError true with no error member', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-connfail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Grab a port, then close it so nothing is listening.
  const probe = createServer(() => {});
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const frames: Array<Record<string, unknown>> = [];
  const rl = createInterface({ input: child.stdout ?? process.stdout });
  rl.on('line', (line: string) => frames.push(JSON.parse(line) as Record<string, unknown>));

  await new Promise((r) => setTimeout(r, 300));
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }) + '\n');

  const frame = await waitForFrame(frames, 2, 5_000);
  rl.close();
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('close', () => resolve(null)));

  assert.equal(frame['error'], undefined, 'connection failure must not be a JSON-RPC error');
  const result = frame['result'] as Record<string, unknown>;
  assert.equal(result['isError'], true);
  const content = result['content'] as Array<{ text: string }>;
  assert.equal(content[0]!.text, 'Node Core is not reachable');
});

// ---------------------------------------------------------------------------
// Round 2 — item 6: buffer stdin reader (real child process).
// ---------------------------------------------------------------------------

function childFrames(child: ChildProcess): { frames: Array<Record<string, unknown>>; close: () => void } {
  const frames: Array<Record<string, unknown>> = [];
  const rl = createInterface({ input: child.stdout ?? process.stdout });
  rl.on('line', (line: string) => frames.push(JSON.parse(line) as Record<string, unknown>));
  return { frames, close: () => rl.close() };
}

async function stopChild(child: ChildProcess): Promise<void> {
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('close', () => resolve(null)));
}

test('a 1 MiB + 1 byte line (in chunks) is answered with one -32600, then a ping answers within 2 s', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const standIn = await startStandIn();
  t.after(() => void closeServer(standIn.server));
  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, standIn.port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const { frames, close } = childFrames(child);
  await new Promise((r) => setTimeout(r, 300));

  // A 1 MiB + 1 byte line written in several chunks, then a ping.
  const pad = 'x'.repeat(RESULT_CAP_BYTES + 1);
  const oversizedLine = JSON.stringify({ jsonrpc: '2.0', id: 500, method: 'ping', params: { pad } });
  // The pad alone exceeds the cap; split into chunks and write without a
  // trailing newline split so the reader accumulates across chunks.
  const chunkSize = 256 * 1024;
  const withNl = `${oversizedLine}\n`;
  for (let i = 0; i < withNl.length; i += chunkSize) {
    child.stdin?.write(withNl.slice(i, i + chunkSize));
    // small backpressure to force chunk boundaries
    if (i % (chunkSize * 2) === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const started = Date.now();
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 501, method: 'ping' }) + '\n');

  // One -32600 for the oversized line, then a ping answer within 2 s.
  const pingFrame = await waitForFrame(frames, 501, 2_000);
  assert.deepEqual(pingFrame['result'], {});
  const oversized = frames.find((f) => f['id'] === null && f['error'] !== undefined && (f['error'] as { code: number }).code === -32600);
  assert.ok(oversized !== undefined, 'no -32600 (id null) frame for the oversized line');
  assert.ok(Date.now() - started < 2_000, `ping did not answer within 2 s (${Date.now() - started} ms)`);

  close();
  await stopChild(child);
});

test('a valid frame of exactly the cap ending in CRLF is accepted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-reader-exact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const standIn = await startStandIn();
  t.after(() => void closeServer(standIn.server));
  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, standIn.port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const { frames, close } = childFrames(child);
  await new Promise((r) => setTimeout(r, 300));

  // A ping line whose length (before CRLF) is exactly FRAME_CAP_BYTES.
  function buildLine(padLen: number): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 600, method: 'ping', params: { pad: 'x'.repeat(padLen) } });
  }
  let padLen = 0;
  for (;;) {
    const line = buildLine(padLen);
    const delta = FRAME_CAP_BYTES - Buffer.byteLength(line, 'utf8');
    if (delta === 0) break;
    padLen += delta; // each extra `x` adds one byte
    if (padLen < 0) assert.fail('could not size the exact-cap line');
  }
  const line = buildLine(padLen);
  assert.equal(Buffer.byteLength(line, 'utf8'), FRAME_CAP_BYTES);
  child.stdin?.write(`${line}\r\n`);

  const frame = await waitForFrame(frames, 600, 2_000);
  assert.deepEqual(frame['result'], {});
  close();
  await stopChild(child);
});

// ---------------------------------------------------------------------------
// Round 3 — item 2: an exact-cap CRLF frame split across chunks is accepted.
// ---------------------------------------------------------------------------

/** Build a ping line whose length (before CRLF) is exactly FRAME_CAP_BYTES. */
function buildExactCapPing(id: number): string {
  function buildLine(padLen: number): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: { pad: 'x'.repeat(padLen) } });
  }
  let padLen = 0;
  for (;;) {
    const line = buildLine(padLen);
    const delta = FRAME_CAP_BYTES - Buffer.byteLength(line, 'utf8');
    if (delta === 0) break;
    padLen += delta; // each extra `x` adds one byte
    if (padLen < 0) assert.fail('could not size the exact-cap line');
  }
  const line = buildLine(padLen);
  assert.equal(Buffer.byteLength(line, 'utf8'), FRAME_CAP_BYTES);
  return line;
}

test('an exact-cap ping whose \\r and \\n arrive in separate writes gets the ping answer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-split-crlf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const standIn = await startStandIn();
  t.after(() => void closeServer(standIn.server));
  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, standIn.port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const { frames, close } = childFrames(child);
  await new Promise((r) => setTimeout(r, 300));

  const line = buildExactCapPing(700);
  // The payload + \r in one write, then \n 300 ms later: the reader sees an
  // exact-cap line plus a trailing CR only once the LF arrives.
  child.stdin?.write(`${line}\r`);
  await new Promise((r) => setTimeout(r, 300));
  child.stdin?.write('\n');

  const frame = await waitForFrame(frames, 700, 2_000);
  assert.deepEqual(frame['result'], {}, 'the exact-cap ping must be answered');
  close();
  await stopChild(child);
});

test('the same payload with one extra non-CR byte gets one -32600', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-split-overflow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const standIn = await startStandIn();
  t.after(() => void closeServer(standIn.server));
  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, standIn.port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const { frames, close } = childFrames(child);
  await new Promise((r) => setTimeout(r, 300));

  const line = buildExactCapPing(701);
  // One extra non-CR byte: the payload now exceeds the cap with a byte that is
  // not the trailing CR, so it overflows before CRLF, yielding one -32600.
  child.stdin?.write(`${line}x\r`);
  await new Promise((r) => setTimeout(r, 300));
  child.stdin?.write('\n');

  // One -32600 (id null) frame for the oversized line, then nothing else.
  await new Promise((r) => setTimeout(r, 400));
  const oversized = frames.filter((f) => f['id'] === null && f['error'] !== undefined && (f['error'] as { code: number }).code === -32600);
  assert.equal(oversized.length, 1, 'exactly one -32600 (id null) frame for the oversized line');

  // The process is still alive and answers a fresh ping.
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 702, method: 'ping' }) + '\n');
  const frame = await waitForFrame(frames, 702, 2_000);
  assert.deepEqual(frame['result'], {});
  close();
  await stopChild(child);
});

test('a blank line produces no frame', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-blank-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const standIn = await startStandIn();
  t.after(() => void closeServer(standIn.server));
  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, standIn.port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const { frames, close } = childFrames(child);
  await new Promise((r) => setTimeout(r, 300));

  const before = frames.length;
  child.stdin?.write('\n');
  child.stdin?.write('\r\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(frames.length, before, 'blank lines must produce no frame');

  // The process is still alive and answers a real ping.
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 601, method: 'ping' }) + '\n');
  const frame = await waitForFrame(frames, 601, 2_000);
  assert.deepEqual(frame['result'], {});
  close();
  await stopChild(child);
});

// ---------------------------------------------------------------------------
// Round 2 — item 11: result cap and 401 bearer.
// ---------------------------------------------------------------------------

function httpResponse(status: number, headers: Record<string, string>, body: Buffer): Buffer {
  const head = `HTTP/1.1 ${status}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), body]);
}

/** A valid JSON object body of exactly `size` bytes, using a `pad` string. */
function jsonBodyOfSize(size: number): Buffer {
  // `{"pad":""}` is 10 bytes; the pad fills the rest.
  const overhead = Buffer.byteLength('{"pad":""}', 'utf8');
  const padLength = size - overhead;
  assert.ok(padLength >= 0, 'requested size too small for a JSON object');
  return Buffer.from(JSON.stringify({ pad: 'x'.repeat(padLength) }), 'utf8');
}

test('a stand-in body of RESULT_CAP_BYTES + 1 gives -32603 and the stand-in sees its socket close, while exactly RESULT_CAP_BYTES is returned whole', async (t) => {
  // exactly RESULT_CAP_BYTES: returned whole.
  {
    const exactBody = jsonBodyOfSize(RESULT_CAP_BYTES);
    const exactStandIn = await startStandIn({
      respond: () => httpResponse(200, { 'content-type': 'application/json', 'content-length': String(exactBody.length), connection: 'close' }, exactBody),
    });
    t.after(() => void closeServer(exactStandIn.server));

    const frames: Array<Record<string, unknown>> = [];
    const server = createMcpServer({
      call: createCoreClient({ port: exactStandIn.port, token: claudeToken }),
      write: (frame) => frames.push(JSON.parse(frame) as Record<string, unknown>),
      log: () => {},
    });
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
    const frame = await waitForFrame(frames, 2, 5_000);
    server.close();
    assert.equal(frame['error'], undefined, 'exactly-cap body must not be an error');
    assert.equal((frame['result'] as Record<string, unknown>)['isError'], false);
    // The returned text is the whole body, exactly RESULT_CAP_BYTES bytes.
    const content = (frame['result'] as Record<string, unknown>)['content'] as Array<{ text: string }>;
    assert.equal(content[0]!.text.length, RESULT_CAP_BYTES, 'the returned text must be exactly RESULT_CAP_BYTES bytes');
  }

  // RESULT_CAP_BYTES + 1: -32603 and socket closed.
  {
    const bigBody = jsonBodyOfSize(RESULT_CAP_BYTES + 1);
    const capStandIn = await startStandIn({
      respond: () => httpResponse(200, { 'content-type': 'application/json', 'content-length': String(bigBody.length), connection: 'close' }, bigBody),
    });
    t.after(() => void closeServer(capStandIn.server));

    const frames: Array<Record<string, unknown>> = [];
    const server = createMcpServer({
      call: createCoreClient({ port: capStandIn.port, token: claudeToken }),
      write: (frame) => frames.push(JSON.parse(frame) as Record<string, unknown>),
      log: () => {},
    });
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
    const frame = await waitForFrame(frames, 2, 5_000);
    server.close();
    const err = frame['error'] as { code: number; message: string };
    assert.equal(err.code, -32603);
    assert.equal(err.message, 'result exceeds 1 MiB');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(capStandIn.closedCount() >= 1, 'the result-cap stand-in did not observe its socket closing');
  }
});

test('a 401 whose body and www-authenticate header contain the bearer answers the fixed text and echoes neither', async (t) => {
  const body = Buffer.from(JSON.stringify({ error: `leak-${claudeToken}`, message: `see-${claudeToken}` }));
  const standIn = await startStandIn({
    respond: () => httpResponse(401, {
      'content-type': 'application/json',
      'content-length': String(body.length),
      'www-authenticate': `Bearer realm="toros", error="invalid_token ${claudeToken}"`,
      connection: 'close',
    }, body),
  });
  t.after(() => void closeServer(standIn.server));

  const frames: Array<Record<string, unknown>> = [];
  const server = createMcpServer({
    call: createCoreClient({ port: standIn.port, token: claudeToken }),
    write: (frame) => frames.push(JSON.parse(frame) as Record<string, unknown>),
    log: () => {},
  });
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  const frame = await waitForFrame(frames, 2, 5_000);
  server.close();

  const result = frame['result'] as Record<string, unknown>;
  assert.equal(result['isError'], true);
  const content = result['content'] as Array<{ text: string }>;
  assert.equal(content[0]!.text, 'Node Core refused the agent token (401)');
  assert.equal(JSON.stringify(frame).includes(claudeToken), false, 'the 401 frame must not echo the bearer');
});

// ---------------------------------------------------------------------------
// Stand-in never answers — the real 45 s deadline. Slow (~45 s): not gated.
// ---------------------------------------------------------------------------

test('a stand-in that never responds answers -32001 at 45 s (±2 s) and the socket closes', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-mcp-deadline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const standIn = await startStandIn({ neverAnswer: true });
  t.after(() => void closeServer(standIn.server));
  const token = randomBytes(24).toString('hex');
  await writeConfig(dir, standIn.port, token);

  const child = spawnMain(['--agent', 'claude'], { LOCALAPPDATA: dir });
  const frames: Array<Record<string, unknown>> = [];
  const rl = createInterface({ input: child.stdout ?? process.stdout });
  rl.on('line', (line: string) => frames.push(JSON.parse(line) as Record<string, unknown>));

  await new Promise((r) => setTimeout(r, 300));
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  const started = Date.now();
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }) + '\n');

  // Poll for the -32001 frame, failing if it arrives way off the 45 s mark.
  let errFrame: Record<string, unknown> | undefined;
  for (let i = 0; i < 110; i++) {
    await new Promise((r) => setTimeout(r, 500));
    errFrame = frames.find((f) => f['id'] === 2 && f['error'] !== undefined);
    if (errFrame !== undefined) break;
  }
  const elapsed = Date.now() - started;
  assert.ok(errFrame !== undefined, 'no -32001 frame within 55 s');
  const error = errFrame!['error'] as { code: number };
  assert.equal(error.code, -32001);
  assert.ok(Math.abs(elapsed - 45_000) <= 2_000, `deadline fired at ${elapsed} ms, expected ~45 000`);

  // The stand-in saw its socket close once the client destroyed the request.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(standIn.closedCount() >= 1, 'the stand-in did not observe its socket closing');

  rl.close();
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('close', () => resolve(null)));
});

// ---------------------------------------------------------------------------
// Against a real Node Core.
// ---------------------------------------------------------------------------

test('against a real Core: toros_status shows the grant, desktop_state succeeds, desktop_inspect pages, and no-grant gives E_GRANT_INVALID', async (t) => {
  const f = await makeFixture({ desktopArGateCleared: true });
  t.after(() => finish(f));

  const h = mcpHarness(f.port, claudeToken);
  init(h);

  // No grant yet: machine_inventory -> isError true, E_GRANT_INVALID, no_grant.
  callTool(h, 10, 'machine_inventory');
  await new Promise((r) => setTimeout(r, 250));
  let result = resultFor(h, 10);
  assert.equal(result['isError'], true);
  const sc10 = result['structuredContent'] as Record<string, unknown>;
  assert.equal(sc10['error'], ErrorCode.E_GRANT_INVALID);
  assert.equal(sc10['reason'], 'no_grant');

  await grant(f, 'claude');

  // toros_status shows the grant.
  callTool(h, 11, 'toros_status');
  await new Promise((r) => setTimeout(r, 250));
  result = resultFor(h, 11);
  assert.equal(result['isError'], false);
  const statusSc = result['structuredContent'] as Record<string, unknown>;
  assert.equal(statusSc['agent'], 'claude');
  assert.equal((statusSc['grant'] as Record<string, unknown>)['job_id'], f.jobId);

  // desktop_state succeeds.
  callTool(h, 12, 'desktop_state');
  await new Promise((r) => setTimeout(r, 250));
  result = resultFor(h, 12);
  assert.equal(result['isError'], false);
  const stateOutput = JSON.parse(String((result['structuredContent'] as Record<string, unknown>)['output'])) as { freshness_token: string };
  assert.equal(typeof stateOutput.freshness_token, 'string');

  // desktop_inspect page 1.
  callTool(h, 13, 'desktop_inspect', { window_id: 'w', freshness_token: stateOutput.freshness_token });
  await new Promise((r) => setTimeout(r, 250));
  result = resultFor(h, 13);
  assert.equal(result['isError'], false);
  const page1 = JSON.parse(String((result['structuredContent'] as Record<string, unknown>)['output'])) as { page: number; continuation_token: string };
  assert.equal(page1.page, 1);
  assert.equal(page1.continuation_token, 'ct-1');

  // desktop_inspect page 2 with the continuation token from page 1.
  callTool(h, 14, 'desktop_inspect', { continuation_token: page1.continuation_token });
  await new Promise((r) => setTimeout(r, 250));
  result = resultFor(h, 14);
  assert.equal(result['isError'], false);
  const page2 = JSON.parse(String((result['structuredContent'] as Record<string, unknown>)['output'])) as { page: number };
  assert.equal(page2.page, 2);

  // machine_inventory now succeeds with a live grant.
  callTool(h, 15, 'machine_inventory');
  await new Promise((r) => setTimeout(r, 250));
  result = resultFor(h, 15);
  assert.equal(result['isError'], false);
});

test('a hanging action returns E_TIMEOUT (isError true, not -32001) before the 45 s MCP deadline and the receipt is terminated', { timeout: 60_000 }, async (t) => {
  const f = await makeFixture({ desktopArGateCleared: true, hang: 'machine.inventory' });
  t.after(() => finish(f));

  // Drive through createMcpServer with the default 45 s deadline.
  const h = mcpHarness(f.port, claudeToken);
  init(h);
  await grant(f, 'claude');

  const started = Date.now();
  callTool(h, 20, 'machine_inventory');
  // The hanging machine.inventory action's own timeout is 30 000 ms (the
  // manifest default_timeout_ms), far below the MCP 45 s deadline, so Core
  // closes the receipt with E_TIMEOUT and the MCP server returns a tool result,
  // never the -32001 deadline error.
  const frame = await waitForFrame(h.frames, 20, 50_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 28_000, `E_TIMEOUT arrived too early (${elapsed} ms); expected >= 28 000`);
  assert.ok(elapsed < 45_000, `E_TIMEOUT arrived at or after the 45 s MCP deadline (${elapsed} ms)`);
  assert.equal(frame['error'], undefined, 'E_TIMEOUT must be a tool result, not a JSON-RPC error');
  const result = frame['result'] as Record<string, unknown>;
  assert.equal(result['isError'], true);
  const structured = result['structuredContent'] as Record<string, unknown>;
  assert.equal(structured['error'], ErrorCode.E_TIMEOUT);

  const store = await openStore({ path: f.dbPath, nodeId: 'node' });
  const receipts: readonly Receipt[] = await store.listReceipts(f.jobId);
  await store.close();
  const receipt = receipts.find((r) => r.capability === 'machine.inventory' && r.outcome === 'terminated');
  assert.ok(receipt, 'no terminated receipt for the hanging machine.inventory');
});