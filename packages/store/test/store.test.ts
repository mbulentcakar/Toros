import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { DatabaseSync } from 'node:sqlite';
import { canonicalize, chainHash, GENESIS_HASH } from '@toros/contracts';
import type { Receipt, SealedEnvelope } from '@toros/contracts';

import { openStore } from '../src/index.js';
import type { StoreOptions } from '../src/index.js';
import { COUNT_RETRIES_SQL, LATEST_RUNNING_RECEIPT_SQL, retrySqliteBusy } from '../src/store.js';
import { sql as migration1Sql } from '../src/migrations/001_initial.js';
import { sql as migration2Sql } from '../src/migrations/002_receipt_adapter_fields.js';
import { sql as migration3Sql } from '../src/migrations/003_conversations.js';
import { sql as migration4Sql } from '../src/migrations/004_job_conversation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoreOptions(path: string, nodeId = 'test-node'): StoreOptions {
  return { path, nodeId };
}

function makeSealed(overrides: Partial<SealedEnvelope['envelope']> = {}): SealedEnvelope {
  const envelope = {
    job_id: `job-${Math.random().toString(36).slice(2)}`,
    objective: 'Test objective',
    allowed_capabilities: ['test.cap'],
    allowed_workspaces: ['default'],
    acceptance: ['criterion 1'],
    forbidden: [],
    max_actions: 10,
    max_retries: 2,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
  return {
    envelope,
    envelope_digest: 'a'.repeat(64),
  };
}

function makeReceipt(
  overrides: Pick<Receipt, 'receipt_id' | 'job_id' | 'capability' | 'started_at'> & Partial<Receipt>,
): Receipt {
  const { receipt_id, job_id, capability, started_at, ...rest } = overrides;
  return {
    receipt_id,
    job_id,
    node_id: 'test-node',
    session_id: null,
    actor: 'model-a',
    capability,
    arguments_normalized: null,
    arguments_digest: 'digest-a',
    decision: { allow: true, reason: 'Allowed' },
    envelope_digest: 'a'.repeat(64),
    started_at,
    ended_at: started_at,
    outcome: 'failed',
    artifact_refs: [],
    finding_refs: [],
    adapter_fields: {},
    ...rest,
  };
}

let tempDir: string;

// ---------------------------------------------------------------------------
// Migrations and lifecycle
// ---------------------------------------------------------------------------

describe('Migrations and lifecycle', () => {
  it('applies migrations on a fresh database', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    // Tables should exist - we verify by using them
    const job = await store.createJob(makeSealed());
    assert.ok(job.job_id);
    assert.equal(job.state, 'working');
    await store.close();
  });

  it('applying migrations twice is a no-op', async () => {
    const store1 = await openStore(makeStoreOptions(':memory:'));
    await store1.close();
    // Opening again on :memory: creates a new database, so this is really
    // testing that re-opening doesn't error. For a real idempotency check
    // we need a file database, which test 18 covers.
    const store2 = await openStore(makeStoreOptions(':memory:'));
    await store2.createJob(makeSealed());
    await store2.close();
  });

  it('close is idempotent', async () => {

    const store = await openStore(makeStoreOptions(':memory:'));
    await store.close();
    await store.close(); // Second call must not throw
  });

  it('upgrades an existing version-1 database with adapter_fields intact', async () => {
    const dbPath = join(tempDir, `migration-v1-${Date.now()}.db`);
    const v1 = new DatabaseSync(dbPath);
    v1.exec(migration1Sql);
    v1.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    v1.close();

    const store = await openStore(makeStoreOptions(dbPath));
    await store.close();

    const upgraded = new DatabaseSync(dbPath);
    const version = upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number };
    const columns = upgraded.prepare('PRAGMA table_info(receipts)').all() as Array<{ name: string }>;
    upgraded.close();
    assert.equal(version.version, 6);
    assert.ok(columns.some((column) => column.name === 'adapter_fields'));
  });

  it('serializes concurrent version-1 opens before checking the migration version', async () => {
    const dbPath = join(tempDir, `migration-race-${Date.now()}.db`);
    const v1 = new DatabaseSync(dbPath);
    v1.exec(migration1Sql);
    v1.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    v1.close();

    const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.js')).href;
    const source = `
      import { workerData, parentPort } from 'node:worker_threads';
      const { openStore } = await import(workerData.storeUrl);
      parentPort.postMessage('ready');
      await new Promise((resolve) => parentPort.once('message', resolve));
      const store = await openStore({ path: workerData.dbPath, nodeId: workerData.nodeId });
      await store.close();
      parentPort.postMessage('done');
    `;
    const workers = Array.from({ length: 8 }, (_, id) => new Worker(source, {
      eval: true,
      workerData: { dbPath, storeUrl, nodeId: `migration-worker-${id}` },
    }));
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once('message', (message) => message === 'ready' && resolve());
      worker.once('error', reject);
    })));
    const completed = workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once('message', (message) => message === 'done' && resolve());
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    }));
    workers.forEach((worker) => worker.postMessage('go'));
    await Promise.all(completed);

    const upgraded = new DatabaseSync(dbPath);
    const versions = upgraded.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
    const columns = upgraded.prepare('PRAGMA table_info(receipts)').all() as Array<{ name: string }>;
    const indexes = upgraded.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('receipts_retry', 'receipts_session_outcome') ORDER BY name",
    ).all() as Array<{ name: string }>;
    upgraded.close();
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(indexes.map((row) => row.name), ['receipts_retry', 'receipts_session_outcome']);
    assert.equal(columns.filter((column) => column.name === 'adapter_fields').length, 1);
  });

  it('upgrades an existing version-2 database to the current version with rows intact', async () => {
    const dbPath = join(tempDir, `migration-v2-${Date.now()}.db`);
    const v2 = new DatabaseSync(dbPath);
    v2.exec(migration1Sql);
    v2.exec(migration2Sql);
    v2.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    v2.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    const sealed = makeSealed({ job_id: 'job-survive-migration' });
    const now = new Date().toISOString();
    v2.prepare(
      `INSERT INTO jobs (job_id, envelope, envelope_digest, state, created_at, updated_at, actions_used)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      sealed.envelope.job_id,
      JSON.stringify(sealed.envelope),
      sealed.envelope_digest,
      'working',
      now,
      now,
    );
    v2.prepare(
      `INSERT INTO receipts (receipt_id, job_id, node_id, session_id, actor, capability,
        arguments_normalized, arguments_digest, decision, envelope_digest,
        started_at, ended_at, outcome, artifact_refs, finding_refs, adapter_fields)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, '[]', '[]', ?)`,
    ).run(
      'rcpt-survive',
      sealed.envelope.job_id,
      'node-a',
      'model-a',
      'test.cap',
      JSON.stringify({ allow: true, reason: 'ok' }),
      sealed.envelope_digest,
      now,
      now,
      'succeeded',
      JSON.stringify({ excel_pid: 99 }),
    );
    v2.close();

    const store = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const job = await store.getJob(sealed.envelope.job_id);
    assert(job !== null);
    assert.equal(job.job_id, sealed.envelope.job_id);
    assert.equal(job.state, 'working');
    const receipts = await store.listReceipts(sealed.envelope.job_id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.receipt_id, 'rcpt-survive');
    assert.deepEqual(receipts[0]?.adapter_fields, { excel_pid: 99 });

    // Conversation tables from migration 3 are usable.
    const conversation = await store.createConversation({
      conversation_id: 'conv-after-upgrade',
      node_id: 'node-a',
      title: 'post-upgrade',
      state: 'open',
    });
    assert.equal(conversation.conversation_id, 'conv-after-upgrade');
    const turn = await store.appendTurn({
      conversation_id: 'conv-after-upgrade',
      role: 'operator',
      channel: 'human',
      content: 'hello after upgrade',
      job_id: sealed.envelope.job_id,
    });
    assert.equal(turn.seq, 1);
    await store.close();

    const upgraded = new DatabaseSync(dbPath);
    const version = upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    };
    const tables = upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversations', 'conversation_turns') ORDER BY name")
      .all() as Array<{ name: string }>;
    upgraded.close();
    assert.equal(version.version, 6);
    assert.deepEqual(tables.map((row) => row.name), ['conversation_turns', 'conversations']);
  });

  it('upgrades a populated version-4 database without changing rows and is idempotent', async () => {
    const dbPath = join(tempDir, `migration-v4-${Date.now()}.db`);
    const v4 = new DatabaseSync(dbPath);
    v4.exec(migration1Sql);
    v4.exec(migration2Sql);
    v4.exec(migration3Sql);
    v4.exec(migration4Sql);
    for (const version of [1, 2, 3, 4]) {
      v4.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    }
    const sealed = makeSealed({ job_id: 'job-populated-v4' });
    v4.prepare(
      `INSERT INTO jobs (job_id, envelope, envelope_digest, state, created_at, updated_at, actions_used, conversation_id)
       VALUES (?, ?, ?, 'working', ?, ?, 2, NULL)`,
    ).run(sealed.envelope.job_id, JSON.stringify(sealed.envelope), sealed.envelope_digest,
      '2026-08-22T10:00:00.000Z', '2026-08-22T10:00:01.000Z');
    v4.prepare(
      `INSERT INTO sessions (session_id, job_id, adapter_id, workspace_id, pid, started_at, stopped_at, read_cursor)
       VALUES ('session-v4', ?, 'cli', 'default', 42, '2026-08-22T10:00:00.000Z', NULL, 7)`,
    ).run(sealed.envelope.job_id);
    const insertV4Receipt = v4.prepare(
      `INSERT INTO receipts (receipt_id, job_id, node_id, session_id, actor, capability,
        arguments_normalized, arguments_digest, decision, envelope_digest, started_at, ended_at,
        outcome, artifact_refs, finding_refs, adapter_fields)
       VALUES (?, ?, 'node-v4', 'session-v4', 'model-v4', 'cli.send', NULL, 'digest-v4', ?, ?, ?, ?, ?, '[]', '[]', ?)`);
    insertV4Receipt.run('success-v4', sealed.envelope.job_id, JSON.stringify({ allow: true, reason: 'ok' }),
      sealed.envelope_digest, '2026-08-22T10:00:02.000Z', '2026-08-22T10:00:03.000Z', 'succeeded', JSON.stringify({ exchange: 1 }));
    insertV4Receipt.run('failed-v4', sealed.envelope.job_id, JSON.stringify({ allow: true, reason: 'ok' }),
      sealed.envelope_digest, '2026-08-22T10:00:04.000Z', '2026-08-22T10:00:05.000Z', 'failed', JSON.stringify({ exchange: 2 }));
    insertV4Receipt.run('running-v4', sealed.envelope.job_id, JSON.stringify({ allow: true, reason: 'ok' }),
      sealed.envelope_digest, '2026-08-22T10:00:06.000Z', null, 'running', JSON.stringify({ exchange: 3 }));
    const beforeRows = v4.prepare('SELECT * FROM receipts ORDER BY receipt_id').all();
    v4.close();

    const store = await openStore(makeStoreOptions(dbPath, 'node-v4'));
    assert.equal((await store.getJob(sealed.envelope.job_id))?.actions_used, 2);
    assert.equal((await store.getSession('session-v4'))?.read_cursor, 7);
    assert.deepEqual(await store.listReceipts(sealed.envelope.job_id), [
      makeReceipt({ receipt_id: 'success-v4', job_id: sealed.envelope.job_id, node_id: 'node-v4',
        session_id: 'session-v4', actor: 'model-v4', capability: 'cli.send', arguments_digest: 'digest-v4',
        decision: { allow: true, reason: 'ok' },
        envelope_digest: sealed.envelope_digest, started_at: '2026-08-22T10:00:02.000Z',
        ended_at: '2026-08-22T10:00:03.000Z', outcome: 'succeeded', adapter_fields: { exchange: 1 } }),
      makeReceipt({ receipt_id: 'failed-v4', job_id: sealed.envelope.job_id, node_id: 'node-v4',
        session_id: 'session-v4', actor: 'model-v4', capability: 'cli.send', arguments_digest: 'digest-v4',
        decision: { allow: true, reason: 'ok' },
        envelope_digest: sealed.envelope_digest, started_at: '2026-08-22T10:00:04.000Z',
        ended_at: '2026-08-22T10:00:05.000Z', outcome: 'failed', adapter_fields: { exchange: 2 } }),
      makeReceipt({ receipt_id: 'running-v4', job_id: sealed.envelope.job_id, node_id: 'node-v4',
        session_id: 'session-v4', actor: 'model-v4', capability: 'cli.send', arguments_digest: 'digest-v4',
        decision: { allow: true, reason: 'ok' },
        envelope_digest: sealed.envelope_digest, started_at: '2026-08-22T10:00:06.000Z',
        ended_at: null, outcome: 'running', adapter_fields: { exchange: 3 } }),
    ]);
    assert.equal(await store.countRetries(sealed.envelope.job_id, 'cli.send', 'digest-v4'), 1);
    assert.equal((await store.latestRunningReceipt(sealed.envelope.job_id, 'session-v4', 'cli.send'))?.receipt_id, 'running-v4');
    await store.close();

    const reopened = await openStore(makeStoreOptions(dbPath, 'node-v4'));
    await reopened.close();
    const upgraded = new DatabaseSync(dbPath);
    const versions = upgraded.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
    const indexes = upgraded.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('receipts_retry', 'receipts_session_outcome') ORDER BY name",
    ).all() as Array<{ name: string }>;
    const afterRows = upgraded.prepare('SELECT * FROM receipts ORDER BY receipt_id').all();
    upgraded.close();
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(indexes.map((row) => row.name), ['receipts_retry', 'receipts_session_outcome']);
    assert.deepEqual(afterRows, beforeRows);
  });

  it('waits beyond the former 750ms WAL retry ceiling for a live database lock', async () => {
    const dbPath = join(tempDir, `wal-contention-${Date.now()}.db`);
    const v1 = new DatabaseSync(dbPath);
    v1.exec(migration1Sql);
    v1.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    v1.close();

    const source = `
      import { DatabaseSync } from 'node:sqlite';
      import { workerData, parentPort } from 'node:worker_threads';
      const db = new DatabaseSync(workerData.dbPath);
      db.exec('BEGIN EXCLUSIVE');
      parentPort.postMessage('locked');
      setTimeout(() => {
        db.exec('ROLLBACK');
        db.close();
        parentPort.postMessage('released');
      }, workerData.holdMs);
    `;
    const locker = new Worker(source, {
      eval: true,
      workerData: { dbPath, holdMs: 1_200 },
    });
    const released = new Promise<void>((resolve, reject) => {
      locker.on('message', (message) => message === 'released' && resolve());
      locker.once('error', reject);
      locker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    });
    await new Promise<void>((resolve, reject) => {
      locker.on('message', (message) => message === 'locked' && resolve());
      locker.once('error', reject);
    });

    const started = Date.now();
    const store = await openStore(makeStoreOptions(dbPath));
    const elapsed = Date.now() - started;
    await store.close();
    await released;
    assert.ok(elapsed >= 1_000, `openStore returned before the lock was released (${elapsed}ms)`);
  });

  it('retries fast SQLITE_BUSY failures beyond the former 750ms ceiling', async (t) => {
    // Drive the backoff on a mocked clock. On the real clock a loaded machine
    // stretches each sleep, so the attempt that lands near 750ms could already
    // be past 800ms and succeed early, which made the attempt count depend on
    // machine speed rather than on the retry schedule.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const attemptTimes: number[] = [];
    let settled = false;
    const retry = retrySqliteBusy(() => {
      attemptTimes.push(Date.now());
      if (Date.now() < 800) throw new Error('database is locked');
      return 'written';
    }, 2_500).finally(() => { settled = true; });

    // setImmediate is not mocked, so each turn lets the retry loop schedule
    // its next sleep before the clock moves on.
    for (let elapsed = 0; !settled && elapsed <= 2_600; elapsed += 10) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!settled) t.mock.timers.tick(10);
    }

    assert.equal(await retry, 'written');
    const last = attemptTimes.at(-1) ?? 0;
    assert.ok(last >= 800, `retry stopped after ${last}ms`);
    assert.ok(attemptTimes.length >= 6, `expected at least six attempts, saw ${attemptTimes.length} at ${attemptTimes.join(', ')}ms`);
  });
});

// ---------------------------------------------------------------------------
// Jobs and sessions
// ---------------------------------------------------------------------------

describe('Jobs and sessions', () => {
  it('createJob then getJob round-trips the envelope and digest unchanged', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const sealed = makeSealed();
    const created = await store.createJob(sealed);
    const fetched = await store.getJob(created.job_id);
    assert(fetched !== null);
    assert.deepEqual(fetched.envelope, sealed.envelope);
    assert.equal(fetched.envelope_digest, sealed.envelope_digest);
    assert.equal(fetched.state, 'working');
    assert.equal(typeof fetched.created_at, 'string');
    assert.equal(typeof fetched.updated_at, 'string');
    assert.equal(fetched.actions_used, 0);
    await store.close();
  });

  it('getJob returns null for an unknown id', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const result = await store.getJob('nonexistent-job-id');
    assert.equal(result, null);
    await store.close();
  });

  it('incrementActionsUsed is atomic under concurrent calls', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const sealed = makeSealed();
    await store.createJob(sealed);

    const CONCURRENT = 50;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < CONCURRENT; i++) {
      promises.push(store.incrementActionsUsed(sealed.envelope.job_id));
    }
    await Promise.all(promises);

    const job = await store.getJob(sealed.envelope.job_id);
    assert(job !== null);
    assert.equal(job.actions_used, CONCURRENT);
    await store.close();
  });

  it('setReadCursor and stopSession round-trip', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const sealed = makeSealed();
    await store.createJob(sealed);

    const session = await store.createSession({
      session_id: 'sess-1',
      job_id: sealed.envelope.job_id,
      adapter_id: 'test',
      workspace_id: 'default',
      pid: 1234,
      started_at: new Date().toISOString(),
    });

    assert.equal(session.read_cursor, 0);
    assert.equal(session.pid, 1234);
    assert.equal(session.stopped_at, null);

    const afterCursor = await store.setReadCursor('sess-1', 42);
    assert.equal(afterCursor.read_cursor, 42);

    const stopped = await store.stopSession('sess-1', new Date().toISOString());
    assert(stopped.stopped_at !== null);
    assert.equal(stopped.pid, null);

    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Receipts and artifacts
// ---------------------------------------------------------------------------

describe('Receipts and artifacts', () => {
  it('putReceipt then listReceipts returns receipts for that job only', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const sealed1 = makeSealed();
    const sealed2 = makeSealed();
    await store.createJob(sealed1);
    await store.createJob(sealed2);

    const now = new Date().toISOString();
    const receipt1: Receipt = {
      receipt_id: 'rcpt-1',
      job_id: sealed1.envelope.job_id,
      node_id: 'node-1',
      session_id: null,
      actor: 'model-a',
      capability: 'test.cap',
      arguments_normalized: { file: '/test.txt' },
      arguments_digest: null,
      decision: { allow: true, reason: 'Allowed' },
      envelope_digest: sealed1.envelope_digest,
      started_at: now,
      ended_at: now,
      outcome: 'succeeded',
      artifact_refs: [],
      finding_refs: [],
      adapter_fields: { excel_pid: 4242 },
    };
    const receipt2: Receipt = {
      receipt_id: 'rcpt-2',
      job_id: sealed2.envelope.job_id,
      node_id: 'node-1',
      session_id: null,
      actor: 'model-a',
      capability: 'test.cap',
      arguments_normalized: null,
      arguments_digest: 'b'.repeat(64),
      decision: { allow: false, code: 'E_FORBIDDEN' as const, reason: 'Not allowed' },
      envelope_digest: sealed2.envelope_digest,
      started_at: now,
      ended_at: now,
      outcome: 'denied',
      artifact_refs: [],
      finding_refs: [],
      adapter_fields: {},
    };

    await store.putReceipt(receipt1);
    await store.putReceipt(receipt2);

    // Receipt 1 listed for job 1
    const rcpts1 = await store.listReceipts(sealed1.envelope.job_id);
    assert.equal(rcpts1.length, 1);
    assert.equal(rcpts1[0]?.receipt_id, 'rcpt-1');
    assert.deepEqual(rcpts1[0]?.adapter_fields, { excel_pid: 4242 });

    // Receipt 2 listed for job 2
    const rcpts2 = await store.listReceipts(sealed2.envelope.job_id);
    assert.equal(rcpts2.length, 1);
    assert.equal(rcpts2[0]?.receipt_id, 'rcpt-2');

    await store.close();
  });

  it('a receipt with arguments_digest and null arguments_normalized round-trips', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const sealed = makeSealed();
    await store.createJob(sealed);

    const now = new Date().toISOString();
    const receipt: Receipt = {
      receipt_id: 'rcpt-args-test',
      job_id: sealed.envelope.job_id,
      node_id: 'node-1',
      session_id: null,
      actor: 'model-a',
      capability: 'test.cap',
      arguments_normalized: null,
      arguments_digest: 'abcdef0123456789'.repeat(4),
      decision: { allow: true, reason: 'ok' },
      envelope_digest: sealed.envelope_digest,
      started_at: now,
      ended_at: null,
      outcome: 'running',
      artifact_refs: [],
      finding_refs: [],
      adapter_fields: { conversation_id: 'thread-1', exchange: 2 },
    };

    await store.putReceipt(receipt);
    const fetched = await store.getReceipt('rcpt-args-test');
    assert(fetched !== null);
    assert.equal(fetched.arguments_normalized, null);
    assert.equal(fetched.arguments_digest, receipt.arguments_digest);
    assert.equal(fetched.ended_at, null);
    assert.equal(fetched.outcome, 'running');
    assert.deepEqual(fetched.adapter_fields, { conversation_id: 'thread-1', exchange: 2 });

    await store.close();
  });
});

describe('Indexed receipt queries', () => {
  it('countRetries is equivalent to the chronological receipt-scan oracle', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const jobId = 'job-retry-equivalence';
    const otherJobId = 'job-retry-other';
    const rows: Receipt[] = [
      makeReceipt({ receipt_id: 'r01', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:01.000Z', outcome: 'failed' }),
      makeReceipt({ receipt_id: 'r02', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:02.000Z', outcome: 'terminated' }),
      makeReceipt({ receipt_id: 'r03', job_id: jobId, capability: 'other.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:03.000Z', outcome: 'failed' }),
      makeReceipt({ receipt_id: 'r04', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:04.000Z', outcome: 'succeeded' }),
      makeReceipt({ receipt_id: 'r05', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-b', started_at: '2026-08-22T10:00:05.000Z', outcome: 'failed' }),
      makeReceipt({ receipt_id: 'r06', job_id: otherJobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:06.000Z', outcome: 'failed' }),
      makeReceipt({ receipt_id: 'r07', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:07.000Z', outcome: 'denied' }),
      makeReceipt({ receipt_id: 'r08', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:08.000Z', outcome: 'failed' }),
      makeReceipt({ receipt_id: 'r09', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:09.000Z', outcome: 'running', ended_at: null }),
      makeReceipt({ receipt_id: 'r10', job_id: jobId, capability: 'test.cap', arguments_digest: null, started_at: '2026-08-22T10:00:10.000Z', outcome: 'terminated' }),
      makeReceipt({ receipt_id: 'r11', job_id: jobId, capability: 'test.cap', arguments_digest: 'digest-a', started_at: '2026-08-22T10:00:11.000Z', outcome: 'terminated' }),
    ];
    for (const row of rows) await store.putReceipt(row);

    const oracle = (receipts: readonly Receipt[], targetJob: string, capability: Receipt['capability'], argumentsDigest: string): number => {
      let failures = 0;
      for (let index = receipts.length - 1; index >= 0; index -= 1) {
        const receipt = receipts[index];
        if (receipt === undefined || receipt.job_id !== targetJob
          || receipt.capability !== capability || receipt.arguments_digest !== argumentsDigest) continue;
        if (receipt.outcome === 'succeeded') break;
        if (receipt.outcome === 'failed' || receipt.outcome === 'terminated') failures += 1;
      }
      return failures;
    };
    const allRows = [...await store.listReceipts(jobId), ...await store.listReceipts(otherJobId)]
      .sort((left, right) => left.started_at.localeCompare(right.started_at));
    for (const [targetJob, capability, argumentsDigest] of [
      [jobId, 'test.cap', 'digest-a'],
      [jobId, 'other.cap', 'digest-a'],
      [jobId, 'test.cap', 'digest-b'],
      [otherJobId, 'test.cap', 'digest-a'],
      [jobId, 'test.cap', 'missing'],
    ] as const) {
      assert.equal(
        await store.countRetries(targetJob, capability, argumentsDigest),
        oracle(allRows, targetJob, capability, argumentsDigest),
      );
    }
    assert.equal(await store.countRetries(jobId, 'test.cap', 'digest-a'), 2);
    await store.close();
  });

  it('latestRunningReceipt is exact, newest, nullable, and maps the complete receipt', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const rows = [
      makeReceipt({ receipt_id: 'old-match', job_id: 'job-a', session_id: 'session-a', capability: 'cli.send', started_at: '2026-08-22T11:00:01.000Z', outcome: 'running', ended_at: null, adapter_fields: { exchange: 1 } }),
      makeReceipt({ receipt_id: 'other-job', job_id: 'job-b', session_id: 'session-a', capability: 'cli.send', started_at: '2026-08-22T11:00:05.000Z', outcome: 'running', ended_at: null }),
      makeReceipt({ receipt_id: 'other-session', job_id: 'job-a', session_id: 'session-b', capability: 'cli.send', started_at: '2026-08-22T11:00:06.000Z', outcome: 'running', ended_at: null }),
      makeReceipt({ receipt_id: 'other-capability', job_id: 'job-a', session_id: 'session-a', capability: 'other.send', started_at: '2026-08-22T11:00:07.000Z', outcome: 'running', ended_at: null }),
      makeReceipt({ receipt_id: 'settled-match', job_id: 'job-a', session_id: 'session-a', capability: 'cli.send', started_at: '2026-08-22T11:00:08.000Z', outcome: 'succeeded' }),
      makeReceipt({ receipt_id: 'new-match', job_id: 'job-a', session_id: 'session-a', capability: 'cli.send', started_at: '2026-08-22T11:00:09.000Z', outcome: 'running', ended_at: null, arguments_normalized: { message: 'new' }, adapter_fields: { exchange: 2 } }),
    ];
    for (const row of rows) await store.putReceipt(row);

    const latest = await store.latestRunningReceipt('job-a', 'session-a', 'cli.send');
    assert.deepEqual(latest, rows[5]);
    assert.equal(await store.latestRunningReceipt('job-a', 'missing-session', 'cli.send'), null);
    assert.equal(await store.latestRunningReceipt('missing-job', 'session-a', 'cli.send'), null);
    assert.equal(await store.latestRunningReceipt('job-a', 'session-a', 'missing.send'), null);
    await store.close();
  });

  it('binds injection-shaped values as data in both receipt queries', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const jobId = "job' OR 1=1 --";
    const sessionId = "session' OR 1=1 --";
    const capability = "cli.send' OR 1=1 --";
    const argumentsDigest = "digest' OR 1=1 --";
    await store.putReceipt(makeReceipt({
      receipt_id: 'quoted-values', job_id: jobId, session_id: sessionId, capability,
      arguments_digest: argumentsDigest, started_at: '2026-08-22T12:00:00.000Z', outcome: 'running', ended_at: null,
    }));
    await store.putReceipt(makeReceipt({
      receipt_id: 'ordinary-values', job_id: 'ordinary-job', session_id: 'ordinary-session', capability: 'cli.send',
      arguments_digest: 'ordinary-digest', started_at: '2026-08-22T12:00:01.000Z', outcome: 'failed',
    }));
    assert.equal((await store.latestRunningReceipt(jobId, sessionId, capability))?.receipt_id, 'quoted-values');
    assert.equal(await store.latestRunningReceipt("' OR 1=1 --", sessionId, capability), null);
    assert.equal(await store.countRetries("' OR 1=1 --", 'cli.send', 'ordinary-digest'), 0);
    await store.putReceipt(makeReceipt({
      receipt_id: 'quoted-failure', job_id: jobId, capability, arguments_digest: argumentsDigest,
      started_at: '2026-08-22T12:00:02.000Z', outcome: 'failed',
    }));
    assert.equal(await store.countRetries(jobId, capability, argumentsDigest), 1);
    await store.close();
  });

  it('uses both binding indexes for the exact production statements', async () => {
    const dbPath = join(tempDir, `receipt-plans-${Date.now()}.db`);
    const store = await openStore(makeStoreOptions(dbPath));
    await store.close();
    const db = new DatabaseSync(dbPath);
    const retryPlan = db.prepare(`EXPLAIN QUERY PLAN ${COUNT_RETRIES_SQL}`).all(
      'job', 'test.cap', 'digest', 'job', 'test.cap', 'digest',
    ) as Array<{ detail: string }>;
    const runningPlan = db.prepare(`EXPLAIN QUERY PLAN ${LATEST_RUNNING_RECEIPT_SQL}`).all(
      'session', 'job', 'cli.send',
    ) as Array<{ detail: string }>;
    db.close();
    assert.match(retryPlan.map((row) => row.detail).join('\n'), /USING (?:COVERING )?INDEX receipts_retry/);
    assert.match(runningPlan.map((row) => row.detail).join('\n'), /USING (?:COVERING )?INDEX receipts_session_outcome/);
  });
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

describe('The chain', () => {
  it('the first append links to GENESIS_HASH', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const event = await store.appendEvent({
      node_id: 'test-node',
      job_id: null,
      kind: 'job.created',
      payload: { msg: 'hello' },
    });
    assert.equal(event.prev_hash, GENESIS_HASH);
    assert.equal(event.hash, chainHash(GENESIS_HASH, { msg: 'hello' }));
    await store.close();
  });

  it('each append links to the previous hash', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    const e1 = await store.appendEvent({
      node_id: 'test-node',
      job_id: null,
      kind: 'job.created',
      payload: { seq: 1 },
    });
    const e2 = await store.appendEvent({
      node_id: 'test-node',
      job_id: null,
      kind: 'action.requested',
      payload: { seq: 2 },
    });
    const e3 = await store.appendEvent({
      node_id: 'test-node',
      job_id: null,
      kind: 'action.decided',
      payload: { seq: 3 },
    });

    assert.equal(e1.prev_hash, GENESIS_HASH);
    assert.equal(e2.prev_hash, e1.hash);
    assert.equal(e3.prev_hash, e2.hash);
    await store.close();
  });

  it('verifyChain reports ok on an intact chain', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    for (let i = 0; i < 5; i++) {
      await store.appendEvent({
        node_id: 'test-node',
        job_id: null,
        kind: 'job.created',
        payload: { seq: i },
      });
    }
    const result = await store.verifyChain('test-node');
    assert.equal(result.ok, true);
    assert.equal(result.broken_at_seq, null);
    assert.equal(result.anchor_matches, true);
    assert.equal(result.rows_checked, 5);
    await store.close();
  });

  it('verifyChain detects an edited payload and reports the first broken seq', async () => {
    // Use a file database so we can corrupt it via a second connection.
    const dbPath = join(tempDir, `chain-edit-${Date.now()}.db`);
    const store = await openStore(makeStoreOptions(dbPath, 'node-a'));
    for (let i = 0; i < 4; i++) {
      await store.appendEvent({
        node_id: 'node-a',
        job_id: null,
        kind: 'job.created',
        payload: { seq: i },
      });
    }
    await store.close();

    // Corrupt payload at seq 2 via a separate connection.
    const raw = new DatabaseSync(dbPath);
    raw.exec('UPDATE events SET payload = \'"corrupted"\' WHERE seq = 2');
    raw.close();

    const store2 = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const result = await store2.verifyChain('node-a');
    assert.equal(result.ok, false);
    assert.equal(result.broken_at_seq, 2);
    assert.equal(result.anchor_matches, false);
    assert(result.reason !== null);
    await store2.close();
  });

  it('verifyChain detects an inserted row', async () => {
    const dbPath = join(tempDir, `chain-insert-${Date.now()}.db`);
    const store = await openStore(makeStoreOptions(dbPath, 'node-a'));
    // Append two events legitimately.
    const e1 = await store.appendEvent({
      node_id: 'node-a',
      job_id: null,
      kind: 'job.created',
      payload: { seq: 1 },
    });
    await store.appendEvent({
      node_id: 'node-a',
      job_id: null,
      kind: 'job.created',
      payload: { seq: 3 },
    });
    await store.close();

    // Insert a rogue row with a broken prev_hash.
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      `INSERT INTO events (node_id, job_id, kind, recorded_at, payload, prev_hash, hash)
       VALUES ('node-a', NULL, 'job.created', '2025-01-01T00:00:00Z', '"rogue"', '${GENESIS_HASH}', '${'f'.repeat(64)}')`,
    );
    raw.close();

    const store2 = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const result = await store2.verifyChain('node-a');
    assert.equal(result.ok, false);
    assert(result.broken_at_seq !== null);
    await store2.close();
  });

  it('verifyChain detects tail truncation via anchor_matches with broken_at_seq null', async () => {
    const dbPath = join(tempDir, `chain-trunc-${Date.now()}.db`);
    const store = await openStore(makeStoreOptions(dbPath, 'node-a'));
    for (let i = 0; i < 5; i++) {
      await store.appendEvent({
        node_id: 'node-a',
        job_id: null,
        kind: 'job.created',
        payload: { seq: i },
      });
    }
    await store.close();

    // Delete the last row (seq 5) to truncate the tail.
    const raw = new DatabaseSync(dbPath);
    raw.exec('DELETE FROM events WHERE seq = (SELECT MAX(seq) FROM events WHERE node_id = \'node-a\')');
    raw.close();

    const store2 = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const result = await store2.verifyChain('node-a');
    // Every surviving row links correctly, so broken_at_seq is null.
    assert.equal(result.broken_at_seq, null);
    // But row_count no longer matches the anchor — the truncation signature.
    assert.equal(result.anchor_matches, false);
    assert.equal(result.ok, false);
    assert.equal(result.rows_checked, 4);
    await store2.close();
  });

  it('chain_head row_count matches the number of event rows after every append', async () => {
    const store = await openStore(makeStoreOptions(':memory:'));
    for (let i = 0; i < 7; i++) {
      await store.appendEvent({
        node_id: 'test-node',
        job_id: null,
        kind: 'job.created',
        payload: { seq: i },
      });
      const head = await store.getChainHead('test-node');
      assert.equal(head.row_count, i + 1);
    }
    await store.close();
  });

  it('concurrent appends produce a linear chain with no shared prev_hash', async () => {
    // node:sqlite is SYNCHRONOUS. Driving one Store instance from a Promise.all
    // in this process proves nothing: each appendEvent runs to completion before
    // the next promise is even created, so the writers never contend and the
    // test passes with or without BEGIN IMMEDIATE.
    //
    // Real contention needs real parallelism, so this spawns worker threads,
    // each opening its OWN connection to the same database file. Under a
    // deferred transaction two workers can both read the same head and write
    // rows sharing a prev_hash — a fork — which the assertions below catch.
    const dbPath = join(tempDir, `chain-concurrent-${Date.now()}.db`);
    const store = await openStore(makeStoreOptions(dbPath, 'node-a'));
    await store.close(); // let the workers own the file; migrations are applied

    const WORKERS = 4;
    const PER_WORKER = 10;
    const COUNT = WORKERS * PER_WORKER;

    const storeUrl = pathToFileURL(
      join(import.meta.dirname, '..', 'src', 'index.js'),
    ).href;

    const source = `
      import { workerData, parentPort } from 'node:worker_threads';
      const { openStore } = await import(workerData.storeUrl);
      const store = await openStore({ path: workerData.dbPath, nodeId: 'node-a' });
      for (let i = 0; i < workerData.count; i++) {
        await store.appendEvent({
          node_id: 'node-a', job_id: null, kind: 'job.created',
          payload: { worker: workerData.id, i },
        });
      }
      await store.close();
      parentPort.postMessage('done');
    `;

    await Promise.all(
      Array.from({ length: WORKERS }, (_, id) => new Promise<void>((resolve, reject) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: { dbPath, storeUrl, count: PER_WORKER, id },
        });
        worker.once('message', () => resolve());
        worker.once('error', reject);
        worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
      })),
    );

    const reopened = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const result = await reopened.verifyChain('node-a');
    assert.equal(result.ok, true, result.reason ?? 'chain should be intact');
    assert.equal(result.rows_checked, COUNT);
    const head = await reopened.getChainHead('node-a');
    assert.equal(head.row_count, COUNT);
    await reopened.close();

    const raw = new DatabaseSync(dbPath);
    const rows = raw.prepare('SELECT prev_hash FROM events WHERE node_id = ? ORDER BY seq').all('node-a') as { prev_hash: string }[];
    raw.close();
    assert.equal(rows.length, COUNT);
    // A fork shows up as two rows sharing a prev_hash.
    assert.equal(new Set(rows.map((r) => r.prev_hash)).size, COUNT, 'two rows shared a prev_hash — the chain forked');
  });
});

// ---------------------------------------------------------------------------
// Restart persistence
// ---------------------------------------------------------------------------

describe('Restart persistence', () => {
  it('a job, its receipts, and an intact chain survive close and reopen', async () => {
    const dbPath = join(tempDir, `persist-${Date.now()}.db`);

    // First session
    const store1 = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const sealed = makeSealed();
    await store1.createJob(sealed);

    const now = new Date().toISOString();
    const receipt: Receipt = {
      receipt_id: 'rcpt-persist',
      job_id: sealed.envelope.job_id,
      node_id: 'node-a',
      session_id: null,
      actor: 'model-a',
      capability: 'test.cap',
      arguments_normalized: { file: '/persist.txt' },
      arguments_digest: null,
      decision: { allow: true, reason: 'Allowed' },
      envelope_digest: sealed.envelope_digest,
      started_at: now,
      ended_at: now,
      outcome: 'succeeded',
      artifact_refs: ['art-1'],
      finding_refs: [],
      adapter_fields: {},
    };
    await store1.putReceipt(receipt);

    await store1.appendEvent({
      node_id: 'node-a',
      job_id: sealed.envelope.job_id,
      kind: 'job.created',
      payload: { msg: 'create' },
    });
    await store1.appendEvent({
      node_id: 'node-a',
      job_id: sealed.envelope.job_id,
      kind: 'action.requested',
      payload: { tool: 'test.cap' },
    });

    await store1.close();

    // Second session — reopen
    const store2 = await openStore(makeStoreOptions(dbPath, 'node-a'));

    const fetchedJob = await store2.getJob(sealed.envelope.job_id);
    assert(fetchedJob !== null);
    assert.deepEqual(fetchedJob.envelope, sealed.envelope);
    assert.equal(fetchedJob.envelope_digest, sealed.envelope_digest);

    const rcpts = await store2.listReceipts(sealed.envelope.job_id);
    assert.equal(rcpts.length, 1);
    assert.equal(rcpts[0]?.receipt_id, 'rcpt-persist');

    const chainResult = await store2.verifyChain('node-a');
    assert.equal(chainResult.ok, true);
    assert.equal(chainResult.rows_checked, 2);

    await store2.close();
  });
});

// ---------------------------------------------------------------------------
// Conversations (spec Y)
// ---------------------------------------------------------------------------

describe('Conversations', () => {
  it('createConversation, getConversation, and listConversations round-trip', async () => {
    const store = await openStore(makeStoreOptions(':memory:', 'node-a'));
    const created = await store.createConversation({
      conversation_id: 'conv-1',
      node_id: 'node-a',
      title: 'First thread',
      state: 'open',
    });
    assert.equal(created.conversation_id, 'conv-1');
    assert.equal(created.node_id, 'node-a');
    assert.equal(created.title, 'First thread');
    assert.equal(created.state, 'open');
    assert.equal(typeof created.created_at, 'string');
    assert.equal(created.updated_at, created.created_at);

    const fetched = await store.getConversation('conv-1');
    assert(fetched !== null);
    assert.deepEqual(fetched, created);

    assert.equal(await store.getConversation('missing'), null);

    await store.createConversation({
      conversation_id: 'conv-2',
      node_id: 'node-a',
      title: 'Second',
      state: 'open',
    });
    const listed = await store.listConversations();
    assert.equal(listed.length, 2);
    assert.equal(new Set(listed.map((c) => c.conversation_id)).size, 2);
    await store.close();
  });

  it('persists lifecycle, routing preferences, and API usage', async () => {
    const store = await openStore(makeStoreOptions(':memory:', 'node-a'));
    await store.createConversation({ conversation_id: 'conv-usage', node_id: 'node-a', title: 'New conversation', state: 'open' });
    const named = await store.renameConversation('conv-usage', 'Quarterly workbook');
    assert.equal(named.title, 'Quarterly workbook');
    const routed = await store.setConversationPreferences('conv-usage', 'codex', 'openai/gpt-5.6-terra');
    assert.equal(routed.agent, 'codex');
    assert.equal(routed.model, 'openai/gpt-5.6-terra');
    await store.recordModelUsage({
      conversation_id: 'conv-usage', job_id: null, provider: 'openrouter.ai', model: 'openai/gpt-5.6-terra',
      prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost_usd: 0.0006,
    });
    const usage = await store.listModelUsage('conv-usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.total_tokens, 150);
    assert.equal(usage[0]?.cost_usd, 0.0006);
    const archived = await store.setConversationState('conv-usage', 'archived');
    assert.equal(archived.state, 'archived');
    await store.close();
  });

  it('appendTurn assigns monotonic seq and listTurns supports after', async () => {
    const store = await openStore(makeStoreOptions(':memory:', 'node-a'));
    await store.createConversation({
      conversation_id: 'conv-turns',
      node_id: 'node-a',
      title: 'turns',
      state: 'open',
    });

    const t1 = await store.appendTurn({
      conversation_id: 'conv-turns',
      role: 'operator',
      channel: 'human',
      content: 'hello',
      job_id: null,
    });
    const t2 = await store.appendTurn({
      conversation_id: 'conv-turns',
      role: 'hermes',
      channel: 'human',
      content: 'hi',
      job_id: null,
    });
    const t3 = await store.appendTurn({
      conversation_id: 'conv-turns',
      role: 'hermes',
      channel: 'machine',
      content: '{"act":{"tool":"read_cli"}}',
      job_id: 'job-1',
    });

    assert.equal(t1.seq, 1);
    assert.equal(t2.seq, 2);
    assert.equal(t3.seq, 3);
    assert.equal(t3.job_id, 'job-1');
    assert.equal(t3.channel, 'machine');

    const all = await store.listTurns('conv-turns');
    assert.deepEqual(all.map((t) => t.seq), [1, 2, 3]);
    assert.deepEqual(all.map((t) => t.content), ['hello', 'hi', '{"act":{"tool":"read_cli"}}']);

    const after = await store.listTurns('conv-turns', { after: 1 });
    assert.deepEqual(after.map((t) => t.seq), [2, 3]);

    // appendTurn bumps conversation.updated_at
    const conversation = await store.getConversation('conv-turns');
    assert(conversation !== null);
    assert.equal(conversation.updated_at, t3.recorded_at);

    await store.close();
  });

  it('binds a job to one conversation, once, and refuses to move it', async () => {
    const store = await openStore(makeStoreOptions(join(tempDir, `bind-${Date.now()}.db`), 'node-a'));
    const created = await store.createJob(makeSealed());
    assert.equal(created.conversation_id, null);

    for (const id of ['conv-bind', 'conv-other']) {
      await store.createConversation({
        conversation_id: id,
        node_id: 'node-a',
        title: id,
        state: 'open',
      });
    }

    const bound = await store.setJobConversation(created.job_id, 'conv-bind');
    assert.equal(bound.conversation_id, 'conv-bind');

    // Binding again to the SAME conversation is how a second Hermes run
    // rejoins the conversation it already belongs to, so it must succeed.
    const rebound = await store.setJobConversation(created.job_id, 'conv-bind');
    assert.equal(rebound.conversation_id, 'conv-bind');

    await assert.rejects(
      () => store.setJobConversation(created.job_id, 'conv-other'),
      /already bound/,
    );

    const reread = await store.getJob(created.job_id);
    assert.equal(reread?.conversation_id, 'conv-bind');
    await store.close();
  });

  it('concurrent appendTurn produces a dense ordered seq on a file-backed database', async () => {
    // node:sqlite is synchronous inside one process, so Promise.all on a single
    // connection never interleaves. Real contention needs separate connections
    // on a real file — same discipline as the concurrent chain-append test.
    const dbPath = join(tempDir, `turns-concurrent-${Date.now()}.db`);
    const bootstrap = await openStore(makeStoreOptions(dbPath, 'node-a'));
    await bootstrap.createConversation({
      conversation_id: 'conv-race',
      node_id: 'node-a',
      title: 'race',
      state: 'open',
    });
    await bootstrap.close();

    const WORKERS = 4;
    const PER_WORKER = 10;
    const COUNT = WORKERS * PER_WORKER;

    const storeUrl = pathToFileURL(
      join(import.meta.dirname, '..', 'src', 'index.js'),
    ).href;

    const source = `
      import { workerData, parentPort } from 'node:worker_threads';
      const { openStore } = await import(workerData.storeUrl);
      const store = await openStore({ path: workerData.dbPath, nodeId: 'node-a' });
      for (let i = 0; i < workerData.count; i++) {
        await store.appendTurn({
          conversation_id: 'conv-race',
          role: 'hermes',
          channel: 'human',
          content: 'w' + workerData.id + '-' + i,
          job_id: null,
        });
      }
      await store.close();
      parentPort.postMessage('done');
    `;

    await Promise.all(
      Array.from({ length: WORKERS }, (_, id) => new Promise<void>((resolve, reject) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: { dbPath, storeUrl, count: PER_WORKER, id },
        });
        worker.once('message', () => resolve());
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`worker exited ${code}`));
        });
      })),
    );

    const reopened = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const turns = await reopened.listTurns('conv-race');
    await reopened.close();

    assert.equal(turns.length, COUNT);
    assert.deepEqual(
      turns.map((t) => t.seq),
      Array.from({ length: COUNT }, (_, i) => i + 1),
      'seq must be dense and ordered with no gaps or duplicates',
    );
    assert.equal(new Set(turns.map((t) => t.seq)).size, COUNT);
  });

  it('conversations and turns survive close and reopen', async () => {
    const dbPath = join(tempDir, `conv-persist-${Date.now()}.db`);
    const store1 = await openStore(makeStoreOptions(dbPath, 'node-a'));
    await store1.createConversation({
      conversation_id: 'conv-persist',
      node_id: 'node-a',
      title: 'durable',
      state: 'open',
    });
    await store1.appendTurn({
      conversation_id: 'conv-persist',
      role: 'operator',
      channel: 'human',
      content: 'remember this',
      job_id: null,
    });
    await store1.appendTurn({
      conversation_id: 'conv-persist',
      role: 'system',
      channel: 'machine',
      content: 'malformed-line',
      job_id: null,
    });
    await store1.close();

    const store2 = await openStore(makeStoreOptions(dbPath, 'node-a'));
    const conversation = await store2.getConversation('conv-persist');
    assert(conversation !== null);
    assert.equal(conversation.title, 'durable');
    const turns = await store2.listTurns('conv-persist');
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.content, 'remember this');
    assert.equal(turns[1]?.role, 'system');
    await store2.close();
  });
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'toros-store-test-'));
});

after(() => {
  if (tempDir) {
    // Windows refuses to remove a directory while any handle is still closing,
    // and the worker threads in the concurrency test release theirs
    // asynchronously — so a bare rmSync raced them and failed with EPERM.
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
