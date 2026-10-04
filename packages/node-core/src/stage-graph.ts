import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  ErrorCode,
  TorosError,
  isTerminal,
  type JobRecord,
  type JsonValue,
  type Store,
  type Workspace,
} from '@toros/contracts';
import type { CoordinatorRun } from './coordinator-supervisor.js';

import {
  STAGE_IDS,
  type CreateStageGraphInput,
  type StageArtifact,
  type StageGraphRecord,
  type StageGraphState,
  type StageId,
  type StageLimits,
  type StageState,
} from './stage-graph-types.js';

export { STAGE_IDS } from './stage-graph-types.js';
export type {
  CreateStageGraphInput,
  StageArtifact,
  StageGraphRecord,
  StageGraphState,
  StageId,
  StageLimits,
  StageRunRecord,
  StageState,
} from './stage-graph-types.js';

interface MutableStage extends StageLimits {
  stage_id: StageId;
  state: StageState;
  attempt: number;
  job_id: string | null;
  job_ids: string[];
  started_at: string | null;
  ended_at: string | null;
  artifacts: StageArtifact[];
  error: string | null;
}

interface MutableGraph {
  pipeline_id: string;
  objective: string;
  workspace_id: string;
  state: StageGraphState;
  current_stage: number;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  stages: MutableStage[];
}

interface PersistedGraphs { readonly version: 1; readonly pipelines: readonly MutableGraph[] }

interface StageGraphDeps {
  readonly db_path: string;
  readonly node_id: string;
  readonly workspaces: readonly Workspace[];
  readonly registered_capabilities: () => readonly string[];
  readonly store: () => Store;
  readonly create_job: (args: Readonly<Record<string, JsonValue>>) => Promise<JobRecord>;
  readonly start_job: (job: JobRecord, operatorMessage?: string) => Promise<CoordinatorRun>;
  readonly coordinator_status: (jobId: string) => CoordinatorRun | null;
  readonly coordinator_stop: (jobId: string) => Promise<CoordinatorRun | null>;
}

const MAX_HANDOFF_FILES = 500;
const MAX_HANDOFF_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HANDOFF_TOTAL_BYTES = 20 * 1024 * 1024;
const RECONCILE_MS = 1_000;
const REQUIRED_ARTIFACT: Record<StageId, string> = {
  specification: 'SPEC.md',
  implementation: 'IMPLEMENTATION.md',
  code_review: 'CODE_REVIEW.md',
  security_review: 'SECURITY_REVIEW.md',
};
const FORBIDDEN_HANDOFF_NAMES = /(^|[\\/])(\.env(?:\.|$)|credentials?|secrets?|id_rsa|id_ed25519)([\\/]|$)/i;

function now(): string { return new Date().toISOString(); }
function fail(message: string): never { throw new TorosError(ErrorCode.E_SCHEMA, message); }
function publicGraph(graph: MutableGraph): StageGraphRecord {
  return JSON.parse(JSON.stringify(graph)) as StageGraphRecord;
}
function asPositiveInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) fail(`${name} must be an integer from 1 to ${max}`);
  return value;
}
function asNonNegativeInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) fail(`${name} must be an integer from 0 to ${max}`);
  return value;
}
function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}
function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

async function filesUnder(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (FORBIDDEN_HANDOFF_NAMES.test(rel)) fail(`handoff contains a credential-like filename: ${rel}`);
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isSymbolicLink()) fail(`handoff may not contain symbolic links: ${rel}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        out.push(full);
        if (out.length > MAX_HANDOFF_FILES) fail(`handoff exceeds ${MAX_HANDOFF_FILES} files`);
      }
    }
  }
  await walk(root);
  return out;
}

export class StageGraphController {
  private readonly graphs = new Map<string, MutableGraph>();
  private readonly jobGraph = new Map<string, string>();
  private readonly statePath: string | null;
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: StageGraphDeps) {
    this.statePath = deps.db_path === ':memory:' ? null : `${deps.db_path}.stage-graphs.json`;
  }

  async start(): Promise<void> {
    if (this.statePath !== null) {
      try {
        const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedGraphs;
        if (parsed.version !== 1 || !Array.isArray(parsed.pipelines)) fail('stage graph state has an unsupported format');
        for (const graph of parsed.pipelines) {
          this.graphs.set(graph.pipeline_id, graph);
          for (const stage of graph.stages) for (const jobId of stage.job_ids) this.jobGraph.set(jobId, graph.pipeline_id);
          if (graph.state === 'running') {
            graph.state = 'paused';
            graph.error = 'Node Core restarted. Review the current stage, then resume it.';
            graph.updated_at = now();
            const stage = graph.stages[graph.current_stage];
            if (stage?.state === 'running') stage.state = 'paused';
          }
        }
        await this.save();
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    this.timer = setInterval(() => { void this.reconcile().catch((error: unknown) => console.error('stage graph reconcile failed', error)); }, RECONCILE_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.saving;
  }

  list(): readonly StageGraphRecord[] {
    return [...this.graphs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(publicGraph);
  }

  get(pipelineId: string): StageGraphRecord | null {
    const graph = this.graphs.get(pipelineId);
    return graph === undefined ? null : publicGraph(graph);
  }

  async create(input: CreateStageGraphInput): Promise<StageGraphRecord> {
    const objective = input.objective.trim();
    if (objective.length === 0 || Buffer.byteLength(objective) > 6 * 1024) fail('objective must contain 1 to 6144 bytes');
    const workspace = this.deps.workspaces.find((candidate) => candidate.id === input.workspace_id);
    if (workspace === undefined) fail(`unknown workspace: ${input.workspace_id}`);
    asPositiveInteger(input.deadline_minutes, 'deadline_minutes', 24 * 60);
    if (input.stages.length !== STAGE_IDS.length || input.stages.some((stage, index) => stage.stage_id !== STAGE_IDS[index])) {
      fail(`stages must be exactly: ${STAGE_IDS.join(', ')}`);
    }
    const registered = new Set(this.deps.registered_capabilities());
    const stages: MutableStage[] = input.stages.map((stage) => {
      for (const action of ['start', 'send', 'read', 'stop']) {
        if (!registered.has(`${stage.adapter_id}.${action}`)) fail(`adapter ${stage.adapter_id} is not a registered CLI worker`);
      }
      return {
        stage_id: stage.stage_id,
        adapter_id: stage.adapter_id,
        max_actions: asPositiveInteger(stage.max_actions, `${stage.stage_id}.max_actions`, 100),
        max_action_retries: asNonNegativeInteger(stage.max_action_retries, `${stage.stage_id}.max_action_retries`, 10),
        timeout_minutes: asPositiveInteger(stage.timeout_minutes, `${stage.stage_id}.timeout_minutes`, 12 * 60),
        max_attempts: asPositiveInteger(stage.max_attempts, `${stage.stage_id}.max_attempts`, 5),
        state: 'pending', attempt: 0, job_id: null, job_ids: [], started_at: null, ended_at: null,
        artifacts: [], error: null,
      };
    });
    const createdAt = now();
    const graph: MutableGraph = {
      pipeline_id: randomUUID(), objective, workspace_id: workspace.id, state: 'running', current_stage: 0,
      deadline_at: new Date(Date.now() + input.deadline_minutes * 60_000).toISOString(),
      created_at: createdAt, updated_at: createdAt, error: null, stages,
    };
    this.graphs.set(graph.pipeline_id, graph);
    await this.save();
    await this.deps.store().appendEvent({
      node_id: this.deps.node_id, job_id: null, kind: 'pipeline.created',
      payload: { pipeline_id: graph.pipeline_id, objective: graph.objective, workspace_id: graph.workspace_id },
    });
    await this.activate(graph, 0);
    return publicGraph(graph);
  }

  async pause(pipelineId: string): Promise<StageGraphRecord> {
    const graph = this.requireGraph(pipelineId);
    if (graph.state !== 'running') return publicGraph(graph);
    const stage = graph.stages[graph.current_stage];
    if (stage?.job_id !== null && stage?.job_id !== undefined) await this.deps.coordinator_stop(stage.job_id);
    graph.state = 'paused'; graph.error = 'Paused by operator.'; graph.updated_at = now();
    if (stage?.state === 'running') stage.state = 'paused';
    await this.save();
    return publicGraph(graph);
  }

  async resume(pipelineId: string, operatorMessage?: string): Promise<StageGraphRecord> {
    const graph = this.requireGraph(pipelineId);
    if (graph.state !== 'paused') fail(`pipeline is ${graph.state}, not paused`);
    if (Date.now() >= Date.parse(graph.deadline_at)) fail('pipeline deadline has passed');
    const stage = graph.stages[graph.current_stage];
    if (stage === undefined) fail('pipeline has no current stage');
    const job = stage.job_id === null ? null : await this.deps.store().getJob(stage.job_id);
    if (job !== null && !isTerminal(job.state)) {
      const previousStartedAt = stage.started_at;
      graph.state = 'running'; graph.error = null; graph.updated_at = now(); stage.error = null;
      stage.state = 'running'; stage.started_at = now();
      try {
        await this.save();
        await this.deps.start_job(job, operatorMessage ?? this.stagePrompt(graph, stage));
      } catch (error: unknown) {
        await this.pauseAfterStartFailure(graph, stage, error, previousStartedAt);
        throw error;
      }
    } else {
      if (stage.attempt >= stage.max_attempts) {
        graph.state = 'paused'; graph.error = `${stage.stage_id} exhausted ${stage.max_attempts} attempts`; stage.state = 'paused';
        await this.save();
        fail(graph.error);
      }
      await this.activate(graph, graph.current_stage, operatorMessage);
    }
    return publicGraph(graph);
  }

  async stopPipeline(pipelineId: string): Promise<StageGraphRecord> {
    const graph = this.requireGraph(pipelineId);
    if (graph.state === 'completed' || graph.state === 'stopped') return publicGraph(graph);
    const stage = graph.stages[graph.current_stage];
    if (stage?.job_id !== null && stage?.job_id !== undefined) {
      await this.deps.coordinator_stop(stage.job_id);
      const job = await this.deps.store().getJob(stage.job_id);
      if (job !== null && !isTerminal(job.state)) await this.deps.store().setJobState(job.job_id, 'cancelled');
      stage.state = 'stopped'; stage.ended_at = now();
    }
    graph.state = 'stopped'; graph.error = 'Stopped by operator.'; graph.updated_at = now();
    await this.save();
    return publicGraph(graph);
  }

  async seedSession(jobId: string, sessionId: string, workspace: Workspace): Promise<void> {
    const graph = this.graphForJob(jobId);
    if (graph === null || graph.current_stage === 0) return;
    const destination = join(workspace.root, sessionId, 'input');
    if (!isInside(workspace.root, destination)) fail('pipeline seed escaped its workspace');
    for (let index = 0; index < graph.current_stage; index += 1) {
      const prior = graph.stages[index];
      if (prior === undefined || prior.artifacts.length === 0) continue;
      const source = this.snapshotDir(workspace, graph.pipeline_id, prior.stage_id, prior.attempt);
      await this.copyTree(source, join(destination, prior.stage_id), prior.artifacts);
    }
  }

  async completeJob(jobId: string, summary: string): Promise<JobRecord> {
    const graph = this.graphForJob(jobId);
    if (graph === null) return this.deps.store().setJobState(jobId, 'proposed');
    const stage = graph.stages[graph.current_stage];
    if (stage === undefined || stage.job_id !== jobId) return this.deps.store().setJobState(jobId, 'proposed');
    try {
      stage.artifacts = [...await this.snapshot(graph, stage, summary)];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      stage.state = 'paused'; stage.error = message; stage.ended_at = now();
      graph.state = 'paused'; graph.error = message; graph.updated_at = now();
      await this.save();
      return this.deps.store().setJobState(jobId, 'blocked');
    }
    const result = await this.deps.store().setJobState(jobId, 'proposed');
    stage.state = 'completed'; stage.ended_at = now(); stage.error = null;
    graph.updated_at = now(); graph.error = null;
    if (graph.current_stage === graph.stages.length - 1) {
      graph.state = 'completed';
      await this.save();
    } else {
      graph.current_stage += 1;
      await this.save();
      await this.activate(graph, graph.current_stage);
    }
    return result;
  }

  async blockJob(jobId: string, reason: string): Promise<JobRecord> {
    const result = await this.deps.store().setJobState(jobId, 'blocked');
    const graph = this.graphForJob(jobId);
    if (graph !== null) {
      const stage = graph.stages[graph.current_stage];
      if (stage?.job_id === jobId) {
        stage.state = 'paused'; stage.error = reason; stage.ended_at = now();
        graph.state = 'paused'; graph.error = reason; graph.updated_at = now();
        await this.save();
      }
    }
    return result;
  }

  private requireGraph(id: string): MutableGraph {
    const graph = this.graphs.get(id);
    if (graph === undefined) fail('unknown pipeline');
    return graph;
  }
  private graphForJob(jobId: string): MutableGraph | null {
    const id = this.jobGraph.get(jobId);
    return id === undefined ? null : this.graphs.get(id) ?? null;
  }

  private async activate(graph: MutableGraph, index: number, operatorMessage?: string): Promise<void> {
    const stage = graph.stages[index];
    if (stage === undefined) fail('unknown pipeline stage');
    const capabilities = ['start', 'send', 'read', 'stop'].map((action) => `${stage.adapter_id}.${action}`);
    const job = await this.deps.create_job({
      objective: this.stageObjective(graph, stage),
      allowed_capabilities: capabilities,
      allowed_workspaces: [graph.workspace_id],
      acceptance: this.stageAcceptance(stage),
      forbidden: [],
      max_actions: stage.max_actions,
      max_retries: stage.max_action_retries,
      expires_in_hours: Math.max(1, Math.ceil((Date.parse(graph.deadline_at) - Date.now()) / 3_600_000)),
    });
    stage.attempt += 1; stage.job_id = job.job_id; stage.job_ids.push(job.job_id); stage.state = 'running';
    stage.started_at = now(); stage.ended_at = null; stage.error = null; stage.artifacts = [];
    graph.state = 'running'; graph.error = null; graph.updated_at = now();
    this.jobGraph.set(job.job_id, graph.pipeline_id);
    try {
      await this.save();
      await this.deps.store().appendEvent({
        node_id: this.deps.node_id, job_id: job.job_id, kind: 'pipeline.stage_changed',
        payload: { pipeline_id: graph.pipeline_id, stage_id: stage.stage_id, state: 'running', attempt: stage.attempt },
      });
      await this.deps.start_job(job, operatorMessage ?? this.stagePrompt(graph, stage));
    } catch (error: unknown) {
      await this.pauseAfterStartFailure(graph, stage, error);
      throw error;
    }
  }

  private async pauseAfterStartFailure(graph: MutableGraph, stage: MutableStage, error: unknown, previousStartedAt?: string | null): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    stage.state = 'paused'; stage.error = message;
    if (previousStartedAt !== undefined) stage.started_at = previousStartedAt;
    graph.state = 'paused'; graph.error = message; graph.updated_at = now();
    try {
      await this.save();
    } catch (persistenceError: unknown) {
      const persistenceMessage = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
      throw new Error(`Failed to persist paused stage after coordinator start failure: ${persistenceMessage}. Original start failure: ${message}`, { cause: persistenceError });
    }
  }

  private stageObjective(graph: MutableGraph, stage: MutableStage): string {
    return `[Pipeline ${graph.pipeline_id}; ${stage.stage_id}; attempt ${stage.attempt + 1}] ${graph.objective}`;
  }
  private stageAcceptance(stage: MutableStage): readonly string[] {
    if (stage.stage_id === 'specification') return ['A concrete implementation specification is written to handoff/SPEC.md.', 'The specification states scope, acceptance checks, and risks.'];
    if (stage.stage_id === 'implementation') return ['Working implementation files are written under handoff/.', 'handoff/IMPLEMENTATION.md explains how to run and test the result.'];
    if (stage.stage_id === 'code_review') return ['Return a decisive code review with prioritized findings and a pass/fail recommendation.'];
    return ['Return an adversarial security review with threat assumptions, prioritized findings, and a release recommendation.'];
  }
  private stagePrompt(graph: MutableGraph, stage: MutableStage): string {
    const prior = graph.current_stage === 0 ? 'There are no prior artifacts.' : 'Read prior versioned artifacts under input/<stage>/.';
    const output = stage.stage_id === 'specification' || stage.stage_id === 'implementation'
      ? `Write every deliverable under handoff/. The required manifest is handoff/${REQUIRED_ARTIFACT[stage.stage_id]}. Do not write outside handoff/.`
      : `You are read-only. Put the complete review in your final response; Node Core will version it as ${REQUIRED_ARTIFACT[stage.stage_id]}.`;
    return `Execute only the ${stage.stage_id} stage for this objective:\n\n${graph.objective}\n\n${prior}\n${output}\nDo not start another model or perform another stage. Report completion only when the stage acceptance criteria are met.`;
  }

  private snapshotDir(workspace: Workspace, pipelineId: string, stageId: StageId, version: number): string {
    return join(workspace.root, '.toros-stage-graphs', pipelineId, stageId, `v${version}`);
  }
  private async snapshot(graph: MutableGraph, stage: MutableStage, summary: string): Promise<readonly StageArtifact[]> {
    const workspace = this.deps.workspaces.find((candidate) => candidate.id === graph.workspace_id);
    if (workspace === undefined) fail('pipeline workspace no longer exists');
    const destination = this.snapshotDir(workspace, graph.pipeline_id, stage.stage_id, stage.attempt);
    if (!isInside(workspace.root, destination)) fail('pipeline snapshot escaped its workspace');
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    if (stage.stage_id === 'code_review' || stage.stage_id === 'security_review') {
      if (summary.trim().length === 0) fail(`${stage.stage_id} returned no review`);
      await writeFile(join(destination, REQUIRED_ARTIFACT[stage.stage_id]), `${summary.trim()}\n`, 'utf8');
    } else {
      const sessions = await this.deps.store().listSessions(stage.job_id ?? '');
      const session = [...sessions].reverse().find((candidate) => candidate.adapter_id === stage.adapter_id);
      if (session === undefined) fail(`${stage.stage_id} created no ${stage.adapter_id} session`);
      const source = join(workspace.root, session.session_id, 'handoff');
      if (!isInside(workspace.root, source)) fail('handoff escaped its workspace');
      try { await stat(join(source, REQUIRED_ARTIFACT[stage.stage_id])); }
      catch { fail(`${stage.stage_id} did not produce handoff/${REQUIRED_ARTIFACT[stage.stage_id]}`); }
      await this.copyTree(source, destination);
    }
    const files = await filesUnder(destination);
    let total = 0;
    const artifacts: StageArtifact[] = [];
    for (const file of files) {
      const info = await lstat(file);
      if (!info.isFile()) continue;
      if (info.size > MAX_HANDOFF_FILE_BYTES) fail(`handoff file exceeds ${MAX_HANDOFF_FILE_BYTES} bytes: ${basename(file)}`);
      total += info.size;
      if (total > MAX_HANDOFF_TOTAL_BYTES) fail(`handoff exceeds ${MAX_HANDOFF_TOTAL_BYTES} bytes`);
      const data = await readFile(file);
      artifacts.push({ path: relative(destination, file).replaceAll('\\', '/'), sha256: hash(data), bytes: data.byteLength });
    }
    if (artifacts.length === 0) fail(`${stage.stage_id} produced an empty handoff`);
    return artifacts;
  }

  private async copyTree(source: string, destination: string, expected?: readonly StageArtifact[]): Promise<void> {
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) fail('handoff source must be a real directory');
    await mkdir(destination, { recursive: true });
    const files = await filesUnder(source);
    const expectedByPath = expected === undefined ? null : new Map(expected.map((item) => [item.path, item]));
    let total = 0;
    for (const file of files) {
      const info = await lstat(file);
      if (info.size > MAX_HANDOFF_FILE_BYTES) fail(`handoff file exceeds ${MAX_HANDOFF_FILE_BYTES} bytes: ${basename(file)}`);
      total += info.size;
      if (total > MAX_HANDOFF_TOTAL_BYTES) fail(`handoff exceeds ${MAX_HANDOFF_TOTAL_BYTES} bytes`);
      const rel = relative(source, file).replaceAll('\\', '/');
      const data = await readFile(file);
      const declared = expectedByPath?.get(rel);
      if (expectedByPath !== null && (declared === undefined || declared.bytes !== data.byteLength || declared.sha256 !== hash(data))) {
        fail(`versioned handoff integrity check failed: ${rel}`);
      }
      const target = join(destination, relative(source, file));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      expectedByPath?.delete(rel);
    }
    if (expectedByPath !== null && expectedByPath.size > 0) {
      fail(`versioned handoff is missing ${expectedByPath.keys().next().value ?? 'an artifact'}`);
    }
  }

  private async reconcile(): Promise<void> {
    for (const graph of this.graphs.values()) {
      if (graph.state !== 'running') continue;
      const stage = graph.stages[graph.current_stage];
      if (stage === undefined || stage.job_id === null) continue;
      const deadline = Math.min(Date.parse(graph.deadline_at), Date.parse(stage.started_at ?? now()) + stage.timeout_minutes * 60_000);
      if (Date.now() >= deadline) {
        await this.deps.coordinator_stop(stage.job_id);
        const job = await this.deps.store().getJob(stage.job_id);
        if (job !== null && !isTerminal(job.state)) await this.deps.store().setJobState(job.job_id, 'cancelled');
        stage.state = 'paused'; stage.ended_at = now(); stage.error = 'Stage timeout reached.';
        graph.state = 'paused'; graph.error = stage.error; graph.updated_at = now(); await this.save();
        continue;
      }
      const run = this.deps.coordinator_status(stage.job_id);
      if (run !== null && ['waiting_for_input', 'waiting_for_approval', 'failed', 'stopped'].includes(run.state)) {
        stage.state = 'paused'; stage.error = run.state.replaceAll('_', ' ');
        graph.state = 'paused'; graph.error = `${stage.stage_id}: ${stage.error}`; graph.updated_at = now(); await this.save();
      }
    }
  }

  private async save(): Promise<void> {
    if (this.statePath === null) return;
    const path = this.statePath;
    const data = JSON.stringify({ version: 1, pipelines: [...this.graphs.values()] } satisfies PersistedGraphs, null, 2);
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, 'utf8');
      await rename(temporary, path);
    });
    await this.saving;
  }
}
