import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ActionResult,
  AdapterContext,
  AdapterManifest,
  JsonValue,
  SessionAdapter,
} from '@toros/contracts';
import { ErrorCode, TorosError } from '@toros/contracts';

/**
 * A CLI session is a CONVERSATION, not a live process.
 *
 * The original design held one child process open and wrote a line per
 * exchange, which is a line-oriented REPL contract. Neither CLI provides one:
 * `codex exec` reads stdin to EOF before it starts, and `claude` is either a
 * one-shot `--print` or a full-screen TUI. Against the real binaries every
 * `send` blocked until the 120 s timeout without the CLI ever running — see
 * `docs/finding-cli-adapter-one-shot.md`.
 *
 * So a session now owns a working directory and the CLI's own conversation id,
 * and each exchange spawns a fresh process: write the message to stdin, close
 * it, and wait for exit. Continuation is the CLI's own resume mechanism, which
 * is what makes a stateless spawn add up to a conversation.
 *
 * The tool surface above this is unchanged. `start_cli`, `send_cli`,
 * `read_cli`, `interrupt_cli` and `stop_cli` keep their exact shapes; the whole
 * change lives below the contract line.
 */

export interface CliAdapterOptions {
  readonly executable: string;
  /**
   * Arguments placed immediately after the executable and before the CLI
   * framing. Production binaries normally leave this empty. It exists so a
   * hermetic protocol fixture can be launched as `node fixture.js <cli args>`
   * without teaching the adapter a third, fictional CLI protocol.
   */
  readonly launcher_args?: readonly string[];
  /**
   * Extra flags inserted into every exchange, before the stdin marker. The
   * framing below supplies the flags that are load-bearing (`--json`, resume,
   * `--skip-git-repo-check`); these are the operator's additions, e.g. `-m`.
   *
   * NOTE: this is no longer the whole argv. A config carrying `["exec"]` from
   * the previous model must be emptied, or codex is invoked as `exec exec`.
   *
   * Security-policy switches are refused at init: callers may choose a model
   * or settings file, but may not override the sandbox and permission mode the
   * adapter pins before these arguments.
   */
  readonly args: readonly string[];
  readonly timeout_ms: number;
  /** Maximum wall time of one background agent exchange. */
  readonly exchange_timeout_ms?: number;
  /** Maximum time a read waits for new output or exchange completion. */
  readonly read_poll_ms?: number;
  readonly output_limit_bytes: number;
  /** Explicit runtime directories prepended to the worker's minimal PATH. */
  readonly runtime_paths?: readonly string[];
  /**
   * The worker's OWN sandbox, pinned explicitly. Defaults to `workspace-write`,
   * which confines the CLI's writes to the session directory.
   *
   * Pinned rather than inherited on purpose. SPEC §8.1 records that Toros
   * bounds its own tool surface and not the worker's behaviour; leaving this to
   * the CLI's default means a version bump can silently widen what a worker may
   * do, with nothing in Toros changing. `danger-full-access` is refused at init
   * — an adapter that can turn its own sandbox off is not a boundary.
   */
  readonly sandbox?: SandboxMode;
}

export type SandboxMode = 'read-only' | 'workspace-write';

/**
 * What differs between the two CLIs, and nothing else. Process management,
 * termination, limits and cursors are shared because they genuinely are.
 */
type CliId = 'claude' | 'codex' | 'gemini' | 'grok';

interface CliFraming {
  /** argv for one exchange. The message goes to stdin, which is then closed. */
  exchange(conversationId: string | null, extra: readonly string[], sandbox: SandboxMode, promptFile: string | null): readonly string[];
  /** Encode the operator message for stdin. Grok reads its prompt from a file. */
  stdin(message: string): string;
  /** Grok requires a prompt argument, so its transient prompt file is explicit. */
  readonly usesPromptFile?: boolean;
  /** The CLI's own conversation id, if this output line announces one. */
  conversationId(line: string): string | null;
  /** The part of this line a coordinator should read, if any. */
  text(line: string): string | null;
  /**
   * When true, `text()` output is appended exactly as returned and the framing
   * supplies its own line breaks. For a CLI that streams a reply as token
   * fragments, appending a newline per event would split one answer across
   * many lines.
   */
  readonly verbatim?: boolean;
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    // Diagnostics interleave with the JSON stream — codex writes a models-cache
    // warning to stderr. A line that does not parse is not an error; it is not
    // an event either, so it belongs in the raw log and nowhere else.
    return null;
  }
}

/**
 * `codex exec --json` emits JSONL: `thread.started` carrying `thread_id`, then
 * `item.completed` per message, then `turn.completed`. Verified against
 * codex-cli 0.145.0 on 2026-08-08, including that `exec resume <id>` replays
 * the prior context.
 *
 * `--skip-git-repo-check` is required on BOTH the first exchange and every
 * resume: a session directory under the workspace is not a git repository, and
 * without the flag codex refuses to start at all.
 */
const CODEX_FRAMING: CliFraming = {
  exchange(conversationId, extra, sandbox) {
    // Both halves are required for a non-interactive run that can do work:
    // the sandbox permits the write, and `approval_policy=never` stops codex
    // waiting for a human who is not there. Verified 2026-08-08 — without them
    // a write fails with "blocked by read-only sandbox; rejected by user
    // approval settings" and the turn completes as if it had succeeded.
    //
    // ORDER MATTERS: these belong to `exec`, not to `resume`, and codex rejects
    // them after the subcommand with "unexpected argument '-s' found".
    const policy = ['exec', '-s', sandbox, '-c', 'approval_policy="never"'];
    const resume = conversationId === null ? [] : ['resume', conversationId];
    return [...policy, ...resume, '--json', '--skip-git-repo-check', ...extra, '-'];
  },
  stdin(message) { return message; },
  conversationId(line) {
    const event = parseLine(line);
    if (event === null || event['type'] !== 'thread.started') return null;
    const id = event['thread_id'];
    return typeof id === 'string' ? id : null;
  },
  text(line) {
    const event = parseLine(line);
    if (event === null) return null;
    if (event['type'] === 'item.completed') {
      const item = event['item'];
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        const text = record['text'];
        if (typeof text === 'string') return text;
      }
      return null;
    }
    if (event['type'] === 'turn.failed') return JSON.stringify(event);
    return null;
  },
};

/**
 * Verified against the real binary by `test/real-claude.test.ts`: stream-json
 * emits the session id and assistant text this parser consumes, and `--resume`
 * continues the same conversation on the next one-shot exchange.
 *
 * These permission modes are Claude policy, not an OS sandbox. They reduce the
 * worker's allowed behaviour, but SPEC 8.1 remains the security boundary:
 * Phase 1 bounds Toros's own tool surface and does not confine worker processes.
 */
const CLAUDE_FRAMING: CliFraming = {
  exchange(conversationId, extra, sandbox) {
    const base = ['--print', '--output-format', 'stream-json', '--verbose'];
    // The nearest Claude policy equivalent of the codex sandbox pin.
    const policy = sandbox === 'read-only' ? ['--permission-mode', 'plan'] : ['--permission-mode', 'acceptEdits'];
    return conversationId === null
      ? [...base, ...policy, ...extra]
      : [...base, ...policy, '--resume', conversationId, ...extra];
  },
  stdin(message) { return message; },
  conversationId(line) {
    const event = parseLine(line);
    if (event === null) return null;
    const id = event['session_id'];
    return typeof id === 'string' ? id : null;
  },
  text(line) {
    const event = parseLine(line);
    if (event === null) return null;
    if (event['type'] !== 'assistant') return null;
    const message = event['message'];
    if (typeof message !== 'object' || message === null) return null;
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) return null;
    const text = content.flatMap((block) => {
      if (typeof block !== 'object' || block === null) return [];
      const record = block as Record<string, unknown>;
      return record['type'] === 'text' && typeof record['text'] === 'string'
        ? [record['text']]
        : [];
    });
    return text.length === 0 ? null : text.join('');
  },
};

/**
 * Antigravity CLI 1.1.22. `stream-json` is the only verified transport that
 * keeps large prompts off the Windows command line. A fresh process consumes
 * one user event from stdin; `--conversation` resumes the recorded context.
 */
const GEMINI_FRAMING: CliFraming = {
  exchange(conversationId, extra, sandbox) {
    const policy = ['--sandbox', '--mode', sandbox === 'read-only' ? 'plan' : 'accept-edits'];
    const resume = conversationId === null ? [] : ['--conversation', conversationId];
    return [...resume, '--input-format', 'stream-json', '--output-format', 'stream-json', ...policy, ...extra];
  },
  stdin(message) {
    return `${JSON.stringify({ event: 'user', message: { role: 'user', content: message } })}\n`;
  },
  conversationId(line) {
    const event = parseLine(line);
    if (event === null || event['event'] !== 'init') return null;
    const id = event['conversation_id'];
    return typeof id === 'string' ? id : null;
  },
  text(line) {
    const event = parseLine(line);
    if (event === null || event['event'] !== 'result') return null;
    const result = event['result'];
    if (typeof result !== 'object' || result === null) return null;
    const response = (result as Record<string, unknown>)['response'];
    return typeof response === 'string' ? response.trimEnd() : null;
  },
};

/**
 * Grok Build 1.0.13–1.0.40. The CLI accepts a prompt file rather than stdin
 * and resumes with `--resume <sessionId>`. The prompt file is deleted as soon
 * as the process exits; raw prompts are not retained by Toros.
 *
 * 1.0.13 emitted the reply as one `text` event; 1.0.40 streams it as one
 * `text` event per token (`"P"`, `"ONG"`). Fragments are therefore appended
 * verbatim and the reply line is closed at the `end` event, which both
 * versions emit last.
 */
const GROK_FRAMING: CliFraming = {
  usesPromptFile: true,
  verbatim: true,
  exchange(conversationId, extra, sandbox, promptFile) {
    if (promptFile === null) throw adapterFailure('Grok exchange requires a prompt file');
    // A headless Grok cannot ask, and in `plan` mode every shell command asks:
    // the CLI records "User cancelled the execution" and ends the whole turn
    // as `cancelled` with no answer (observed 1.0.40, JanBot 2026-09-21, on
    // `git rev-parse HEAD`). A read-only worker therefore gets no shell tool
    // at all; `read_file`, `grep`, and `list_dir` never ask. Workspace mode
    // keeps the shell, where `dontAsk` auto-approves ordinary commands.
    const policy = [
      '--permission-mode', sandbox === 'read-only' ? 'plan' : 'dontAsk',
      '--sandbox', sandbox === 'read-only' ? 'read-only' : 'workspace',
      '--no-subagents', '--no-auto-update',
      ...(sandbox === 'read-only' ? ['--disallowed-tools', 'run_terminal_cmd'] : []),
    ];
    const resume = conversationId === null ? [] : ['--resume', conversationId];
    return [...resume, '--prompt-file', promptFile, '--output-format', 'streaming-json', ...policy, ...extra];
  },
  stdin() { return ''; },
  conversationId(line) {
    const event = parseLine(line);
    if (event?.['type'] !== 'end') return null;
    const id = event['sessionId'];
    return typeof id === 'string' ? id : null;
  },
  text(line) {
    const event = parseLine(line);
    if (event?.['type'] === 'end') return '\n';
    if (event?.['type'] !== 'text') return null;
    const value = event['data'];
    return typeof value === 'string' ? value : null;
  },
};

/** One spawned exchange. Termination is per-run, because the process is. */
interface Run {
  readonly child: ChildProcessWithoutNullStreams;
  close_promise: Promise<void>;
  kill_promise: Promise<void> | null;
  /** Set by the child's own `close`, so it is the only evidence it exited. */
  exited: boolean;
  /** Set when the child outlived every termination attempt. */
  orphaned: boolean;
  exit_code: number | null;
  signal: string | null;
  readonly exchange: number;
  readonly prompt_file: string | null;
  state: 'running' | 'succeeded' | 'failed' | 'interrupted';
  error: TorosError | null;
  raw: string;
  timeout: NodeJS.Timeout | null;
  completion: Promise<void>;
}

interface Session {
  readonly id: string;
  readonly context: AdapterContext;
  readonly cwd: string;
  /** Rendered text the coordinator reads, accumulated across exchanges. */
  readonly bytes: Buffer[];
  bytes_total: number;
  /** The CLI's own conversation id, learned from the first exchange. */
  conversation_id: string | null;
  exchanges: number;
  run: Run | null;
  last_run: Run | null;
  closed: boolean;
  terminal_error: TorosError | null;
  abort_listener: (() => void) | null;
  readonly read_waiters: Set<() => void>;
}

/**
 * Termination is escalating and bounded: each attempt is followed by a wait for
 * a real `close`, and only a real `close` ends it.
 *
 * `kill` is awaited by callers that treat its return as "the child is gone" —
 * Node Core releases the per-job lock as soon as the action settles, and the
 * next action may reuse the same session directory. So `kill` must never
 * resolve on a timer standing in for process death. It must, however, still
 * terminate, hence a fixed number of attempts and an explicit orphan outcome
 * rather than an unbounded wait.
 */
const KILL_GRACE_MS = 5_000;
const KILL_ATTEMPTS = 2;

const INPUT_START: JsonValue = { type: 'object', additionalProperties: false };
const INPUT_SEND: JsonValue = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};
const INPUT_READ: JsonValue = {
  type: 'object',
  properties: { cursor: { type: 'integer', minimum: 0 } },
  required: ['cursor'],
  additionalProperties: false,
};
const INPUT_EMPTY: JsonValue = { type: 'object', additionalProperties: false };

function manifest(id: CliId, timeout_ms: number, output_limit_bytes: number): AdapterManifest {
  return {
    id,
    version: '0.2.0',
    platforms: ['win32'],
    actions: [
      { id: 'start', summary: 'Open a CLI conversation', input_schema: INPUT_START, path_fields: [], mutates: true, always_requires_approval: false, timeout_ms, output_limit_bytes },
      { id: 'send', summary: 'Start a CLI exchange in the background', input_schema: INPUT_SEND, path_fields: [], mutates: true, always_requires_approval: false, timeout_ms, output_limit_bytes },
      { id: 'read', summary: 'Long-poll incremental CLI output and exchange state', input_schema: INPUT_READ, path_fields: [], mutates: false, always_requires_approval: false, timeout_ms, output_limit_bytes },
      { id: 'interrupt', summary: 'Terminate the exchange currently running', input_schema: INPUT_EMPTY, path_fields: [], mutates: true, always_requires_approval: false, timeout_ms, output_limit_bytes },
      { id: 'stop', summary: 'Close the conversation and its process tree', input_schema: INPUT_EMPTY, path_fields: [], mutates: true, always_requires_approval: false, timeout_ms, output_limit_bytes },
    ],
    required_permissions: ['process.spawn', 'fs.read', 'fs.write'],
    allowed_resources: [],
    default_timeout_ms: timeout_ms,
    cancellation: 'kill',
    receipt_fields: ['exit_code', 'signal', 'bytes_read', 'truncated', 'conversation_id', 'exchange', 'exchange_state', 'exchange_error'],
  };
}

function adapterFailure(message: string): TorosError {
  return new TorosError(ErrorCode.E_ADAPTER_FAILURE, message);
}

function sessionError(): TorosError {
  return new TorosError(ErrorCode.E_SESSION_UNKNOWN, 'Unknown CLI session');
}

function asSessionId(ctx: AdapterContext): string {
  return ctx.session_id ?? randomUUID();
}

function minimalEnvironment(runtimePaths: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // PATHEXT is the Windows table that resolves `git` to `git.exe`. Without it
  // a worker's shell finds nothing by name, however complete PATH is — Grok's
  // PowerShell reported "Git isn't on PATH" with Git on PATH. It names no
  // credential and no location, so it stays inside SPEC §8.1.
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'USERPROFILE']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (runtimePaths.length > 0) {
    environment['PATH'] = [...runtimePaths, environment['PATH'] ?? ''].filter((part) => part.length > 0).join(delimiter);
  }
  return environment;
}

function isAbortError(error: unknown): error is TorosError {
  return error instanceof TorosError && error.code === ErrorCode.E_CANCELLED;
}

class CliSessionAdapter implements SessionAdapter {
  readonly manifest: AdapterManifest;
  private readonly options: CliAdapterOptions;
  private readonly framing: CliFraming;
  private readonly sessions = new Map<string, Session>();
  private initialized = false;

  constructor(id: CliId, options: CliAdapterOptions) {
    this.options = options;
    this.framing = id === 'codex' ? CODEX_FRAMING
      : id === 'claude' ? CLAUDE_FRAMING
        : id === 'gemini' ? GEMINI_FRAMING
          : GROK_FRAMING;
    this.manifest = manifest(id, options.timeout_ms, options.output_limit_bytes);
  }

  async init(): Promise<void> {
    const executable = this.options.executable.toLowerCase();
    const isNodeRuntime = this.options.executable === process.execPath;
    if (executable.endsWith('.cmd') || executable.endsWith('.bat') || (!executable.endsWith('.exe') && !isNodeRuntime)) {
      throw adapterFailure('CLI executable must be a real .exe file');
    }
    if (!Number.isFinite(this.options.timeout_ms) || this.options.timeout_ms <= 0 || !Number.isInteger(this.options.output_limit_bytes) || this.options.output_limit_bytes < 0) {
      throw adapterFailure('Invalid CLI adapter limits');
    }
    const exchangeTimeout = this.options.exchange_timeout_ms ?? this.options.timeout_ms;
    const readPoll = this.options.read_poll_ms ?? 20_000;
    if (!Number.isFinite(exchangeTimeout) || exchangeTimeout <= 0 || !Number.isFinite(readPoll) || readPoll <= 0) {
      throw adapterFailure('Invalid CLI exchange timing');
    }
    for (const path of this.options.runtime_paths ?? []) {
      if (!isAbsolute(path) || path.includes('\0')) throw adapterFailure(`Runtime path must be absolute: ${path}`);
      try {
        if (!(await stat(path)).isDirectory()) throw adapterFailure(`Runtime path is not a directory: ${path}`);
      } catch (error: unknown) {
        if (error instanceof TorosError) throw error;
        throw adapterFailure(`Runtime path is unavailable: ${path}`);
      }
    }
    const policyFlags = ['--permission-mode', '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions', '--always-approve', '--yolo',
      '--allow', '--deny', '--tools', '--disallowed-tools', '--mode',
      '-s', '--sandbox', '-a', '--ask-for-approval', '-c', '--config'];
    const override = this.options.args.find((arg) => policyFlags.some(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    ));
    if (override !== undefined) throw adapterFailure(`CLI security policy argument is reserved: ${override}`);

    const sandbox = this.options.sandbox ?? 'workspace-write';
    if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
      throw adapterFailure(`Unsupported sandbox mode: ${String(sandbox)}`);
    }
    this.initialized = true;
  }

  /**
   * Opening a conversation spawns nothing. There is no process to report a pid
   * for between exchanges, and inventing one would make the session record
   * assert something false — `SessionRecord.pid` is already nullable for
   * exactly this case.
   */
  async start(ctx: AdapterContext): Promise<{ readonly pid: number }> {
    this.requireInitialized();
    const id = asSessionId(ctx);
    if (this.sessions.has(id)) throw adapterFailure('Session already exists');
    const cwd = join(ctx.workspace.root, ctx.correlation_id);
    await mkdir(cwd, { recursive: true });
    const session: Session = {
      id, context: ctx, cwd, bytes: [], bytes_total: 0,
      conversation_id: null, exchanges: 0, run: null, last_run: null, closed: false,
      terminal_error: null, abort_listener: null, read_waiters: new Set(),
    };
    const onAbort = (): void => {
      if (!session.closed && session.terminal_error === null) {
        session.terminal_error = new TorosError(ErrorCode.E_CANCELLED, 'CLI session cancelled');
        void this.killRun(session);
      }
    };
    session.abort_listener = onAbort;
    if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    this.sessions.set(id, session);
    return { pid: -1 };
  }

  /**
   * Start one exchange: spawn, write the message, CLOSE STDIN, and return.
   *
   * Closing stdin is the whole fix. `codex exec` announces "Reading additional
   * input from stdin..." and does nothing until EOF, so writing a newline and
   * waiting for output — which is what this used to do — waits forever.
   */
  async send(sessionId: string, message: string): Promise<void> {
    const session = this.get(sessionId);
    await this.withBound(session, async () => {
      if (session.closed) throw sessionError();
      if (session.run !== null) throw adapterFailure('An exchange is already running for this session');

      const nextExchange = session.exchanges + 1;
      const promptFile = this.framing.usesPromptFile === true
        ? join(session.cwd, `.exchange-${nextExchange}.prompt.txt`)
        : null;
      if (promptFile !== null) await writeFile(promptFile, message, 'utf8');
      const argv = [
        ...(this.options.launcher_args ?? []),
        ...this.framing.exchange(session.conversation_id, this.options.args, this.options.sandbox ?? 'workspace-write', promptFile),
      ];
      const child = spawn(this.options.executable, argv, {
        cwd: session.cwd,
        env: minimalEnvironment(this.options.runtime_paths ?? []),
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const run: Run = {
        child,
        close_promise: Promise.resolve(),
        kill_promise: null,
        exited: false,
        orphaned: false,
        exit_code: null,
        signal: null,
        exchange: nextExchange,
        prompt_file: promptFile,
        state: 'running',
        error: null,
        raw: '',
        timeout: null,
        completion: Promise.resolve(),
      };
      session.run = run;
      session.exchanges += 1;

      let pending = '';
      const consume = (chunk: Buffer): void => {
        const textChunk = chunk.toString('utf8');
        run.raw += textChunk;
        pending += textChunk;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (session.conversation_id === null) {
            const id = this.framing.conversationId(line);
            if (id !== null) session.conversation_id = id;
          }
          const text = this.framing.text(line);
          if (text !== null) this.append(session, this.framing.verbatim === true ? text : `${text}\n`);
          newline = pending.indexOf('\n');
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);

      run.close_promise = new Promise<void>((resolve) => {
        child.once('close', (code, signal) => {
          run.exited = true;
          run.exit_code = code;
          run.signal = signal;
          resolve();
        });
      });

      const spawned = new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => reject(adapterFailure('CLI process failed to start')));
      });
      try {
        await spawned;
      } catch (error: unknown) {
        if (promptFile !== null) await unlink(promptFile).catch(() => undefined);
        session.run = null;
        run.state = 'failed';
        run.error = error instanceof TorosError ? error : adapterFailure('CLI process failed to start');
        session.last_run = run;
        this.notifyReaders(session);
        throw run.error;
      }

      run.completion = this.completeRun(session, run, () => pending);
      run.timeout = setTimeout(() => {
        if (run.exited || session.run !== run) return;
        run.error = new TorosError(ErrorCode.E_TIMEOUT, 'CLI exchange timed out');
        void this.killRun(session);
      }, this.options.exchange_timeout_ms ?? this.options.timeout_ms);

      try {
        await new Promise<void>((resolve, reject) => {
          child.stdin.end(this.framing.stdin(message), (error?: Error | null) => error == null ? resolve() : reject(adapterFailure('Unable to write to CLI')));
        });
      } catch (error: unknown) {
        run.state = 'failed';
        run.error = error instanceof TorosError ? error : adapterFailure('Unable to write to CLI');
        await this.killRun(session);
        if (run.exited) await run.completion;
        throw run.error;
      }
    });
  }

  async read(sessionId: string, cursor: number): Promise<{ readonly chunk: string; readonly cursor: number; readonly exchange_state: 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted'; readonly exchange_error: string | null }> {
    const session = this.get(sessionId);
    if (!Number.isInteger(cursor) || cursor < 0) throw new TorosError(ErrorCode.E_SCHEMA, 'Cursor must be a non-negative integer');
    if (session.terminal_error !== null) await this.throwTerminal(session);
    if (session.run !== null && cursor >= session.bytes_total) await this.waitForRead(session, cursor);
    if (session.terminal_error !== null) await this.throwTerminal(session);
    const all = Buffer.concat(session.bytes);
    const state = session.run?.state ?? session.last_run?.state ?? 'idle';
    const error = session.run?.error?.code ?? session.last_run?.error?.code ?? null;
    if (cursor >= all.byteLength) return { chunk: '', cursor, exchange_state: state, exchange_error: error };
    // A byte cursor may point into a UTF-8 sequence.  Include that sequence's
    // lead bytes when decoding so a read never manufactures U+FFFD merely
    // because the caller resumed at a byte boundary inside a character.
    let decodeFrom = cursor;
    // noUncheckedIndexedAccess makes the element possibly undefined; treat an
    // out-of-range index as "not a continuation byte" and stop.
    while (decodeFrom > 0 && ((all[decodeFrom] ?? 0) & 0xc0) === 0x80) decodeFrom -= 1;
    return { chunk: all.subarray(decodeFrom).toString('utf8'), cursor: all.byteLength, exchange_state: state, exchange_error: error };
  }

  /**
   * Terminate the exchange currently running, if there is one. Interrupting an
   * idle conversation is a no-op rather than an error: the coordinator cannot
   * know whether the turn finished between its own calls.
   */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    await this.withBound(session, async () => {
      const run = session.run;
      if (run !== null) {
        run.state = 'interrupted';
        run.error = new TorosError(ErrorCode.E_CANCELLED, 'CLI exchange interrupted');
        await this.killRun(session);
        if (run.exited) await run.completion;
      }
    });
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    const run = session.run;
    if (run !== null && run.error === null) {
      run.state = 'interrupted';
      run.error = new TorosError(ErrorCode.E_CANCELLED, 'CLI exchange stopped');
    }
    await this.killRun(session);
    session.closed = true;
    if (run?.exited === true) await run.completion;
    if (session.abort_listener !== null) {
      session.context.signal.removeEventListener('abort', session.abort_listener);
      session.abort_listener = null;
    }
    // `stop_cli` claims the process tree is gone. If it is not, say so, or the
    // receipt records a successful stop for a session that is still running.
    if (session.run?.orphaned === true && session.terminal_error !== null) throw session.terminal_error;
  }

  async invoke(actionId: string, args: Readonly<Record<string, JsonValue>>, ctx: AdapterContext): Promise<ActionResult> {
    const sessionId = ctx.session_id;
    if (actionId === 'start') {
      await this.withContextBound(ctx, () => this.start(ctx));
      return this.result('', { exit_code: null, signal: null, bytes_read: 0, truncated: false, conversation_id: null, exchange: 0 });
    }
    if (sessionId === null) throw sessionError();
    // Every session action is wrapped in a bound that must know WHICH session
    // it is bounding.
    //
    // Passing no session made the outer timer the one that fired first — same
    // duration as the inner one but started marginally earlier — and with no
    // session it had nothing to kill, so it rejected with E_TIMEOUT while the
    // child was untouched. The inner bound's kill then ran with nobody waiting
    // on it. Both timers now settle on the same session.
    const session = this.get(sessionId);
    if (actionId === 'send') {
      const message = args.message;
      if (typeof message !== 'string') throw new TorosError(ErrorCode.E_SCHEMA, 'message must be a string');
      await this.withContextBound(ctx, () => this.send(sessionId, message), session);
      return this.result('', this.receipt(session));
    }
    if (actionId === 'read') {
      const cursor = args.cursor;
      if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) throw new TorosError(ErrorCode.E_SCHEMA, 'cursor must be a non-negative integer');
      const output = await this.withContextBound(ctx, () => this.read(sessionId, cursor), session);
      return this.result(output.chunk, { ...this.receipt(session), bytes_read: output.cursor, exchange_state: output.exchange_state, exchange_error: output.exchange_error });
    }
    if (actionId === 'interrupt') await this.withContextBound(ctx, () => this.interrupt(sessionId), session);
    else if (actionId === 'stop') await this.withContextBound(ctx, () => this.stop(sessionId), session);
    else throw new TorosError(ErrorCode.E_SCHEMA, `Unknown CLI action: ${actionId}`);
    return this.result('', this.receipt(session));
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.killRun(session)));
    this.sessions.clear();
    // Shutting down while a child survives is exactly the condition that must
    // not be silent — the adapter is going away and nothing else will observe
    // the leak. Forget the sessions first so a second dispose is still clean.
    const orphan = sessions.find((session) => session.run?.orphaned === true);
    if (orphan !== undefined && orphan.terminal_error !== null) throw orphan.terminal_error;
  }

  private receipt(session: Session): Record<string, JsonValue> {
    const run = session.run ?? session.last_run;
    return {
      exit_code: run?.exit_code ?? null,
      signal: run?.signal ?? null,
      bytes_read: 0,
      truncated: false,
      conversation_id: session.conversation_id,
      exchange: session.exchanges,
      exchange_state: run?.state ?? 'idle',
      exchange_error: run?.error?.code ?? null,
    };
  }

  private append(session: Session, text: string): void {
    if (session.terminal_error !== null) return;
    const chunk = Buffer.from(text, 'utf8');
    session.bytes.push(chunk);
    session.bytes_total += chunk.byteLength;
    if (session.bytes_total > this.options.output_limit_bytes) {
      session.terminal_error = new TorosError(ErrorCode.E_OUTPUT_LIMIT, 'CLI output limit exceeded');
    this.notifyReaders(session);
      void this.killRun(session);
    }
  }

  /** True when the session output is non-empty and its last byte is not a newline. */
  private hasOpenLine(session: Session): boolean {
    for (let index = session.bytes.length - 1; index >= 0; index -= 1) {
      const chunk = session.bytes[index]!;
      if (chunk.byteLength === 0) continue;
      return chunk[chunk.byteLength - 1] !== 0x0a;
    }
    return false;
  }

  private result(output: string, receipt_extra: Readonly<Record<string, JsonValue>>): ActionResult {
    return { output, truncated: false, artifacts: [], receipt_extra };
  }

  private async completeRun(session: Session, run: Run, pending: () => string): Promise<void> {
    try {
      await run.close_promise;
      if (run.timeout !== null) clearTimeout(run.timeout);
      const tail = pending();
      if (tail.length > 0) {
        if (session.conversation_id === null) {
          const id = this.framing.conversationId(tail);
          if (id !== null) session.conversation_id = id;
        }
        const text = this.framing.text(tail);
        if (text !== null) this.append(session, this.framing.verbatim === true ? text : `${text}\n`);
      }
      // A verbatim framing closes its reply line at the CLI's terminal event.
      // A run that ends without one — interrupted, timed out, or killed at the
      // output limit — would otherwise leave the next exchange's text on the
      // same line as this partial reply. Close it here, exactly once.
      if (this.framing.verbatim === true && this.hasOpenLine(session)) this.append(session, '\n');
      try {
        await writeFile(join(session.cwd, `exchange-${run.exchange}.jsonl`), run.raw, 'utf8');
      } catch {
        session.terminal_error = adapterFailure('Unable to persist raw CLI audit log');
      }
      if (run.error === null && run.exit_code === 0) run.state = 'succeeded';
      else if (run.state !== 'interrupted') {
        run.state = 'failed';
        if (run.error === null) {
          run.error = adapterFailure(`CLI process exited with code ${run.exit_code ?? 'null'}`);
        }
      }
      if (run.exit_code !== 0 && run.state !== 'interrupted') {
        this.append(session, `\n[exit ${run.exit_code ?? 'null'}] ${run.raw.slice(-2000)}\n`);
      }
    } catch (error: unknown) {
      session.terminal_error = error instanceof TorosError ? error : adapterFailure('Unable to finalize CLI exchange');
      run.state = 'failed';
      run.error = session.terminal_error;
    } finally {
      if (run.timeout !== null) clearTimeout(run.timeout);
      if (run.prompt_file !== null) await unlink(run.prompt_file).catch(() => undefined);
      if (session.run === run) session.run = null;
      session.last_run = run;
      this.notifyReaders(session);
    }
  }

  private async waitForRead(session: Session, cursor: number): Promise<void> {
    if (session.run === null || session.bytes_total > cursor) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        session.read_waiters.delete(finish);
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      session.read_waiters.add(finish);
      timer = setTimeout(finish, this.options.read_poll_ms ?? 20_000);
      if (session.run === null || session.bytes_total > cursor) finish();
    });
  }

  private notifyReaders(session: Session): void {
    for (const resolve of [...session.read_waiters]) resolve();
  }
  private requireInitialized(): void {
    if (!this.initialized) throw adapterFailure('CLI adapter is not initialized');
  }


  private get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw sessionError();
    return session;
  }

  /** Terminate the session's current exchange, if any. Idle is success. */
  private async killRun(session: Session): Promise<void> {
    const run = session.run;
    if (run === null) return;
    if (run.kill_promise !== null) return run.kill_promise;
    const killPromise = (async () => {
      for (let attempt = 0; attempt < KILL_ATTEMPTS; attempt += 1) {
        if (run.exited) return;
        await this.signalTermination(run);
        if (await this.waitForClose(run, KILL_GRACE_MS)) return;
      }
      if (run.exited) return;
      // The child outlived every attempt. Record that, rather than returning as
      // if the kill had worked: the previous code raced `close_promise` against
      // a timer and returned on whichever fired first, so a surviving process
      // was indistinguishable from a terminated one at every call site.
      run.orphaned = true;
      session.terminal_error = new TorosError(
        ErrorCode.E_ADAPTER_FAILURE,
        `CLI process ${run.child.pid ?? -1} survived termination`,
        { session_id: session.id, pid: run.child.pid ?? null },
      );
    })();
    run.kill_promise = killPromise;
    return killPromise;
  }

  private async signalTermination(run: Run): Promise<void> {
    if (process.platform === 'win32' && run.child.pid !== undefined) {
      try {
        const killer = spawn('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { shell: false, windowsHide: true, detached: false });
        await this.waitForProcess(killer);
      } catch {
        // A failure to launch taskkill must not leave an unhandled error or
        // make the supervisor wait forever for the target process.
      }
    } else {
      try { run.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  private async waitForProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; resolve(); } };
      child.once('close', finish);
      child.once('error', finish);
    });
  }

  /**
   * Wait up to `timeoutMs` for the child's own `close`. Returns whether it
   * actually closed — the timer arm proves nothing, so it must not be reported
   * as success.
   */
  private async waitForClose(run: Run, timeoutMs: number): Promise<boolean> {
    if (run.exited) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        run.close_promise,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // `exited` is set by the child's own 'close' handler, so it is the only
    // evidence the process exited.
    return run.exited;
  }

  private async withContextBound<T>(ctx: AdapterContext, operation: () => Promise<T>, session?: Session): Promise<T> {
    return this.bound(ctx.signal, operation, session);
  }

  private async withBound<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    if (session.terminal_error !== null) await this.throwTerminal(session);
    return this.bound(session.context.signal, operation, session);
  }

  /**
   * Report a session's terminal error — but not before the kill that error
   * triggered has finished.
   *
   * The abort listener and the output-limit guard both start the kill from a
   * callback that cannot await it, so every path that reports the failure to
   * Node Core has to do the waiting instead. Without this, an aborted session
   * answered E_CANCELLED while its child was still alive, and Node Core
   * released the per-job lock on that answer.
   */
  private async throwTerminal(session: Session): Promise<never> {
    const kill = session.run?.kill_promise ?? null;
    if (kill !== null) await kill;
    throw session.terminal_error ?? adapterFailure('CLI session is in a terminal state');
  }

  private async bound<T>(signal: AbortSignal, operation: () => Promise<T>, session?: Session): Promise<T> {
    if (signal.aborted) {
      if (session !== undefined) await this.killWithError(session, ErrorCode.E_CANCELLED);
      throw this.terminationError(session, ErrorCode.E_CANCELLED, 'CLI action cancelled');
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => {
        const fail = (): void => reject(this.terminationError(session, ErrorCode.E_CANCELLED, 'CLI action cancelled'));
        // Settle only once the child is actually gone. Killing in the
        // background and rejecting immediately handed E_CANCELLED/E_TIMEOUT
        // back to Node Core while the child was still alive — and Node Core
        // releases the per-job lock as soon as the action settles, so the next
        // action could start against the same session directory the dying
        // child was still writing to.
        if (session === undefined) { fail(); return; }
        void this.killWithError(session, ErrorCode.E_CANCELLED).then(fail, fail);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const fail = (): void => reject(this.terminationError(session, ErrorCode.E_TIMEOUT, 'CLI action timed out'));
        if (session === undefined) { fail(); return; }
        void this.killWithError(session, ErrorCode.E_TIMEOUT).then(fail, fail);
      }, this.options.timeout_ms);
    });
    try {
      return await Promise.race([operation(), abort, timeout]);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  private async killWithError(session: Session, code: 'E_TIMEOUT' | 'E_CANCELLED'): Promise<void> {
    if (session.terminal_error === null) session.terminal_error = new TorosError(code, code === ErrorCode.E_TIMEOUT ? 'CLI action timed out' : 'CLI session cancelled');
    await this.killRun(session);
  }

  /**
   * The error a timed-out or cancelled action should reject with. Normally the
   * timeout or cancellation itself — but a child that survived termination is
   * the more serious fact and the one the caller has to act on, so it wins.
   */
  private terminationError(session: Session | undefined, code: 'E_TIMEOUT' | 'E_CANCELLED', message: string): TorosError {
    if (session !== undefined && session.run?.orphaned === true && session.terminal_error !== null) return session.terminal_error;
    return new TorosError(code, message);
  }
}

export function createClaudeAdapter(options: CliAdapterOptions): SessionAdapter {
  return new CliSessionAdapter('claude', options);
}

export function createCodexAdapter(options: CliAdapterOptions): SessionAdapter {
  return new CliSessionAdapter('codex', options);
}

export function createGeminiAdapter(options: CliAdapterOptions): SessionAdapter {
  return new CliSessionAdapter('gemini', options);
}

export function createGrokAdapter(options: CliAdapterOptions): SessionAdapter {
  return new CliSessionAdapter('grok', options);
}
