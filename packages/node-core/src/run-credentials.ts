import { randomUUID } from 'node:crypto';

import { ErrorCode, TorosError, type JsonValue } from '@toros/contracts';

/** A live run: which conversation it owns, which job it drives, and what it may do. */
export interface RunBinding {
  readonly job_id: string | null;
  readonly conversation_id: string;
  readonly mode: 'job' | 'advisory';
  /** The CLI family selected for this advisory run, if any. */
  readonly agent: string | null;
  /** The API model selected for Hermes during this run. */
  readonly model: string | null;
  /**
   * The supervisor's id for the exact run this credential was issued to.
   *
   * Revocation matches on this rather than on the job or conversation, because
   * a later run can occupy the same key while an earlier one is still
   * terminating — revoking by key took the live replacement down with it.
   * Null only between minting and the supervisor returning the run.
   */
  run_id: string | null;
  /**
   * The credential that resolves this binding, i.e. its key in `runTokens`.
   *
   * Held so `runFor` can re-read the map at the moment of use rather than
   * trusting the binding captured at authentication: a run can end while the
   * request body is still arriving, and the fresh read plus the synchronous
   * store write happen in one tick, so a revocation cannot slip between them.
   */
  readonly token: string;
}

export interface RunCredentials {
  readonly mint: (jobId: string | null, conversationId: string, mode: 'job' | 'advisory', agent?: string | null, model?: string | null) => string;
  readonly bind: (token: string, runId: string | null) => void;
  readonly revoke: (runId: string) => void;
  readonly resolveAdvisory: (token: string) => RunBinding | null;
  readonly runFor: (args: Readonly<Record<string, JsonValue>>, advisory: RunBinding | null) => RunBinding;
  readonly redactSecrets: (content: string) => string;
  readonly clear: () => void;
}

/**
 * How many revoked run credentials stay recognisable to redaction.
 *
 * One credential is minted per run, so this is a generous window over recent
 * history rather than a limit anyone should reach in a single session.
 */
const MAX_REMEMBERED_REVOKED_TOKENS = 512;

export function createRunCredentials(
  nodeToken: string,
  operatorToken?: string,
  agentTokens: { readonly claude?: string; readonly codex?: string } = {},
): RunCredentials {
  /**
   * Live per-run credentials. A run may reach the conversation it was started
   * for and no other: the coordinator never names a conversation, it presents
   * the token it was handed, and Node Core resolves the rest. Deliberately in
   * memory — a token must not outlive the process that issued it.
   */
  const runTokens = new Map<string, RunBinding>();

  /**
   * Credentials that have been revoked, remembered ONLY so that redaction
   * keeps recognising them.
   *
   * `redactSecrets` enumerated the live credentials, so the moment a run token
   * was revoked it stopped being redacted. A turn persisted in the shutdown
   * window — after the run ends and before the child's last write is
   * processed — stored the credential in clear text in the durable
   * conversation, which is rehydrated into later model context. The token is
   * dead by then, so this is disclosure of an expired secret; it still teaches
   * the model what a Toros credential looks like, and it persists.
   *
   * Insertion-ordered and trimmed from the front, so this cannot grow without
   * bound across a long-lived node. It grants nothing: membership here is
   * never consulted by `resolve`.
   */
  const revokedTokens = new Set<string>();

  /** Keep a revoked credential recognisable to redaction, and only to it. */
  const rememberRevoked = (token: string): void => {
    revokedTokens.add(token);
    while (revokedTokens.size > MAX_REMEMBERED_REVOKED_TOKENS) {
      const oldest = revokedTokens.values().next();
      if (oldest.done === true) break;
      revokedTokens.delete(oldest.value);
    }
  };

  return {
    mint(jobId: string | null, conversationId: string, mode: 'job' | 'advisory', agent: string | null = null, model: string | null = null): string {
      const token = randomUUID();
      runTokens.set(token, { job_id: jobId, conversation_id: conversationId, mode, run_id: null, token, agent, model });
      return token;
    },

    /**
     * Attach a credential to the run the supervisor actually created, or drop it.
     *
     * A token minted before `start` and left behind when `start` throws is a
     * credential with no run to die with, so it would live until shutdown.
     */
    bind(token: string, runId: string | null): void {
      const binding = runTokens.get(token);
      if (binding === undefined) return;
      if (runId === null) { runTokens.delete(token); rememberRevoked(token); return; }
      runTokens.set(token, { ...binding, run_id: runId });
    },

    /**
     * Revoke every credential issued to the runs under one supervisor key.
     *
     * Called when a run's process ends, however it ended, and again on an
     * explicit stop. Matching on the supervisor key rather than on `job_id` is
     * what makes advisory credentials revocable: they carry no job.
     */
    revoke(runId: string): void {
      for (const [token, binding] of runTokens) {
        if (binding.run_id === runId) {
          runTokens.delete(token);
          rememberRevoked(token);
        }
      }
    },

    /** Resolve an advisory run credential fresh. */
    resolveAdvisory(token: string): RunBinding | null {
      const binding = runTokens.get(token);
      return binding !== undefined && binding.mode === 'advisory' ? binding : null;
    },

    runFor(args: Readonly<Record<string, JsonValue>>, advisory: RunBinding | null): RunBinding {
      // Re-read the map, whichever mode. This is the last synchronous step before
      // the store write in list_turns/append_turn, and there is no await between
      // here and that write, so a run that ends now — after the body was read,
      // after authentication — cannot commit through a binding that has already
      // been revoked. An advisory run is identified by its bearer; a job run by
      // its run_token argument.
      const supplied = args['run_token'];
      const token = advisory !== null ? advisory.token
        : typeof supplied === 'string' && supplied.length > 0 ? supplied
          : (() => { throw new TorosError(ErrorCode.E_SCHEMA, 'run_token must be a non-empty string'); })();
      const binding = runTokens.get(token);
      if (binding === undefined) throw new TorosError(ErrorCode.E_RUN_INVALID, 'Unknown or expired run token');
      return binding;
    },

    /**
     * Strip anything this node knows to be a credential out of text about to be
     * persisted.
     *
     * The coordinator redacts before it writes, but the coordinator is the
     * untrusted party — a rule only it enforces is not enforced. This is the same
     * rule at the authority that owns the store, so a faulty or hostile
     * `append_turn`, or an operator pasting a bearer into the chat box, cannot put
     * a live credential into durable history and back into later model context.
     * The scope is every bearer class the node knows: node, operator, and the
     * configured agent tokens — an agent bearer pasted into an objective, an
     * acceptance line or a turn is sealed/rehydrated by exactly the same paths.
     */
    redactSecrets(content: string): string {
      let out = content;
      const secrets = [nodeToken, operatorToken, agentTokens.claude, agentTokens.codex, ...runTokens.keys(), ...revokedTokens];
      for (const secret of secrets) {
        if (secret === undefined || secret.length < 8) continue;
        out = out.split(secret).join('[redacted]');
      }
      return out;
    },

    clear(): void { runTokens.clear(); revokedTokens.clear(); },
  };
}
