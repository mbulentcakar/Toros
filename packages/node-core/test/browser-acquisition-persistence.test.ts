import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BrowserAcquisitionController, type BrowserAcquisitionRecord } from '../src/browser-acquisition.js';

// A completed acquisition must stay completed when the final manifest write hits a held file.
// On Windows, rename onto a file that any handle has open fails with EPERM; operators, the
// cockpit, Defender, and the search indexer all open manifests while a run is live.

interface Harness {
  readonly root: string;
  readonly controller: BrowserAcquisitionController;
  readonly record: BrowserAcquisitionRecord;
  readonly manifestPath: string;
  /** Runs one reconcile pass, which processes the single item through completion. */
  readonly reconcile: () => Promise<void>;
}

async function harness(onProposed: (manifestPath: string) => Promise<void> | void): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'toros-browser-persist-'));
  const job = { job_id: 'persist-job', state: 'working' };
  let manifestPath = '';
  const controller = new BrowserAcquisitionController({
    db_path: join(root, 'node.sqlite'),
    workspaces: [{ id: 'work', root }],
    allowed_domains: () => ['example.com'],
    worker_status: () => ({ connected: true, paired: true, tab: { id: 9, url: 'https://www.example.com/US/en', title: 'Example' } } as never),
    store: () => ({
      getJob: async () => job,
      setJobState: async (_jobId: string, state: string) => {
        job.state = state;
        if (state === 'proposed') await onProposed(manifestPath);
      },
      listArtifacts: async () => [{ artifact_id: 'artifact-1', path: join(root, 'sds-1.pdf'), sha256: 'a'.repeat(64), bytes: 20 }],
    } as never),
    create_job: async () => job as never,
    invoke_action: async (_job, _workspace, action) => {
      if (action === 'navigate') return { output: JSON.stringify({ url: 'https://www.example.com/products/s2000', title: 'S2000', challenge: false, http_status: 200 }), artifacts: [] };
      if (action === 'extract') {
        return {
          output: JSON.stringify({ fields: { product_name: 'Viscosity Standard' }, documents: [{ kind: 'sds', text: 'Safety Data Sheet', url: 'https://www.example.com/sds/s2000' }] }),
          artifacts: [],
        };
      }
      return { output: JSON.stringify({ mime_type: 'application/pdf', http_status: 200 }), artifacts: ['artifact-1'] };
    },
  });
  // No start(): the test drives reconcile itself, so nothing races the assertions.
  const record = await controller.create({
    name: 'Persistence check', workspace_id: 'work', site_profile: 'generic',
    sources: [{ item_id: 'S2000', url: 'https://www.example.com/products/s2000' }],
    fields: [{ name: 'product_name', selector: 'h1' }],
    documents: [{ kind: 'sds', text_contains: ['sds'], url_contains: ['/sds/'], required: true, max_files: 1 }],
    min_delay_seconds: 1, max_delay_seconds: 1, max_attempts: 2,
    max_backoff_minutes: 5, max_consecutive_rate_limits: 2, max_document_bytes: 1024,
  });
  manifestPath = join(root, ...record.manifest_path.split('/'));
  const reconcile = (): Promise<void> => (controller as unknown as { reconcile(): Promise<void> }).reconcile();
  return { root, controller, record, manifestPath, reconcile };
}

function assertCompleted(value: unknown): void {
  const record = value as Record<string, unknown> | undefined;
  assert.equal(record?.['state'], 'completed', `acquisition error: ${String(record?.['error'])}`);
  assert.equal(record?.['error'], null);
  const item = (record?.['items'] as Array<Record<string, unknown>>)[0];
  assert.equal(item?.['state'], 'completed');
  assert.equal(item?.['attempts'], 1);
  assert.equal(item?.['error'], null);
  const document = (item?.['documents'] as Array<Record<string, unknown>>)[0];
  assert.equal(document?.['outcome'], 'downloaded');
  assert.equal(document?.['bytes'], 20);
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

test('a manifest held open across completion still records a completed acquisition', async (t) => {
  let handle: FileHandle | null = null;
  let released: Promise<void> = Promise.resolve();
  const h = await harness(async (manifestPath) => {
    // Hold the manifest open exactly while the completion write runs, then let go shortly after,
    // the way a viewer or scanner would. On Windows the completion rename meets EPERM.
    handle = await open(manifestPath, 'r');
    const held = handle;
    released = new Promise((resolve) => setTimeout(() => { void held.close().then(() => resolve()); }, 150));
  });
  t.after(async () => { await released; await h.controller.stop(); await rm(h.root, { recursive: true, force: true }); });

  const failure = await h.reconcile().then(() => null, (error: unknown) => error);
  assert.ok(handle !== null, 'the completion hook must have run');
  await released;

  assertCompleted(h.controller.list().find((candidate) => candidate.acquisition_id === h.record.acquisition_id));
  assert.equal(failure, null);
  assertCompleted(await readManifest(h.manifestPath));
});

test('a manifest write that keeps failing after completion never reopens the completed item', async (t) => {
  const realRename = fsPromises.rename;
  let failing = false;
  let injected = 0;
  t.mock.method(fsPromises, 'rename', async (from: string, to: string) => {
    if (failing && to.endsWith('manifest.json')) {
      injected += 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM', syscall: 'rename' });
    }
    return realRename(from, to);
  });
  syncBuiltinESMExports();
  const h = await harness(() => { failing = true; });
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await h.controller.stop(); await rm(h.root, { recursive: true, force: true });
  });

  // Every manifest rename fails from the moment the job turns 'proposed', past any retry budget.
  const failure = await h.reconcile().then(() => null, (error: unknown) => error);
  assert.ok(injected > 0, 'the completion write must have hit the injected EPERM');
  assertCompleted(h.controller.list().find((candidate) => candidate.acquisition_id === h.record.acquisition_id));
  assert.equal(failure, null);
  const stale = await readManifest(h.manifestPath);
  assert.notEqual(stale['state'], 'paused');

  // Once the file is writable again, the next reconcile catches the manifest up.
  failing = false;
  await h.reconcile();
  assertCompleted(await readManifest(h.manifestPath));
  assertCompleted(h.controller.list().find((candidate) => candidate.acquisition_id === h.record.acquisition_id));
});
