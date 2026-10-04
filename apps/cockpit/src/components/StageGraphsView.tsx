import type { FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  createStageGraph,
  getOperatorCatalog,
  listStageGraphs,
  pauseStageGraph,
  resumeStageGraph,
  stopStageGraph,
} from '../api';
import type { CreateStageGraphInput, OperatorCatalog, StageGraphRecord, StageId, StageLimits, StageRunRecord } from '../types';
import { usePoll } from '../hooks';
import { ErrorState, LoadingState } from './States';

interface StageDefinition {
  readonly id: StageId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly output: string;
  readonly defaultAdapter: string;
}

const STAGES: readonly StageDefinition[] = [
  { id: 'specification', label: 'Write the specification', shortLabel: 'Specification', description: 'Turns the objective into a concrete plan and acceptance checks.', output: 'SPEC.md', defaultAdapter: 'codex' },
  { id: 'implementation', label: 'Build the result', shortLabel: 'Implementation', description: 'Creates the working files and explains how to run them.', output: 'IMPLEMENTATION.md + deliverables', defaultAdapter: 'codex' },
  { id: 'code_review', label: 'Review the implementation', shortLabel: 'Code review', description: 'Checks correctness, maintainability, and whether the specification was met.', output: 'CODE_REVIEW.md', defaultAdapter: 'codex' },
  { id: 'security_review', label: 'Challenge the result', shortLabel: 'Security review', description: 'Looks for abuse paths and gives a release recommendation.', output: 'SECURITY_REVIEW.md', defaultAdapter: 'claude' },
];

type PresetId = 'quick' | 'balanced' | 'thorough';
interface PipelinePreset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  readonly deadline: number;
  readonly limits: Readonly<Record<StageId, Omit<StageLimits, 'adapter_id'>>>;
}

const PRESETS: readonly PipelinePreset[] = [
  {
    id: 'quick', label: 'Quick check', description: 'A small, well-defined task where speed matters most.', deadline: 120,
    limits: {
      specification: { max_actions: 6, max_action_retries: 1, timeout_minutes: 20, max_attempts: 2 },
      implementation: { max_actions: 10, max_action_retries: 1, timeout_minutes: 50, max_attempts: 2 },
      code_review: { max_actions: 6, max_action_retries: 1, timeout_minutes: 25, max_attempts: 2 },
      security_review: { max_actions: 6, max_action_retries: 1, timeout_minutes: 25, max_attempts: 2 },
    },
  },
  {
    id: 'balanced', label: 'Balanced', description: 'Good default for normal feature work and unattended runs.', deadline: 240,
    limits: {
      specification: { max_actions: 8, max_action_retries: 1, timeout_minutes: 30, max_attempts: 2 },
      implementation: { max_actions: 12, max_action_retries: 2, timeout_minutes: 90, max_attempts: 2 },
      code_review: { max_actions: 8, max_action_retries: 1, timeout_minutes: 45, max_attempts: 2 },
      security_review: { max_actions: 8, max_action_retries: 1, timeout_minutes: 45, max_attempts: 2 },
    },
  },
  {
    id: 'thorough', label: 'Thorough', description: 'More room for complex work and deeper independent review.', deadline: 480,
    limits: {
      specification: { max_actions: 10, max_action_retries: 2, timeout_minutes: 45, max_attempts: 2 },
      implementation: { max_actions: 20, max_action_retries: 2, timeout_minutes: 150, max_attempts: 3 },
      code_review: { max_actions: 12, max_action_retries: 2, timeout_minutes: 60, max_attempts: 2 },
      security_review: { max_actions: 12, max_action_retries: 2, timeout_minutes: 75, max_attempts: 2 },
    },
  },
];

const STATE_LABEL: Record<StageGraphRecord['state'], string> = {
  running: 'Running', paused: 'Needs attention', completed: 'Completed', stopped: 'Stopped',
};
const STAGE_STATE_LABEL: Record<StageRunRecord['state'], string> = {
  pending: 'Waiting', running: 'In progress', paused: 'Needs attention', completed: 'Done', stopped: 'Stopped',
};

function cliWorkers(catalog: OperatorCatalog | null): readonly string[] {
  if (catalog === null) return [];
  const capabilities = new Set(catalog.capabilities);
  const candidates = new Set(catalog.capabilities.map((id) => id.slice(0, id.lastIndexOf('.'))));
  return [...candidates].filter((id) => ['start', 'send', 'read', 'stop'].every((action) => capabilities.has(`${id}.${action}`))).sort();
}

function initialLimits(): Record<StageId, StageLimits> {
  const balanced = PRESETS.find((preset) => preset.id === 'balanced')!;
  return Object.fromEntries(STAGES.map((stage) => [stage.id, { adapter_id: stage.defaultAdapter, ...balanced.limits[stage.id] }])) as Record<StageId, StageLimits>;
}

function apiError(cause: unknown): ApiError {
  return cause instanceof ApiError ? cause : new ApiError(0, 'Unavailable', cause instanceof Error ? cause.message : String(cause));
}

function stageDefinition(stageId: StageId): StageDefinition {
  return STAGES.find((stage) => stage.id === stageId)!;
}

function currentStageText(graph: StageGraphRecord): string {
  if (graph.state === 'completed') return 'All four stages finished';
  if (graph.state === 'stopped') return 'This pipeline was stopped';
  const stage = graph.stages[graph.current_stage];
  if (stage === undefined) return 'Waiting to start';
  return `${graph.current_stage + 1} of ${graph.stages.length} · ${stageDefinition(stage.stage_id).shortLabel}`;
}

export function StageGraphsView({ active = true }: { readonly active?: boolean } = {}): ReactNode {
  const [catalog, setCatalog] = useState<OperatorCatalog | null>(null);
  const [objective, setObjective] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [presetId, setPresetId] = useState<PresetId>('balanced');
  const [deadline, setDeadline] = useState(240);
  const [limits, setLimits] = useState<Record<StageId, StageLimits>>(initialLimits);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resumeMessages, setResumeMessages] = useState<Record<string, string>>({});
  const fetchGraphs = useCallback(() => listStageGraphs(), []);
  const { data: graphs, loading, error } = usePoll(fetchGraphs, 2_000, active);

  useEffect(() => {
    if (!active) return;
    void getOperatorCatalog().then((value) => {
      setCatalog(value);
      setWorkspace((current) => current || value.workspaces[0] || '');
      const workers = cliWorkers(value);
      setLimits((current) => Object.fromEntries(STAGES.map((stage) => {
        const configured = current[stage.id];
        const adapter = workers.includes(configured.adapter_id) ? configured.adapter_id : workers[0] ?? configured.adapter_id;
        return [stage.id, { ...configured, adapter_id: adapter }];
      })) as Record<StageId, StageLimits>);
    }).catch((cause: unknown) => setActionError(apiError(cause)));
  }, [active]);

  const workers = useMemo(() => cliWorkers(catalog), [catalog]);
  const limitsValid = Number.isFinite(deadline) && deadline >= 1 && deadline <= 1440
    && STAGES.every((stage) => {
      const value = limits[stage.id];
      return Number.isFinite(value.max_actions) && value.max_actions >= 1
        && Number.isFinite(value.max_action_retries) && value.max_action_retries >= 0
        && Number.isFinite(value.timeout_minutes) && value.timeout_minutes >= 1
        && Number.isFinite(value.max_attempts) && value.max_attempts >= 1;
    });

  function selectPreset(id: PresetId): void {
    const preset = PRESETS.find((candidate) => candidate.id === id)!;
    setPresetId(id);
    setDeadline(preset.deadline);
    setLimits((current) => Object.fromEntries(STAGES.map((stage) => [stage.id, {
      adapter_id: current[stage.id].adapter_id,
      ...preset.limits[stage.id],
    }])) as Record<StageId, StageLimits>);
  }

  function update(stageId: StageId, field: keyof StageLimits, value: string): void {
    setLimits((current) => ({
      ...current,
      [stageId]: { ...current[stageId], [field]: field === 'adapter_id' ? value : Number(value) },
    }));
  }

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setActionError(null); setNotice(null);
    const input: CreateStageGraphInput = {
      objective, workspace_id: workspace, deadline_minutes: deadline,
      stages: STAGES.map((stage) => ({ stage_id: stage.id, ...limits[stage.id] })),
    };
    try {
      await createStageGraph(input);
      setObjective('');
      setNotice('Pipeline started. Toros is writing the specification first. You can leave this screen and return later.');
    } catch (cause: unknown) { setActionError(apiError(cause)); }
    finally { setBusy(false); }
  }

  async function act(operation: () => Promise<StageGraphRecord>, success?: string): Promise<void> {
    setBusy(true); setActionError(null); setNotice(null);
    try { await operation(); if (success !== undefined) setNotice(success); }
    catch (cause: unknown) { setActionError(apiError(cause)); }
    finally { setBusy(false); }
  }

  return (
    <div className="stage-graphs">
      <header className="stage-graphs__hero">
        <div><span className="eyebrow">Unattended work</span><h2>Build, review, and challenge a result</h2><p>Describe one outcome. Toros gives each stage its own worker and limits, carries only declared artifacts forward, and pauses when you need to decide.</p></div>
        <div className="stage-graphs__promise"><strong>Safe to leave running</strong><span>Hard deadline · bounded attempts · pause on questions</span></div>
      </header>

      {actionError !== null && <ErrorState error={actionError} />}
      {notice !== null && <div className="stage-graph-notice" role="status"><span aria-hidden="true">✓</span><p>{notice}</p></div>}

      <form className="pipeline-builder" onSubmit={(event) => { void create(event); }}>
        <section className="pipeline-builder__section pipeline-builder__objective">
          <span className="section-number">1</span><div><h3>What should Toros deliver?</h3><p>Give it a bounded outcome, useful constraints, and what “done” means.</p></div>
          <label className="pipeline-objective"><span className="visually-hidden">Pipeline objective</span><textarea required maxLength={6144} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Describe the bounded result this pipeline should produce." /><small>{objective.length.toLocaleString()} / 6,144 characters</small></label>
          <button className="text-button" type="button" onClick={() => setObjective('Build a small TypeScript command-line program that finds all perfect numbers up to a user-provided limit. Include automated tests and clear usage instructions.')}>Use a small test objective</button>
        </section>

        <section className="pipeline-builder__section">
          <span className="section-number">2</span><div><h3>Choose the pace</h3><p>These presets set time and action limits. You can inspect or edit them below.</p></div>
          <div className="pipeline-presets" role="radiogroup" aria-label="Pipeline pace">
            {PRESETS.map((preset) => <button aria-checked={presetId === preset.id} className={`pipeline-preset${presetId === preset.id ? ' pipeline-preset--selected' : ''}`} key={preset.id} onClick={() => selectPreset(preset.id)} role="radio" type="button"><span><strong>{preset.label}</strong>{preset.id === 'balanced' && <em>Recommended</em>}</span><p>{preset.description}</p><small>Up to {preset.deadline / 60} hours</small></button>)}
          </div>
        </section>

        <section className="pipeline-builder__section">
          <span className="section-number">3</span><div><h3>Confirm the team</h3><p>Each worker sees only the artifacts produced by earlier stages.</p></div>
          <ol className="pipeline-team">
            {STAGES.map((stage, index) => <li key={stage.id}><span className="pipeline-team__number">{index + 1}</span><div><strong>{stage.label}</strong><p>{stage.description}</p><small>Produces {stage.output}</small></div><label>Worker<select aria-label={`${stage.shortLabel} worker`} value={limits[stage.id].adapter_id} onChange={(event) => update(stage.id, 'adapter_id', event.target.value)}>{workers.map((id) => <option key={id}>{id}</option>)}</select></label></li>)}
          </ol>
        </section>

        <details className="pipeline-advanced">
          <summary><span>Advanced limits</span><small>Workspace, deadline, actions, retries, and attempts</small></summary>
          <div className="pipeline-advanced__global"><label>Workspace<select required value={workspace} onChange={(event) => setWorkspace(event.target.value)}>{catalog?.workspaces.map((id) => <option key={id}>{id}</option>)}</select></label><label>Total deadline (minutes)<input min={1} max={1440} type="number" value={deadline} onChange={(event) => setDeadline(Number(event.target.value))} /></label></div>
          <div className="pipeline-limits" role="group" aria-label="Per-stage limits">
            {STAGES.map((stage) => { const config = limits[stage.id]; return <fieldset key={stage.id}><legend>{stage.shortLabel}</legend><label>Actions<input aria-label={`${stage.shortLabel} actions`} min={1} max={100} type="number" value={config.max_actions} onChange={(event) => update(stage.id, 'max_actions', event.target.value)} /></label><label>Action retries<input aria-label={`${stage.shortLabel} action retries`} min={0} max={10} type="number" value={config.max_action_retries} onChange={(event) => update(stage.id, 'max_action_retries', event.target.value)} /></label><label>Timeout (minutes)<input aria-label={`${stage.shortLabel} timeout`} min={1} max={720} type="number" value={config.timeout_minutes} onChange={(event) => update(stage.id, 'timeout_minutes', event.target.value)} /></label><label>Stage attempts<input aria-label={`${stage.shortLabel} attempts`} min={1} max={5} type="number" value={config.max_attempts} onChange={(event) => update(stage.id, 'max_attempts', event.target.value)} /></label></fieldset>; })}
          </div>
          <p className="pipeline-boundary"><strong>What these limits mean:</strong> Toros enforces the selected CLI lifecycle, actions, retries, attempts, and wall-clock time. Current CLI adapters do not report enforceable token usage, so there is no pretend token limit.</p>
        </details>

        <footer className="pipeline-builder__footer"><div><strong>{limitsValid ? 'Ready to run four bounded stages' : 'Correct the advanced limits'}</strong><span>{presetId === 'balanced' ? 'Balanced limits' : PRESETS.find((preset) => preset.id === presetId)?.label} · {workspace || 'No workspace available'} · {workers.length} worker{workers.length === 1 ? '' : 's'} installed</span></div><button className="btn btn--primary pipeline-start" disabled={busy || workers.length === 0 || objective.trim().length === 0 || !limitsValid} type="submit">{busy ? 'Starting…' : 'Start 4-stage pipeline'}</button></footer>
      </form>

      <section className="pipeline-activity">
        <header><div><span className="eyebrow">Live status</span><h2>Pipeline activity</h2></div><span className="live-indicator"><i />Updates automatically</span></header>
        {loading && <LoadingState />}
        {error !== null && <ErrorState error={error} />}
        {!loading && error === null && (!graphs || graphs.length === 0) && <div className="pipeline-empty"><span aria-hidden="true">→</span><div><strong>No pipelines yet</strong><p>Configure the first run above. Once started, progress and questions will appear here.</p></div></div>}
        <div className="stage-graph-runs">
          {graphs?.map((graph) => {
            const completed = graph.stages.filter((stage) => stage.state === 'completed').length;
            return <article className={`stage-graph-run stage-graph-run--${graph.state}`} key={graph.pipeline_id}>
              <header className="stage-graph-run__header"><div><span className="stage-graph-run__meta">{currentStageText(graph)}</span><h3>{graph.objective}</h3><p>Workspace {graph.workspace_id} · Deadline {new Date(graph.deadline_at).toLocaleString()}</p></div><span className={`stage-graph-state stage-graph-state--${graph.state}`}>{STATE_LABEL[graph.state]}</span></header>
              <div className="pipeline-progress" aria-label={`${completed} of ${graph.stages.length} stages completed`}><span style={{ width: `${(completed / graph.stages.length) * 100}%` }} /></div>
              {graph.state === 'paused' && <div className="pipeline-attention"><div><strong>Toros needs your attention</strong><p>{graph.error ?? 'Review the current stage before continuing.'}</p></div><label><span>Clarification or instruction</span><input aria-label={`Message for ${graph.pipeline_id}`} placeholder="Tell Toros how to continue (optional)" value={resumeMessages[graph.pipeline_id] ?? ''} onChange={(event) => setResumeMessages((current) => ({ ...current, [graph.pipeline_id]: event.target.value }))} /></label><button className="btn btn--primary" disabled={busy} onClick={() => { void act(() => resumeStageGraph(graph.pipeline_id, resumeMessages[graph.pipeline_id]), 'Pipeline resumed.'); }} type="button">Resume pipeline</button></div>}
              <ol className="stage-timeline">{graph.stages.map((stage, index) => { const definition = stageDefinition(stage.stage_id); return <li className={`stage-run stage-run--${stage.state}`} key={stage.stage_id}><span className="stage-run__marker" aria-hidden="true">{stage.state === 'completed' ? '✓' : index + 1}</span><div className="stage-run__main"><div><strong>{definition.shortLabel}</strong><span>{STAGE_STATE_LABEL[stage.state]}</span></div><p>{definition.description}</p><small>{stage.adapter_id} · attempt {Math.max(stage.attempt, 1)} of {stage.max_attempts}</small>{stage.artifacts.length > 0 && <small className="stage-run__artifact">✓ {stage.artifacts.length} verified artifact{stage.artifacts.length === 1 ? '' : 's'}</small>}{stage.error !== null && stage.state !== 'paused' && <small className="stage-graph-run__error">{stage.error}</small>}<details><summary>Technical details</summary><p>Job {stage.job_id ?? 'not created'}<br />{stage.max_actions} actions · {stage.max_action_retries} retries · {stage.timeout_minutes} minute timeout</p>{stage.artifacts.length > 0 && <ul>{stage.artifacts.map((artifact) => <li key={artifact.path}>{artifact.path}</li>)}</ul>}</details></div></li>; })}</ol>
              {(graph.state === 'running' || graph.state === 'paused') && <footer className="stage-graph-controls">{graph.state === 'running' && <button className="btn" disabled={busy} onClick={() => { void act(() => pauseStageGraph(graph.pipeline_id), 'Pipeline paused.'); }} type="button">Pause after current action</button>}<button className="text-button text-button--danger" disabled={busy} onClick={() => { void act(() => stopStageGraph(graph.pipeline_id), 'Pipeline stopped.'); }} type="button">Stop pipeline</button></footer>}
            </article>;
          })}
        </div>
      </section>
    </div>
  );
}
