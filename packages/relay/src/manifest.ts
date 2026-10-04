/**
 * Capsule manifest types. SPEC I-relay §"Manifest".
 *
 * `state` is always `relay`. Never `proposed`, never `accepted`: a capsule is
 * material for another node to work on, it asserts nothing about acceptance
 * (SPEC §2, §3.4 — a checkpoint or relay is not a commit/review/acceptance).
 */

export interface CapsuleFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly content_scanned: boolean;
}

export interface CapsuleArtifact {
  readonly artifact_id: string;
  /**
   * Workspace-relative tar entry name. `selected_outputs` files are packed
   * into the capsule exactly like `selected_files` (I-relay §"Capsules"), so
   * this is the name the entry is stored under and the name `importCapsule`
   * verifies against.
   */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /**
   * True when the packed bytes were content-scanned, false when the file was
   * over the scan limit. An artifact the manifest is silent about scanning is
   * a claim the capsule cannot support — same rule as `CapsuleFile`.
   */
  readonly content_scanned: boolean;
}

export interface CapsuleManifest {
  readonly schema_version: 1;
  readonly capsule_id: string;
  readonly job_id: string;
  readonly envelope_digest: string;
  readonly node_id: string;
  readonly created_at: string;
  readonly files: readonly CapsuleFile[];
  readonly artifacts: readonly CapsuleArtifact[];
  readonly state: 'relay';
}

export interface CapsuleRef {
  readonly capsule_id: string;
  /** Absolute path to the written `.tar.gz`. */
  readonly path: string;
  readonly manifest: CapsuleManifest;
}

export interface CheckpointRef {
  /**
   * Opaque id encoding `{job_id}:{seq}` of the `checkpoint.created` event row.
   * The job id is needed to find the row via `Store.listEvents`, which is
   * keyed by job, and the store exposes no node-wide event walk.
   */
  readonly checkpoint_id: string;
  readonly job_id: string;
  readonly node_id: string;
  /** Hash of the chain head recorded at checkpoint time. */
  readonly chain_head: string;
  readonly chain_row_count: number;
  readonly created_at: string;
}

/** Parse and minimally validate a manifest read from a capsule. */
export function parseManifest(text: string): CapsuleManifest {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.schema_version !== 1) {
    throw new Error(`unsupported manifest schema_version: ${String(value.schema_version)}`);
  }
  if (value.state !== 'relay') {
    throw new Error(`manifest state must be 'relay', got ${String(value.state)}`);
  }
  return value as unknown as CapsuleManifest;
}
