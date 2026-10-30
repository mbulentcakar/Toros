/** Node Core client transported through the Tauri shell. */

import type {
  JobRecord,
  SessionRecord,
  Receipt,
  EventRow,
  ChainVerification,
  FindingRecord,
  ArtifactRecord,
  ApprovalRequest,
  CheckpointRecord,
  RelayCapsule,
  CoordinatorRun,
  CreateJobInput,
  OperatorCatalog,
  ConversationRecord,
  ConversationTurn,
  ModelUsageSummary,
  StageGraphRecord,
  CreateStageGraphInput,
  BrowserAcquisitionRecord,
  CreateBrowserAcquisitionInput,
  ChromePairingCode,
  ChromeWorkerStatus,
} from './types';
import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// ApiError
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string, body?: string) {
    const message = body ? `${status} ${statusText}: ${body}` : `${status} ${statusText}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
  }
}

// ---------------------------------------------------------------------------
// Configuration — read at runtime, never at build time
// ---------------------------------------------------------------------------

export interface CockpitStatus {
  readonly approvals_configured: boolean;
}

interface ProxyResponse<T> {
  readonly status: number;
  readonly body: T;
}

let _status: CockpitStatus | null = null;

/**
 * The only configuration fact exposed across IPC is whether the operator
 * credential exists. Rust retains the port and both credentials.
 */
export class ConfigUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Could not read the Node Core configuration from the Tauri config store. The cockpit cannot authenticate without it.');
    this.name = 'ConfigUnavailableError';
    this.cause = cause;
  }
}

export async function resolveConfig(): Promise<CockpitStatus> {
  if (_status) return _status;

  try {
    const status = await invoke<CockpitStatus>('cockpit_status');
    if (typeof status.approvals_configured !== 'boolean') {
      throw new Error('the cockpit status response is invalid');
    }
    _status = status;
    return status;
  } catch (error: unknown) {
    throw new ConfigUnavailableError(error);
  }
}

/** Reset the cached status after the runtime configuration changes. */
export function resetConfig(): void {
  _status = null;
}

/** Start the one fixed Windows scheduled task; no executable or argument crosses IPC. */
export async function startNodeCore(): Promise<void> {
  await invoke<void>('start_node_core');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function statusText(status: number): string {
  return new Map<number, string>([
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [409, 'Conflict'],
    [413, 'Content Too Large'],
    [500, 'Internal Server Error'],
  ]).get(status) ?? 'HTTP Error';
}

function responseBody(body: unknown): string | undefined {
  if (body === null || body === undefined || body === '') return undefined;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

async function request<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
  let response: ProxyResponse<T>;
  try {
    response = await invoke<ProxyResponse<T>>('node_core_request', { operation, body });
  } catch (cause: unknown) {
    throw new ApiError(0, 'Unavailable', cause instanceof Error ? cause.message : String(cause));
  }

  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(response.status, statusText(response.status), responseBody(response.body));
  }

  return response.body;
}

// ---------------------------------------------------------------------------
// API surface — maps each cockpit operation to a real Node Core tool
// ---------------------------------------------------------------------------

/**
 * Bulk jobs are unavailable. Node Core exposes only job_status({ job_id });
 * callers must not turn that single-job tool into a fake list endpoint.
 */
export async function listJobs(): Promise<readonly JobRecord[]> {
  const result = await request<{ readonly jobs: readonly JobRecord[] }>('operator_jobs');
  return result.jobs;
}


export async function listStageGraphs(): Promise<readonly StageGraphRecord[]> {
  const result = await request<{ readonly pipelines: readonly StageGraphRecord[] }>('operator_pipelines');
  return result.pipelines;
}

export async function createStageGraph(input: CreateStageGraphInput): Promise<StageGraphRecord> {
  return request<StageGraphRecord>('operator_pipeline_create', input as unknown as Record<string, unknown>);
}

export async function pauseStageGraph(pipelineId: string): Promise<StageGraphRecord> {
  return request<StageGraphRecord>('operator_pipeline_pause', { pipeline_id: pipelineId });
}

export async function resumeStageGraph(pipelineId: string, operatorMessage?: string): Promise<StageGraphRecord> {
  return request<StageGraphRecord>('operator_pipeline_resume', { pipeline_id: pipelineId, ...(operatorMessage?.trim() ? { operator_message: operatorMessage.trim() } : {}) });
}

export async function stopStageGraph(pipelineId: string): Promise<StageGraphRecord> {
  return request<StageGraphRecord>('operator_pipeline_stop', { pipeline_id: pipelineId });
}
export async function getBrowserStatus(): Promise<ChromeWorkerStatus> {
  const result = await request<{ readonly worker: ChromeWorkerStatus }>('operator_browser_status');
  return result.worker;
}
export async function createChromePairingCode(): Promise<ChromePairingCode> {
  return request<ChromePairingCode>('operator_browser_pairing');
}
export async function listBrowserAcquisitions(): Promise<readonly BrowserAcquisitionRecord[]> {
  const result = await request<{ readonly acquisitions: readonly BrowserAcquisitionRecord[] }>('operator_browser_acquisitions');
  return result.acquisitions;
}
export async function createBrowserAcquisition(input: CreateBrowserAcquisitionInput): Promise<BrowserAcquisitionRecord> {
  return request<BrowserAcquisitionRecord>('operator_browser_acquisition_create', input as unknown as Record<string, unknown>);
}
export async function pauseBrowserAcquisition(acquisitionId: string): Promise<BrowserAcquisitionRecord> {
  return request<BrowserAcquisitionRecord>('operator_browser_acquisition_pause', { acquisition_id: acquisitionId });
}
export async function resumeBrowserAcquisition(acquisitionId: string): Promise<BrowserAcquisitionRecord> {
  return request<BrowserAcquisitionRecord>('operator_browser_acquisition_resume', { acquisition_id: acquisitionId });
}
export async function stopBrowserAcquisition(acquisitionId: string): Promise<BrowserAcquisitionRecord> {
  return request<BrowserAcquisitionRecord>('operator_browser_acquisition_stop', { acquisition_id: acquisitionId });
}
/**
 * Get a single job record by ID.
 *   Tool: job_status({ job_id })
 *   Response: JobRecord
 */
export async function getJob(jobId: string): Promise<JobRecord> {
  return request<JobRecord>('job_status', { job_id: jobId });
}

export async function getOperatorCatalog(): Promise<OperatorCatalog> {
  return request<OperatorCatalog>('operator_catalog');
}

export async function createJob(input: CreateJobInput): Promise<JobRecord> {
  return request<JobRecord>('operator_create_job', input);
}

export async function archiveJob(jobId: string): Promise<JobRecord> {
  return request<JobRecord>('operator_job_archive', { job_id: jobId });
}

export async function getHermesStatus(jobId: string): Promise<CoordinatorRun | null> {
  const result = await request<{ readonly run: CoordinatorRun | null }>('operator_hermes_status', { job_id: jobId });
  return result.run;
}

export async function startHermes(
  jobId: string,
  input: { readonly operator_message?: string; readonly approval_id?: string } = {},
): Promise<CoordinatorRun> {
  const result = await request<{ readonly run: CoordinatorRun }>('operator_hermes_start', {
    job_id: jobId,
    ...input,
  });
  return result.run;
}

export async function stopHermes(jobId: string): Promise<CoordinatorRun | null> {
  const result = await request<{ readonly run: CoordinatorRun | null }>('operator_hermes_stop', { job_id: jobId });
  return result.run;
}

/**
 * The durable conversation for a job. This is the transcript — a coordinator
 * run's in-memory output is not, and does not survive a Node Core restart.
 */
export async function listConversationTurns(jobId: string): Promise<readonly ConversationTurn[]> {
  const result = await request<{ readonly turns: readonly ConversationTurn[] }>('operator_conversation', {
    job_id: jobId,
  });
  return result.turns;
}

// ---------------------------------------------------------------------------
// Conversations — talking to Hermes before any job exists
// ---------------------------------------------------------------------------

export async function listConversations(): Promise<readonly ConversationRecord[]> {
  const result = await request<{ readonly conversations: readonly ConversationRecord[] }>('operator_conversations');
  return result.conversations;
}

export async function createConversation(title: string): Promise<ConversationRecord> {
  return request<ConversationRecord>('operator_conversation_create', { title });
}

export async function listTurns(conversationId: string): Promise<readonly ConversationTurn[]> {
  const result = await request<{ readonly turns: readonly ConversationTurn[] }>('operator_conversation_turns', {
    conversation_id: conversationId,
  });
  return result.turns;
}

/** Say something to Hermes and optionally pin this advisory run to one CLI agent. */
export async function sendMessage(conversationId: string, message: string, agent?: string, model?: string): Promise<void> {
  await request<unknown>('operator_conversation_send', {
    conversation_id: conversationId,
    message,
    ...(agent === undefined || agent === '' ? {} : { agent }),
    ...(model === undefined || model === '' ? {} : { model }),
  });
}

export async function archiveConversation(conversationId: string): Promise<ConversationRecord> {
  return request<ConversationRecord>('operator_conversation_archive', { conversation_id: conversationId });
}

export async function getConversationUsage(conversationId: string): Promise<ModelUsageSummary> {
  const result = await request<{ readonly summary: ModelUsageSummary }>('operator_conversation_usage', { conversation_id: conversationId });
  return result.summary;
}

/** Confirm the proposal the operator saw, named by its turn and digest; no client-authored envelope travels. */
export async function acceptProposal(conversationId: string, seq: number, agreementDigest: string): Promise<JobRecord> {
  return request<JobRecord>('operator_accept_proposal', { conversation_id: conversationId, seq, agreement_digest: agreementDigest });
}

export async function rejectProposal(conversationId: string): Promise<void> {
  await request<unknown>('operator_reject_proposal', { conversation_id: conversationId });
}

export async function createCheckpoint(jobId: string, description: string): Promise<void> {
  await request<unknown>('operator_checkpoint', { job_id: jobId, description });
}

/**
 * List receipts for a job.
 *   Tool: list_activity({ job_id })
 *   Response: { receipts: Receipt[], events: EventRow[] }
 */
export async function listReceipts(jobId: string): Promise<readonly Receipt[]> {
  const result = await request<{ readonly receipts: readonly Receipt[] }>('list_activity', {
    job_id: jobId,
  });
  return result.receipts;
}

/**
 * List sessions for one job. Node Core requires job_id.
 */
export async function listSessions(jobId: string): Promise<readonly SessionRecord[]> {
  const result = await request<{ readonly sessions: readonly SessionRecord[] }>('list_sessions', { job_id: jobId });
  return result.sessions;
}

function operatorConfigError(): ApiError {
  return new ApiError(0, 'Unavailable', 'Approvals are not configured on this node');
}

export async function listPendingApprovals(): Promise<ApprovalRequest[]> {
  const status = await resolveConfig();
  if (!status.approvals_configured) throw operatorConfigError();
  const response = await request<{ readonly pending: ApprovalRequest[] }>('operator_approvals');
  return response.pending;
}

export async function grantApproval(approvalId: string): Promise<void> {
  const status = await resolveConfig();
  if (!status.approvals_configured) throw operatorConfigError();
  await request<unknown>('operator_approve', { approval_id: approvalId });
}

/**
 * Global events are unavailable. Node Core's list_activity requires job_id.
 */
export async function listAllEvents(): Promise<readonly EventRow[]> {
  // Deliberately no request: list_activity is job-scoped.
  return [];
}

/**
 * Chain verification is unavailable. Node Core has no chain-status tool.
 */
export async function verifyChain(nodeId: string): Promise<ChainVerification> {
  throw new ApiError(0, 'Unavailable', `Chain verification is not available from Node Core's Phase 1 surface (${nodeId})`);
}

/**
 * Checkpoint listing is unavailable. Node Core exposes only create_checkpoint.
 */
export async function listCheckpoints(): Promise<readonly CheckpointRecord[]> {
  // create_checkpoint is a mutation, not a list endpoint.
  return [];
}

/**
 * Relay capsule listing is unavailable. Node Core exposes only create_local_relay.
 */
export async function listRelayCapsules(): Promise<readonly RelayCapsule[]> {
  // create_local_relay is a mutation, not a list endpoint.
  return [];
}

/**
 * List findings for one job through the operator-only surface. Findings are
 * intentionally absent from the coordinator's `/tools` surface.
 */
export async function listFindings(jobId: string): Promise<readonly FindingRecord[]> {
  const response = await request<{ readonly findings: readonly FindingRecord[] }>('operator_findings', { job_id: jobId });
  return response.findings;
}

export async function listArtifacts(jobId: string): Promise<readonly ArtifactRecord[]> {
  void jobId;
  return [];
}
