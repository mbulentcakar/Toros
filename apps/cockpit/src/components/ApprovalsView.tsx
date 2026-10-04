import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ApiError, grantApproval, listPendingApprovals, resolveConfig, startHermes } from '../api';
import type { ApprovalRequest } from '../types';
import { EmptyState, ErrorState, LoadingState } from './States';

export function ApprovalsView({ active = true }: { readonly active?: boolean } = {}): ReactNode {
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [granting, setGranting] = useState<string | null>(null);

  async function refresh(initial: boolean = false): Promise<void> {
    if (initial) setLoading(true);
    setError(null);
    try {
      const status = await resolveConfig();
      if (!status.approvals_configured) {
        setConfigured(false);
        setApprovals([]);
        return;
      }
      setConfigured(true);
      setApprovals(await listPendingApprovals());
    } catch (cause: unknown) {
      const nextError = cause instanceof ApiError
        ? cause
        : new ApiError(0, 'Unavailable', cause instanceof Error ? cause.message : 'Could not load approvals');
      setError(nextError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    let first = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      await refresh(first);
      first = false;
      if (mounted && document.visibilityState !== 'hidden') timer = setTimeout(() => { void poll(); }, 3_000);
    }
    function visibilityChanged(): void {
      if (document.visibilityState === 'hidden') { if (timer !== null) clearTimeout(timer); timer = null; }
      else if (timer === null) void poll();
    }
    if (document.visibilityState !== 'hidden') void poll();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => { mounted = false; if (timer !== null) clearTimeout(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [active]);

  async function approve(approval: ApprovalRequest): Promise<void> {
    setGranting(approval.approval_id);
    setError(null);
    try {
      await grantApproval(approval.approval_id);
      await startHermes(approval.binding.job_id, { approval_id: approval.approval_id });
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof ApiError
        ? cause
        : new ApiError(0, 'Unavailable', cause instanceof Error ? cause.message : 'Could not grant approval'));
    } finally {
      setGranting(null);
    }
  }

  return (
    <div className="approvals-view">
      <div className="section-heading"><div><span className="eyebrow">Exact authority</span><h2>Pending approvals</h2></div>{approvals.length > 0 && <span className="section-heading__meta">{approvals.length} waiting</span>}</div>
      {loading && <LoadingState />}
      {!loading && configured === false && <EmptyState message="Approvals are not configured on this node." />}
      {!loading && configured === true && error === null && approvals.length === 0 && (
        <EmptyState message="There are no pending approvals." />
      )}
      {error !== null && <ErrorState error={error} />}
      {!loading && approvals.length > 0 && (
        <div className="approvals-list">
          {approvals.map((approval) => (
            <article className="approval-card" data-approval-id={approval.approval_id} key={approval.approval_id}>
              <div className="approval-card__header">
                <h3>{approval.binding.capability}</h3>
                <button className="btn btn--approve" disabled={granting !== null} onClick={() => { void approve(approval); }} type="button">
                  {granting === approval.approval_id ? 'Approving…' : 'Approve and resume'}
                </button>
              </div>
              <dl className="approval-card__meta">
                <dt>Job</dt><dd>{approval.binding.job_id}</dd>
                <dt>Requested</dt><dd>{approval.requested_at}</dd>
                <dt>Expires</dt><dd>{approval.expires_at}</dd>
              </dl>
              <h4>Arguments</h4>
              <pre className="approval-card__arguments">{JSON.stringify(approval.arguments, null, 2)}</pre>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
