export const STAGE_IDS = ['specification', 'implementation', 'code_review', 'security_review'] as const;
export type StageId = typeof STAGE_IDS[number];
export type StageGraphState = 'running' | 'paused' | 'completed' | 'stopped';
export type StageState = 'pending' | 'running' | 'paused' | 'completed' | 'stopped';

export interface StageLimits {
  readonly adapter_id: string;
  readonly max_actions: number;
  readonly max_action_retries: number;
  readonly timeout_minutes: number;
  readonly max_attempts: number;
}

export interface StageArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

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
