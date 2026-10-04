import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createNodeCore, type NodeCore } from '../src/index.js';
import { MODEL_PROFILES } from '../src/model-profiles.js';

const coordinatorToken = 'coordinator-token-for-ae-remediation';
const operatorToken = 'operator-token-for-ae-remediation-1234';
const requestWatchdogMs = 2_000;

interface ResponseResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function startCore(t: TestContext, configuredOperatorToken: string | undefined): Promise<{ core: NodeCore; port: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'toros-ae-remediation-'));
  const core = createNodeCore({
    node_id: 'node',
    db_path: join(directory, 'node.sqlite'),
    workspaces: [{ id: 'work', root: directory }],
    port: 0,
    token: coordinatorToken,
    adapters: [],
    observer: null,
    approval_required: [],
    ...(configuredOperatorToken === undefined ? {} : { operator_token: configuredOperatorToken }),
  });
  t.after(async () => {
    await core.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = await core.start();
  return { core, port };
}

async function operatorPost(port: number, operation: string, token = operatorToken): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: `/operator/${operation}`,
      method: 'POST',
      agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(watchdog);
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
          });
        } catch (error: unknown) {
          reject(error);
        }
      });
    });
    const watchdog = setTimeout(() => {
      req.destroy();
      reject(new Error(`operator request did not complete within ${requestWatchdogMs}ms`));
    }, requestWatchdogMs);
    req.on('error', (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    req.end('{}');
  });
}

test('F1: omitted operator token promptly completes the exact baseline 401 response', async (t) => {
  const { port } = await startCore(t, undefined);
  const result = await operatorPost(port, 'catalog');
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'Unauthorized' });
});

test('F1: empty operator token promptly completes the exact baseline 401 response', async (t) => {
  const { port } = await startCore(t, '');
  const result = await operatorPost(port, 'catalog');
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'Unauthorized' });
});

test('F2: inherited Object.prototype operator names complete as ordinary 404 responses', async (t) => {
  const { port } = await startCore(t, operatorToken);
  for (const operation of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const result = await operatorPost(port, operation);
    assert.equal(result.status, 404, operation);
    assert.deepEqual(result.body, { error: 'Not found' }, operation);
  }
});

test('F2 control: a registered operator route still dispatches normally', async (t) => {
  const { port } = await startCore(t, operatorToken);
  const result = await operatorPost(port, 'catalog');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { capabilities: [], workspaces: ['work'], agents: [], models: MODEL_PROFILES });
});
