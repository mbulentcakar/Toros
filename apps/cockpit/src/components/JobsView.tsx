import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { listJobs } from '../api';
import { usePoll } from '../hooks';
import { WORK_ITEM_STATE_LABEL } from '../types';
import { EmptyState, ErrorState, LoadingState } from './States';

interface JobsViewProps {
  readonly active?: boolean;
  readonly onSelectJob?: (jobId: string) => void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function JobsView({ active = true, onSelectJob }: JobsViewProps): ReactNode {
  const [query, setQuery] = useState('');
  const fetchJobs = useCallback(() => listJobs(), []);
  const { data: jobs, loading, error } = usePoll(fetchJobs, 5_000, active);
  const filtered = useMemo(() => (jobs ?? []).filter((job) => `${job.envelope.objective} ${job.job_id} ${job.state}`.toLowerCase().includes(query.trim().toLowerCase())), [jobs, query]);

  return (
    <div className="audit-view page-stack">
      <header className="page-header"><div><span className="eyebrow">Durable evidence</span><h1>Audit</h1><p>Open a work item to review its conversation, receipts, sessions, and security findings together.</p></div><label className="search-field"><span className="visually-hidden">Search jobs</span><input aria-label="Search jobs" onChange={(event) => setQuery(event.target.value)} placeholder="Search objective or job ID" value={query} /></label></header>
      {loading && <LoadingState />}
      {error !== null && <ErrorState error={error} />}
      {!loading && error === null && (!jobs || jobs.length === 0) && <EmptyState message="There are no local jobs." />}
      {!loading && error === null && jobs && jobs.length > 0 && filtered.length === 0 && <EmptyState message="No jobs match this search." />}
      {filtered.length > 0 && <div className="audit-list">{filtered.map((job) => <button className="audit-row" key={job.job_id} onClick={() => onSelectJob?.(job.job_id)} type="button"><span className={`state-dot state-dot--${job.state}`} /><span className="audit-row__objective"><strong>{job.envelope.objective}</strong><small><code>{job.job_id}</code> · updated {formatDate(job.updated_at)}</small></span><span className="audit-row__usage"><strong>{job.actions_used}/{job.envelope.max_actions}</strong><small>actions</small></span><span className={`state-pill state-pill--${job.state}`}>{WORK_ITEM_STATE_LABEL[job.state]}</span><span aria-hidden="true">→</span></button>)}</div>}
    </div>
  );
}
