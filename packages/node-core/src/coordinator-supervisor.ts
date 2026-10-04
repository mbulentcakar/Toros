import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync } from 'node:fs';

export type CoordinatorRunState =
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'finished'
  | 'failed'
  | 'stopped';

export interface CoordinatorMessage {
  readonly seq: number;
  readonly role: 'hermes' | 'system';
  readonly text: string;
  readonly recorded_at: string;
}

export interface CoordinatorRun {
  readonly run_id: string;
  readonly job_id: string;
  readonly state: CoordinatorRunState;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly exit_code: number | null;
  readonly messages: readonly CoordinatorMessage[];
}

export interface CoordinatorStartInput {
  readonly operator_message?: string;
  /**
   * A per-run credential minted by Node Core. It is the only thing that lets
   * this run reach its own conversation, and it dies with the run.
   */
  readonly run_token?: string;
  readonly conversation_id?: string;
  /**
   * An advisory run: no job, no capability, and a coordinator that can only
   * talk and propose. Started keyed by conversation rather than by job.
   */
  readonly advisory?: boolean;
  /** What this machine has, so an advisory run can draft against it. */
  readonly capabilities?: readonly string[];
  readonly workspaces?: readonly string[];
  /** The CLI agent family chosen for this advisory run. */
  readonly agent?: string;
  /** API model chosen from Node Core's bounded catalogue. */
  readonly model?: string;
}

export interface CoordinatorControl {
  start(jobId: string, input?: CoordinatorStartInput): Promise<CoordinatorRun>;
  status(jobId: string): CoordinatorRun | null;
  stop(jobId: string): Promise<CoordinatorRun | null>;
  stopAll(): Promise<void>;
  /**
   * Register a listener called with the `run_id` of a run whose process is
   * gone, however it went — clean exit, spawn error, stop, or shutdown.
   *
   * It is the run id and not the key deliberately. A later run can occupy the
   * same key while an earlier one is still terminating, and revoking by key
   * would take the live replacement's credential down with the corpse.
   */
  onRunEnded(listener: (runId: string) => void): void;
}

interface MutableRun {
  run_id: string;
  job_id: string;
  state: CoordinatorRunState;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  messages: CoordinatorMessage[];
  child: ChildProcessWithoutNullStreams | null;
}

const MAX_MESSAGES = 200;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_FINISHED_RUNS = 64;
const STOP_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;

function publicRun(run: MutableRun): CoordinatorRun {
  return {
    run_id: run.run_id,
    job_id: run.job_id,
    state: run.state,
    started_at: run.started_at,
    ended_at: run.ended_at,
    exit_code: run.exit_code,
    messages: [...run.messages],
  };
}

export function bounded(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MESSAGE_BYTES) return text;
  // Binary-search the greatest character index whose UTF-8 prefix is <= limit.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid)) <= MAX_MESSAGE_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // The search works in UTF-16 code units, so the fitting prefix can end
  // between the two halves of a surrogate pair. Encoding a lone surrogate
  // yields U+FFFD, which is the same corruption the byte-slice version caused,
  // one layer up. Back off the orphan.
  const lastUnit = low > 0 ? text.charCodeAt(low - 1) : 0;
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) low -= 1;
  return `${text.slice(0, low)}\n...[truncated]`;
}

async function terminate(child: ChildProcessWithoutNullStreams, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    let stopTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (stopTimer !== null) clearTimeout(stopTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      child.off('exit', finish);
      resolve();
    };
    stopTimer = setTimeout(() => {
      child.off('exit', finish);
      child.kill('SIGKILL');
      killTimer = setTimeout(finish, KILL_GRACE_MS);
      child.once('exit', () => {
        if (killTimer !== null) clearTimeout(killTimer);
        finish();
      });
    }, timeoutMs);
    child.once('exit', finish);
    child.kill();
  });
}

export function createCoordinatorSupervisor(entryPath: string): CoordinatorControl {
  try {
    accessSync(entryPath);
  } catch {
    throw new Error(`coordinator_entry does not exist: ${entryPath}`);
  }

  const runs = new Map<string, MutableRun>();
  const finishedOrder: string[] = [];
  const endedListeners: Array<(runId: string) => void> = [];

  function announceEnded(key: string): void {
    for (const listener of endedListeners) {
      try { listener(key); } catch { /* a listener must not keep a process alive */ }
    }
  }

  function append(run: MutableRun, role: CoordinatorMessage['role'], text: string): void {
    const normalized = bounded(text.trim());
    if (normalized.length === 0) return;
    run.messages.push({
      seq: (run.messages.at(-1)?.seq ?? 0) + 1,
      role,
      text: normalized,
      recorded_at: new Date().toISOString(),
    });
    if (run.messages.length > MAX_MESSAGES) run.messages.splice(0, run.messages.length - MAX_MESSAGES);
  }

  function collect(run: MutableRun, role: CoordinatorMessage['role'], stream: NodeJS.ReadableStream): void {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) append(run, role, line);
    });
    stream.on('end', () => append(run, role, pending));
  }

  function finishRun(run: MutableRun): void {
    if (runs.get(run.job_id) !== run) return;
    const idx = finishedOrder.indexOf(run.job_id);
    if (idx !== -1) finishedOrder.splice(idx, 1);
    finishedOrder.push(run.job_id);
    while (finishedOrder.length > MAX_FINISHED_RUNS) {
      const evict = finishedOrder.shift();
      if (evict !== undefined) runs.delete(evict);
    }
  }

  return {
    async start(jobId, input = {}) {
      const existing = runs.get(jobId);
      if (existing?.state === 'running') throw new Error('Hermes is already running for this job');

      // An advisory run has no job to name. The key it is stored under is its
      // conversation, and the child is told only that it is advisory — its
      // conversation arrives over stdin with the credential that reaches it.
      const args = input.advisory === true ? [entryPath, '--advisory'] : [entryPath, jobId];
      const child = spawn(process.execPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const run: MutableRun = {
        run_id: randomUUID(),
        job_id: jobId,
        state: 'running',
        started_at: new Date().toISOString(),
        ended_at: null,
        exit_code: null,
        messages: [],
        child,
      };
      runs.set(jobId, run);
      const idx = finishedOrder.indexOf(jobId);
      if (idx !== -1) finishedOrder.splice(idx, 1);
      // The whole start context goes over stdin as one JSON object: the run
      // token is a credential and the clarification is operator text, and
      // neither belongs in a command line any process listing can read.
      if (input.operator_message !== undefined) {
        append(run, 'system', `Operator replied: ${input.operator_message}`);
      }
      child.stdin.end(JSON.stringify({
        ...(input.run_token === undefined ? {} : { run_token: input.run_token }),
        ...(input.conversation_id === undefined ? {} : { conversation_id: input.conversation_id }),
        ...(input.operator_message === undefined ? {} : { operator_message: input.operator_message }),
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
        ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model }),
      }));
      collect(run, 'hermes', child.stdout);
      collect(run, 'system', child.stderr);
      child.once('error', (error) => {
        append(run, 'system', error.message);
        run.state = 'failed';
        run.ended_at = new Date().toISOString();
        run.child = null;
        finishRun(run); announceEnded(run.run_id);
      });
      child.once('exit', (code) => {
        run.exit_code = code;
        run.ended_at = new Date().toISOString();
        run.child = null;
        if (run.state !== 'stopped') {
          run.state = code === 0 ? 'finished'
            : code === 3 ? 'waiting_for_input'
            : code === 6 ? 'waiting_for_approval'
            : 'failed';
        }
        finishRun(run); announceEnded(run.run_id);
      });
      return publicRun(run);
    },

    status(jobId) {
      const run = runs.get(jobId);
      return run === undefined ? null : publicRun(run);
    },

    async stop(jobId) {
      const run = runs.get(jobId);
      if (run === undefined) return null;
      if (run.child !== null) {
        run.state = 'stopped';
        run.ended_at = new Date().toISOString();
        const child = run.child;
        run.child = null;
        await terminate(child);
        finishRun(run); announceEnded(run.run_id);
      }
      return publicRun(run);
    },

    onRunEnded(listener) { endedListeners.push(listener); },

    async stopAll() {
      const pending: Promise<void>[] = [];
      for (const run of runs.values()) {
        if (run.child !== null) {
          run.state = 'stopped';
          run.ended_at = new Date().toISOString();
          const child = run.child;
          run.child = null;
          pending.push(terminate(child));
        }
      }
      await Promise.all(pending);
      // Shutdown ends runs too, and a credential must not survive one.
      for (const run of runs.values()) announceEnded(run.run_id);
      runs.clear();
      finishedOrder.length = 0;
    },
  };
}
