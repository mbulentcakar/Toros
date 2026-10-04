import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { ErrorCode, isTerminal, WorkItemState } from '@toros/contracts';
import type { SealedEnvelope, Store } from '@toros/contracts';
import { openStore } from '@toros/store';

import { createRelay } from '../src/index.js';
import type { RelayOptions, CreateCapsuleInput, CapsuleManifest } from '../src/index.js';
import { buildTar } from '../src/tar.js';
import {
  writeAbsolutePathCapsule,
  writeDotDotCapsule,
  writeSymlinkCapsule,
  writeOversizeCapsule,
} from './tar-fixture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_NODE = 'test-node';

function makeSealed(jobId?: string): SealedEnvelope {
  const envelope = {
    job_id: jobId ?? `job-${Math.random().toString(36).slice(2)}`,
    objective: 'Test objective',
    allowed_capabilities: ['test.cap'],
    allowed_workspaces: ['default'],
    acceptance: ['criterion 1'],
    forbidden: [],
    max_actions: 10,
    max_retries: 2,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  return { envelope, envelope_digest: 'a'.repeat(64) };
}

interface Fixture {
  root: string;
  workspace: { id: string; root: string };
  outputDir: string;
}

function makeFixture(slug: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `toros-relay-${slug}-`));
  const outputDir = join(root, 'out');
  mkdirSync(outputDir, { recursive: true });
  return { root, workspace: { id: 'default', root }, outputDir };
}

function createHashSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function relayOptions(store: Store, fx: Fixture, max = 5 * 1024 * 1024): RelayOptions {
  return {
    store,
    workspace: fx.workspace,
    output_dir: fx.outputDir,
    max_capsule_bytes: max,
    node_id: TEST_NODE,
  };
}

/** Asserts a promise rejects with a TorosError carrying the given code. */
async function assertRejectsCode(fn: () => Promise<unknown>, code: ErrorCode): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof Error, `expected Error, got ${String(err)}`);
    assert.equal((err as { code?: string }).code, code, `expected ${code}, got ${(err as { code?: string }).code}`);
    return true;
  });
}

let suiteDir: string;

before(() => {
  suiteDir = mkdtempSync(join(tmpdir(), 'toros-relay-suite-'));
});

after(() => {
  // Best-effort cleanup; tmp dirs are reaped by the OS.
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe('Checkpoints', () => {
  it('1. createCheckpoint sets state to checkpoint and returns a ref', async () => {
    const store = await openStore({ path: ':memory:', nodeId: TEST_NODE });
    const fx = makeFixture('ck1');
    try {
      const sealed = makeSealed();
      const job = await store.createJob(sealed);
      const relay = createRelay(relayOptions(store, fx));

      const ref = await relay.createCheckpoint(job.job_id, 'mid-run snapshot');

      const after = await store.getJob(job.job_id);
      assert.equal(after?.state, WorkItemState.CHECKPOINT);
      assert.ok(ref.checkpoint_id.length > 0);
      assert.equal(ref.job_id, job.job_id);
      assert.equal(ref.node_id, TEST_NODE);
      assert.match(ref.chain_head, /^[0-9a-f]{64}$/);
      assert.ok(ref.chain_row_count >= 1);
      assert.equal(ref.created_at.length > 0, true);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('2. checkpoint state is not terminal and the job can continue', async () => {
    const store = await openStore({ path: ':memory:', nodeId: TEST_NODE });
    const fx = makeFixture('ck2');
    try {
      const sealed = makeSealed();
      const job = await store.createJob(sealed);
      const relay = createRelay(relayOptions(store, fx));

      await relay.createCheckpoint(job.job_id, 'snapshot');

      const ck = await store.getJob(job.job_id);
      assert.equal(isTerminal(ck!.state), false);

      // The job can continue: transition back to working and execute an action.
      await store.setJobState(job.job_id, WorkItemState.WORKING);
      await store.incrementActionsUsed(job.job_id);
      const after = await store.getJob(job.job_id);
      assert.equal(after?.state, WorkItemState.WORKING);
      assert.equal(after?.actions_used, 1);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('3. restoreCheckpoint returns the job and cursors after a store reopen', async () => {
    const dbPath = join(suiteDir, 'ck3.db');
    const fx = makeFixture('ck3');
    try {
      const sealed = makeSealed();
      let store = await openStore({ path: dbPath, nodeId: TEST_NODE });
      const job = await store.createJob(sealed);
      // A session with a read cursor — this is the "cursor" the restore must
      // re-establish. Everything it needs lives in the store, not in memory.
      const session = await store.createSession({
        session_id: 'sess-1',
        job_id: job.job_id,
        adapter_id: 'test.adapter',
        workspace_id: 'default',
        pid: 4242,
        started_at: new Date().toISOString(),
      });
      // Set the cursor to the checkpointed value, THEN checkpoint.
      await store.setReadCursor(session.session_id, 1234);
      const relay = createRelay(relayOptions(store, fx));
      const ref = await relay.createCheckpoint(job.job_id, 'before restart');
      await store.close();

      // Reopen on the same file — simulate a process restart.
      store = await openStore({ path: dbPath, nodeId: TEST_NODE });
      const relay2 = createRelay(relayOptions(store, fx));

      // Move the cursor AFTER the checkpoint. A restore that only proved SQLite
      // persisted the session row would still see 9999 here; a restore that
      // actually re-establishes cursors from the snapshot must put it back.
      await store.setReadCursor(session.session_id, 9999);
      const afterDrift = await store.listSessions(job.job_id);
      assert.equal(afterDrift[0]?.read_cursor, 9999);

      const restored = await relay2.restoreCheckpoint(ref.checkpoint_id);
      assert.equal(restored.job_id, job.job_id);
      assert.equal(restored.state, WorkItemState.CHECKPOINT);

      // The restored cursor is the CHECKPOINTED value, not the drifted one.
      const sessions = await store.listSessions(job.job_id);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.read_cursor, 1234);
      await store.close();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('4. checkpoint does not copy workspace files', async () => {
    const store = await openStore({ path: ':memory:', nodeId: TEST_NODE });
    const fx = makeFixture('ck4');
    try {
      // Populate the workspace with some files.
      writeFileSync(join(fx.root, 'a.txt'), 'hello');
      mkdirSync(join(fx.root, 'sub'), { recursive: true });
      writeFileSync(join(fx.root, 'sub', 'b.txt'), 'world');
      const before = new Set(listWorkspaceFiles(fx.root));

      const sealed = makeSealed();
      const job = await store.createJob(sealed);
      const relay = createRelay(relayOptions(store, fx));
      await relay.createCheckpoint(job.job_id, 'snapshot');

      const after = new Set(listWorkspaceFiles(fx.root));
      assert.deepEqual(after, before, 'checkpoint must not copy workspace files');
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('5. restore surfaces a chain head that is not a descendant of the recorded one', async () => {
    const dbPath = join(suiteDir, 'ck5.db');
    const fx = makeFixture('ck5');
    try {
      const sealed = makeSealed();
      let store = await openStore({ path: dbPath, nodeId: TEST_NODE });
      const job = await store.createJob(sealed);
      const relay = createRelay(relayOptions(store, fx));
      const ref = await relay.createCheckpoint(job.job_id, 'before divergence');
      // Grow the chain so the recorded head is genuinely in the past.
      await store.appendEvent({
        node_id: TEST_NODE,
        job_id: job.job_id,
        kind: 'job.created',
        payload: { note: 'after checkpoint' },
      });
      await store.close();

      // Corrupt the chain anchor so the current "head" is no longer the
      // recorded head's descendant — the events still link, but the anchor
      // points elsewhere. This is the truncation/fork signature.
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE chain_head SET head_hash = ? WHERE node_id = ?').run(
        '1'.repeat(64),
        TEST_NODE,
      );
      db.close();

      store = await openStore({ path: dbPath, nodeId: TEST_NODE });
      const relay2 = createRelay(relayOptions(store, fx));
      await assertRejectsCode(() => relay2.restoreCheckpoint(ref.checkpoint_id), ErrorCode.E_CHAIN_BROKEN);
      await store.close();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Capsule creation
// ---------------------------------------------------------------------------

describe('Capsule creation', () => {
  async function setup(slug: string, files: Record<string, string | Buffer> = {}, max = 5 * 1024 * 1024) {
    const store = await openStore({ path: ':memory:', nodeId: TEST_NODE });
    const fx = makeFixture(slug);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(fx.root, ...rel.split('/'));
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    const sealed = makeSealed();
    const job = await store.createJob(sealed);
    return { store, fx, job, relay: createRelay(relayOptions(store, fx, max)) };
  }

  function capsuleInput(jobId: string, files: readonly string[], outputs: readonly string[] = []): CreateCapsuleInput {
    return { job_id: jobId, selected_files: files, selected_outputs: outputs };
  }

  it('6. creates a capsule containing exactly the selected files', async () => {
    const { store, fx, job, relay } = await setup('cap6', {
      'a.txt': 'alpha',
      'b.txt': 'beta',
      'c.txt': 'gamma',
    });
    try {
      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['a.txt', 'b.txt']));
      assert.ok(existsSync(ref.path));

      // The tar contains exactly manifest.json and the two selected files.
      const gz = readFileSync(ref.path);
      const tar = gunzipSync(gz);
      const { readTar } = await import('../src/tar.js');
      const entries = readTar(tar);
      const names = entries.map((e) => e.name).sort();
      assert.deepEqual(names, ['a.txt', 'b.txt', 'manifest.json']);

      // Importing verifies the hashes; success means the capsule contains
      // exactly what the manifest declares (import rejects extras/missing).
      const manifest = await relay.importCapsule(ref.path);
      assert.deepEqual(
        manifest.files.map((f) => f.path).sort(),
        ['a.txt', 'b.txt'],
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('7. rejects a glob in selected_files with E_SCHEMA', async () => {
    const { store, fx, job, relay } = await setup('cap7', { 'a.txt': 'x' });
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['*.txt'])),
        ErrorCode.E_SCHEMA,
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('8. rejects an absolute path', async () => {
    const { store, fx, job, relay } = await setup('cap8', { 'a.txt': 'x' });
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['/etc/passwd'])),
        ErrorCode.E_SCHEMA,
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('9. rejects a path containing ..', async () => {
    const { store, fx, job, relay } = await setup('cap9', { 'a.txt': 'x' });
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['../escape.txt'])),
        ErrorCode.E_SCHEMA,
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('10. rejects a directory', async () => {
    const { store, fx, job, relay } = await setup('cap10', {});
    try {
      mkdirSync(join(fx.root, 'sub'), { recursive: true });
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['sub'])),
        ErrorCode.E_SCHEMA,
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('11. refuses the whole capsule on a secret match with E_SECRET_DETECTED', async () => {
    const { store, fx, job, relay } = await setup('cap11', {
      'innocent.txt': 'nothing here',
      'leak.txt': 'password=supersecretvalue1234',
    });
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['innocent.txt', 'leak.txt'])),
        ErrorCode.E_SECRET_DETECTED,
      );
      // No capsule file was written.
      assert.equal(readdirSync(fx.outputDir).length, 0);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('12. refuses on a .env filename even when the contents are innocuous', async () => {
    const { store, fx, job, relay } = await setup('cap12', {
      '.env': 'DATABASE_URL=postgres://localhost/mydb\n',
    });
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['.env'])),
        ErrorCode.E_SECRET_DETECTED,
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('13. detects a private key block in a UTF-16 encoded file', async () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n';
    // UTF-16LE with a BOM. The raw bytes have NULs between every code unit;
    // scanning decoded text (BOM-directed) is what catches it.
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(text, 'utf16le');
    const { store, fx, job, relay } = await setup('cap13', {
      'key.txt': Buffer.concat([bom, body]),
    });
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['key.txt'])),
        ErrorCode.E_SECRET_DETECTED,
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('14. marks a file over 8 MiB as content_scanned false in the manifest', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 0); // innocuous zeros
    const { store, fx, job, relay } = await setup('cap14', { 'big.bin': big }, 20 * 1024 * 1024);
    try {
      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['big.bin']));
      const bigFile = ref.manifest.files.find((f) => f.path === 'big.bin');
      assert.ok(bigFile);
      assert.equal(bigFile!.content_scanned, false);
      assert.equal(bigFile!.bytes, big.length);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('14b. refuses an oversize selection that would have compressed under the limit', async () => {
    // 20 MiB of zeros gzips to a few kilobytes. Under the old code the limit
    // was checked ONLY against the compressed archive, at the very end — so
    // this selection was read whole into memory, tarred, gzipped, and then
    // waved through, because the thing being measured was not the thing being
    // allocated. The cap bounds what the process holds, so it has to be spent
    // on uncompressed bytes before the read.
    const big = Buffer.alloc(20 * 1024 * 1024, 0);
    const { store, fx, job, relay } = await setup('cap14b', { 'big.bin': big }, 1024 * 1024);
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['big.bin'])),
        ErrorCode.E_SCHEMA,
      );
      // Refused means nothing on disk.
      assert.equal(existsSync(fx.outputDir) && readdirSync(fx.outputDir).length > 0, false);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('14c. charges the running total across files, not each file separately', async () => {
    // Three files, none over the cap on its own, together well past it. A
    // per-file check would admit them all.
    const chunk = Buffer.alloc(400 * 1024, 1);
    const { store, fx, job, relay } = await setup(
      'cap14c',
      { 'a.bin': chunk, 'b.bin': chunk, 'c.bin': chunk },
      1024 * 1024,
    );
    try {
      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['a.bin', 'b.bin', 'c.bin'])),
        ErrorCode.E_SCHEMA,
      );
      // Two of them still fit, so the refusal above is the total talking and
      // not a blanket denial.
      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['a.bin', 'b.bin']));
      assert.equal(ref.manifest.files.length, 2);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('15. manifest state is relay and never proposed or accepted', async () => {
    const { store, fx, job, relay } = await setup('cap15', { 'a.txt': 'x' });
    try {
      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['a.txt']));
      assert.equal(ref.manifest.state, 'relay');
      assert.notEqual(ref.manifest.state, 'proposed');
      assert.notEqual(ref.manifest.state, 'accepted');
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('15b. refuses a capsule for a job in any terminal state, and writes nothing', async () => {
    // A capsule manifest declares `state: "relay"` — work handed off and
    // resumable elsewhere. Asserting that of a job that has already reached
    // `proposed`, `accepted`, `blocked` or `cancelled` writes a false claim
    // into the record, and the read it performs is an action on a job that is
    // over. create_checkpoint got this guard; its sibling did not.
    for (const state of [WorkItemState.PROPOSED, WorkItemState.ACCEPTED, WorkItemState.BLOCKED, WorkItemState.CANCELLED]) {
      const { store, fx, job, relay } = await setup(`cap15b-${state}`, { 'a.txt': 'x' });
      try {
        assert.equal(isTerminal(state), true);
        await store.setJobState(job.job_id, state);
        await assertRejectsCode(
          () => relay.createCapsule(capsuleInput(job.job_id, ['a.txt'])),
          ErrorCode.E_JOB_TERMINAL,
        );
        // Refused means nothing on disk, not a capsule written then rejected.
        assert.equal(existsSync(fx.outputDir) && readdirSync(fx.outputDir).length > 0, false);
      } finally {
        await store.close();
        rmSync(fx.root, { recursive: true, force: true });
      }
    }
  });

  it('16. manifest records the envelope digest', async () => {
    const { store, fx, job, relay } = await setup('cap16', { 'a.txt': 'x' });
    try {
      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['a.txt']));
      assert.equal(ref.manifest.envelope_digest, job.envelope_digest);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('16a. selected_outputs files are packed into the tar and verified on import', async () => {
    // An artifact whose file lives in the workspace. `selected_outputs` must
    // pack the bytes into the capsule, not just reference them — otherwise the
    // manifest describes content the capsule does not contain.
    const { store, fx, job, relay } = await setup('cap16a', { 'a.txt': 'alpha' });
    try {
      const artifactPath = join(fx.root, 'out.txt');
      writeFileSync(artifactPath, 'artifact-bytes');
      const artifactId = 'art-1';
      await store.putArtifact({
        artifact_id: artifactId,
        job_id: job.job_id,
        path: artifactPath,
        sha256: createHashSha256('artifact-bytes'),
        bytes: 'artifact-bytes'.length,
        created_at: new Date().toISOString(),
      });

      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['a.txt'], [artifactId]));

      // The artifact's file is in the tar alongside the selected file.
      const tar = gunzipSync(readFileSync(ref.path));
      const { readTar } = await import('../src/tar.js');
      const names = readTar(tar).map((e) => e.name).sort();
      assert.deepEqual(names, ['a.txt', 'manifest.json', 'out.txt']);

      // The manifest records the artifact with its packed hash and content_scanned.
      const art = ref.manifest.artifacts.find((x) => x.artifact_id === artifactId);
      assert.ok(art);
      assert.equal(art!.path, 'out.txt');
      assert.equal(art!.bytes, 'artifact-bytes'.length);
      assert.equal(art!.content_scanned, true);

      // Import re-verifies the artifact bytes against the manifest.
      const manifest = await relay.importCapsule(ref.path);
      assert.equal(manifest.artifacts[0]?.path, 'out.txt');
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('16b. refuses the capsule when a selected_outputs file contains a secret', async () => {
    // Scanning applies to artifact bytes exactly like selected_files: a secret
    // in a packed output refuses the whole capsule, not just the metadata.
    const { store, fx, job, relay } = await setup('cap16b', { 'a.txt': 'alpha' });
    try {
      const artifactPath = join(fx.root, 'leak.txt');
      writeFileSync(artifactPath, 'password=supersecretvalue1234');
      const artifactId = 'art-leak';
      await store.putArtifact({
        artifact_id: artifactId,
        job_id: job.job_id,
        path: artifactPath,
        sha256: createHashSha256('password=supersecretvalue1234'),
        bytes: 'password=supersecretvalue1234'.length,
        created_at: new Date().toISOString(),
      });

      await assertRejectsCode(
        () => relay.createCapsule(capsuleInput(job.job_id, ['a.txt'], [artifactId])),
        ErrorCode.E_SECRET_DETECTED,
      );
      assert.equal(readdirSync(fx.outputDir).length, 0);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe('Import', () => {
  async function setup(slug: string, files: Record<string, string | Buffer> = {}, max = 5 * 1024 * 1024) {
    const store = await openStore({ path: ':memory:', nodeId: TEST_NODE });
    const fx = makeFixture(slug);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(fx.root, ...rel.split('/'));
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    const sealed = makeSealed();
    const job = await store.createJob(sealed);
    return { store, fx, job, relay: createRelay(relayOptions(store, fx, max)) };
  }

  function capsuleInput(jobId: string, files: readonly string[], outputs: readonly string[] = []): CreateCapsuleInput {
    return { job_id: jobId, selected_files: files, selected_outputs: outputs };
  }

  it('17. imports a capsule this node created and returns its manifest', async () => {
    const { store, fx, job, relay } = await setup('imp17', { 'a.txt': 'alpha', 'b.txt': 'beta' });
    try {
      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['a.txt', 'b.txt']));
      const manifest = await relay.importCapsule(ref.path);
      assert.equal(manifest.capsule_id, ref.manifest.capsule_id);
      assert.equal(manifest.job_id, job.job_id);
      assert.equal(manifest.state, 'relay');
      assert.deepEqual(
        manifest.files.map((f) => f.path).sort(),
        ['a.txt', 'b.txt'],
      );
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('18. rejects a capsule whose file hash does not match the manifest', async () => {
    const { store, fx, job, relay } = await setup('imp18', { 'a.txt': 'alpha' });
    try {
      const ref = await relay.createCapsule(capsuleInput(job.job_id, ['a.txt']));
      // Rebuild the tar with tampered content but the original manifest,
      // so the manifest's hash no longer matches the file.
      const { readTar } = await import('../src/tar.js');
      const tar = gunzipSync(readFileSync(ref.path));
      const entries = readTar(tar);
      const manifestEntry = entries.find((e) => e.name === 'manifest.json')!;
      const tampered = buildTar([
        { name: 'manifest.json', content: manifestEntry.content },
        { name: 'a.txt', content: Buffer.from('TAMPERED', 'utf8') },
      ]);
      const tamperedPath = join(fx.outputDir, 'tampered.tar.gz');
      writeFileSync(tamperedPath, gzipSync(tampered));

      await assertRejectsCode(() => relay.importCapsule(tamperedPath), ErrorCode.E_ENVELOPE_INVALID);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('19. rejects a tar entry with an absolute path', async () => {
    const { store, fx } = await setup('imp19');
    try {
      const path = join(fx.outputDir, 'abs.tar.gz');
      writeAbsolutePathCapsule(path, '/etc/passwd');
      await assertRejectsCode(() => createRelay(relayOptions(store, fx)).importCapsule(path), ErrorCode.E_SCHEMA);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('20. rejects a tar entry containing ..', async () => {
    const { store, fx } = await setup('imp20');
    try {
      const path = join(fx.outputDir, 'dotdot.tar.gz');
      writeDotDotCapsule(path, '../escape.txt');
      await assertRejectsCode(() => createRelay(relayOptions(store, fx)).importCapsule(path), ErrorCode.E_SCHEMA);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('21. rejects a tar entry that is a symlink', async () => {
    const { store, fx } = await setup('imp21');
    try {
      const path = join(fx.outputDir, 'symlink.tar.gz');
      writeSymlinkCapsule(path, 'link', '/etc/passwd');
      await assertRejectsCode(() => createRelay(relayOptions(store, fx)).importCapsule(path), ErrorCode.E_SCHEMA);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  // Archive traversal via Windows path forms. Import validation exists because
  // the capsule came from elsewhere, so it must reject every form a hostile
  // archive could use to escape extraction — not just the POSIX ones. One test
  // per form, hand-built byte for byte.
  for (const [form, name] of [
    ['unc', '\\\\server\\share\\file'],
    ['extended-length', '\\\\?\\C:\\windows\\file'],
    ['backslash-parent', '..\\escape.txt'],
    ['drive-absolute', 'C:\\absolute.txt'],
    ['drive-relative', 'C:relative.txt'],
  ] as const) {
    it(`21${form}. rejects a tar entry using a Windows ${form} path`, async () => {
      const { store, fx } = await setup(`imp21${form}`);
      try {
        const path = join(fx.outputDir, `${form}.tar.gz`);
        writeAbsolutePathCapsule(path, name);
        await assertRejectsCode(
          () => createRelay(relayOptions(store, fx)).importCapsule(path),
          ErrorCode.E_SCHEMA,
        );
      } finally {
        await store.close();
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }

  it('22. refuses a capsule exceeding max_capsule_bytes while streaming', async () => {
    const { store, fx } = await setup('imp22', {}, 1024);
    try {
      const path = join(fx.outputDir, 'oversize.tar.gz');
      // Decompresses to 8 KiB, far over the 1 KiB cap.
      writeOversizeCapsule(path, 8 * 1024);
      await assertRejectsCode(() => createRelay(relayOptions(store, fx, 1024)).importCapsule(path), ErrorCode.E_SCHEMA);
    } finally {
      await store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('23. import does not write into a workspace or create a job', async () => {
    // Create a capsule on one store/workspace.
    const src = await setup('imp23-src', { 'a.txt': 'alpha' });
    let capsulePath: string;
    let manifest: CapsuleManifest;
    try {
      const ref = await src.relay.createCapsule(capsuleInput(src.job.job_id, ['a.txt']));
      // Copy the capsule out of the source workspace before it is torn down,
      // so the destination import has a stable file to read.
      capsulePath = join(suiteDir, `imp23-${ref.manifest.capsule_id}.tar.gz`);
      writeFileSync(capsulePath, readFileSync(ref.path));
      manifest = ref.manifest;
    } finally {
      await src.store.close();
      rmSync(src.fx.root, { recursive: true, force: true });
    }

    // Import it on a fresh, empty store and workspace.
    const dstStore = await openStore({ path: ':memory:', nodeId: TEST_NODE });
    const dstFx = makeFixture('imp23-dst');
    try {
      const before = new Set(listWorkspaceFiles(dstFx.root));
      const relay = createRelay(relayOptions(dstStore, dstFx));
      const imported = await relay.importCapsule(capsulePath!);
      assert.equal(imported.capsule_id, manifest.capsule_id);

      const after = new Set(listWorkspaceFiles(dstFx.root));
      assert.deepEqual(after, before, 'import must not extract files into the workspace');

      // No job was created in the destination store.
      const job = await dstStore.getJob(manifest.job_id);
      assert.equal(job, null);
    } finally {
      await dstStore.close();
      rmSync(dstFx.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The standing rule
// ---------------------------------------------------------------------------

describe('The standing rule', () => {
  it('24. no code path in this package invokes git', async () => {
    const here = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src');
    const srcDir = join(here);
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length > 0, 'expected relay source files');
    for (const f of files) {
      const text = readFileSync(join(srcDir, f), 'utf8');
      // The package never spawns a subprocess at all — no `node:child_process`
      // import means no shell, no exec, no git. This is the strongest form of
      // the rule: there is no code path that CAN invoke an external process.
      assert.ok(
        !text.includes('child_process'),
        `${f} must not import or use node:child_process`,
      );
      assert.ok(
        !/\bspawn\s*\(|\bexecSync\s*\(|\bexecFile\s*\(/.test(text),
        `${f} must not spawn a subprocess`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function listWorkspaceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        // Skip the relay output directory — capsules live there, not workspace
        // content, and counting them would make test 4's "no copy" check noisy.
        if (entry === 'out') continue;
        walk(full);
      } else {
        out.push(full.slice(root.length + 1));
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('capsule creation rejects the same path forms import does', () => {
  // createCapsule accepted `C:relative.txt` while importCapsule rejected it, so
  // the relay could produce a capsule it would then refuse to read back. A path
  // form must be judged the same on the way out as on the way in.
  for (const bad of ['C:relative.txt', 'C:\absolute.txt', '\\server\share\f.txt']) {
    it(`rejects the selected file ${JSON.stringify(bad)}`, async () => {
      const fx = makeFixture('create-' + Buffer.from(bad).toString('hex').slice(0, 8));
      const store = await openStore({ path: join(fx.root, 'r.db'), nodeId: TEST_NODE });
      try {
        const job = await store.createJob(makeSealed());
        await assertRejectsCode(
          () => createRelay(relayOptions(store, fx)).createCapsule({
            job_id: job.job_id, selected_files: [bad], selected_outputs: [],
          }),
          ErrorCode.E_SCHEMA,
        );
      } finally {
        await store.close();
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }
});
