import type { ReactNode } from 'react';
import { useState } from 'react';
import { archiveJob, stopBrowserAcquisition, stopStageGraph } from '../api';
import type { CockpitOverview } from '../useCockpitOverview';
import { ApprovalsView } from './ApprovalsView';
import type { WorkMode } from './HomeView';

interface InboxViewProps {
  readonly active: boolean;
  readonly overview: CockpitOverview;
  readonly onOpenJob: (jobId: string) => void;
  readonly onOpenWork: (mode: WorkMode) => void;
  readonly onRefresh?: () => void;
}

export function InboxView({ active, overview, onOpenJob, onOpenWork, onRefresh }: InboxViewProps): ReactNode {
  const [closing, setClosing] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [closeError, setCloseError] = useState<string | null>(null);
  async function close(key: string, action: () => Promise<unknown>): Promise<void> {
    setClosing(key); setCloseError(null);
    try {
      await action();
      setClosed((current) => new Set([...current, key]));
      onRefresh?.();
    } catch (cause: unknown) {
      setCloseError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setClosing(null); }
  }
  const pausedPipelines = overview.pipelines.filter((item) => item.state === 'paused' && !closed.has(item.pipeline_id));
  const pausedCaptures = overview.captures.filter((item) => item.state === 'paused' && !closed.has(item.acquisition_id));
  const checkpointJobs = overview.jobs.filter((item) => item.state === 'checkpoint' && !closed.has(item.job_id));
  const noOperationalAttention = pausedPipelines.length === 0 && pausedCaptures.length === 0 && checkpointJobs.length === 0;

  return (
    <div className="inbox-view page-stack">
      <header className="page-header"><div><span className="eyebrow">Operator decisions</span><h1>Inbox</h1><p>Everything that is paused or waiting for your authority.</p></div></header>
      <ApprovalsView active={active} />
      <section className="attention-section">
        <div className="section-heading"><div><span className="eyebrow">Paused work</span><h2>Questions and checkpoints</h2></div></div>
        {noOperationalAttention && <div className="quiet-empty quiet-empty--success"><strong>All clear</strong><p>No pipeline, capture, or job checkpoint is waiting.</p></div>}
        {closeError !== null && <div className="notice notice--error" role="alert"><strong>Could not close task.</strong> {closeError}</div>}
        <div className="attention-list">
          {checkpointJobs.map((job) => <article className="attention-card" key={job.job_id}><span className="attention-card__kind">Job checkpoint</span><h3>{job.envelope.objective}</h3><p>Review the conversation and receipts before deciding how to continue.</p><div className="attention-card__actions"><button className="btn btn--primary" onClick={() => onOpenJob(job.job_id)} type="button">Open job</button><button className="btn" disabled={closing !== null} onClick={() => { void close(job.job_id, () => archiveJob(job.job_id)); }} type="button">{closing === job.job_id ? 'Closing…' : 'Close task'}</button></div></article>)}
          {pausedPipelines.map((pipeline) => <article className="attention-card" key={pipeline.pipeline_id}><span className="attention-card__kind">Pipeline paused</span><h3>{pipeline.objective}</h3><p>{pipeline.error ?? 'The current stage needs an operator decision.'}</p><div className="attention-card__actions"><button className="btn btn--primary" onClick={() => onOpenWork('pipeline')} type="button">Open pipeline</button><button className="btn" disabled={closing !== null} onClick={() => { void close(pipeline.pipeline_id, () => stopStageGraph(pipeline.pipeline_id)); }} type="button">Close task</button></div></article>)}
          {pausedCaptures.map((capture) => <article className="attention-card" key={capture.acquisition_id}><span className="attention-card__kind">Web capture paused</span><h3>{capture.name}</h3><p>{capture.error ?? 'The browser worker needs attention.'}</p><div className="attention-card__actions"><button className="btn btn--primary" onClick={() => onOpenWork('capture')} type="button">Open web capture</button><button className="btn" disabled={closing !== null} onClick={() => { void close(capture.acquisition_id, () => stopBrowserAcquisition(capture.acquisition_id)); }} type="button">Close task</button></div></article>)}
        </div>
      </section>
    </div>
  );
}
