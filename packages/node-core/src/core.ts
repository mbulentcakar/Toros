import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ErrorCode, TorosError, isTerminal, type CapabilityId, type JobRecord, type SecurityObserver, type Store } from '@toros/contracts';
import { isChromeWorkerAdapter, type ChromeWorkerAdapter } from '@toros/adapters-chrome';
import { createPolicy, type Policy } from '@toros/policy';
import { createRegistry } from '@toros/registry';
import { createRelay, type Relay } from '@toros/relay';
import { openStore } from '@toros/store';

import { createActionPipeline, type SettlementTimingOptions } from './action-pipeline.js';
import { approvalTtlMinutes, createApprovalRegistry, type ApprovalRegistry } from './approvals.js';
import { BrowserAcquisitionController } from './browser-acquisition.js';
import { createConversationGuard, type ConversationGuard } from './conversation-guard.js';
import { createDraftService, type DraftService } from './draft.js';
import { createHttpTransport, toros, type HttpTransport, type ToolRouteSurface } from './http.js';
import type { NodeCore, NodeCoreOptions } from './index.js';
import { createChromeRoutes } from './routes-chrome.js';
import { createOperatorRoutes } from './routes-operator.js';
import { createToolRoutes } from './routes-tools.js';
import { createRunCredentials, type RunCredentials } from './run-credentials.js';
import { StageGraphController } from './stage-graph.js';

export class Core implements NodeCore {
  private store: Store | null = null;
  private policy: Policy | null = null;
  private relay: Relay | null = null;
  private stageGraphs: StageGraphController | null = null;
  private chromeWorker: ChromeWorkerAdapter | null = null;
  private browserAcquisitions: BrowserAcquisitionController | null = null;
  private registeredCapabilities: readonly string[] = [];
  private observer: SecurityObserver | null = null;
  /**
   * session_id → job_id for every session this process created. Also the set of
   * correlation ids route 1 can resolve: `start_cli` uses one id for the
   * receipt, the session and the adapter's per-session directory name, so the
   * last path segment an observer reports IS the session id when it names one
   * of ours.
   */
  private readonly sessionJobs = new Map<string, string>();
  private readonly actionPipeline: ReturnType<typeof createActionPipeline>;
  private readonly approvals: ApprovalRegistry;
  private readonly runCredentials: RunCredentials;
  private readonly activeCoordinatorStarts = new Set<string>();
  private readonly conversationGuard: ConversationGuard;
  private readonly draft: DraftService;
  private readonly tools: ToolRouteSurface;
  private readonly http: HttpTransport;

  constructor(private readonly options: NodeCoreOptions) {
    this.approvals = createApprovalRegistry(approvalTtlMinutes(options.approval_ttl_minutes) * 60 * 1000);
    this.conversationGuard = createConversationGuard();
    this.runCredentials = createRunCredentials(options.token, options.operator_token);
    this.draft = createDraftService({
      node_id: options.node_id,
      workspaces: options.workspaces,
      registeredCapabilities: () => this.registeredCapabilities,
      store: () => this.getStore(),
      redactSecrets: (content) => this.runCredentials.redactSecrets(content),
    });
    // `pipeline_settlement` is an internal test seam that intentionally has no
    // entry on the public NodeCoreOptions type: tests construct a Core (or
    // pipeline) with short settlement timings for their own instance, and
    // production config never sets it, so the pipeline always runs the
    // immutable production values. Plumbed through here and omitted when
    // absent (exactOptionalPropertyTypes: passing an explicit undefined is a
    // type error, so it is spread conditionally).
    const settlement = (this.options as NodeCoreOptions & { readonly pipeline_settlement?: SettlementTimingOptions }).pipeline_settlement;
    const actionPipeline = createActionPipeline({
      node_id: options.node_id,
      adapters: options.adapters,
      workspaces: options.workspaces,
      registeredCapabilities: () => this.registeredCapabilities,
      store: () => this.getStore(),
      policy: () => this.getPolicy(),
      stageGraphs: () => this.getStageGraphs(),
      approvals: this.approvals,
      ...(settlement === undefined ? {} : { settlement }),
      recordSession: (sessionId, jobId) => { this.sessionJobs.set(sessionId, jobId); },
      removeSession: (sessionId) => { this.sessionJobs.delete(sessionId); },
    });
    this.actionPipeline = actionPipeline;
    this.tools = createToolRoutes({
      registeredCapabilities: () => this.registeredCapabilities,
      store: () => this.getStore(),
      stageGraphs: () => this.getStageGraphs(),
      relay: () => this.getRelay(),
      runCredentials: this.runCredentials,
      draft: this.draft,
      actionPipeline,
      conversationGuard: this.conversationGuard,
    });
    const operator = createOperatorRoutes({
      node_id: options.node_id,
      workspaces: options.workspaces,
      registeredCapabilities: () => this.registeredCapabilities,
      store: () => this.getStore(),
      chromeWorker: () => this.getChromeWorker(),
      browserAcquisitions: () => this.getBrowserAcquisitions(),
      stageGraphs: () => this.getStageGraphs(),
      ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
      approvals: this.approvals,
      actionPipeline,
      conversationGuard: this.conversationGuard,
      runCredentials: this.runCredentials,
      draft: this.draft,
      tools: this.tools,
      conversationFor: (job) => this.conversationFor(job),
      withCoordinatorStartGuard: (jobId, work) => this.withCoordinatorStartGuard(jobId, work),
    });
    const chrome = createChromeRoutes({ getChromeWorker: () => this.getChromeWorker() });
    this.http = createHttpTransport({
      token: options.token,
      ...(options.operator_token === undefined ? {} : { operator_token: options.operator_token }),
      runCredentials: this.runCredentials,
      tools: this.tools,
      operator,
      chrome,
    });
  }

  async start(): Promise<{ readonly port: number; readonly registered_capabilities: readonly string[] }> {
    const activePort = this.http.port();
    if (activePort !== null) return { port: activePort, registered_capabilities: this.registeredCapabilities };
    // A credential must not outlive the process it was issued to. The
    // supervisor is the only thing that knows when a child is gone.
    this.options.coordinator?.onRunEnded((runId) => { this.runCredentials.revoke(runId); });
    const store = await openStore({ path: this.options.db_path, nodeId: this.options.node_id });
    this.store = store;
    const registry = createRegistry({ workspaces: this.options.workspaces });
    for (const adapter of this.options.adapters) {
      try { await registry.register(adapter); }
      catch (error: unknown) { console.error('adapter registration failed', adapter.manifest.id, error instanceof Error ? error.message : String(error)); }
    }
    this.registeredCapabilities = registry.list();
    // A restart must not leave a `send_cli` receipt open past its settlement
    // deadline: the deadline timers are in-memory and died with the previous
    // process, so every running send whose deadline has already passed is closed
    // here exactly as the in-process deadline would have closed it (AR-F4 Round
    // 2 item 2). A write failure here must not take the node down — the server
    // is not up yet, and the normal exchange settlement still applies.
    try { await this.actionPipeline.reconcileCliSettlements(); }
    catch (error: unknown) { console.error('failed to reconcile cli settlement deadlines', error); }
    const chrome = this.options.adapters.find(isChromeWorkerAdapter);
    this.chromeWorker = chrome !== undefined && this.registeredCapabilities.includes('chrome.navigate') ? chrome : null;
    // A gate nobody can open is a broken node that looks like a working one:
    // every gated action would deny E_APPROVAL_REQUIRED forever, and the only
    // symptom would be work quietly not happening. Refuse to start instead, and
    // say which capabilities are gated.
    const gated = this.gatedCapabilities(registry);
    if (gated.length > 0) {
      const operatorToken = this.options.operator_token;
      if (operatorToken === undefined || operatorToken.length < 32) {
        throw new Error(`operator_token of at least 32 characters is required because these capabilities need approval: ${gated.join(', ')}`);
      }
      if (operatorToken === this.options.token) {
        throw new Error('operator_token must differ from token: the coordinator holds token, and it must not be able to approve its own actions');
      }
    }
    this.policy = createPolicy({ registry, approval_required: this.options.approval_required, approvals: this.approvals });
    // The relay resolves selected_files against a workspace root, so it needs
    // one workspace. Phase 1 has exactly one sandbox root (SPEC 12.2).
    const relayWorkspace = this.options.workspaces[0];
    if (relayWorkspace !== undefined) {
      this.relay = createRelay({ store, workspace: relayWorkspace, output_dir: join(relayWorkspace.root, '_relay'), max_capsule_bytes: 256 * 1024 * 1024, node_id: this.options.node_id });
    }
    this.stageGraphs = new StageGraphController({
      db_path: this.options.db_path,
      node_id: this.options.node_id,
      workspaces: this.options.workspaces,
      registered_capabilities: () => this.registeredCapabilities,
      store: () => this.getStore(),
      create_job: (args) => this.draft.createJobFromArgs(args),
      start_job: (job, operatorMessage) => this.startCoordinatorForJob(job, operatorMessage),
      coordinator_status: (jobId) => this.options.coordinator?.status(jobId) ?? null,
      coordinator_stop: (jobId) => this.options.coordinator?.stop(jobId) ?? Promise.resolve(null),
    });
    await this.stageGraphs.start();
    if (this.chromeWorker !== null) {
      this.browserAcquisitions = new BrowserAcquisitionController({
        db_path: this.options.db_path,
        workspaces: this.options.workspaces,
        allowed_domains: () => this.getChromeWorker().status().allowed_domains,
        worker_status: () => this.getChromeWorker().status(),
        store: () => this.getStore(),
        create_job: (args) => this.draft.createJobFromArgs(args),
        invoke_action: async (job, workspaceId, actionId, parameters) => {
          return await this.tools.dispatch('invoke_app_action', {
            job_id: job.job_id, app_id: 'chrome', action_id: actionId,
            parameters, workspace_id: workspaceId, model: 'browser-acquisition',
          }) as { readonly output: string; readonly artifacts: readonly string[] };
        },
      });
      await this.browserAcquisitions.start();
    }
    const verification = await store.verifyChain(this.options.node_id);
    console.info('event chain verification', verification);
    this.observer = typeof this.options.observer === 'function'
      ? this.options.observer({ resolveSession: (correlationId) => this.resolveSession(correlationId), jobForSession: (sessionId) => this.jobForSession(sessionId) })
      : this.options.observer;
    if (this.observer !== null) {
      this.observer.onFinding((finding) => {
        // A rejected write here used to be an unhandled rejection, which on a
        // service is a crash. The observer is an audit channel, not a control
        // channel: it must not be able to take the node down.
        void store.putFinding({ ...finding, finding_id: randomUUID() })
          .catch((error: unknown) => { console.error('failed to record finding', error); });
      });
      // Registering this is what makes the retraction channel exist. The
      // contract, the correlator emission and the event kind were all in place
      // and nothing listened, so every route-3 invalidation was built, emitted
      // and dropped — and the log kept the withdrawn attribution as if it still
      // stood. Appended, never an edit (SPEC §8.2): the record shows both what
      // was believed and when it stopped being believed.
      this.observer.onRetraction((retraction) => {
        void store.appendEvent({
          node_id: this.options.node_id,
          // Null when the withdrawn session is not one of ours — the retraction
          // is still worth recording, and job_id is nullable for exactly this.
          job_id: this.jobForSession(retraction.retracted_session_id),
          kind: 'finding.correlation_retracted',
          payload: {
            run_id: retraction.run_id,
            retracted_session_id: retraction.retracted_session_id,
            retracted_finding_keys: [...retraction.retracted_finding_keys],
            observed_at: retraction.observed_at,
            reason: retraction.reason,
          },
        }).catch((error: unknown) => { console.error('failed to record correlation retraction', error); });
      });
      await this.observer.start();
    }
    const started = await this.http.start(this.options.port);
    return { port: started.port, registered_capabilities: this.registeredCapabilities };
  }

  async stop(): Promise<void> {
    await this.http.stop();
    if (this.observer !== null) { await this.observer.stop(); this.observer = null; }
    await this.options.coordinator?.stopAll();
    if (this.stageGraphs !== null) { await this.stageGraphs.stop(); this.stageGraphs = null; }
    if (this.browserAcquisitions !== null) { await this.browserAcquisitions.stop(); this.browserAcquisitions = null; }
    this.chromeWorker = null;
    this.runCredentials.clear();
    for (const adapter of this.options.adapters) { try { await adapter.dispose(); } catch { /* best effort during shutdown */ } }
    if (this.store !== null) { await this.store.close(); this.store = null; }
    this.relay = null;
    // Both of these are documented as process-scoped and neither was cleared,
    // so a stop()/start() in one process carried them across. That contradicted
    // the two invariants they are built on: that a correlation id from a
    // previous run resolves to nothing, because its CLI child did not survive
    // (the adapters were just disposed above); and that a restart clears
    // pending approvals, which DEPLOY.md states and an operator would rely on.
    this.sessionJobs.clear();
    this.approvals.clear();
  }

  /**
   * Every registered capability that needs operator approval — from the config
   * list or from the action's own manifest, which is the same union policy
   * applies at rule 12.
   */
  private gatedCapabilities(registry: ReturnType<typeof createRegistry>): readonly CapabilityId[] {
    const configured = new Set(this.options.approval_required);
    return registry.list().filter((capability) => {
      if (configured.has(capability)) return true;
      const entry = registry.get(capability);
      if (entry === null) return false;
      return entry.adapter.manifest.actions.some((action) => action.id === entry.actionId && action.always_requires_approval);
    });
  }

  /**
   * A correlation id resolves only if it names a session this node created.
   * Echoing the id back unchecked would let any observed path segment mint an
   * attribution, which is the one thing §8.2's routes are built to prevent.
   */
  private resolveSession(correlationId: string): string | null {
    return this.sessionJobs.has(correlationId) ? correlationId : null;
  }

  private jobForSession(sessionId: string): string | null { return this.sessionJobs.get(sessionId) ?? null; }
  private getStore(): Store { if (this.store === null) throw new Error('Node Core is not started'); return this.store; }
  private getPolicy(): Policy { if (this.policy === null) throw new Error('Node Core is not started'); return this.policy; }
  private getRelay(): Relay { if (this.relay === null) throw new Error('Node Core is not started'); return this.relay; }
  private getStageGraphs(): StageGraphController { if (this.stageGraphs === null) throw new Error('Node Core is not started'); return this.stageGraphs; }
  private getChromeWorker(): ChromeWorkerAdapter {
    if (this.chromeWorker === null) throw new TorosError(ErrorCode.E_NOT_REGISTERED, 'Chrome worker is not configured on this node', {});
    return this.chromeWorker;
  }
  private getBrowserAcquisitions(): BrowserAcquisitionController {
    if (this.browserAcquisitions === null) throw new TorosError(ErrorCode.E_NOT_REGISTERED, 'Browser acquisitions are not configured on this node', {});
    return this.browserAcquisitions;
  }

  /**
   * The conversation a job belongs to, minting and binding one on the job's
   * first Hermes run. Binding is persisted, so a Node Core restart rejoins the
   * same conversation instead of orphaning its history behind a new one.
   */
  private async conversationFor(job: JobRecord): Promise<string> {
    if (job.conversation_id !== null) return job.conversation_id;
    const conversationId = randomUUID();
    await this.getStore().createConversation({ conversation_id: conversationId, node_id: this.options.node_id, title: job.envelope.objective.slice(0, 200), state: 'open' });
    await this.getStore().setJobConversation(job.job_id, conversationId);
    return conversationId;
  }

  private async withCoordinatorStartGuard<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    if (this.activeCoordinatorStarts.has(jobId)) {
      throw toros(ErrorCode.E_PARALLEL_ACTION, 'A coordinator start is already in progress for this job');
    }
    this.activeCoordinatorStarts.add(jobId);
    try {
      return await work();
    } finally {
      this.activeCoordinatorStarts.delete(jobId);
    }
  }

  private async startCoordinatorForJob(job: JobRecord, operatorMessage?: string): Promise<import('./coordinator-supervisor.js').CoordinatorRun> {
    return this.withCoordinatorStartGuard(job.job_id, async () => {
      const current = await this.getStore().getJob(job.job_id);
      if (current === null) throw toros(ErrorCode.E_ENVELOPE_INVALID, 'Unknown job');
      if (isTerminal(current.state)) throw toros(ErrorCode.E_JOB_TERMINAL, `The job is ${current.state}`);
      if (operatorMessage !== undefined && (operatorMessage.trim().length === 0 || Buffer.byteLength(operatorMessage) > 8 * 1024)) {
        throw toros(ErrorCode.E_SCHEMA, 'operator_message must contain 1 to 8192 bytes');
      }
      const control = this.options.coordinator;
      if (control === undefined) throw toros(ErrorCode.E_ADAPTER_FAILURE, 'Hermes coordinator is unavailable');
      if (control.status(current.job_id)?.state === 'running') throw toros(ErrorCode.E_PARALLEL_ACTION, 'Hermes is already running for this job');
      const conversationId = await this.conversationFor(current);
      const storedMessage = operatorMessage === undefined ? undefined : this.runCredentials.redactSecrets(operatorMessage);
      if (storedMessage !== undefined) await this.getStore().appendTurn({ conversation_id: conversationId, role: 'operator', channel: 'human', content: storedMessage, job_id: current.job_id });
      const runToken = this.runCredentials.mint(current.job_id, conversationId, 'job');
      const run = await control.start(current.job_id, { run_token: runToken, conversation_id: conversationId, ...(storedMessage === undefined ? {} : { operator_message: storedMessage }) })
        .catch((cause: unknown) => { this.runCredentials.bind(runToken, null); throw cause; });
      this.runCredentials.bind(runToken, run.run_id);
      return run;
    });
  }
}
