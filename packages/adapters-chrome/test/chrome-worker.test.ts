import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ErrorCode, TorosError, type AdapterContext } from '@toros/contracts';
import { createChromeWorkerAdapter } from '../src/index.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'toros-chrome-'));
  const adapter = createChromeWorkerAdapter({
    allowed_domains: ['example.org'],
    state_path: join(root, 'worker.json'),
    extension_dir: join(root, 'extension'),
    command_timeout_ms: 5_000,
  });
  await adapter.init();
  const pairing = adapter.createPairingCode();
  const paired = await adapter.pair(pairing.code, ORIGIN);
  const controller = new AbortController();
  const ctx: AdapterContext = {
    job_id: 'job-1', session_id: null,
    workspace: { id: 'sandbox', root },
    correlation_id: 'receipt-1', signal: controller.signal,
  };
  adapter.poll({ extension_version: '0.1.0', tab: { id: 7, url: 'https://www.example.org/US/en', title: 'Example' } });
return { root, adapter, token: paired.token, ctx, controller };
}

async function nextCommand(adapter: ReturnType<typeof createChromeWorkerAdapter>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = adapter.poll({ extension_version: '0.1.0', tab: { id: 7, url: 'https://www.example.org/US/en', title: 'Example' } });
    if (result.command !== null) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Chrome command was not queued');
}

test('pairs once, persists only a digest, and authenticates one extension id', async () => {
  const { root, adapter, token } = await fixture();
  try {
    assert.equal(adapter.authenticate(token, ORIGIN), true);
    assert.equal(adapter.authenticate(`${token}x`, ORIGIN), false);
    assert.equal(adapter.authenticate(token, `chrome-extension://${'b'.repeat(32)}`), false);
    const stored = await readFile(join(root, 'worker.json'), 'utf8');
    assert.equal(stored.includes(token), false);
    assert.match(stored, /"token_digest": "[a-f0-9]{64}"/);
    assert.equal(adapter.status().connected, true);
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('queues one allowlisted navigation and returns bounded worker output', async () => {
  const { root, adapter, ctx } = await fixture();
  try {
    const invocation = adapter.invoke('navigate', { url: 'https://www.example.org/products/s2000', wait_ms: 0 }, ctx);
    const polled = await nextCommand(adapter);
    assert.equal(polled.command?.action, 'navigate');
    await adapter.submitResult({
      command_id: polled.command?.command_id ?? '', ok: true,
      output: { url: 'https://www.example.org/products/s2000', title: 'S2000', challenge: false },
    });
    const result = await invocation;
    assert.equal(JSON.parse(result.output).title, 'S2000');
    assert.equal(result.receipt_extra['chrome_tab_id'], 7);
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('denies a non-allowlisted domain before a command is queued', async () => {
  const { root, adapter, ctx } = await fixture();
  try {
    await assert.rejects(
      adapter.invoke('navigate', { url: 'https://example.com/', wait_ms: 0 }, ctx),
      (error: unknown) => error instanceof TorosError && error.code === ErrorCode.E_FORBIDDEN,
    );
    assert.equal(adapter.status().queued_commands, 0);
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('streams a document in ordered chunks and records its workspace artifact', async () => {
  const { root, adapter, ctx } = await fixture();
  try {
    const outPath = join(root, 'browser-acquisitions', 'run-1', 'sds.pdf');
    const invocation = adapter.invoke('download', {
      url: 'https://www.example.org/sds/s2000',
      out_path: outPath,
      max_bytes: 1024,
      expected_mime: 'application/pdf',
    }, ctx);
    const polled = await nextCommand(adapter);
    assert.equal(polled.command?.action, 'download');
    const uploadId = polled.command?.payload['upload_id'];
    assert.equal(typeof uploadId, 'string');
    await adapter.uploadChunk({ upload_id: String(uploadId), index: 0, data: Buffer.from('%PDF-one').toString('base64'), final: false });
    await adapter.uploadChunk({ upload_id: String(uploadId), index: 1, data: Buffer.from('-two').toString('base64'), final: true, mime_type: 'application/pdf; charset=binary', http_status: 200 });
    await adapter.submitResult({ command_id: polled.command?.command_id ?? '', ok: true, output: { url: 'https://www.example.org/sds/s2000', mime_type: 'application/pdf', http_status: 200 } });
    const result = await invocation;
    assert.equal(await readFile(outPath, 'utf8'), '%PDF-one-two');
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]?.bytes, 12);
    assert.match(result.artifacts[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an HTML body mislabeled as a PDF', async () => {
  const { root, adapter, ctx } = await fixture();
  try {
    const invocation = adapter.invoke('download', {
      url: 'https://www.example.org/sds/s2000',
      out_path: join(root, 'browser-acquisitions', 'run-invalid', 'sds.pdf'),
      max_bytes: 1024,
      expected_mime: 'application/pdf',
    }, ctx);
    const polled = await nextCommand(adapter);
    const uploadId = String(polled.command?.payload['upload_id']);
    await adapter.uploadChunk({ upload_id: uploadId, index: 0, data: Buffer.from('<html>blocked</html>').toString('base64'), final: false });
    await assert.rejects(
      adapter.uploadChunk({ upload_id: uploadId, index: 1, data: '', final: true, mime_type: 'application/pdf', http_status: 200 }),
      (error: unknown) => error instanceof TorosError && error.detail['worker_code'] === 'pdf_magic_mismatch',
    );
    await adapter.submitResult({
      command_id: polled.command?.command_id ?? '', ok: false,
      error: { code: 'pdf_magic_mismatch', message: 'The response was not a PDF.', http_status: 200, content_type: 'application/pdf' },
    });
    await assert.rejects(invocation, (error: unknown) => error instanceof TorosError && error.detail['worker_code'] === 'pdf_magic_mismatch');
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test('rejects out-of-order chunks and maps worker rate limits into typed detail', async () => {
  const { root, adapter, ctx } = await fixture();
  try {
    const invocation = adapter.invoke('download', {
      url: 'https://www.example.org/sds/s2000',
      out_path: join(root, 'browser-acquisitions', 'run-2', 'sds.pdf'),
      max_bytes: 1024,
      expected_mime: 'application/pdf',
    }, ctx);
    const polled = await nextCommand(adapter);
    const uploadId = String(polled.command?.payload['upload_id']);
    await assert.rejects(adapter.uploadChunk({ upload_id: uploadId, index: 1, data: '', final: false }), /out of order/);
    await adapter.submitResult({ command_id: polled.command?.command_id ?? '', ok: false, error: { code: 'rate_limited', message: 'HTTP 429', retry_after_seconds: 120 } });
    await assert.rejects(invocation, (error: unknown) => {
      return error instanceof TorosError && error.detail['worker_code'] === 'rate_limited' && error.detail['retry_after_seconds'] === 120;
    });
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
