import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ErrorCode, TorosError, isTerminal, type JobRecord, type JsonValue, type Store, type Workspace } from '@toros/contracts';
import type { ChromeWorkerAdapter } from '@toros/adapters-chrome';

import type { ApprovalRegistry } from './approvals.js';
import type { ActionPipeline } from './action-pipeline.js';
import type { ConversationGuard } from './conversation-guard.js';
import { type BrowserAcquisitionController, type BrowserAcquisitionInput } from './browser-acquisition.js';
import type { CoordinatorControl } from './coordinator-supervisor.js';
import { MAX_TURN_BYTES, type DraftService } from './draft.js';
import { asRecord, optionalString, readBody, requiredPositiveInteger, requiredString, send, stringArray, toros, type RouteSurface, type ToolRouteSurface } from './http.js';
import type { RunCredentials } from './run-credentials.js';
import { hasModelProfile, MODEL_PROFILES } from './model-profiles.js';
import { type CreateStageGraphInput, type StageGraphController } from './stage-graph.js';

type OperatorHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createOperatorRoutes(deps: {
  readonly node_id: string;
  readonly workspaces: readonly Workspace[];
  readonly registeredCapabilities: () => readonly string[];
  readonly store: () => Store;
  readonly chromeWorker: () => ChromeWorkerAdapter;
  readonly browserAcquisitions: () => BrowserAcquisitionController;
  readonly stageGraphs: () => StageGraphController;
  readonly coordinator?: CoordinatorControl;
  readonly approvals: ApprovalRegistry;
  readonly actionPipeline: ActionPipeline;
  readonly conversationGuard: ConversationGuard;
  readonly runCredentials: RunCredentials;
  readonly draft: DraftService;
  readonly tools: ToolRouteSurface;
  readonly conversationFor: (job: JobRecord) => Promise<string>;
  readonly withCoordinatorStartGuard: <T>(jobId: string, work: () => Promise<T>) => Promise<T>;
}): RouteSurface {
  async function job(args: Readonly<Record<string, JsonValue>>): Promise<JobRecord> {
    const found = await deps.store().getJob(requiredString(args, 'job_id'));
    if (found === null) throw toros(ErrorCode.E_ENVELOPE_INVALID, 'Unknown job');
    return found;
  }

  const drain = async (request: IncomingMessage): Promise<void> => { await readBody(request).catch(() => undefined); };

  const browserStatus: OperatorHandler = async (request, response) => {
    await drain(request); send(response, 200, { worker: deps.chromeWorker().status() });
  };
  const browserPairing: OperatorHandler = async (request, response) => {
    await drain(request); send(response, 200, deps.chromeWorker().createPairingCode());
  };
  const browserAcquisitions: OperatorHandler = async (request, response) => {
    await drain(request); send(response, 200, { acquisitions: deps.browserAcquisitions().list() });
  };
  const browserAcquisitionCreate: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request));
    const sources = args['sources']; const fields = args['fields']; const documents = args['documents'];
    if (!Array.isArray(sources) || !Array.isArray(fields) || !Array.isArray(documents)) throw toros(ErrorCode.E_SCHEMA, 'sources, fields, and documents must be arrays');
    const input: BrowserAcquisitionInput = {
      name: requiredString(args, 'name'), workspace_id: requiredString(args, 'workspace_id'),
      site_profile: requiredString(args, 'site_profile') as BrowserAcquisitionInput['site_profile'],
      sources: sources.map((value) => { const source = asRecord(value); return { item_id: requiredString(source, 'item_id'), url: requiredString(source, 'url') }; }),
      fields: fields.map((value) => { const field = asRecord(value); const attribute = optionalString(field, 'attribute'); return { name: requiredString(field, 'name'), selector: requiredString(field, 'selector'), ...(attribute === null ? {} : { attribute }) }; }),
      documents: documents.map((value) => {
        const document = asRecord(value); const required = document['required'];
        if (typeof required !== 'boolean') throw toros(ErrorCode.E_SCHEMA, 'document.required must be a boolean');
        return { kind: requiredString(document, 'kind'), text_contains: stringArray(document, 'text_contains'), url_contains: stringArray(document, 'url_contains'), required, max_files: requiredPositiveInteger(document, 'max_files', 5) };
      }),
      min_delay_seconds: requiredPositiveInteger(args, 'min_delay_seconds', 3600),
      max_delay_seconds: requiredPositiveInteger(args, 'max_delay_seconds', 7200),
      max_attempts: requiredPositiveInteger(args, 'max_attempts', 10),
      max_backoff_minutes: requiredPositiveInteger(args, 'max_backoff_minutes', 1440),
      max_consecutive_rate_limits: requiredPositiveInteger(args, 'max_consecutive_rate_limits', 5),
      max_document_bytes: requiredPositiveInteger(args, 'max_document_bytes', 100 * 1024 * 1024),
    };
    send(response, 200, await deps.browserAcquisitions().create(input));
  };
  const browserControl = (operation: 'pause' | 'resume' | 'stop'): OperatorHandler => async (request, response) => {
    const args = asRecord(await readBody(request)); const id = requiredString(args, 'acquisition_id');
    const result = operation === 'pause' ? await deps.browserAcquisitions().pause(id)
      : operation === 'stop' ? await deps.browserAcquisitions().stopAcquisition(id)
        : await deps.browserAcquisitions().resume(id);
    send(response, 200, result);
  };
  const pipelines: OperatorHandler = async (request, response) => {
    await drain(request); send(response, 200, { pipelines: deps.stageGraphs().list() });
  };
  const pipelineCreate: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const stages = args['stages'];
    if (!Array.isArray(stages)) throw toros(ErrorCode.E_SCHEMA, 'stages must be an array');
    const input: CreateStageGraphInput = {
      objective: requiredString(args, 'objective'), workspace_id: requiredString(args, 'workspace_id'),
      deadline_minutes: requiredPositiveInteger(args, 'deadline_minutes', 24 * 60),
      stages: stages.map((value) => {
        const stage = asRecord(value); const actionRetries = stage['max_action_retries'];
        if (typeof actionRetries !== 'number' || !Number.isInteger(actionRetries) || actionRetries < 0 || actionRetries > 10) throw toros(ErrorCode.E_SCHEMA, 'max_action_retries must be an integer from 0 to 10');
        return {
          stage_id: requiredString(stage, 'stage_id') as CreateStageGraphInput['stages'][number]['stage_id'],
          adapter_id: requiredString(stage, 'adapter_id'), max_actions: requiredPositiveInteger(stage, 'max_actions', 100),
          max_action_retries: actionRetries, timeout_minutes: requiredPositiveInteger(stage, 'timeout_minutes', 12 * 60),
          max_attempts: requiredPositiveInteger(stage, 'max_attempts', 5),
        };
      }),
    };
    send(response, 200, await deps.stageGraphs().create(input));
  };
  const pipelineControl = (operation: 'pause' | 'resume' | 'stop'): OperatorHandler => async (request, response) => {
    const args = asRecord(await readBody(request)); const pipelineId = requiredString(args, 'pipeline_id');
    const graph = operation === 'pause' ? await deps.stageGraphs().pause(pipelineId)
      : operation === 'stop' ? await deps.stageGraphs().stopPipeline(pipelineId)
        : await deps.stageGraphs().resume(pipelineId, optionalString(args, 'operator_message') ?? undefined);
    send(response, 200, graph);
  };
  const catalog: OperatorHandler = async (request, response) => {
    await drain(request); send(response, 200, { capabilities: deps.registeredCapabilities(), workspaces: deps.workspaces.map((workspace) => workspace.id), agents: deps.draft.agents(), models: MODEL_PROFILES });
  };
  const jobs: OperatorHandler = async (request, response) => {
    await drain(request); send(response, 200, { jobs: await deps.store().listJobs() });
  };
  const createJob: OperatorHandler = async (request, response) => {
    send(response, 200, await deps.draft.createJobFromArgs(asRecord(await readBody(request))));
  };
  const archiveJob: OperatorHandler = async (request, response) => {
    const current = await job(asRecord(await readBody(request)));
    if (isTerminal(current.state)) { send(response, 200, current); return; }
    const stopped = await deps.coordinator?.stop(current.job_id);
    if (stopped !== null && stopped !== undefined) deps.runCredentials.revoke(stopped.run_id);
    send(response, 200, await deps.store().setJobState(current.job_id, 'cancelled'));
  };
  // Talk first. A conversation exists before any job does, costs nothing,
  // and touches nothing — which is what makes it safe to open one without
  // authoring an envelope.
  const conversationCreate: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request).catch(() => ({})));
    const conversation = await deps.store().createConversation({ conversation_id: randomUUID(), node_id: deps.node_id, title: (optionalString(args, 'title') ?? 'New conversation').slice(0, 60), state: 'open', agent: null, model: null });
    send(response, 200, conversation);
  };
  const conversations: OperatorHandler = async (request, response) => {
    await drain(request); send(response, 200, { conversations: (await deps.store().listConversations()).filter((conversation) => conversation.state === 'open') });
  };
  const conversationArchive: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const conversationId = requiredString(args, 'conversation_id');
    const current = await deps.store().getConversation(conversationId);
    if (current === null) throw toros(ErrorCode.E_SCHEMA, 'Unknown conversation');
    if (deps.coordinator?.status(conversationId)?.state === 'running') throw toros(ErrorCode.E_PARALLEL_ACTION, 'Hermes is still answering this conversation');
    send(response, 200, await deps.store().setConversationState(conversationId, 'archived'));
  };
  const conversationUsage: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const conversationId = requiredString(args, 'conversation_id');
    if (await deps.store().getConversation(conversationId) === null) throw toros(ErrorCode.E_SCHEMA, 'Unknown conversation');
    const records = await deps.store().listModelUsage(conversationId);
    send(response, 200, {
      records,
      summary: {
        prompt_tokens: records.reduce((sum, item) => sum + item.prompt_tokens, 0),
        completion_tokens: records.reduce((sum, item) => sum + item.completion_tokens, 0),
        total_tokens: records.reduce((sum, item) => sum + item.total_tokens, 0),
        cost_usd: records.some((item) => item.cost_usd !== null) ? records.reduce((sum, item) => sum + (item.cost_usd ?? 0), 0) : null,
      },
    });
  };
  const conversationTurns: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const conversationId = requiredString(args, 'conversation_id');
    if (await deps.store().getConversation(conversationId) === null) throw toros(ErrorCode.E_SCHEMA, 'Unknown conversation');
    send(response, 200, { turns: await deps.store().listTurns(conversationId) });
  };
  /**
   * Say something to Hermes. The operator's words are recorded first, then
   * an advisory run is started to answer them. An advisory run holds no job
   * and no capability: it can read this conversation, speak into it, and
   * propose. That is the whole of its reach.
   */
  const conversationSend: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const conversationId = requiredString(args, 'conversation_id');
    const conversation = await deps.store().getConversation(conversationId);
    if (conversation === null || conversation.state !== 'open') throw toros(ErrorCode.E_SCHEMA, 'Unknown or archived conversation');
    const message = requiredString(args, 'message');
    if (message.trim().length === 0 || Buffer.byteLength(message) > MAX_TURN_BYTES) throw toros(ErrorCode.E_SCHEMA, `message must contain 1 to ${MAX_TURN_BYTES} bytes`);
    const agent = optionalString(args, 'agent') ?? null;
    if (agent !== null && !deps.draft.agents().includes(agent)) throw toros(ErrorCode.E_NOT_REGISTERED, `Unknown agent: ${agent}`);
    const model = optionalString(args, 'model') ?? null;
    if (model !== null && !hasModelProfile(model)) throw toros(ErrorCode.E_NOT_REGISTERED, `Unknown model: ${model}`);
    const control = deps.coordinator;
    if (control === undefined) throw toros(ErrorCode.E_ADAPTER_FAILURE, 'Hermes coordinator is unavailable');
    await deps.conversationGuard.run(conversationId, async () => {
      if (control.status(conversationId)?.state === 'running') throw toros(ErrorCode.E_PARALLEL_ACTION, 'Hermes is still answering this conversation');
      await deps.store().appendTurn({ conversation_id: conversationId, role: 'operator', channel: 'human', content: deps.runCredentials.redactSecrets(message), job_id: null });
      await deps.store().setConversationPreferences(conversationId, agent, model);
      const runToken = deps.runCredentials.mint(null, conversationId, 'advisory', agent, model);
      const run = await control.start(conversationId, {
        run_token: runToken,
        conversation_id: conversationId,
        advisory: true,
        capabilities: deps.registeredCapabilities(),
        workspaces: deps.workspaces.map((workspace) => workspace.id),
        ...(agent === null ? {} : { agent }),
        ...(model === null ? {} : { model }),
      }).catch((cause: unknown) => { deps.runCredentials.bind(runToken, null); throw cause; });
      deps.runCredentials.bind(runToken, run.run_id);
      send(response, 200, { run });
    });
  };
  /** Seal exactly the live proposal Node Core recorded. */
  const acceptProposal: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const conversationId = requiredString(args, 'conversation_id');
    if (await deps.store().getConversation(conversationId) === null) throw toros(ErrorCode.E_SCHEMA, 'Unknown conversation');
    await deps.conversationGuard.run(conversationId, async () => {
      const created = await deps.draft.createJobFromArgs(await deps.draft.liveProposal(conversationId));
      const current = await deps.store().setJobConversation(created.job_id, conversationId);
      await deps.store().appendTurn({ conversation_id: conversationId, role: 'system', channel: 'human', content: `Job created: ${current.envelope.objective}`, job_id: current.job_id });
      send(response, 200, current);
    });
  };
  /**
   * Reject the current proposal without creating authority. The durable
   * human-channel turn consumes the proposal and leaves the conversation
   * open for a revised request.
   */
  const rejectProposal: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const conversationId = requiredString(args, 'conversation_id');
    if (await deps.store().getConversation(conversationId) === null) throw toros(ErrorCode.E_SCHEMA, 'Unknown conversation');
    await deps.conversationGuard.run(conversationId, async () => {
      await deps.draft.liveProposal(conversationId);
      await deps.store().appendTurn({ conversation_id: conversationId, role: 'system', channel: 'human', content: 'Proposal rejected. Continue the conversation to revise it.', job_id: null });
      send(response, 200, { rejected: true });
    });
  };
  // The operator reads a conversation by job. Durable turns are the
  // transcript; a coordinator run's in-memory output is not.
  const conversation: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const current = await job(args); const after = args['after'];
    if (after !== undefined && after !== null && (typeof after !== 'number' || !Number.isInteger(after) || after < 0)) throw toros(ErrorCode.E_SCHEMA, 'after must be a non-negative integer');
    send(response, 200, { conversation_id: current.conversation_id, turns: current.conversation_id === null ? [] : await deps.store().listTurns(current.conversation_id, typeof after === 'number' ? { after } : {}) });
  };
  const hermesStatus: OperatorHandler = async (request, response) => {
    const current = await job(asRecord(await readBody(request))); send(response, 200, { run: deps.coordinator?.status(current.job_id) ?? null });
  };
  const hermesStart: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request));
    const jobId = requiredString(args, 'job_id');
    await deps.withCoordinatorStartGuard(jobId, async () => {
      const current = await job(args);
      const approvalId = optionalString(args, 'approval_id');
      if (approvalId !== null && approvalId.length === 0) throw toros(ErrorCode.E_SCHEMA, 'approval_id must not be empty');
      // Preserve the ordinary start's terminal precheck. Approval replay is the
      // deliberate exception: current policy must produce the denial receipt.
      if (approvalId === null && isTerminal(current.state)) throw toros(ErrorCode.E_JOB_TERMINAL, `The job is ${current.state}`);
      const control = deps.coordinator;
      if (control === undefined) throw toros(ErrorCode.E_ADAPTER_FAILURE, 'Hermes coordinator is unavailable');
      const operatorMessage = optionalString(args, 'operator_message');
      if (operatorMessage !== null && (operatorMessage.trim().length === 0 || Buffer.byteLength(operatorMessage) > 8 * 1024)) throw toros(ErrorCode.E_SCHEMA, 'operator_message must contain 1 to 8192 bytes');
      if (control.status(current.job_id)?.state === 'running') throw toros(ErrorCode.E_PARALLEL_ACTION, 'Hermes is already running for this job');
      if (approvalId !== null) {
        // Lookup is non-spending; policy consumes the grant inside the ordinary
        // action pipeline. Await the complete receipt chain before any
        // conversation mutation, run credential, or coordinator process exists.
        await deps.actionPipeline.replay(approvalId, current.job_id);
      }
      const conversationId = await deps.conversationFor(current);
      const conversationRecord = await deps.store().getConversation(conversationId);
      // Redact ONCE, and let the child see exactly what was stored. Storing a
      // redacted copy while handing the original to the coordinator put the
      // raw credential into model context and broke the rehydration
      // comparison, so the same reply arrived twice in two different forms.
      const storedMessage = operatorMessage === null ? null : deps.runCredentials.redactSecrets(operatorMessage);
      if (storedMessage !== null) await deps.store().appendTurn({ conversation_id: conversationId, role: 'operator', channel: 'human', content: storedMessage, job_id: current.job_id });
      // One credential, one run. It authorises exactly this run's access to
      // exactly this conversation and is revoked the moment the run ends.
      const runToken = deps.runCredentials.mint(current.job_id, conversationId, 'job', conversationRecord?.agent ?? null, conversationRecord?.model ?? null);
      const run = await control.start(current.job_id, { run_token: runToken, conversation_id: conversationId, ...(storedMessage === null ? {} : { operator_message: storedMessage }), ...(conversationRecord?.model === null || conversationRecord?.model === undefined ? {} : { model: conversationRecord.model }) })
        .catch((cause: unknown) => { deps.runCredentials.bind(runToken, null); throw cause; });
      deps.runCredentials.bind(runToken, run.run_id);
      send(response, 200, { run });
    });
  };
  const hermesStop: OperatorHandler = async (request, response) => {
    const current = await job(asRecord(await readBody(request))); const control = deps.coordinator;
    if (control === undefined) throw toros(ErrorCode.E_ADAPTER_FAILURE, 'Hermes coordinator is unavailable');
    const stopped = await control.stop(current.job_id);
    // Revoke the run that was actually stopped. The supervisor also
    // announces the end, so this is belt and braces rather than the only
    // path — but it must name the run, not the key it lived under.
    if (stopped !== null) deps.runCredentials.revoke(stopped.run_id);
    send(response, 200, { run: stopped });
  };
  const checkpoint: OperatorHandler = async (request, response) => {
    send(response, 200, await deps.tools.dispatch('create_checkpoint', asRecord(await readBody(request))));
  };
  const findings: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); send(response, 200, { findings: await deps.store().listFindings(requiredString(args, 'job_id')) });
  };
  const approvals: OperatorHandler = async (request, response) => {
    // Drain the body even though nothing is read from it. An unread request
    // stream keeps a keep-alive socket occupied, so a client that POSTs a
    // body here hangs on its next request.
    await drain(request);
    // The pending records carry their full arguments. That is the point:
    // an operator deciding from a digest alone is taking the coordinator's
    // word for what the action does, and the coordinator is the party the
    // gate exists to constrain.
    send(response, 200, { pending: deps.approvals.pending(new Date()) });
  };
  const approve: OperatorHandler = async (request, response) => {
    const args = asRecord(await readBody(request)); const approvalId = requiredString(args, 'approval_id'); const currentTime = new Date();
    const target = deps.approvals.find(approvalId, currentTime);
    if (target === null) { send(response, 404, { error: ErrorCode.E_APPROVAL_INVALID, message: 'Unknown or expired approval' }); return; }
    // Already granted: report it without appending a second
    // `approval.resolved`. One decision, one event — repeating the call
    // used to write a duplicate every time, so the log implied the operator
    // had decided repeatedly.
    if (target.approved) { send(response, 200, { ...target, already_approved: true }); return; }
        // AUDIT FIRST, then grant.
        //
        // The previous order flipped `approved` and then appended. A transient
        // append failure returned an error to the operator while leaving the
        // approval spendable in memory, so the action could later run with no
        // `approval.resolved` in the log — an executed high-impact action whose
        // human decision the record does not contain. Granting is now
        // contingent on the audit having been written.
    await deps.store().appendEvent({
      node_id: deps.node_id, job_id: target.binding.job_id, kind: 'approval.resolved',
      payload: { approval_id: target.approval_id, capability: target.binding.capability, arguments_digest: target.binding.arguments_digest, approved: true, expires_at: target.expires_at },
    });
    const granted = deps.approvals.approve(approvalId, currentTime);
    if (granted === null) {
      // It expired or was spent between the lookup and the append. The
      // event now describes a decision that cannot be exercised, which is
      // the safe direction: the log over-records rather than under-records.
      send(response, 404, { error: ErrorCode.E_APPROVAL_INVALID, message: 'The approval expired before it could be granted' });
      return;
    }
    send(response, 200, granted.request);
  };

  const routes: Record<string, OperatorHandler> = {
    browser_status: browserStatus,
    browser_pairing: browserPairing,
    browser_acquisitions: browserAcquisitions,
    browser_acquisition_create: browserAcquisitionCreate,
    browser_acquisition_pause: browserControl('pause'),
    browser_acquisition_resume: browserControl('resume'),
    browser_acquisition_stop: browserControl('stop'),
    pipelines,
    pipeline_create: pipelineCreate,
    pipeline_pause: pipelineControl('pause'),
    pipeline_resume: pipelineControl('resume'),
    pipeline_stop: pipelineControl('stop'),
    catalog,
    jobs,
    create_job: createJob,
    job_archive: archiveJob,
    conversation_create: conversationCreate,
    conversations,
    conversation_turns: conversationTurns,
    conversation_send: conversationSend,
    conversation_archive: conversationArchive,
    conversation_usage: conversationUsage,
    accept_proposal: acceptProposal,
    reject_proposal: rejectProposal,
    conversation,
    hermes_status: hermesStatus,
    hermes_start: hermesStart,
    hermes_stop: hermesStop,
    checkpoint,
    findings,
    approvals,
    approve,
  };

  return {
    async handle(operation, request, response): Promise<void> {
      try {
        if (operation === undefined || !Object.prototype.hasOwnProperty.call(routes, operation)) {
          send(response, 404, { error: 'Not found' });
          return;
        }
        const handler = routes[operation]!;
        await handler(request, response);
      } catch (error: unknown) {
        const e = error instanceof TorosError ? error
          : error instanceof Error ? toros(ErrorCode.E_ADAPTER_FAILURE, error.message)
            : toros(ErrorCode.E_ADAPTER_FAILURE, String(error));
        const status = e.detail['body_too_large'] === true ? 413 : e.code === ErrorCode.E_PARALLEL_ACTION ? 409 : 400;
        send(response, status, { error: e.code, message: e.message });
      }
    },
  };
}
