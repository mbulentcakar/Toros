import type { ReactNode } from 'react';
import { getJob, listReceipts } from '../api';
import { usePoll } from '../hooks';
import { ErrorState, LoadingState, EmptyState } from './States';
import { ReceiptList } from './ReceiptList';
import { WORK_ITEM_STATE_LABEL } from '../types';

/**
 * JobDetailView — shows a single job's detail.
 *
 * SPEC: receipts in order, with capability, decision, outcome, timings.
 * Never offers a control that sets `accepted` (SPEC §7).
 */
interface JobDetailViewProps {
  readonly jobId: string;
}

export function JobDetailView({ jobId }: JobDetailViewProps): ReactNode {
  const { data: job, loading: jobLoading, error: jobError } = usePoll(
    () => getJob(jobId),
    5000,
  );

  const { data: receipts, loading: recLoading, error: recError } = usePoll(
    () => listReceipts(jobId),
    5000,
  );

  if (jobError) return <ErrorState error={jobError} />;
  if (recError) return <ErrorState error={recError} />;
  if (jobLoading) return <LoadingState />;

  if (!job) return <EmptyState message={`Job ${jobId} not found.`} />;

  return (
    <div className="job-detail">
      <h2 className="view-title">Job Detail: {job.job_id}</h2>

      <dl className="job-detail__meta">
        <dt>Objective</dt>
        <dd>{job.envelope.objective}</dd>

        <dt>State</dt>
        <dd>{WORK_ITEM_STATE_LABEL[job.state] ?? job.state}</dd>

        <dt>Actions Used</dt>
        <dd>{job.actions_used} / {job.envelope.max_actions}</dd>

        <dt>Expires</dt>
        <dd>{job.envelope.expires_at}</dd>

        <dt>Envelope Digest</dt>
        <dd>{job.envelope_digest}</dd>

        <dt>Allowed Capabilities</dt>
        <dd>{job.envelope.allowed_capabilities.join(', ') || '(none)'}</dd>

        <dt>Allowed Workspaces</dt>
        <dd>{job.envelope.allowed_workspaces.join(', ') || '(none)'}</dd>

        <dt>Acceptance Criteria</dt>
        <dd>{job.envelope.acceptance.join('; ') || '(none)'}</dd>
      </dl>

      <h3>Receipts</h3>
      {recLoading ? (
        <LoadingState />
      ) : receipts && receipts.length > 0 ? (
        <ReceiptList receipts={receipts} />
      ) : (
        <EmptyState message="No receipts yet." />
      )}
    </div>
  );
}