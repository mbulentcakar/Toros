import type { ReactNode } from 'react';
import type { CockpitOverview } from '../useCockpitOverview';
import { WORK_ITEM_STATE_LABEL } from '../types';
import { ErrorState } from './States';

export type WorkMode = 'assistant' | 'pipeline' | 'capture';

interface HomeViewProps {
  readonly overview: CockpitOverview;
  readonly onOpenJob: (jobId: string) => void;
  readonly onOpenWork: (mode: WorkMode) => void;
  readonly onOpenInbox: () => void;
}

function activeJob(state: string): boolean {
  return ['working', 'checkpoint', 'relay'].includes(state);
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function HomeView({ overview, onOpenJob, onOpenWork, onOpenInbox }: HomeViewProps): ReactNode {
  const pausedPipelines = overview.pipelines.filter((item) => item.state === 'paused').length;
  const pausedCaptures = overview.captures.filter((item) => item.state === 'paused').length;
  const checkpointJobs = overview.jobs.filter((item) => item.state === 'checkpoint').length;
  const attention = overview.approvals.length + pausedPipelines + pausedCaptures + checkpointJobs;
  const active = overview.jobs.filter((item) => activeJob(item.state)).length
    + overview.pipelines.filter((item) => item.state === 'running').length
    + overview.captures.filter((item) => ['running', 'waiting'].includes(item.state)).length;
  const recent = overview.jobs.slice(0, 5);
  const nodeReady = !overview.loading && overview.error === null;

  return (
    <div className="home-view page-stack">
      <header className="page-hero page-hero--home">
        <div>
          <span className="eyebrow">Operator home</span>
          <h1>What needs you right now</h1>
          <p>Start work, intervene when Toros pauses, and review durable evidence from one place.</p>
        </div>
        <div className={`system-health${nodeReady ? ' system-health--ok' : ''}`}>
          <span className="system-health__dot" />
          <div><strong>{overview.loading ? 'Checking Node Core' : nodeReady ? 'Node Core reachable' : 'Node Core needs attention'}</strong><small>{overview.updatedAt === null ? 'Checking local services…' : `Updated ${overview.updatedAt.toLocaleTimeString()}`}</small></div>
        </div>
      </header>
      {overview.error !== null && <ErrorState error={overview.error} />}

      <section className="metric-grid" aria-label="Cockpit summary">
        <button className={`metric-card${attention > 0 ? ' metric-card--attention' : ''}`} onClick={onOpenInbox} type="button">
          <span>Needs attention</span><strong>{attention}</strong><small>{attention === 0 ? 'Nothing is waiting on you' : 'Approvals, pauses, and checkpoints'}</small>
        </button>
        <div className="metric-card"><span>Active work</span><strong>{active}</strong><small>Jobs, pipelines, and captures</small></div>
        <div className="metric-card"><span>Chrome worker</span><strong className="metric-card__status">{overview.worker?.connected ? 'Ready' : 'Not connected'}</strong><small>{overview.worker?.tab?.title ?? 'No allowed tab attached'}</small></div>
      </section>

      <section className="home-section">
        <div className="section-heading"><div><span className="eyebrow">Start something</span><h2>New work</h2></div></div>
        <div className="launch-grid">
          <button className="launch-card" onClick={() => onOpenWork('assistant')} type="button"><span className="launch-card__icon">H</span><strong>Ask Hermes</strong><p>Describe an outcome in your own words. Approve the bounded job only when the proposal is right.</p><span>Start a conversation →</span></button>
          <button className="launch-card" onClick={() => onOpenWork('pipeline')} type="button"><span className="launch-card__icon">4</span><strong>Run a reviewed pipeline</strong><p>Specification, implementation, code review, and security review with separate limits.</p><span>Configure a pipeline →</span></button>
          <button className="launch-card" onClick={() => onOpenWork('capture')} type="button"><span className="launch-card__icon">W</span><strong>Capture web documents</strong><p>Run a paced, checkpointed acquisition through an operator-attached Chrome tab.</p><span>Configure web capture →</span></button>
        </div>
      </section>

      <section className="home-section">
        <div className="section-heading"><div><span className="eyebrow">Durable work</span><h2>Recent jobs</h2></div><span className="section-heading__meta">{overview.jobs.length} total</span></div>
        {recent.length === 0 ? <div className="quiet-empty"><strong>No jobs yet</strong><p>Start with Hermes or a guided pipeline above.</p></div> : (
          <div className="work-list">
            {recent.map((job) => <button className="work-row" key={job.job_id} onClick={() => onOpenJob(job.job_id)} type="button"><span className={`state-dot state-dot--${job.state}`} /><span className="work-row__main"><strong>{job.envelope.objective}</strong><small>{shortDate(job.updated_at)} · {job.actions_used}/{job.envelope.max_actions} actions</small></span><span className={`state-pill state-pill--${job.state}`}>{WORK_ITEM_STATE_LABEL[job.state]}</span><span aria-hidden="true">→</span></button>)}
          </div>
        )}
      </section>
    </div>
  );
}
