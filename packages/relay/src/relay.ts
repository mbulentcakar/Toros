/**
 * `@toros/relay` — checkpoints and relay capsules. SPEC I-relay.
 *
 * The rule underneath both: a checkpoint or a relay is not a commit, a review,
 * an acceptance, or a deployment (SPEC §3.4, §2 non-goals). Nothing here touches
 * git, pushes anything, or moves a work item to `accepted`. Checkpoints record
 * state in the store; capsules are explicit, secret-scanned, size-capped tar.gz
 * archives the operator hands to another node.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createGunzip, gzipSync } from 'node:zlib';

import { ErrorCode, TorosError, isTerminal, type JobRecord, type Store, type Workspace } from '@toros/contracts';

import { buildTar, readTar, type TarEntryInput } from './tar.js';
import { scanContent, scanFilename, CONTENT_SCAN_MAX_BYTES } from './scan.js';
import { validateSelectedPath } from './paths.js';
import type { CapsuleArtifact, CapsuleFile, CapsuleManifest, CapsuleRef, CheckpointRef } from './manifest.js';
import { parseManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// Checkpoint snapshot
// ---------------------------------------------------------------------------

/**
 * The serialisable snapshot stored in a `checkpoint.created` event payload.
 * SPEC I-relay §"Checkpoints": a checkpoint records enough to resume — the job
 * record, every session's read cursor, the artifact ids, and the chain head at
 * that moment. Everything lives in the store, so `restoreCheckpoint` works
 * after a process restart with nothing in memory.
 *
 * Declared as a `type` alias (not an `interface`) so it carries the implicit
 * index signature that makes it assignable to `JsonValue` — the same trick
 * `JobEnvelope` uses. The event log canonicalises this payload, so every field
 * must be JSON-round-trippable and contain no `undefined`.
 */
type CheckpointSnapshot = {
  readonly description: string;
  readonly state: 'checkpoint';
  readonly job: {
    readonly job_id: string;
    readonly envelope: JobRecord['envelope'];
    readonly envelope_digest: string;
    readonly state: string;
    readonly created_at: string;
    readonly updated_at: string;
    readonly actions_used: number;
    /** Absent in snapshots written before jobs carried a conversation. */
    readonly conversation_id?: string | null;
  };
  readonly sessions: ReadonlyArray<{ readonly session_id: string; readonly read_cursor: number }>;
  readonly artifacts: ReadonlyArray<{ readonly artifact_id: string }>;
  readonly chain_head: { readonly head_hash: string; readonly row_count: number };
};

/** Reconstruct a `JobRecord`-shaped object from a parsed snapshot. */
function jobFromSnapshot(snap: CheckpointSnapshot): JobRecord {
  return {
    job_id: snap.job.job_id,
    envelope: snap.job.envelope,
    envelope_digest: snap.job.envelope_digest,
    state: snap.job.state as JobRecord['state'],
    created_at: snap.job.created_at,
    updated_at: snap.job.updated_at,
    actions_used: snap.job.actions_used,
    conversation_id: snap.job.conversation_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public options and surface
// ---------------------------------------------------------------------------

export interface RelayOptions {
  readonly store: Store;
  /**
   * Workspace the relay resolves `selected_files` against. The store holds
   * `allowed_workspaces` ids, not roots, so the caller must hand the root in —
   * the spec's `RelayOptions` could not read a workspace-relative path without
   * it. The spec has been amended to include `workspace`.
   */
  readonly workspace: Workspace;
  /** Where capsules are written. Inside the workspace root. */
  readonly output_dir: string;
  /** Bytes. A capsule larger than this is refused. */
  readonly max_capsule_bytes: number;
  /**
   * This node's id. The store does not expose its configured node id, and the
   * manifest requires one, so the caller hands it in. The spec has been
   * amended to include `node_id`.
   */
  readonly node_id: string;
}

export interface CreateCapsuleInput {
  readonly job_id: string;
  readonly selected_files: readonly string[];
  readonly selected_outputs: readonly string[];
}

export interface Relay {
  createCheckpoint(jobId: string, description: string): Promise<CheckpointRef>;
  restoreCheckpoint(checkpointId: string): Promise<JobRecord>;
  createCapsule(input: CreateCapsuleInput): Promise<CapsuleRef>;
  importCapsule(path: string): Promise<CapsuleManifest>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Compute a forward-slash, workspace-relative tar entry name from an absolute
 * artifact path, refusing anything that escapes the root. An artifact record
 * is "absolute path inside the workspace" by contract, so escape here is a
 * containment violation regardless of who wrote the record — and a capsule
 * entry name must be a clean relative path the importer can re-validate.
 */
function toWorkspaceRelative(absPath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, absPath);
  if (rel === '' || rel === '.') {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `artifact path is the workspace root itself: ${absPath}`,
      { path: absPath, root: workspaceRoot },
    );
  }
  // `relative` uses the platform separator; normalise to forward slashes so the
  // tar entry name and the importer's `..`-segment check (split on '/') agree.
  const fwd = rel.split(sep).join('/');
  if (fwd.startsWith('/') || fwd.includes('\\') || fwd.includes('..')) {
    throw new TorosError(
      ErrorCode.E_PATH_ESCAPE,
      `artifact path resolves outside the workspace root: ${absPath}`,
      { path: absPath, relative: fwd, root: workspaceRoot },
    );
  }
  for (const seg of fwd.split('/')) {
    if (seg === '..' || seg === '') {
      throw new TorosError(
        ErrorCode.E_PATH_ESCAPE,
        `artifact path resolves outside the workspace root: ${absPath}`,
        { path: absPath, relative: fwd, root: workspaceRoot },
      );
    }
  }
  return fwd;
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * A checkpoint records enough to resume: the job record, its envelope digest,
 * session cursors, artifact references, and the event chain head at that
 * moment. Everything it needs lives in the store, so `restoreCheckpoint` works
 * after a process restart. It does NOT copy workspace files — that would make
 * checkpointing too expensive to use, and a checkpoint is a state snapshot, not
 * a backup.
 */
async function createCheckpointImpl(
  store: Store,
  nodeId: string,
  jobId: string,
  description: string,
): Promise<CheckpointRef> {
  const job = await store.getJob(jobId);
  if (job === null) {
    throw new TorosError(
      ErrorCode.E_ENVELOPE_INVALID,
      `cannot checkpoint: job ${jobId} not found`,
      { job_id: jobId },
    );
  }
  // Sets the work item's state to `checkpoint` — resumable, not terminal.
  // `setJobState` appends a `job.state_changed` event using the store's
  // configured node id, which is the only way an event gets a real node id
  // without the relay hardcoding it.
  await store.setJobState(jobId, 'checkpoint');

  // Read the node id from the event the store just appended, so the
  // `checkpoint.created` event we append next uses the same node id even if
  // the caller's `node_id` and the store's differ.
  const events = await store.listEvents(jobId);
  const stateChanged = events[events.length - 1];
  if (stateChanged === undefined) {
    throw new TorosError(
      ErrorCode.E_ADAPTER_FAILURE,
      'setJobState did not append a state_changed event',
      { job_id: jobId },
    );
  }
  const eventNodeId = stateChanged.node_id;

  // Snapshot the job, sessions, artifacts, and chain head BEFORE appending
  // the `checkpoint.created` event. The head before the append is what the
  // checkpoint event will link from (`prev_hash`), so it is by construction
  // an ancestor of any later head — and it can be stored in the payload
  // without the chicken-and-egg of needing the event's own hash.
  const jobAtCheckpoint = await store.getJob(jobId);
  if (jobAtCheckpoint === null) {
    throw new TorosError(
      ErrorCode.E_ADAPTER_FAILURE,
      `job ${jobId} vanished after setJobState`,
      { job_id: jobId },
    );
  }
  const sessions = await store.listSessions(jobId);
  const allArtifacts = await store.listArtifacts(jobId);
  const headBefore = await store.getChainHead(eventNodeId);

  const payload: CheckpointSnapshot = {
    description,
    state: 'checkpoint',
    job: {
      job_id: jobAtCheckpoint.job_id,
      envelope: jobAtCheckpoint.envelope,
      envelope_digest: jobAtCheckpoint.envelope_digest,
      state: jobAtCheckpoint.state,
      created_at: jobAtCheckpoint.created_at,
      updated_at: jobAtCheckpoint.updated_at,
      actions_used: jobAtCheckpoint.actions_used,
    },
    sessions: sessions.map((s) => ({ session_id: s.session_id, read_cursor: s.read_cursor })),
    artifacts: allArtifacts.map((a) => ({ artifact_id: a.artifact_id })),
    chain_head: { head_hash: headBefore.head_hash, row_count: headBefore.row_count },
  };

  const checkpointEvent = await store.appendEvent({
    node_id: eventNodeId,
    job_id: jobId,
    kind: 'checkpoint.created',
    payload,
  });

  return {
    checkpoint_id: `${jobId}:${checkpointEvent.seq}`,
    job_id: jobId,
    node_id: eventNodeId,
    chain_head: headBefore.head_hash,
    chain_row_count: headBefore.row_count,
    created_at: checkpointEvent.recorded_at,
  };
}

/**
 * Restore a checkpoint: returns the job record FROM THE SNAPSHOT and
 * re-establishes every session's read cursor from the snapshot. If the current
 * chain head is not a descendant of the recorded one — truncation, a fork, or
 * a replaced anchor — that is surfaced as `E_CHAIN_BROKEN`, not silently
 * swallowed. Restore is a real restore: the cursors go back to what they were
 * at checkpoint time, not whatever the store happens to hold now.
 */
async function restoreCheckpointImpl(
  store: Store,
  checkpointId: string,
): Promise<JobRecord> {
  const sepIdx = checkpointId.lastIndexOf(':');
  if (sepIdx < 0) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `malformed checkpoint_id: ${checkpointId}`,
      { checkpoint_id: checkpointId },
    );
  }
  const jobId = checkpointId.slice(0, sepIdx);
  const seqStr = checkpointId.slice(sepIdx + 1);
  const seq = Number(seqStr);
  if (!Number.isInteger(seq)) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `malformed checkpoint_id seq: ${checkpointId}`,
      { checkpoint_id: checkpointId },
    );
  }

  const events = await store.listEvents(jobId);
  const checkpointEvent = events.find((e) => e.seq === seq && e.kind === 'checkpoint.created');
  if (checkpointEvent === undefined) {
    // The checkpoint event itself is gone — the log was truncated before it.
    throw new TorosError(
      ErrorCode.E_CHAIN_BROKEN,
      `checkpoint event seq ${seq} for job ${jobId} is not present in the log`,
      { job_id: jobId, seq },
    );
  }

  const snapshot = checkpointEvent.payload as unknown as CheckpointSnapshot;
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    snapshot.state !== 'checkpoint' ||
    snapshot.job === undefined ||
    !Array.isArray(snapshot.sessions) ||
    !Array.isArray(snapshot.artifacts) ||
    snapshot.chain_head === undefined ||
    typeof snapshot.chain_head.head_hash !== 'string' ||
    typeof snapshot.chain_head.row_count !== 'number'
  ) {
    throw new TorosError(
      ErrorCode.E_CHAIN_BROKEN,
      `checkpoint event seq ${seq} for job ${jobId} has a malformed snapshot payload`,
      { job_id: jobId, seq },
    );
  }

  const eventNodeId = checkpointEvent.node_id;
  const recorded = snapshot.chain_head;

  // The checkpoint event must link from the recorded head. The payload is
  // hash-chained so it cannot have been tampered with, but this confirms the
  // snapshot belongs to this chain rather than to a row that happens to share
  // the seq — a belt-and-braces check that the recorded head is real.
  if (checkpointEvent.prev_hash !== recorded.head_hash) {
    throw new TorosError(
      ErrorCode.E_CHAIN_BROKEN,
      `checkpoint event prev_hash does not match recorded chain head: recorded ${recorded.head_hash}, prev_hash ${checkpointEvent.prev_hash}`,
      { node_id: eventNodeId, recorded: recorded.head_hash, prev_hash: checkpointEvent.prev_hash },
    );
  }

  const current = await store.getChainHead(eventNodeId);
  const verification = await store.verifyChain(eventNodeId);
  if (!verification.ok) {
    throw new TorosError(
      ErrorCode.E_CHAIN_BROKEN,
      `event chain for node ${eventNodeId} failed verification: ${verification.reason ?? 'anchor mismatch'}`,
      { node_id: eventNodeId, broken_at_seq: verification.broken_at_seq },
    );
  }
  // The current head must be at or past the checkpoint event. An intact chain
  // whose row count is at least the checkpoint's seq has the checkpoint event
  // on it, and therefore the recorded head (its `prev_hash`) as an ancestor.
  if (current.row_count < checkpointEvent.seq) {
    throw new TorosError(
      ErrorCode.E_CHAIN_BROKEN,
      `chain was truncated: recorded head at seq ${checkpointEvent.seq}, current row_count ${current.row_count}`,
      { node_id: eventNodeId, recorded_seq: checkpointEvent.seq, current_row_count: current.row_count },
    );
  }
  if (current.row_count === checkpointEvent.seq && current.head_hash !== checkpointEvent.hash) {
    throw new TorosError(
      ErrorCode.E_CHAIN_BROKEN,
      `chain head diverged at the checkpoint: recorded ${checkpointEvent.hash}, current ${current.head_hash}`,
      { node_id: eventNodeId, recorded: checkpointEvent.hash, current: current.head_hash },
    );
  }

  // Re-establish cursors FROM THE SNAPSHOT. A restore that returned whatever
  // the store currently holds would only prove SQLite persisted; it would not
  // restore anything. Sessions that no longer exist are skipped — a vanished
  // session cannot be brought back, and refusing the whole restore for a
  // cursor that can no longer be set would make restart recovery impossible.
  for (const s of snapshot.sessions) {
    const existing = await store.getSession(s.session_id);
    if (existing !== null) {
      await store.setReadCursor(s.session_id, s.read_cursor);
    }
  }

  return jobFromSnapshot(snapshot);
}

// ---------------------------------------------------------------------------
// Capsule creation
// ---------------------------------------------------------------------------

async function createCapsuleImpl(
  options: RelayOptions,
  input: CreateCapsuleInput,
): Promise<CapsuleRef> {
  const { store, workspace, output_dir, max_capsule_bytes, node_id } = options;

  const job = await store.getJob(input.job_id);
  if (job === null) {
    throw new TorosError(
      ErrorCode.E_ENVELOPE_INVALID,
      `cannot create capsule: job ${input.job_id} not found`,
      { job_id: input.job_id },
    );
  }

  // A capsule declares `state: "relay"` — work handed off and resumable
  // elsewhere. That is a false claim for a job that has already reached a
  // terminal state, and the read-and-write it performs is action on a job that
  // is over. Node Core guards its own tool; this guards the capability, which
  // is callable without it.
  if (isTerminal(job.state)) {
    throw new TorosError(
      ErrorCode.E_JOB_TERMINAL,
      `cannot create capsule: job ${input.job_id} is ${job.state}`,
      { job_id: input.job_id, state: job.state },
    );
  }

  // Charge every byte against the cap BEFORE reading it.
  //
  // The size check used to run once, at the very end, against the COMPRESSED
  // archive — by which point every selected file had already been read whole
  // into memory and concatenated into a tar. One mistaken multi-gigabyte
  // selection was therefore fully allocated before it could be refused, and a
  // highly compressible one could blow any memory budget while still passing a
  // limit expressed in compressed bytes. The cap is a bound on what this
  // process will hold, so it is enforced on uncompressed bytes, per file,
  // before the read that would materialise them.
  let uncompressedBytes = 0;
  const chargeBytes = (label: string, size: number): void => {
    uncompressedBytes += size;
    if (uncompressedBytes > max_capsule_bytes) {
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `capsule contents reach ${uncompressedBytes} uncompressed bytes at "${label}", exceeding max_capsule_bytes ${max_capsule_bytes}`,
        { bytes: uncompressedBytes, limit: max_capsule_bytes, file: label },
      );
    }
  };

  // Validate, resolve, read, and scan every selected file. Refuse the whole
  // capsule on the first secret hit; do not redact and continue.
  const files: CapsuleFile[] = [];
  const tarEntries: TarEntryInput[] = [];
  const seenPaths = new Set<string>();
  for (const rel of input.selected_files) {
    const abs = validateSelectedPath(rel, workspace.root);
    if (seenPaths.has(abs)) {
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `duplicate selected_files entry: ${rel}`,
        { path: rel },
      );
    }
    seenPaths.add(abs);

    const basename = rel.slice(rel.lastIndexOf('/') + 1);
    const fnHit = scanFilename(basename);
    if (fnHit !== null) {
      throw new TorosError(
        ErrorCode.E_SECRET_DETECTED,
        `secret-pattern match on filename "${rel}" (rule ${fnHit.rule_id}); refusing capsule`,
        { file: rel, rule_id: fnHit.rule_id },
      );
    }

    chargeBytes(rel, statSync(abs).size);
    const bytes = readFileSync(abs);
    let contentScanned: boolean;
    if (bytes.length > CONTENT_SCAN_MAX_BYTES) {
      // Over 8 MiB: skip content scanning but keep the filename rules, and
      // record that we did not scan — a manifest silent about an unscanned file
      // would be a claim the capsule cannot support.
      contentScanned = false;
    } else {
      const cHit = scanContent(bytes);
      if (cHit !== null) {
        throw new TorosError(
          ErrorCode.E_SECRET_DETECTED,
          `secret-pattern match in "${rel}" (rule ${cHit.rule_id}); refusing capsule`,
          { file: rel, rule_id: cHit.rule_id },
        );
      }
      contentScanned = true;
    }

    files.push({
      path: rel,
      sha256: sha256(bytes),
      bytes: bytes.length,
      content_scanned: contentScanned,
    });
    tarEntries.push({ name: rel, content: bytes });
  }

  // Artifacts: their files are packed and secret-scanned EXACTLY like
  // selected_files. A capsule that named outputs but did not contain them, or
  // that described content scanning the manifest implied but never performed,
  // would be a capsule the manifest could not support — so the bytes travel
  // with the capsule and the manifest records whether they were scanned.
  const allArtifacts = await store.listArtifacts(input.job_id);
  const byId = new Map(allArtifacts.map((a) => [a.artifact_id, a]));
  const artifacts: CapsuleArtifact[] = [];
  for (const id of input.selected_outputs) {
    const a = byId.get(id);
    if (a === undefined) {
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `selected_outputs artifact ${id} not found for job ${input.job_id}`,
        { artifact_id: id, job_id: input.job_id },
      );
    }
    // The artifact's stored path is absolute and inside the workspace. Compute
    // the workspace-relative tar entry name, refusing anything that escapes —
    // an artifact path that leaves the workspace is a containment violation
    // regardless of who wrote the record.
    const relArtifact = toWorkspaceRelative(a.path, workspace.root);
    if (seenPaths.has(relArtifact)) {
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `selected_outputs entry collides with a selected_files entry: ${relArtifact}`,
        { path: relArtifact, artifact_id: id },
      );
    }
    seenPaths.add(relArtifact);

    const basename = relArtifact.slice(relArtifact.lastIndexOf('/') + 1);
    const fnHit = scanFilename(basename);
    if (fnHit !== null) {
      throw new TorosError(
        ErrorCode.E_SECRET_DETECTED,
        `secret-pattern match on filename "${relArtifact}" (rule ${fnHit.rule_id}); refusing capsule`,
        { file: relArtifact, rule_id: fnHit.rule_id, artifact_id: id },
      );
    }

    chargeBytes(relArtifact, statSync(a.path).size);
    const bytes = readFileSync(a.path);
    let contentScanned: boolean;
    if (bytes.length > CONTENT_SCAN_MAX_BYTES) {
      contentScanned = false;
    } else {
      const cHit = scanContent(bytes);
      if (cHit !== null) {
        throw new TorosError(
          ErrorCode.E_SECRET_DETECTED,
          `secret-pattern match in "${relArtifact}" (rule ${cHit.rule_id}); refusing capsule`,
          { file: relArtifact, rule_id: cHit.rule_id, artifact_id: id },
        );
      }
      contentScanned = true;
    }

    artifacts.push({
      artifact_id: a.artifact_id,
      path: relArtifact,
      sha256: sha256(bytes),
      bytes: bytes.length,
      content_scanned: contentScanned,
    });
    tarEntries.push({ name: relArtifact, content: bytes });
  }

  const capsuleId = randomUUID();
  const createdAt = nowISO();
  const manifest: CapsuleManifest = {
    schema_version: 1,
    capsule_id: capsuleId,
    job_id: input.job_id,
    envelope_digest: job.envelope_digest,
    node_id,
    created_at: createdAt,
    files,
    artifacts,
    state: 'relay',
  };

  // manifest.json first, then the selected files. Order matters on import:
  // the reader needs the manifest before it can verify file hashes.
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const tar = buildTar([
    { name: 'manifest.json', content: manifestBytes },
    ...tarEntries,
  ]);
  const gz = gzipSync(tar);

  // Backstop only. The contents were already bounded above, before they were
  // read; this catches the archive's own overhead — tar headers, padding and
  // the manifest — pushing an otherwise-legal selection over the line.
  if (gz.length > max_capsule_bytes) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `capsule is ${gz.length} bytes, exceeds max_capsule_bytes ${max_capsule_bytes}`,
      { bytes: gz.length, limit: max_capsule_bytes },
    );
  }

  mkdirSync(output_dir, { recursive: true });
  const outPath = join(output_dir, `capsule-${capsuleId}.tar.gz`);
  writeFileSync(outPath, gz);

  return { capsule_id: capsuleId, path: outPath, manifest };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Gunzip with a streaming size cap. The cap is enforced on actual decompressed
 * bytes, never on a size header a hostile archive controls — that is the
 * classic "we wrote the archive" defence, and the whole point of a capsule is
 * that it arrived from elsewhere.
 */
function gunzipCapped(filePath: string, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    const rs = createReadStream(filePath);
    const gz = createGunzip();

    const onAbort = (err: Error) => {
      if (aborted) return;
      aborted = true;
      rs.destroy();
      gz.destroy();
      reject(err);
    };

    gz.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        onAbort(
          new TorosError(
            ErrorCode.E_SCHEMA,
            `capsule uncompressed size exceeds max_capsule_bytes (${maxBytes})`,
            { limit: maxBytes, observed: total },
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    gz.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    gz.on('error', (err) => onAbort(err));
    rs.on('error', (err) => onAbort(err));
    rs.pipe(gz);
  });
}

/**
 * Reject a tar entry whose path is unsafe for extraction. The whole point of
 * import validation is that the capsule arrived from ELSEWHERE, so this defends
 * against every archive-traversal form, not just the POSIX ones — Windows
 * shapes (`\\server\share` UNC, `\\?\C:\...` extended-length, `..\escape`
 * backslash-parent, `C:\absolute`, `C:relative` drive-relative) are all rejected
 * here, because a backslash is a legal filename character on POSIX and would
 * defeat a naive `..` segment check split on `/`.
 */
function assertSafeEntryPath(name: string, typeflag: string, linkname: string): void {
  // No symlinks or hardlinks. The classic archive traversal; "we wrote the
  // archive" is not a defence when the capsule arrived from elsewhere.
  if (typeflag === '1' || typeflag === '2') {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `capsule entry is a link (typeflag ${typeflag}): ${name}`,
      { name, typeflag, linkname },
    );
  }
  // No backslashes anywhere. On POSIX a backslash is a legal filename
  // character, so a `..\escape` or `\\server\share` would slip past a `/`-only
  // `..` check; on Windows they are path separators that name absolute, UNC,
  // or extended-length paths. Rejecting the character outright is the only
  // check that covers all five Windows forms at once.
  if (name.includes('\\')) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `capsule entry uses a backslash separator: ${name}`,
      { name },
    );
  }
  // No absolute paths. POSIX `/` and any Windows drive letter — `C:\absolute`
  // (caught above for its backslash, but `C:/absolute` reaches here) and the
  // drive-relative `C:relative` form, which a `[\\/]`-anchored regex would miss.
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `capsule entry has an absolute path: ${name}`,
      { name },
    );
  }
  // No `..` segments — would escape the extraction root.
  for (const seg of name.split('/')) {
    if (seg === '..') {
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `capsule entry contains '..': ${name}`,
        { name },
      );
    }
  }
}

async function importCapsuleImpl(path: string, maxBytes: number): Promise<CapsuleManifest> {
  // Confirm the file exists; surface a clean error rather than a stream error.
  try {
    statSync(path);
  } catch {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `capsule file not found: ${path}`,
      { path },
    );
  }

  const tarBytes = await gunzipCapped(path, maxBytes);
  const entries = readTar(tarBytes);

  let manifest: CapsuleManifest | undefined;
  const fileByName = new Map<string, Buffer>();

  for (const entry of entries) {
    // Every entry is checked, regardless of order, before any of its content
    // is trusted. manifest.json is the one exception to "no special names":
    // it is parsed and then drives the per-file hash check.
    assertSafeEntryPath(entry.name, entry.typeflag, entry.linkname);

    if (entry.name === 'manifest.json') {
      manifest = parseManifest(entry.content.toString('utf8'));
      continue;
    }
    fileByName.set(entry.name, entry.content);
  }

  if (manifest === undefined) {
    throw new TorosError(
      ErrorCode.E_ENVELOPE_INVALID,
      'capsule is missing manifest.json',
      { path },
    );
  }

  // IMPORT VERIFIES BEFORE IT TRUSTS. Every file's SHA-256 is checked against
  // the manifest — mismatch is E_ENVELOPE_INVALID naming the file. Missing or
  // extra files are also rejected. Artifact entries (selected_outputs) are
  // verified against the same standard: their bytes travel with the capsule
  // and the manifest asserts their hash, so a hostile or corrupted archive
  // cannot slip an unsanctioned artifact through.
  const declared = new Set<string>();
  for (const expected of manifest.files) {
    declared.add(expected.path);
    const content = fileByName.get(expected.path);
    if (content === undefined) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `manifest file not present in capsule: ${expected.path}`,
        { file: expected.path },
      );
    }
    const hash = sha256(content);
    if (hash !== expected.sha256) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `hash mismatch for ${expected.path}: manifest ${expected.sha256}, actual ${hash}`,
        { file: expected.path, expected: expected.sha256, actual: hash },
      );
    }
  }
  for (const expected of manifest.artifacts) {
    declared.add(expected.path);
    const content = fileByName.get(expected.path);
    if (content === undefined) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `manifest artifact not present in capsule: ${expected.path}`,
        { artifact_id: expected.artifact_id, file: expected.path },
      );
    }
    const hash = sha256(content);
    if (hash !== expected.sha256) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `hash mismatch for artifact ${expected.artifact_id} (${expected.path}): manifest ${expected.sha256}, actual ${hash}`,
        { artifact_id: expected.artifact_id, file: expected.path, expected: expected.sha256, actual: hash },
      );
    }
  }
  // Extra files the manifest does not mention are rejected too — a capsule
  // contains only what the manifest declares, whether file or artifact.
  for (const name of fileByName.keys()) {
    if (!declared.has(name)) {
      throw new TorosError(
        ErrorCode.E_ENVELOPE_INVALID,
        `capsule contains a file not declared in the manifest: ${name}`,
        { file: name },
      );
    }
  }

  // Import returns the manifest. It does NOT write into a workspace, create a
  // job, or set any state — the operator decides what to do with a verified
  // capsule.
  return manifest;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRelay(options: RelayOptions): Relay {
  return {
    async createCheckpoint(jobId: string, description: string): Promise<CheckpointRef> {
      return createCheckpointImpl(options.store, options.node_id, jobId, description);
    },
    async restoreCheckpoint(checkpointId: string): Promise<JobRecord> {
      return restoreCheckpointImpl(options.store, checkpointId);
    },
    async createCapsule(input: CreateCapsuleInput): Promise<CapsuleRef> {
      return createCapsuleImpl(options, input);
    },
    async importCapsule(path: string): Promise<CapsuleManifest> {
      return importCapsuleImpl(path, options.max_capsule_bytes);
    },
  };
}
