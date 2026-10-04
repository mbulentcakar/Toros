import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import {
  ApiError,
  createCheckpoint,
  getHermesStatus,
  getJob,
  grantApproval,
  listConversationTurns,
  listFindings,
  listPendingApprovals,
  listReceipts,
  listSessions,
  startHermes,
  stopHermes,
} from '../api';
import { usePoll } from '../hooks';
import type { ConversationTurn, CoordinatorRunState, WorkItemState } from '../types';
import { WORK_ITEM_STATE_LABEL } from '../types';
import { CorrelationBadge } from './CorrelationBadge';
import { EmptyState, ErrorState, LoadingState } from './States';
import { ReceiptList } from './ReceiptList';

type DetailTab = 'overview' | 'conversation' | 'activity' | 'security';

interface JobWorkspaceViewProps {
  readonly active?: boolean;
  readonly jobId: string;
  readonly onBack: () => void;
}

const TERMINAL = new Set<WorkItemState>(['proposed', 'accepted', 'blocked', 'cancelled']);

function formatDate(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function humanText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as Record<string, unknown>).say ?? (parsed as Record<string, unknown>).ask;
      if (typeof value === 'string') return value;
    }
  } catch { /* Plain operator turns are already human-readable. */ }
  return content;
}

function machineSummary(turn: ConversationTurn): string {
  try {
    const parsed: unknown = JSON.parse(turn.content);
    if (typeof parsed === 'object' && parsed !== null) {
      const key = Object.keys(parsed as Record<string, unknown>)[0];
      if (key !== undefined) return key.replaceAll('_', ' ');
    }
  } catch { /* Fall through to the channel label. */ }
  return 'machine event';
}

function runLabel(state: CoordinatorRunState | undefined): string {
  if (state === undefined) return 'No active run';
  return ({
    running: 'Hermes is working', waiting_for_input: 'Waiting for your answer',
    waiting_for_approval: 'Waiting for approval', finished: 'Run finished', failed: 'Run failed', stopped: 'Run stopped',
  } as const)[state];
}

export function JobWorkspaceView({ active = true, jobId, onBack }: JobWorkspaceViewProps): ReactNode {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const jobFetcher = useCallback(() => getJob(jobId), [jobId]);
  const receiptsFetcher = useCallback(() => listReceipts(jobId), [jobId]);
  const sessionsFetcher = useCallback(() => listSessions(jobId), [jobId]);
  const findingsFetcher = useCallback(() => listFindings(jobId), [jobId]);
  const runFetcher = useCallback(() => getHermesStatus(jobId), [jobId]);
  const turnsFetcher = useCallback(() => listConversationTurns(jobId), [jobId]);
  const approvalsFetcher = useCallback(async () => (await listPendingApprovals()).filter((item) => item.binding.job_id === jobId), [jobId]);

  const jobState = usePoll(jobFetcher, 3_000, active);
  const receiptsState = usePoll(receiptsFetcher, 3_000, active);
  const sessionsState = usePoll(sessionsFetcher, 5_000, active);
  const findingsState = usePoll(findingsFetcher, 5_000, active);
  const runState = usePoll(runFetcher, 2_000, active);
  const turnsState = usePoll(turnsFetcher, 2_000, active);
  const approvalsState = usePoll(approvalsFetcher, 3_000, active);

  function refreshAll(): void {
    jobState.refresh(); receiptsState.refresh(); sessionsState.refresh(); findingsState.refresh();
    runState.refresh(); turnsState.refresh(); approvalsState.refresh();
  }

  async function act(operation: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true); setActionError(null); setNotice(null);
    try { await operation(); setNotice(success); refreshAll(); }
    catch (cause: unknown) { setActionError(cause instanceof ApiError ? cause : new ApiError(0, 'Unavailable', cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(false); }
  }

  const job = jobState.data;
  const run = runState.data;
  const approvals = approvalsState.data ?? [];
  if (jobState.loading) return <LoadingState />;
  if (jobState.error !== null) return <ErrorState error={jobState.error} />;
  if (job === null) return <EmptyState message={`Job ${jobId} was not found.`} />;
  const canRun = !TERMINAL.has(job.state) && run?.state !== 'running';
  const canCheckpoint = !TERMINAL.has(job.state);

  return (
    <div className="job-workspace page-stack">
      <button className="back-link" onClick={onBack} type="button">← Back</button>
      <header className="job-workspace__hero">
        <div className="job-workspace__title"><div><span className={`state-pill state-pill--${job.state}`}>{WORK_ITEM_STATE_LABEL[job.state]}</span><span className="job-id">{job.job_id}</span></div><h1>{job.envelope.objective}</h1><p>{job.actions_used} of {job.envelope.max_actions} actions used · expires {formatDate(job.envelope.expires_at)}</p></div>
        <div className="job-run-card"><span className={`run-pulse${run?.state === 'running' ? ' is-running' : ''}`} /><div><strong>{runLabel(run?.state)}</strong><small>{run?.ended_at ? `Ended ${formatDate(run.ended_at)}` : run?.started_at ? `Started ${formatDate(run.started_at)}` : 'Coordinator is idle'}</small></div></div>
      </header>

      {actionError !== null && <ErrorState error={actionError} />}
      {notice !== null && <div className="notice notice--success" role="status">{notice}</div>}

      <div className="job-command-bar">
        {run?.state === 'running'
          ? <button className="btn btn--danger" disabled={busy} onClick={() => { void act(() => stopHermes(jobId), 'Hermes stopped. The job remains resumable.'); }} type="button">Stop Hermes</button>
          : <button className="btn btn--primary" disabled={busy || !canRun || (run?.state === 'waiting_for_approval' && approvals.length > 0)} onClick={() => { void act(() => startHermes(jobId), 'Hermes started.'); }} type="button">{run === null ? 'Start Hermes' : 'Resume Hermes'}</button>}
        <button className="btn" disabled={busy || !canCheckpoint} onClick={() => { void act(() => createCheckpoint(jobId, 'Operator checkpoint from Cockpit'), 'Checkpoint created.'); }} type="button">Create checkpoint</button>
        <button className="btn btn--quiet" disabled={busy} onClick={refreshAll} type="button">Refresh</button>
      </div>

      {run?.state === 'waiting_for_input' && <form className="job-question" onSubmit={(event) => { event.preventDefault(); const value = message.trim(); if (value) void act(() => startHermes(jobId, { operator_message: value }), 'Reply sent and Hermes resumed.').then(() => setMessage('')); }}><div><strong>Hermes needs clarification</strong><p>Answer in plain language; the reply becomes part of the durable conversation.</p></div><label><span className="visually-hidden">Reply to Hermes</span><textarea aria-label="Reply to Hermes" onChange={(event) => setMessage(event.target.value)} placeholder="Tell Hermes how to continue" value={message} /></label><button className="btn btn--primary" disabled={busy || message.trim().length === 0} type="submit">Reply and resume</button></form>}

      {approvals.map((approval) => <article className="inline-approval" key={approval.approval_id}><div><span className="eyebrow">Approval required</span><h2>{approval.binding.capability}</h2><p>Expires {formatDate(approval.expires_at)}</p></div><details><summary>Review exact arguments</summary><pre>{JSON.stringify(approval.arguments, null, 2)}</pre></details><button className="btn btn--approve" disabled={busy} onClick={() => { void act(async () => { await grantApproval(approval.approval_id); await startHermes(jobId, { approval_id: approval.approval_id }); }, 'Approved exact action and resumed Hermes.'); }} type="button">Approve exact action</button></article>)}

      <div className="detail-tabs" role="tablist" aria-label="Job detail">
        {([['overview', 'Overview'], ['conversation', 'Conversation'], ['activity', `Activity (${receiptsState.data?.length ?? 0})`], ['security', `Security (${findingsState.data?.length ?? 0})`]] as const).map(([id, label]) => <button aria-selected={tab === id} className={tab === id ? 'is-active' : ''} key={id} onClick={() => setTab(id)} role="tab" type="button">{label}</button>)}
      </div>

      {tab === 'overview' && <section className="job-overview"><div className="fact-grid"><article><span>Run state</span><strong>{runLabel(run?.state)}</strong><small>{run?.exit_code === null || run?.exit_code === undefined ? 'No exit code' : `Exit ${run.exit_code}`}</small></article><article><span>Sessions</span><strong>{sessionsState.data?.length ?? 0}</strong><small>{sessionsState.data?.filter((session) => session.stopped_at === null).length ?? 0} active</small></article><article><span>Receipts</span><strong>{receiptsState.data?.length ?? 0}</strong><small>Durable action evidence</small></article><article><span>Findings</span><strong>{findingsState.data?.length ?? 0}</strong><small>Advisory security signals</small></article></div><div className="job-boundaries"><article><h2>Acceptance criteria</h2>{job.envelope.acceptance.length === 0 ? <p>None declared.</p> : <ul>{job.envelope.acceptance.map((item) => <li key={item}>{item}</li>)}</ul>}</article><article><h2>Boundaries</h2><dl><dt>Capabilities</dt><dd>{job.envelope.allowed_capabilities.join(', ') || 'None'}</dd><dt>Workspaces</dt><dd>{job.envelope.allowed_workspaces.join(', ') || 'None'}</dd><dt>Forbidden</dt><dd>{job.envelope.forbidden.join(', ') || 'None'}</dd><dt>Envelope digest</dt><dd><code>{job.envelope_digest}</code></dd></dl></article></div></section>}

      {tab === 'conversation' && <section className="job-conversation" aria-label="Durable conversation">{turnsState.loading && <LoadingState />}{!turnsState.loading && (turnsState.data?.length ?? 0) === 0 && <EmptyState message="No durable conversation turns were recorded for this job." />}{turnsState.data?.map((turn) => turn.channel === 'machine' ? <details className="machine-turn" key={turn.seq}><summary>Action · {machineSummary(turn)}</summary><pre>{turn.content}</pre></details> : <article className={`conversation-turn conversation-turn--${turn.role}`} key={turn.seq}><header><strong>{turn.role === 'operator' ? 'You' : turn.role === 'hermes' ? 'Hermes' : 'Toros'}</strong><time>{formatDate(turn.recorded_at)}</time></header><p>{humanText(turn.content)}</p></article>)}</section>}

      {tab === 'activity' && <section className="job-activity">{receiptsState.error !== null && <ErrorState error={receiptsState.error} />}{receiptsState.loading ? <LoadingState /> : (receiptsState.data?.length ?? 0) > 0 ? <div className="table-scroll"><ReceiptList receipts={receiptsState.data ?? []} /></div> : <EmptyState message="No action receipts yet." />}</section>}

      {tab === 'security' && <section className="job-security">{findingsState.error !== null && <ErrorState error={findingsState.error} />}{findingsState.loading ? <LoadingState /> : (findingsState.data?.length ?? 0) === 0 ? <EmptyState message="No security findings for this job." /> : <div className="finding-list">{findingsState.data?.map((finding) => <article key={finding.finding_id}><div><span className={`severity-badge severity-badge--${finding.severity}`}>{finding.severity}</span><span>{formatDate(finding.observed_at)}</span></div><h2>{finding.title}</h2><p><code>{finding.rule_id}</code></p><CorrelationBadge confidence={finding.correlation} receiptId={finding.receipt_id} /></article>)}</div>}</section>}
    </div>
  );
}
