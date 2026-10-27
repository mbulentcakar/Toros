/**
 * Protocol-layer tests for `createMcpServer` against a fake `call` (spec AT
 * acceptance tests 9 and 10). No real network or Node Core here.
 *
 * `receive` is fed one complete line at a time; the 1 MiB frame cap is
 * enforced by the server on that line, which is what these tests assert.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DEADLINE_MS,
  MAX_OUTSTANDING,
  PROTOCOL_VERSION,
  createMcpServer,
  type CoreCall,
  type McpServer,
} from '../src/index.js';

/** A fake `call` that records invocations and answers from a script. */
type Behaviour = (route: string, body: unknown, signal: AbortSignal) => Promise<{ status: number; text: string; body: unknown }>;

function harness(options: { deadline_ms?: number } = {}): {
  server: McpServer;
  frames: unknown[];
  calls: Array<{ route: string; body: unknown; signal: AbortSignal }>;
  setBehaviour: (b: Behaviour) => void;
} {
  const frames: unknown[] = [];
  const calls: Array<{ route: string; body: unknown; signal: AbortSignal }> = [];
  let behaviour: Behaviour = async () => ({ status: 200, text: '{"ok":true}', body: { ok: true } });

  const call: CoreCall = (route, body, signal) => {
    calls.push({ route, body, signal });
    return behaviour(route, body, signal);
  };

  const server = createMcpServer({
    call,
    write: (frame: string) => frames.push(JSON.parse(frame)),
    log: () => {},
    ...(options.deadline_ms === undefined ? {} : { deadline_ms: options.deadline_ms }),
  });

  return { server, frames, calls, setBehaviour: (b) => { behaviour = b; } };
}

function receive(server: McpServer, msgs: unknown[]): void {
  for (const m of msgs) server.receive(JSON.stringify(m));
}

function lastFrame(frames: unknown[]): Record<string, unknown> {
  return frames[frames.length - 1] as Record<string, unknown>;
}

function idOf(frame: Record<string, unknown>): unknown {
  return frame['id'];
}

function errorOf(frame: Record<string, unknown>): { code: number; message: string } {
  return (frame['error'] ?? { code: 0, message: '' }) as { code: number; message: string };
}

function initialize(server: McpServer, version = PROTOCOL_VERSION): void {
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } }));
}

function notificationsInitialized(server: McpServer): void {
  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

test('initialize with 2025-06-18 answers 2025-06-18', () => {
  const { server, frames } = harness();
  initialize(server, '2025-06-18');
  const result = lastFrame(frames)['result'] as Record<string, unknown>;
  assert.equal(result['protocolVersion'], '2025-06-18');
  assert.equal((result['serverInfo'] as Record<string, unknown>)['name'], 'toros-discovery');
  const capabilities = result['capabilities'] as Record<string, unknown>;
  assert.deepEqual(capabilities['tools'], { listChanged: false });
  assert.equal(typeof result['instructions'], 'string');
});

test('initialize with another well-formed date answers 2025-06-18', () => {
  const { server, frames } = harness();
  initialize(server, '2025-03-26');
  const result = lastFrame(frames)['result'] as Record<string, unknown>;
  assert.equal(result['protocolVersion'], '2025-06-18');
});

test('a missing or malformed protocolVersion gives -32602', () => {
  for (const params of [{}, { protocolVersion: 123 }, { protocolVersion: 'not-a-date' }, { protocolVersion: '2025-06-18T00:00:00Z' }, undefined]) {
    const { server, frames } = harness();
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params }));
    assert.equal(errorOf(lastFrame(frames)).code, -32602);
  }
});

test('a second initialize gives -32600', () => {
  const { server, frames } = harness();
  initialize(server);
  assert.equal(typeof lastFrame(frames)['result'], 'object');
  initialize(server);
  assert.equal(errorOf(lastFrame(frames)).code, -32600);
});

test('a request before initialize gives -32002, and ping before initialize works', () => {
  const { server, frames } = harness();
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(errorOf(lastFrame(frames)).code, -32002);
  const before = frames.length;
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
  assert.deepEqual(lastFrame(frames)['result'], {});
  assert.equal(frames.length, before + 1);
});

test('the notifications/initialized notification is accepted', () => {
  const { server, frames } = harness();
  initialize(server);
  const before = frames.length;
  notificationsInitialized(server);
  assert.equal(frames.length, before);
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('tools/list returns exactly the four tools, each additionalProperties false', () => {
  const { server, frames } = harness();
  initialize(server);
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const result = lastFrame(frames)['result'] as { tools: Array<Record<string, unknown>> };
  const names = result.tools.map((tool) => tool['name']).sort();
  assert.deepEqual(names, ['desktop_inspect', 'desktop_state', 'machine_inventory', 'toros_status']);
  for (const tool of result.tools) {
    const schema = tool['inputSchema'] as Record<string, unknown>;
    assert.equal(schema['type'], 'object');
    assert.equal(schema['additionalProperties'], false);
    assert.equal(typeof tool['description'], 'string');
  }
});

// ---------------------------------------------------------------------------
// Frame and shape errors (acceptance test 9 + 10).
// ---------------------------------------------------------------------------

test('a 1 MiB + 1 byte line gives -32600, and the next valid line still works', () => {
  const { server, frames } = harness();
  const oversized = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'toros_status', arguments: { pad: 'x'.repeat(1024 * 1024) } } });
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 1024 * 1024, 'the line was not oversized');
  server.receive(oversized);
  assert.equal(errorOf(lastFrame(frames)).code, -32600);
  // The next valid line still works.
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }));
  assert.deepEqual(lastFrame(frames)['result'], {});
});

test('non-object frames (array, number, string, null) give -32600', () => {
  for (const value of [[], 42, 'hello', null]) {
    const { server, frames } = harness();
    server.receive(JSON.stringify(value));
    assert.equal(errorOf(lastFrame(frames)).code, -32600, `for ${JSON.stringify(value)}`);
  }
});

test('an unparsable line gives -32700', () => {
  const { server, frames } = harness();
  server.receive('{not json');
  assert.equal(errorOf(lastFrame(frames)).code, -32700);
});

test('an unknown tool gives -32602 and an unknown method gives -32601', () => {
  const { server, frames } = harness();
  initialize(server);
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }));
  assert.equal(errorOf(lastFrame(frames)).code, -32602);
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'no/such/method' }));
  assert.equal(errorOf(lastFrame(frames)).code, -32601);
});

test('a 5th outstanding request gives -32000 while 4 are held open', async () => {
  const { server, frames, setBehaviour } = harness();
  initialize(server);

  // A fake call that never resolves holds ids open.
  const pending: Array<{ resolve: (v: any) => void; signal: AbortSignal }> = [];
  setBehaviour((_route, _body, signal) => new Promise((resolve) => { pending.push({ resolve, signal }); }));

  for (let i = 0; i < 4; i++) {
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  }
  assert.equal(pending.length, 4);

  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 200, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  assert.equal(errorOf(lastFrame(frames)).code, -32000);

  // Once one resolves, a new request is accepted again.
  pending[0]!.resolve({ status: 200, text: '{}', body: {} });
  await new Promise((r) => setTimeout(r, 0));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  const result = lastFrame(frames)['result'] as Record<string, unknown> | undefined;
  assert.ok(result !== undefined, 'a new request was accepted after one resolved');
});

test('a request reusing an outstanding id gives -32600', () => {
  const { server, frames, setBehaviour } = harness();
  initialize(server);
  const stalled: Array<{ resolve: (v: any) => void }> = [];
  setBehaviour(() => new Promise((resolve) => { stalled.push({ resolve }); }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'toros_status' } }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'toros_status' } }));
  assert.equal(errorOf(lastFrame(frames)).code, -32600);
});

// ---------------------------------------------------------------------------
// Acceptance test 10 — smuggled fields.
// ---------------------------------------------------------------------------

test('desktop_state with a smuggled field gives -32602 and the call is never invoked', () => {
  for (const key of ['url', 'port', 'token', 'path', 'job_id', 'session_scope']) {
    const { server, frames, calls } = harness();
    initialize(server);
    const arguments_: Record<string, unknown> = {};
    arguments_[key] = key === 'port' ? 1234 : 'evil';
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'desktop_state', arguments: arguments_ } }));
    assert.equal(errorOf(lastFrame(frames)).code, -32602, `for ${key}`);
    assert.equal(calls.length, 0, `the fake call was invoked for ${key}`);
  }
});

test('desktop_inspect with both shapes, or neither, gives -32602', () => {
  const cases: Array<Record<string, unknown>> = [
    // both shapes
    { window_id: 'w', freshness_token: 'f', continuation_token: 'c' },
    // neither shape
    {},
    // window_id without freshness_token (neither a full page 1 nor a continuation)
    { window_id: 'w' },
  ];
  for (const arguments_ of cases) {
    const { server, frames, calls } = harness();
    initialize(server);
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'desktop_inspect', arguments: arguments_ } }));
    assert.equal(errorOf(lastFrame(frames)).code, -32602, JSON.stringify(arguments_));
    assert.equal(calls.length, 0, JSON.stringify(arguments_));
  }
});

test('desktop_inspect with a valid page 1 shape invokes Node Core', async () => {
  const { server, frames, calls, setBehaviour } = harness();
  initialize(server);
  setBehaviour(async (route, body) => ({ status: 200, text: '{"status":"ok"}', body: { status: 'ok' } }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'desktop_inspect', arguments: { window_id: 'w', freshness_token: 'f', depth: 3 } } }));
  await new Promise((r) => setTimeout(r, 20));
  const result = lastFrame(frames)['result'] as Record<string, unknown>;
  assert.equal(result['isError'], false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.route, '/agent/invoke');
  const body = calls[0]!.body as { capability: string; parameters: Record<string, unknown> };
  assert.equal(body.capability, 'desktop.inspect');
  assert.deepEqual(body.parameters, { window_id: 'w', freshness_token: 'f', depth: 3 });
});

// ---------------------------------------------------------------------------
// Deadline.
// ---------------------------------------------------------------------------

test('a call that never resolves answers -32001 near the deadline and aborts the signal', async () => {
  const { server, frames, calls, setBehaviour } = harness({ deadline_ms: 200 });
  initialize(server);

  const resolvers: Array<(v: { status: number; text: string; body: unknown }) => void> = [];
  setBehaviour((_route, _body, _signal) => new Promise((resolve) => { resolvers.push(resolve); }));

  const started = Date.now();
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'toros_status' } }));
  await new Promise((r) => setTimeout(r, 400));
  const err = lastFrame(frames);
  assert.equal(errorOf(err).code, -32001);
  assert.equal(idOf(err), 10);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 100 && elapsed < 2000, `deadline answered after ${elapsed}ms`);

  // The AbortSignal passed to `call` was aborted by the deadline.
  assert.equal(calls[0]?.signal.aborted, true);

  // A late resolve after the deadline writes nothing.
  const countAfter = frames.length;
  resolvers[0]?.({ status: 200, text: '{}', body: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(frames.length, countAfter, 'a late resolve must write nothing');
});

test('DEFAULT_DEADLINE_MS === 45000 and exceeds 30000', () => {
  assert.equal(DEFAULT_DEADLINE_MS, 45_000);
  assert.ok(DEFAULT_DEADLINE_MS > 30_000);
});

test('MAX_OUTSTANDING is 4', () => {
  assert.equal(MAX_OUTSTANDING, 4);
});

// ---------------------------------------------------------------------------
// Answer mapping.
// ---------------------------------------------------------------------------

test('mapping: 200 gives isError false; a 400 body with reason gives isError true and keeps reason; 401 gives the fixed text', async () => {
  // 200
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => ({ status: 200, text: '{"a":1}', body: { a: 1 } }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'toros_status' } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.equal(result['isError'], false);
    assert.deepEqual(result['structuredContent'], { a: 1 });
  }
  // 400 with reason
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => ({ status: 400, text: '{"error":"E_GRANT_INVALID","message":"m","reason":"no_grant"}', body: { error: 'E_GRANT_INVALID', message: 'm', reason: 'no_grant' } }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'machine_inventory' } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.equal(result['isError'], true);
    const sc = result['structuredContent'] as Record<string, unknown>;
    assert.equal(sc['reason'], 'no_grant');
  }
  // 401
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => ({ status: 401, text: '{}', body: {} }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'toros_status' } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.equal(result['isError'], true);
    const content = result['content'] as Array<{ type: string; text: string }>;
    assert.equal(content[0]!.text, 'Node Core refused the agent token (401)');
  }
});

// ---------------------------------------------------------------------------
// stdout purity.
// ---------------------------------------------------------------------------

test('every write is exactly one line that parses as a JSON-RPC message', () => {
  const rawFrames: string[] = [];
  const { server } = harness();
  // Rebuild with a raw writer to check line purity.
  void server;
  const raw: string[] = [];
  const s = createMcpServer({
    call: async () => ({ status: 200, text: '{}', body: {} }),
    write: (frame: string) => raw.push(frame),
    log: () => {},
  });
  initialize(s);
  s.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  for (const line of raw) {
    assert.equal(line.includes('\n'), false, 'no embedded newline');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed['jsonrpc'], '2.0');
  }
  void rawFrames;
});

// ---------------------------------------------------------------------------
// Round 2 — item 1: prototype-chain tool lookup.
// ---------------------------------------------------------------------------

test('tools/call with a prototype-chain tool name gives -32602 and never invokes call', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'valueOf']) {
    const { server, frames, calls } = harness();
    initialize(server);
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name, arguments: {} } }));
    assert.equal(errorOf(lastFrame(frames)).code, -32602, `for ${name}`);
    assert.equal(calls.length, 0, `call was invoked for ${name}`);
    // The next frame still works.
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'ping' }));
    assert.deepEqual(lastFrame(frames)['result'], {}, `ping after ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Round 2 — item 2: missing/non-object arguments.
// ---------------------------------------------------------------------------

test('desktop_inspect with no arguments gives -32602 and never invokes call', () => {
  const { server, frames, calls } = harness();
  initialize(server);
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'desktop_inspect' } }));
  assert.equal(errorOf(lastFrame(frames)).code, -32602);
  assert.equal(calls.length, 0);
});

test('a non-object arguments (array, string, null, number) gives -32602', () => {
  for (const bad of [[], 'str', null, 42]) {
    const { server, frames, calls } = harness();
    initialize(server);
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'toros_status', arguments: bad } }));
    assert.equal(errorOf(lastFrame(frames)).code, -32602, `for ${JSON.stringify(bad)}`);
    assert.equal(calls.length, 0, `for ${JSON.stringify(bad)}`);
  }
});

test('a valid tool with an empty arguments object still validates and invokes', async () => {
  const { server, frames, calls, setBehaviour } = harness();
  initialize(server);
  setBehaviour(async () => ({ status: 200, text: '{}', body: {} }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.equal((lastFrame(frames)['result'] as Record<string, unknown>)['isError'], false);
});

// ---------------------------------------------------------------------------
// Round 2 — item 3: continuation_token must be the sole key.
// ---------------------------------------------------------------------------

test('desktop_inspect page N+1 with continuation_token plus another key gives -32602', () => {
  for (const extra of [{ depth: 2 }, { window_id: 'w' }, { freshness_token: 'f' }]) {
    const { server, frames, calls } = harness();
    initialize(server);
    const arguments_ = { continuation_token: 'ct', ...extra };
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'desktop_inspect', arguments: arguments_ } }));
    assert.equal(errorOf(lastFrame(frames)).code, -32602, JSON.stringify(arguments_));
    assert.equal(calls.length, 0, JSON.stringify(arguments_));
  }
});

test('desktop_inspect page N+1 with continuation_token alone is valid', async () => {
  const { server, frames, calls, setBehaviour } = harness();
  initialize(server);
  setBehaviour(async () => ({ status: 200, text: '{}', body: {} }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'desktop_inspect', arguments: { continuation_token: 'ct' } } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Round 2 — item 4: connection failure is a tool result, not a JSON-RPC error.
// ---------------------------------------------------------------------------

test('a connection failure answers a tool result isError true with no error member', async () => {
  const { server, frames, setBehaviour } = harness();
  initialize(server);
  setBehaviour(async () => { throw { code: 'connection_failed' }; });
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  await new Promise((r) => setTimeout(r, 20));
  const frame = lastFrame(frames);
  assert.equal(frame['error'], undefined, 'connection failure must not be a JSON-RPC error');
  const result = frame['result'] as Record<string, unknown>;
  assert.equal(result['isError'], true);
  const content = result['content'] as Array<{ text: string }>;
  assert.equal(content[0]!.text, 'Node Core is not reachable');
});

// ---------------------------------------------------------------------------
// Round 2 — item 5: structuredContent is never null; present only for object bodies.
// ---------------------------------------------------------------------------

test('structuredContent is absent on 401, on connection failure, and on a non-object body', async () => {
  // 401
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => ({ status: 401, text: '{}', body: { error: 'Unauthorized' } }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.equal('structuredContent' in result, false, '401 must omit structuredContent');
    assert.equal(result['isError'], true);
  }
  // connection failure
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => { throw { code: 'connection_failed' }; });
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.equal('structuredContent' in result, false, 'connection failure must omit structuredContent');
  }
  // body that did not parse to an object (a bare array body, via a 200 with an array body)
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => ({ status: 200, text: '[]', body: [] }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.equal('structuredContent' in result, false, 'non-object body must omit structuredContent');
  }
});

test('structuredContent is present as an object on 200 and on a 4xx tool error', async () => {
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => ({ status: 200, text: '{"a":1}', body: { a: 1 } }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 73, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.deepEqual(result['structuredContent'], { a: 1 });
  }
  {
    const { server, frames, setBehaviour } = harness();
    initialize(server);
    setBehaviour(async () => ({ status: 400, text: '{"error":"E","message":"m"}', body: { error: 'E', message: 'm' } }));
    server.receive(JSON.stringify({ jsonrpc: '2.0', id: 74, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 20));
    const result = lastFrame(frames)['result'] as Record<string, unknown>;
    assert.equal(result['isError'], true);
    assert.equal((result['structuredContent'] as Record<string, unknown>)['error'], 'E');
  }
});

// ---------------------------------------------------------------------------
// Round 2 — item 7: JSON-RPC envelope validation.
// ---------------------------------------------------------------------------

test('a frame without jsonrpc "2.0" gives -32600', () => {
  const { server, frames } = harness();
  initialize(server);
  server.receive(JSON.stringify({ id: 80, method: 'ping' }));
  assert.equal(errorOf(lastFrame(frames)).code, -32600);
});

test('an id that is present but not a string or finite number gives -32600 with id null', () => {
  for (const id of [null, {}, [], true]) {
    const { server, frames } = harness();
    server.receive(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }));
    const frame = lastFrame(frames);
    assert.equal(errorOf(frame).code, -32600, `for id ${JSON.stringify(id)}`);
    assert.equal(frame['id'], null, `for id ${JSON.stringify(id)}`);
  }
});

test('a message without an id is a notification and never produces a frame', () => {
  const { server, frames } = harness();
  initialize(server);
  const before = frames.length;
  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }));
  assert.equal(frames.length, before, 'notifications must produce no frame');
});

test('a notifications/* method sent with an id gives -32600', () => {
  const { server, frames } = harness();
  initialize(server);
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'notifications/initialized' }));
  assert.equal(errorOf(lastFrame(frames)).code, -32600);
});

test('a ping reusing an in-flight tools/call id gives -32600', () => {
  const { server, frames, setBehaviour } = harness();
  initialize(server);
  const pending: Array<() => void> = [];
  setBehaviour(() => new Promise((resolve) => { pending.push(() => resolve({ status: 200, text: '{}', body: {} })); }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 82, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 82, method: 'ping' }));
  assert.equal(errorOf(lastFrame(frames)).code, -32600);
});

// ---------------------------------------------------------------------------
// Round 2 — item 8: close cleans up in-flight calls.
// ---------------------------------------------------------------------------

test('close() with an in-flight call aborts its signal and writes no further frame', async () => {
  const { server, frames, calls, setBehaviour } = harness();
  initialize(server);
  const captured: Array<AbortSignal> = [];
  setBehaviour(async (_route, _body, signal) => {
    captured.push(signal);
    return new Promise(() => { /* never resolves */ });
  });
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.aborted, false);
  const before = frames.length;
  server.close();
  assert.equal(captured[0]!.aborted, true, 'close() must abort the in-flight signal');
  // No frame is written for the aborted in-flight call.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(frames.length, before, 'close() must not write a frame for the aborted call');
  void calls;
});

// ---------------------------------------------------------------------------
// Round 2 — item 9: notifications/cancelled.
// ---------------------------------------------------------------------------

test('notifications/cancelled aborts an in-flight tools/call and writes no response for that id', async () => {
  const { server, frames, calls, setBehaviour } = harness();
  initialize(server);

  const captured: Array<AbortSignal> = [];
  const resolvers: Array<(v: { status: number; text: string; body: unknown }) => void> = [];
  setBehaviour((_route, _body, signal) => new Promise((resolve) => { captured.push(signal); resolvers.push(resolve); }));

  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  assert.equal(captured.length, 1);
  const before = frames.length;

  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100 } }));
  assert.equal(captured[0]!.aborted, true, 'cancel must abort the in-flight signal');
  // Even if the call later settles, no response is written for id 100.
  resolvers[0]?.({ status: 200, text: '{}', body: {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(frames.length, before, 'no frame must be written for the cancelled id');

  // A new request is then accepted (the slot was freed).
  setBehaviour(async () => ({ status: 200, text: '{}', body: {} }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'toros_status', arguments: {} } }));
  await new Promise((r) => setTimeout(r, 20));
  const last = lastFrame(frames);
  assert.equal(last['id'], 101);
  assert.ok(last['result'] !== undefined, 'new request accepted after cancel');
});

test('notifications/cancelled with an unknown or finished requestId is ignored', () => {
  const { server, frames, setBehaviour } = harness();
  initialize(server);
  const before = frames.length;
  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } }));
  server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }));
  assert.equal(frames.length, before);
  void setBehaviour;
});