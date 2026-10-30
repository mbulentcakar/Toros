import type { FormEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  acceptProposal,
  archiveConversation,
  createConversation,
  getConversationUsage,
  getOperatorCatalog,
  listConversations,
  listTurns,
  rejectProposal,
  resolveConfig,
  sendMessage,
  startHermes,
} from '../api';
import type { ConversationRecord, ConversationTurn, JobProposal, ModelUsageSummary } from '../types';
import { EmptyState, ErrorState, LoadingState } from './States';

function apiError(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError(0, 'Unavailable', cause instanceof Error ? cause.message : String(cause));
}

const SPEAKER: Record<ConversationTurn['role'], string> = {
  operator: 'You',
  hermes: 'Hermes',
  system: 'Toros',
  tool: 'Tool',
};

/** The sentence inside a human-channel turn, not the envelope it arrived in. */
function humanText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const said = record.say ?? record.ask;
      if (typeof said === 'string') return said;
    }
  } catch {
    // Operator turns are plain text, not JSON. Show them as they were typed.
  }
  return content;
}

/** A machine turn carrying a draft envelope and its agreement digest, or null. */
interface ProposalTurn {
  readonly proposal: JobProposal;
  readonly agreement_digest: string;
}

function proposalOf(turn: ConversationTurn): ProposalTurn | null {
  if (turn.channel !== 'machine') return null;
  try {
    const parsed: unknown = JSON.parse(turn.content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const draft = record.propose_job;
    if (typeof draft !== 'object' || draft === null) return null;
    const draftRecord = draft as Record<string, unknown>;
    if (typeof draftRecord.objective !== 'string') return null;
    const agreement_digest = record.agreement_digest;
    if (typeof agreement_digest !== 'string') return null;
    return { proposal: draftRecord as unknown as JobProposal, agreement_digest };
  } catch {
    return null;
  }
}

function machineSummary(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      const key = Object.keys(parsed as Record<string, unknown>)[0];
      if (key !== undefined) return key.replaceAll('_', ' ');
    }
  } catch { /* Stored content remains available in the expanded view. */ }
  return 'machine event';
}

const REQUIRED_CLI_LIFECYCLE = ['start', 'send', 'read', 'stop'] as const;
function agentOf(proposal: JobProposal): string | null {
  const ids = new Set(proposal.capabilities.map((capability) => capability.id));
  for (const capability of proposal.capabilities) {
    const separator = capability.id.lastIndexOf('.');
    if (separator <= 0) continue;
    const adapter = capability.id.slice(0, separator);
    if (REQUIRED_CLI_LIFECYCLE.every((action) => ids.has(`${adapter}.${action}`))) return adapter;
  }
  return null;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function workerLabel(value: string): string {
  return value === 'gemini' ? 'Gemini (AGY)' : titleCase(value);
}

function limitsSentence(proposal: JobProposal): string {
  const retries = proposal.max_retries === 1 ? '1 retry' : `${proposal.max_retries} retries`;
  const hours = proposal.expires_in_hours === 1 ? '1 hour' : `${proposal.expires_in_hours} hours`;
  return `At most ${proposal.max_actions} actions and ${retries}, expiring in ${hours}.`;
}

interface ProposalCardProps {
  readonly proposal: JobProposal;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

function ProposalCard({ proposal, busy, onAccept, onReject }: ProposalCardProps): ReactNode {
  const agent = agentOf(proposal);
  const where = proposal.workspaces.join(', ');
  const plan = proposal.plan ?? [];

  return (
    <article className="hermes-proposal" aria-label="Proposed job">
      <h4>Hermes's plan</h4>
      <p className="hermes-proposal__objective">{proposal.objective}</p>
      <ol className="hermes-proposal__plan">
        {plan.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
      </ol>
      {proposal.intent !== undefined && (
        <p className="hermes-proposal__intent"><strong>Intent</strong> {proposal.intent}</p>
      )}
      {proposal.target !== undefined && (
        <p className="hermes-proposal__target"><strong>Target</strong> {proposal.target}</p>
      )}
      {proposal.changes !== undefined && (
        <p className="hermes-proposal__changes"><strong>Changes</strong> {proposal.changes}</p>
      )}
      <dl className="hermes-proposal__facts">
        <dt>Using</dt>
        <dd>{agent === null ? `This machine, in ${where}` : `${workerLabel(agent)} in ${where}`}</dd>
        <dt>Done when</dt>
        <dd>{proposal.acceptance.join('; ')}</dd>
        <dt>Limits</dt>
        <dd>{limitsSentence(proposal)}{proposal.forbidden.length > 0 && ` Never: ${proposal.forbidden.join(', ')}.`}</dd>
      </dl>
      <details className="hermes-proposal__permissions">
        <summary>{proposal.capabilities.length} permissions it will hold</summary>
        <ul>
        {proposal.capabilities.map((capability) => (
          <li key={capability.id}><strong>{capability.id}</strong> — {capability.why}</li>
        ))}
        </ul>
      </details>
      <p className="hermes-proposal__drafted">Drafted by Hermes{agent === null ? '' : ` for ${workerLabel(agent)}`}.</p>
      <div className="hermes-proposal__decision">
        <button className="btn btn--approve" disabled={busy} onClick={onAccept} type="button">Agree and run</button>
        <button className="btn" disabled={busy} onClick={onReject} type="button">No — let me explain</button>
      </div>
    </article>
  );
}

/**
 * Talk to Hermes. No form, no envelope, no capability identifiers — a message
 * box and a thread. The bounded job is drafted by Hermes when it wants to act,
 * and sealed only when the operator confirms it.
 */
interface HermesChatProps {
  readonly active?: boolean;
  readonly onOpenJob?: (jobId: string) => void;
}

export function HermesChat({ active = true, onOpenJob }: HermesChatProps = {}): ReactNode {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [conversations, setConversations] = useState<readonly ConversationRecord[]>([]);
  const [selected, setSelected] = useState('');
  const [turns, setTurns] = useState<readonly ConversationTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [acceptedJobId, setAcceptedJobId] = useState<string | null>(null);
  const [agents, setAgents] = useState<readonly string[]>([]);
  const [agent, setAgent] = useState('');
  const [models, setModels] = useState<ReadonlyArray<{ readonly id: string; readonly label: string; readonly provider: string }>>([]);
  const [model, setModel] = useState('');
  const [usage, setUsage] = useState<ModelUsageSummary | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void (async () => {
      try {
        const status = await resolveConfig();
        if (!mounted) return;
        setConfigured(status.approvals_configured);
        if (!status.approvals_configured) return;
        const [existing, catalog] = await Promise.all([
          listConversations(),
          getOperatorCatalog().catch(() => null),
        ]);
        if (!mounted) return;
        setConversations(existing);
        if (existing.length > 0) setSelected((current) => current || existing[0]!.conversation_id);
        const available = catalog?.agents ?? [];
        setAgents(available);
        if (available.length > 0) setAgent((current) => current || available[0]!);
        const availableModels = catalog?.models ?? [];
        setModels(availableModels);
        if (availableModels.length > 0) setModel((current) => current || availableModels[0]!.id);
      } catch (cause: unknown) {
        if (mounted) setError(apiError(cause));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [active]);

  useEffect(() => {
    if (!active || !selected || configured !== true) { if (!selected) setTurns([]); return; }
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function refresh(): Promise<void> {
      try {
        const [next, latestConversations, nextUsage] = await Promise.all([
          listTurns(selected), listConversations(), getConversationUsage(selected).catch(() => null),
        ]);
        if (mounted) { setTurns(next); setConversations(latestConversations); setUsage(nextUsage); setError(null); }
      } catch (cause: unknown) {
        if (mounted) setError(apiError(cause));
      } finally {
        if (mounted && document.visibilityState !== 'hidden') timer = setTimeout(() => { void refresh(); }, 2_000);
      }
    }
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'hidden') { if (timer !== null) clearTimeout(timer); timer = null; }
      else if (timer === null) void refresh();
    };
    if (document.visibilityState !== 'hidden') void refresh();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => { mounted = false; if (timer !== null) clearTimeout(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [active, configured, selected]);

  useEffect(() => {
    const conversation = conversations.find((item) => item.conversation_id === selected);
    if (conversation?.agent !== null && conversation?.agent !== undefined) setAgent(conversation.agent);
    if (conversation?.model !== null && conversation?.model !== undefined) setModel(conversation.model);
  }, [conversations, selected]);

  useEffect(() => {
    const element = threadEnd.current;
    if (active && element !== null && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'end' });
  }, [active, turns]);

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const message = draft.trim();
    if (message.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let conversationId = selected;
      // The first thing said opens the conversation. The operator never has to
      // create one first, and never names it.
      if (conversationId === '') {
        const created = await createConversation('New conversation');
        conversationId = created.conversation_id;
        setConversations([created, ...conversations]);
        setSelected(conversationId);
      }
      await sendMessage(conversationId, message, agent === '' ? undefined : agent, model === '' ? undefined : model);
      setDraft('');
      setTurns(await listTurns(conversationId));
    } catch (cause: unknown) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function newConversation(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const created = await createConversation('New conversation');
      setConversations((current) => [created, ...current]);
      setSelected(created.conversation_id); setTurns([]); setUsage(null); setAcceptedJobId(null);
    } catch (cause: unknown) { setError(apiError(cause)); }
    finally { setBusy(false); }
  }

  async function archiveSelected(): Promise<void> {
    if (selected === '') return;
    setBusy(true); setError(null);
    try {
      await archiveConversation(selected);
      const remaining = conversations.filter((item) => item.conversation_id !== selected);
      setConversations(remaining); setSelected(remaining[0]?.conversation_id ?? ''); setTurns([]); setUsage(null); setAcceptedJobId(null);
    } catch (cause: unknown) { setError(apiError(cause)); }
    finally { setBusy(false); }
  }

  async function accept(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const lastTurn = turns.at(-1);
      if (lastTurn === undefined) return;
      const proposalTurn = proposalOf(lastTurn);
      if (proposalTurn === null) return;
      const job = await acceptProposal(selected, lastTurn.seq, proposalTurn.agreement_digest);
      await startHermes(job.job_id);
      setAcceptedJobId(job.job_id);
      setTurns(await listTurns(selected));
    } catch (cause: unknown) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await rejectProposal(selected);
      setTurns(await listTurns(selected));
    } catch (cause: unknown) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState />;
  if (configured === false) return <EmptyState message="The operator workspace is not configured on this node." />;

  // Only the newest proposal is actionable; earlier ones have been superseded
  // by the conversation that followed them.
  const lastTurn = turns.at(-1);
  const latestProposalSeq = lastTurn !== undefined && proposalOf(lastTurn) !== null ? lastTurn.seq : null;

  return (
    <div className="hermes-chat">
      <div className="hermes-chat__header">
        <h2 className="view-title">Hermes</h2>
        <div className="hermes-chat__conversation-controls">
          <select aria-label="Conversation" title={conversations.find((item) => item.conversation_id === selected)?.title} onChange={(event) => setSelected(event.target.value)} value={selected}>
            <option value="">Choose a conversation</option>
            {conversations.map((conversation) => (
              <option key={conversation.conversation_id} value={conversation.conversation_id}>{conversation.title}</option>
            ))}
          </select>
          <button className="btn" disabled={busy} onClick={() => { void newConversation(); }} type="button">New conversation</button>
          <button className="text-button hermes-chat__archive" disabled={busy || selected === ''} onClick={() => { void archiveSelected(); }} type="button">Archive</button>
        </div>
      </div>
      {usage !== null && usage.total_tokens > 0 && <p className="hermes-chat__usage" aria-label="API model cost">API usage · {usage.total_tokens.toLocaleString()} tokens · {usage.cost_usd === null ? 'cost unavailable' : `$${usage.cost_usd.toFixed(4)}`}</p>}
      <p className="hermes-chat__boundary">
        The reasoning model is the API coordinator: it talks, plans, and drafts bounded jobs, but cannot touch a workspace.
        The worker CLI is the locally authenticated coding agent used only after you approve a job. The cost meter covers
        API reasoning; subscription-backed CLI usage is tracked as activity, not estimated dollars. Do not paste secrets.
      </p>
      {error !== null && <ErrorState error={error} />}
      {acceptedJobId !== null && (
        <div className="hermes-chat__accepted"><span>Job created and Hermes started.</span><button className="text-button" onClick={() => onOpenJob?.(acceptedJobId)} type="button">Open job workspace →</button></div>
      )}

      <div className="hermes-chat__thread" aria-label="Conversation">
        {turns.length === 0
          ? <EmptyState message="Say what you need in your own words." />
          : turns.map((turn) => {
            const proposal = proposalOf(turn);
            if (proposal !== null) {
              return turn.seq === latestProposalSeq
                ? <ProposalCard busy={busy} key={turn.seq} onAccept={() => { void accept(); }} onReject={() => { void reject(); }} proposal={proposal.proposal} />
                : <p className="hermes-chat__superseded" key={turn.seq}>An earlier proposal, superseded.</p>;
            }
            if (turn.channel === 'machine') return <details className="machine-turn" key={turn.seq}><summary>Action · {machineSummary(turn.content)}</summary><pre>{turn.content}</pre></details>;
            return (
              <article className={`hermes-chat__turn hermes-chat__turn--${turn.role}`} key={turn.seq}>
                <strong>{SPEAKER[turn.role]}</strong>
                <p>{humanText(turn.content)}</p>
              </article>
            );
          })}
        <div ref={threadEnd} />
      </div>

      <form className="hermes-chat__composer" onSubmit={(event) => { void send(event); }}>
        <label>
          <span className="visually-hidden">Message</span>
          <textarea
            aria-label="Message"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Tell Hermes what you need"
            value={draft}
          />
        </label>
        <div className="hermes-chat__send">
          {agents.length > 0 && (
            <label className="hermes-chat__agent">
              <span>Worker CLI</span>
              <select aria-label="Agent" onChange={(event) => setAgent(event.target.value)} value={agent}>
                {agents.map((id) => <option key={id} value={id}>{workerLabel(id)}</option>)}
              </select>
            </label>
          )}
          {models.length > 0 && (
            <label className="hermes-chat__agent">
              <span>Reasoning model</span>
              <select aria-label="Model" onChange={(event) => setModel(event.target.value)} value={model}>
                {models.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.provider}</option>)}
              </select>
            </label>
          )}
          <button className="btn btn--primary" disabled={busy || draft.trim().length === 0} type="submit">
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
