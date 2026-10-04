import type { FormEvent, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { listFindings } from '../api';
import { usePoll } from '../hooks';
import type { FindingRecord } from '../types';
import { CorrelationBadge } from './CorrelationBadge';
import { EmptyState, ErrorState, LoadingState } from './States';

function FindingsForJob({ jobId }: { readonly jobId: string }): ReactNode {
  const fetcher = useCallback(() => listFindings(jobId), [jobId]);
  const { data: findings, loading, error } = usePoll(fetcher, 5000);

  if (error !== null) return <ErrorState error={error} />;
  if (loading) return <LoadingState />;
  if (findings === null || findings.length === 0) {
    return <EmptyState message={`No findings recorded for job ${jobId}.`} />;
  }

  return (
    <table className="findings-table">
      <thead>
        <tr>
          <th>Observed</th>
          <th>Severity</th>
          <th>Rule</th>
          <th>Title</th>
          <th>Correlation</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((finding: FindingRecord) => (
          <tr data-finding-id={finding.finding_id} key={finding.finding_id}>
            <td>{finding.observed_at}</td>
            <td>
              <span className={`severity-badge severity-badge--${finding.severity}`}>
                {finding.severity}
              </span>
            </td>
            <td>{finding.rule_id}</td>
            <td>{finding.title}</td>
            <td>
              <CorrelationBadge
                confidence={finding.correlation}
                receiptId={finding.receipt_id}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Findings are operator-only and job-scoped. The job id is explicit so the
 * cockpit never turns a narrow store query into an accidental global feed.
 */
export function FindingsView(): ReactNode {
  const [input, setInput] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = input.trim();
    if (value.length > 0) setJobId(value);
  }

  return (
    <div className="findings-view">
      <h2 className="view-title">Security Findings</h2>
      <form className="findings-filter" onSubmit={submit}>
        <label htmlFor="findings-job-id">Job ID</label>
        <input
          id="findings-job-id"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Enter a job ID"
          type="text"
          value={input}
        />
        <button className="btn" disabled={input.trim().length === 0} type="submit">
          Show findings
        </button>
      </form>
      {jobId === null
        ? <EmptyState message="Enter a job ID to view its Numbat findings." />
        : <FindingsForJob jobId={jobId} />}
    </div>
  );
}
