import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createChromeWorkerAdapter } from '@toros/adapters-chrome';
import { BrowserAcquisitionController } from '../src/browser-acquisition.js';
import { createNodeCore } from '../src/index.js';

const OPERATOR_TOKEN = 'browser-worker-operator-token-1234567890';
const COORDINATOR_TOKEN = 'browser-worker-coordinator-token-123456';
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

async function post(
  port: number,
  path: string,
  body: Record<string, unknown>,
  options: { readonly token?: string; readonly origin?: string } = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: {
        'content-type': 'application/json',
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode ?? 0, body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function waitForCommand(port: number, token: string, action: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await post(port, '/chrome-worker/poll', {
      extension_version: '0.1.0',
      tab: { id: 9, url: 'https://www.example.com/US/en', title: 'Example' },
    }, { token, origin: ORIGIN });
    assert.equal(response.status, 200);
    const command = response.body['command'];
    if (typeof command === 'object' && command !== null && (command as Record<string, unknown>)['action'] === action) return command as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${action}`);
}

test('paired extension completes a receipt-bound resumable browser acquisition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toros-browser-worker-'));
  const adapter = createChromeWorkerAdapter({
    allowed_domains: ['example.com'],
    state_path: join(root, 'chrome-worker.json'),
    extension_dir: join(root, 'extension'),
    command_timeout_ms: 10_000,
  });
  const core = createNodeCore({
    node_id: 'node', db_path: join(root, 'node.sqlite'), workspaces: [{ id: 'work', root }],
    port: 0, token: COORDINATOR_TOKEN, operator_token: OPERATOR_TOKEN,
    adapters: [adapter], observer: null, approval_required: [],
  });
  t.after(async () => { await core.stop(); await rm(root, { recursive: true, force: true }); });
  const { port } = await core.start();

  const initial = await post(port, '/operator/browser_status', {}, { token: OPERATOR_TOKEN });
  assert.equal(initial.status, 200);
  assert.equal((initial.body['worker'] as Record<string, unknown>)['connected'], false);
  assert.equal((await post(port, '/chrome-worker/pair', { code: '00000000' }, { origin: `chrome-extension://${'b'.repeat(32)}` })).status, 400);

  const pairing = await post(port, '/operator/browser_pairing', {}, { token: OPERATOR_TOKEN });
  const paired = await post(port, '/chrome-worker/pair', { code: pairing.body['code'] }, { origin: ORIGIN });
  assert.equal(paired.status, 200);
  const workerToken = paired.body['token'];
  assert.equal(typeof workerToken, 'string');
  await post(port, '/chrome-worker/poll', {
    extension_version: '0.1.0',
    tab: { id: 9, url: 'https://www.example.com/US/en', title: 'Example' },
  }, { token: String(workerToken), origin: ORIGIN });

  const created = await post(port, '/operator/browser_acquisition_create', {
    name: 'Document check', workspace_id: 'work', site_profile: 'generic',
    sources: [{ item_id: 'S2000', url: 'https://www.example.com/products/s2000' }],
    fields: [{ name: 'product_name', selector: 'h1' }],
    documents: [{ kind: 'sds', text_contains: ['safety data sheet', 'sds'], url_contains: ['/sds/'], required: true, max_files: 1 }],
    min_delay_seconds: 1, max_delay_seconds: 1, max_attempts: 2, max_backoff_minutes: 5,
    max_consecutive_rate_limits: 2, max_document_bytes: 1024 * 1024,
  }, { token: OPERATOR_TOKEN });
  assert.equal(created.status, 200);
  const acquisitionId = String(created.body['acquisition_id']);
  const jobId = String(created.body['job_id']);

  const limitedNavigate = await waitForCommand(port, String(workerToken), 'navigate');
  await post(port, '/chrome-worker/result', {
    command_id: limitedNavigate['command_id'], ok: false,
    error: { code: 'rate_limited', message: 'HTTP 429', retry_after_seconds: 0 },
  }, { token: String(workerToken), origin: ORIGIN });
  let observedWaiting = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const inventory = await post(port, '/operator/browser_acquisitions', {}, { token: OPERATOR_TOKEN });
    const acquisition = (inventory.body['acquisitions'] as Array<Record<string, unknown>>)[0];
    if (acquisition?.['state'] === 'waiting' && typeof acquisition['next_run_at'] === 'string') { observedWaiting = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(observedWaiting, true);

  const navigate = await waitForCommand(port, String(workerToken), 'navigate');
  await post(port, '/chrome-worker/result', {
    command_id: navigate['command_id'], ok: true,
    output: { url: 'https://www.example.com/products/s2000', title: 'S2000', challenge: false },
  }, { token: String(workerToken), origin: ORIGIN });

  const extract = await waitForCommand(port, String(workerToken), 'extract');
  await post(port, '/chrome-worker/result', {
    command_id: extract['command_id'], ok: true,
    output: {
      url: 'https://www.example.com/products/s2000', challenge: false,
      fields: { product_name: 'Viscosity Standard' },
      documents: [{ kind: 'sds', text: 'Safety Data Sheet', url: 'https://www.example.com/sds/s2000' }],
    },
  }, { token: String(workerToken), origin: ORIGIN });

  const download = await waitForCommand(port, String(workerToken), 'download');
  const payload = download['payload'] as Record<string, unknown>;
  const pdf = Buffer.from('%PDF-1.7\nToros test\n');
  await post(port, '/chrome-worker/upload', {
    upload_id: payload['upload_id'], index: 0, data: pdf.toString('base64'), final: false,
  }, { token: String(workerToken), origin: ORIGIN });
  await post(port, '/chrome-worker/upload', {
    upload_id: payload['upload_id'], index: 1, data: '', final: true, mime_type: 'application/pdf', http_status: 200,
  }, { token: String(workerToken), origin: ORIGIN });
  await post(port, '/chrome-worker/result', {
    command_id: download['command_id'], ok: true,
    output: { url: 'https://www.example.com/sds/s2000', mime_type: 'application/pdf', http_status: 200, bytes: pdf.length },
  }, { token: String(workerToken), origin: ORIGIN });

  let completed: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inventory = await post(port, '/operator/browser_acquisitions', {}, { token: OPERATOR_TOKEN });
    const acquisition = (inventory.body['acquisitions'] as Array<Record<string, unknown>>).find((value) => value['acquisition_id'] === acquisitionId);
    if (acquisition?.['state'] === 'completed') { completed = acquisition; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(completed);
  const manifestPath = join(root, ...String(completed['manifest_path']).split('/'));
  let item: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    item = (manifest['items'] as Array<Record<string, unknown>>)[0];
    if (item?.['state'] === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(item?.['state'], 'completed');
  assert.equal((item?.['fields'] as Record<string, unknown>)['product_name'], 'Viscosity Standard');
  const document = (item?.['documents'] as Array<Record<string, unknown>>)[0];
  assert.equal(document?.['bytes'], pdf.length);
  assert.equal(document?.['outcome'], 'downloaded');
  assert.equal(document?.['http_status'], 200);
  assert.equal(item?.['final_url'], 'https://www.example.com/products/s2000');
  assert.match(String(document?.['sha256']), /^[a-f0-9]{64}$/);

  const activity = await post(port, '/tools/list_activity', { job_id: jobId }, { token: COORDINATOR_TOKEN });
  const receipts = activity.body['receipts'] as Array<Record<string, unknown>>;
  assert.deepEqual(receipts.map((receipt) => receipt['capability']), ['chrome.navigate', 'chrome.navigate', 'chrome.extract', 'chrome.download']);
  assert.deepEqual(receipts.map((receipt) => receipt['outcome']), ['failed', 'succeeded', 'succeeded', 'succeeded']);
});


test('restart pauses active acquisition in both durable records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toros-browser-restart-'));
  const dbPath = join(root, 'node.sqlite');
  const deps = {
    db_path: dbPath,
    workspaces: [{ id: 'work', root }],
    allowed_domains: () => ['example.com'],
    worker_status: () => ({ connected: true, paired: true, tab: { id: 9, url: 'https://www.example.com/US/en', title: 'Example' } } as never),
    store: () => ({} as never),
    create_job: async () => ({ job_id: 'restart-job' } as never),
    invoke_action: async () => { throw new Error('reconcile must not run during this fixture'); },
  };

  const first = new BrowserAcquisitionController(deps);
  await first.start();
  const created = await first.create({
    name: 'Restart check', workspace_id: 'work', site_profile: 'generic',
    sources: [{ item_id: 'S2000', url: 'https://www.example.com/products/s2000' }],
    fields: [{ name: 'product_name', selector: 'h1' }],
    documents: [{ kind: 'sds', text_contains: ['sds'], url_contains: ['/sds/'], required: true, max_files: 1 }],
    min_delay_seconds: 1, max_delay_seconds: 1, max_attempts: 2,
    max_backoff_minutes: 5, max_consecutive_rate_limits: 2, max_document_bytes: 1024,
  });
  await first.stop();

  const recovered = new BrowserAcquisitionController(deps);
  await recovered.start();
  t.after(async () => { await recovered.stop(); await rm(root, { recursive: true, force: true }); });

  const record = recovered.list().find((candidate) => candidate.acquisition_id === created.acquisition_id);
  assert.equal(record?.state, 'paused');
  assert.match(record?.error ?? '', /Node Core restarted/);
  assert.equal(record?.next_run_at, null);

  const manifest = JSON.parse(await readFile(join(root, ...created.manifest_path.split('/')), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest['state'], 'paused');
  assert.match(String(manifest['error']), /Node Core restarted/);
});
test('create rejects any site profile other than generic', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toros-browser-profile-'));
  const controller = new BrowserAcquisitionController({
    db_path: ':memory:',
    workspaces: [{ id: 'work', root }],
    allowed_domains: () => ['example.com'],
    worker_status: () => ({ connected: true, paired: true, tab: { id: 9, url: 'https://www.example.com/', title: 'Example' } } as never),
    store: () => ({} as never),
    create_job: async () => { throw new Error('a rejected profile must not create a job'); },
    invoke_action: async () => { throw new Error('a rejected profile must not invoke an action'); },
  });
  await controller.start();
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(controller.create({
    name: 'Profile check', workspace_id: 'work', site_profile: 'vendor_specific' as never,
    sources: [{ item_id: 'one', url: 'https://www.example.com/products/one' }],
    fields: [{ name: 'product_name', selector: 'h1' }],
    documents: [{ kind: 'sds', text_contains: ['sds'], url_contains: ['/sds/'], required: true, max_files: 1 }],
    min_delay_seconds: 1, max_delay_seconds: 1, max_attempts: 1,
    max_backoff_minutes: 1, max_consecutive_rate_limits: 1, max_document_bytes: 1024,
  }), /site_profile is invalid/);
});
