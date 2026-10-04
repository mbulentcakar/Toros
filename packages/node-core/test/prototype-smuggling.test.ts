/**
 * A request body may not carry a `__proto__` key.
 *
 * `normalizeParsed` rebuilds every parsed object so that the executed value
 * equals the digested value. A key literally named `__proto__` defeats the
 * rebuild: `JSON.parse` produces it as an ordinary own property, but assigning
 * it to a plain object sets that object's PROTOTYPE instead, so the value
 * becomes readable through `args[field]` while being invisible to
 * `Object.keys`, `Object.values`, and `JSON.stringify`.
 *
 * That splits one object into two views, and everything that audits or gates
 * reads the own-property view:
 *
 *   - `arguments_digest` is taken over the canonical JSON, so the receipt
 *     records `{}` for arguments that validated as complete;
 *   - the operator approval surface renders the same JSON;
 *   - policy's forbidden-term check walks `Object.values`.
 *
 * While Ajv accepts the object: `required` is satisfied through the prototype
 * chain and `additionalProperties: false` sees no extra own key.
 *
 * Measured before the fix, against the real loopback service: the smuggled
 * call returned 200. The value did NOT reach the adapter — the object spread
 * inside `resolvePathArgs` drops it on the way — so the live impact is that
 * schema validation can be satisfied by data that never executes, and that
 * policy's `paths()` (bracket access, so it reads the prototype) decides
 * containment for a path the adapter is never given. Both are divergences
 * between the decided value and the executed value, which is the class of gap
 * the surrounding code says it closed. The barrier is one refactor of a
 * function whose stated job is path resolution, not sanitisation.
 *
 * So: refuse at the parse boundary, and fail closed. Skipping the key silently
 * would leave a caller able to satisfy a `required` field with a value that
 * never executes. No legitimate Toros argument is named `__proto__`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type ActionResult,
  type Adapter,
  type AdapterContext,
  type AdapterManifest,
  type JsonValue,
} from '@toros/contracts';
import { createNodeCore } from '../src/index.js';

const coordinatorToken = 'coordinator-token-for-prototype-smuggling-test';
const operatorToken = 'operator-token-for-prototype-smuggling-test-1';

/** Records exactly what the adapter was handed, so the test can read it back. */
const seen: Array<Readonly<Record<string, JsonValue>>> = [];

const manifest: AdapterManifest = {
  id: 'mock',
  version: '1.0.0',
  platforms: [process.platform as 'win32' | 'linux' | 'darwin'],
  actions: [{
    id: 'run',
    summary: 'Run',
    // `label` is optional and free-form: the shape of a great many real action
    // schemas, and all a smuggled key needs.
    input_schema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      additionalProperties: false,
    },
    path_fields: [],
    mutates: false,
    always_requires_approval: false,
  }],
  required_permissions: [],
  allowed_resources: [],
  default_timeout_ms: 1_000,
  cancellation: 'graceful',
  receipt_fields: [],
};

const adapter: Adapter = {
  manifest,
  async init() {},
  async invoke(_action: string, args: Readonly<Record<string, JsonValue>>, _context: AdapterContext): Promise<ActionResult> {
    seen.push(args);
    return { output: 'ok', truncated: false, artifacts: [], receipt_extra: {} };
  },
  async dispose() {},
};

function post(
  port: number,
  path: string,
  rawBody: string,
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
    req.end(rawBody);
  });
}

test('a request body carrying __proto__ is refused rather than silently reshaped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-proto-smuggle-'));
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [],
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();
  seen.length = 0;

  const created = await post(port, '/operator/create_job', JSON.stringify({
    objective: 'bounded task',
    allowed_capabilities: ['mock.run'],
    allowed_workspaces: ['work'],
    acceptance: ['done'],
    forbidden: ['smuggled'],
    max_actions: 5,
    max_retries: 1,
    expires_in_hours: 24,
  }), operatorToken);
  assert.equal(created.status, 200);
  const jobId = String(created.body['job_id']);

  // The benign call, to establish that the action itself works.
  const honest = await post(port, '/tools/invoke_app_action', JSON.stringify({
    job_id: jobId, workspace_id: 'work', app_id: 'mock', action_id: 'run', parameters: { label: 'honest' },
  }), coordinatorToken);
  assert.equal(honest.status, 200, JSON.stringify(honest.body));
  assert.equal(seen.at(-1)?.['label'], 'honest');

  // The same call with the label moved onto the prototype. Written as raw text:
  // an object literal in TypeScript would set the prototype at construction
  // rather than produce the key an attacker puts on the wire.
  const smuggled = await post(port, '/tools/invoke_app_action', JSON.stringify({
    job_id: jobId, workspace_id: 'work', app_id: 'mock', action_id: 'run',
    parameters: JSON.parse('{"__proto__":{"label":"smuggled"}}') as JsonValue,
  }), coordinatorToken);

  assert.equal(smuggled.status, 400, `expected refusal, got ${smuggled.status}: ${JSON.stringify(smuggled.body)}`);
  assert.equal(smuggled.body['error'], 'E_SCHEMA');
  assert.match(String(smuggled.body['message']), /__proto__/);

  // Nothing reached the adapter, so nothing could have executed with an
  // argument the receipt and the approval surface would not have shown.
  assert.equal(seen.length, 1, 'the smuggled call must not reach an adapter');
});

test('the refusal covers a __proto__ nested anywhere in the body', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-proto-smuggle-nested-'));
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [],
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  for (const raw of [
    '{"objective":{"__proto__":{"x":1}}}',
    '{"a":[{"__proto__":{"x":1}}]}',
    '{"__proto__":{"x":1}}',
  ]) {
    const response = await post(port, '/operator/create_job', raw, operatorToken);
    assert.equal(response.status, 400, `expected refusal for ${raw}`);
    assert.equal(response.body['error'], 'E_SCHEMA');
  }
});

test('an ordinary body is unaffected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-proto-smuggle-ok-'));
  const core = createNodeCore({
    node_id: 'node', db_path: join(dir, 'node.sqlite'), workspaces: [{ id: 'work', root: dir }],
    port: 0, token: coordinatorToken, operator_token: operatorToken,
    adapters: [adapter], observer: null, approval_required: [],
  });
  t.after(async () => { await core.stop(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await core.start();

  // `constructor` and `prototype` are ordinary JSON keys that assign normally;
  // refusing them too would break real payloads for no gain.
  const created = await post(port, '/operator/create_job', JSON.stringify({
    objective: 'a task mentioning constructor and prototype',
    allowed_capabilities: ['mock.run'], allowed_workspaces: ['work'],
    acceptance: ['done'], forbidden: [], max_actions: 2, max_retries: 1, expires_in_hours: 1,
  }), operatorToken);
  assert.equal(created.status, 200);

  const response = await post(port, '/tools/invoke_app_action', JSON.stringify({
    job_id: String(created.body['job_id']),
    workspace_id: 'work', app_id: 'mock', action_id: 'run', parameters: { label: 'constructor' },
  }), coordinatorToken);
  assert.equal(response.status, 200, JSON.stringify(response.body));
});
