/**
 * Types mirrored from @toros/contracts.
 *
 * The cockpit builds through Vite rather than the TypeScript project graph,
 * so these types are copied here rather than imported across the boundary.
 * See 00-CONTRACTS.md §2 and J-cockpit.md §Allowed paths.
 *
 * Source: packages/contracts/src/canonical.ts
 * Source: packages/contracts/src/envelope.ts
 * Source: packages/contracts/src/receipt.ts
 * Source: packages/contracts/src/errors.ts
 * Source: packages/contracts/src/capability.ts
 * Source: packages/contracts/src/ports.ts
 *
 * TYPES ONLY — never logic, never canonicalize, never chainHash.
 *
 * Additional types (ApprovalRequest, CheckpointRecord, RelayCapsule) are
 * defined locally for the HTTP response surface of Node Core, which is not
 * part of the frozen contracts.
 */

// ---------------------------------------------------------------------------
// From canonical.ts
// ---------------------------------------------------------------------------
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// From envelope.ts
// ---------------------------------------------------------------------------
export type JobEnvelope = {
  readonly job_id: string;
  readonly objective: string;
  readonly allowed_capabilities: readonly string[];
  readonly allowed_workspaces: readonly string[];
  readonly acceptance: readonly string[];
  readonly forbidden: readonly string[];
  readonly max_actions: number;
  readonly max_retries: number;
  readonly expires_at: string;
};

export interface SealedEnvelope {
  readonly envelope: JobEnvelope;
  readonly envelope_digest: string;
}

export type WorkItemState =
  | 'working'
  | 'checkpoint'
  | 'relay'
  | 'proposed'
  | 'accepted'
  | 'blocked'
  | 'cancelled';

// ---------------------------------------------------------------------------
// From receipt.ts
// ---------------------------------------------------------------------------
export type PolicyDecision =
  | { readonly allow: true; readonly reason: string }
  | { readonly allow: false; readonly code: string; readonly reason: string };

export interface Receipt {
  readonly receipt_id: string;
  readonly job_id: string;
  readonly node_id: string;
  readonly session_id: string | null;
  readonly actor: string;
  readonly capability: string;
  readonly arguments_normalized: JsonValue | null;
  readonly arguments_digest: string | null;
  readonly decision: PolicyDecision;
  readonly envelope_digest: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: ActionOutcome;
  readonly artifact_refs: readonly string[];
  readonly finding_refs: readonly string[];
  readonly adapter_fields: Readonly<Record<string, JsonValue>>;
}

export type ActionOutcome =
  | 'succeeded'
  | 'denied'
  | 'failed'
  | 'terminated'
  | 'running';

export interface EventRow {
  readonly seq: number;
  readonly node_id: string;
  readonly job_id: string | null;
  readonly kind: EventKind;
  readonly recorded_at: string;
  readonly payload: JsonValue;
  readonly prev_hash: string;
  readonly hash: string;
}

export type EventKind =
  | 'job.created'
  | 'job.state_changed'
  | 'action.requested'
  | 'action.decided'
  | 'action.started'
  | 'action.finished'
  | 'session.started'
  | 'session.stopped'
  | 'checkpoint.created'
  | 'relay.created'
  | 'relay.imported'
  | 'approval.requested'
  | 'approval.resolved'
  | 'finding.observed'
  | 'pipeline.created'
  | 'pipeline.stage_changed'
  | 'pipeline.state_changed';

export interface ChainHead {
  readonly node_id: string;
  readonly head_hash: string;
  readonly row_count: number;
  readonly updated_at: string;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly rows_checked: number;
  readonly broken_at_seq: number | null;
  readonly anchor_matches: boolean;
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// From ports.ts
// ---------------------------------------------------------------------------
export interface JobRecord {
  readonly job_id: string;
  readonly envelope: JobEnvelope;
  readonly envelope_digest: string;
  readonly state: WorkItemState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly actions_used: number;
}

export interface SessionRecord {
  readonly session_id: string;
  readonly job_id: string;
  readonly adapter_id: string;
  readonly workspace_id: string;
  readonly pid: number | null;
  readonly started_at: string;
  readonly stopped_at: string | null;
  readonly read_cursor: number;
}

export interface ArtifactRecord {
  readonly artifact_id: string;
  readonly job_id: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly created_at: string;
}

export type CorrelationConfidence =
  | 'exact'
  | 'cited'
  | 'session'
  | 'none';

export interface FindingRecord {
  readonly finding_id: string;
  readonly receipt_id: string | null;
  readonly job_id: string | null;
  readonly session_id: string | null;
  readonly correlation: CorrelationConfidence;
  readonly rule_id: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly title: string;
  readonly observed_at: string;
  readonly detail: JsonValue;
}

// ---------------------------------------------------------------------------
// Local types for Node Core HTTP surface (not in contracts)
// ---------------------------------------------------------------------------

/** A pending approval request from Node Core's operator HTTP surface. */
export interface ApprovalRequest {
  readonly approval_id: string;
  readonly binding: {
    readonly job_id: string;
    readonly capability: string;
    readonly arguments_digest: string;
  };
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly approved: boolean;
}

/** A checkpoint from Node Core's HTTP surface. */
export interface CheckpointRecord {
  readonly checkpoint_id: string;
  readonly job_id: string;
  readonly description: string;
  readonly created_at: string;
  readonly artifact_ids: readonly string[];
}

/** A relay capsule from Node Core's HTTP surface. */
export interface RelayCapsule {
  readonly capsule_id: string;
  readonly job_id: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly manifest: RelayManifest;
}

export interface RelayManifest {
  readonly files: readonly RelayFile[];
  readonly outputs: readonly RelayOutput[];
}

export interface RelayFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RelayOutput {
  readonly name: string;
  readonly kind: string;
}

export interface OperatorCatalog {
  readonly capabilities: readonly string[];
  readonly workspaces: readonly string[];
  readonly agents: readonly string[];
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string; readonly provider: string }>;
}

export type CoordinatorRunState =
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'finished'
  | 'failed'
  | 'stopped';

export interface CoordinatorMessage {
  readonly seq: number;
  readonly role: 'hermes' | 'system';
  readonly text: string;
  readonly recorded_at: string;
}

export interface CoordinatorRun {
  readonly run_id: string;
  readonly job_id: string;
  readonly state: CoordinatorRunState;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly exit_code: number | null;
  readonly messages: readonly CoordinatorMessage[];
}

export type CreateJobInput = Omit<JobEnvelope, 'job_id' | 'expires_at'> & { readonly expires_in_hours: number };

export type ConversationTurnRole = 'operator' | 'hermes' | 'system' | 'tool';

/**
 * `human` is prose a person reads. `machine` is act/done traffic and is never
 * rendered as prose — the cockpit summarises it instead.
 */
export type ConversationTurnChannel = 'human' | 'machine';

export interface ConversationTurn {
  readonly conversation_id: string;
  readonly seq: number;
  readonly role: ConversationTurnRole;
  readonly channel: ConversationTurnChannel;
  readonly content: string;
  readonly job_id: string | null;
  readonly recorded_at: string;
}

// ---------------------------------------------------------------------------
// Derivation for the cockpit
// ---------------------------------------------------------------------------

/** A human-readable label for the job state. */
export const WORK_ITEM_STATE_LABEL: Record<WorkItemState, string> = {
  working: 'Working',
  checkpoint: 'Checkpoint',
  relay: 'Relay',
  proposed: 'Proposed',
  accepted: 'Accepted',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

export interface ConversationRecord {
  readonly conversation_id: string;
  readonly node_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly state: 'open' | 'archived';
  readonly agent: string | null;
  readonly model: string | null;
}

export interface ModelUsageSummary {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number | null;
}

/** A draft envelope Hermes wants confirmed. Not a job until the operator says so. */
export interface JobProposal {
  readonly objective: string;
  readonly plan: readonly string[];
  readonly acceptance: readonly string[];
  readonly capabilities: ReadonlyArray<{ readonly id: string; readonly why: string }>;
  readonly workspaces: readonly string[];
  readonly forbidden: readonly string[];
  readonly max_actions: number;
  readonly max_retries: number;
  readonly expires_in_hours: number;
  readonly intent?: string;
  readonly target?: string;
  readonly changes?: string;
}

export type StageId = 'specification' | 'implementation' | 'code_review' | 'security_review';
export type StageGraphState = 'running' | 'paused' | 'completed' | 'stopped';
export type StageState = 'pending' | 'running' | 'paused' | 'completed' | 'stopped';

export interface StageLimits {
  readonly adapter_id: string;
  readonly max_actions: number;
  readonly max_action_retries: number;
  readonly timeout_minutes: number;
  readonly max_attempts: number;
}

export interface StageArtifact { readonly path: string; readonly sha256: string; readonly bytes: number }
export interface StageRunRecord extends StageLimits {
  readonly stage_id: StageId;
  readonly state: StageState;
  readonly attempt: number;
  readonly job_id: string | null;
  readonly job_ids: readonly string[];
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly artifacts: readonly StageArtifact[];
  readonly error: string | null;
}
export interface StageGraphRecord {
  readonly pipeline_id: string;
  readonly objective: string;
  readonly workspace_id: string;
  readonly state: StageGraphState;
  readonly current_stage: number;
  readonly deadline_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly error: string | null;
  readonly stages: readonly StageRunRecord[];
}
export interface CreateStageGraphInput {
  readonly objective: string;
  readonly workspace_id: string;
  readonly deadline_minutes: number;
  readonly stages: readonly ({ readonly stage_id: StageId } & StageLimits)[];
}
export interface ChromeWorkerTab { readonly id: number; readonly url: string; readonly title: string }
export interface ChromeWorkerStatus {
  readonly paired: boolean; readonly connected: boolean; readonly extension_id: string | null;
  readonly extension_version: string | null; readonly paired_at: string | null; readonly last_seen_at: string | null;
  readonly tab: ChromeWorkerTab | null; readonly allowed_domains: readonly string[]; readonly extension_dir: string | null;
  readonly queued_commands: number; readonly active_command: string | null;
}
export interface ChromePairingCode { readonly code: string; readonly expires_at: string }
export interface BrowserFieldRule { readonly name: string; readonly selector: string; readonly attribute?: string }
export interface BrowserDocumentRule { readonly kind: string; readonly text_contains: readonly string[]; readonly url_contains: readonly string[]; readonly required: boolean; readonly max_files: number }
export interface BrowserAcquisitionSource { readonly item_id: string; readonly url: string }
export type BrowserAcquisitionState = 'running' | 'waiting' | 'paused' | 'completed' | 'stopped';
export interface BrowserAcquisitionDocument { readonly kind: string; readonly url: string | null; readonly text: string; readonly state: 'pending' | 'completed' | 'failed' | 'not_found'; readonly outcome: string; readonly http_status: number | null; readonly content_type: string | null; readonly path: string | null; readonly sha256: string | null; readonly bytes: number | null; readonly duplicate_of: string | null; readonly error: string | null }
export interface BrowserAcquisitionItem { readonly item_id: string; readonly manifest_index: number; readonly url: string; readonly final_url: string | null; readonly page_outcome: string; readonly page_http_status: number | null; readonly product_title: string | null; readonly retry_after_seconds: number | null; readonly error_code: string | null; readonly state: 'pending' | 'running' | 'completed' | 'paused'; readonly attempts: number; readonly fields: Readonly<Record<string, string | null>>; readonly documents: readonly BrowserAcquisitionDocument[]; readonly started_at: string | null; readonly ended_at: string | null; readonly error: string | null }
export interface BrowserAcquisitionRecord {
  readonly acquisition_id: string; readonly name: string; readonly workspace_id: string; readonly site_profile: 'generic'; readonly job_id: string;
  readonly state: BrowserAcquisitionState; readonly current_item: number; readonly created_at: string; readonly updated_at: string;
  readonly next_run_at: string | null; readonly error: string | null; readonly manifest_path: string;
  readonly fields: readonly BrowserFieldRule[]; readonly document_rules: readonly BrowserDocumentRule[];
  readonly min_delay_seconds: number; readonly max_delay_seconds: number; readonly max_attempts: number;
  readonly max_backoff_minutes: number; readonly max_consecutive_rate_limits: number; readonly consecutive_rate_limits: number; readonly max_document_bytes: number; readonly items: readonly BrowserAcquisitionItem[];
}
export interface CreateBrowserAcquisitionInput {
  readonly name: string; readonly workspace_id: string; readonly site_profile: 'generic'; readonly sources: readonly BrowserAcquisitionSource[];
  readonly fields: readonly BrowserFieldRule[]; readonly documents: readonly BrowserDocumentRule[];
  readonly min_delay_seconds: number; readonly max_delay_seconds: number; readonly max_attempts: number;
  readonly max_backoff_minutes: number; readonly max_consecutive_rate_limits: number; readonly max_document_bytes: number;
}
