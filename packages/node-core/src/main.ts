/**
 * The Toros Node Core process entrypoint.
 *
 * Reads its configuration from a file, wires the adapters this host actually
 * has, and serves the Hermes tool surface on loopback until it is signalled.
 *
 * Deliberately thin: everything it does is composition. The rules live in
 * `packages/policy`, the persistence in `packages/store`, and nothing here
 * decides anything — a process entrypoint is a bad place to hide behaviour.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Adapter, AppRule, NodePlatform, SecurityObserver, Workspace } from '@toros/contracts';
import { createClaudeAdapter, createCodexAdapter, createGeminiAdapter, createGrokAdapter } from '@toros/adapters-cli';
import { createExcelAdapter } from '@toros/adapters-app';
import { createChromeWorkerAdapter } from '@toros/adapters-chrome';
import { createMachineAdapter, DEFAULT_MACHINE_PROBES } from '@toros/adapters-machine';
import { createDesktopAdapter, createPowerShellUiaProbe } from '@toros/adapters-desktop';
import { createNumbatObserver, createNullObserver } from '@toros/observer';

interface CliFileConfig {
  readonly executable: string;
  readonly launcher_args?: readonly string[];
  readonly args?: readonly string[];
  readonly runtime_profile?: string;
  readonly exchange_timeout_ms?: number;
  readonly read_poll_ms?: number;
}

interface RuntimeProfile {
  readonly path_entries: readonly string[];
}

import { createNodeCore, type ObserverDeps } from './index.js';
import { createCoordinatorSupervisor } from './coordinator-supervisor.js';
import { approvalTtlMinutes } from './approvals.js';
import { validateDesktopAuthorizedApps } from './desktop-config.js';

interface FileConfig {
  readonly node_id: string;
  readonly db_path: string;
  readonly port: number;
  readonly token: string;
  readonly workspaces: readonly Workspace[];
  readonly adapters?: {
    readonly claude?: CliFileConfig;
    readonly codex?: CliFileConfig;
    readonly gemini?: CliFileConfig;
    readonly grok?: CliFileConfig;
    readonly excel?: { readonly executable: string };
readonly chrome?: {
        readonly allowed_domains: readonly string[];
        readonly extension_dir?: string;
      };
      readonly desktop?: { authorized_apps: AppRule[] };
    };
  readonly runtime_profiles?: Readonly<Record<string, RuntimeProfile>>;
  readonly numbat?: { readonly records_path?: string };
  readonly approval_required?: readonly string[];
  readonly approval_ttl_minutes?: number;
  /**
   * Bearer for the operator surface (`/operator/*`), which issues approvals.
   * Required when `approval_required` is non-empty, and must differ from
   * `token` — Node Core refuses to start otherwise.
   */
  readonly operator_token?: string;
  /**
   * When true, Node Core starts the one-job Hermes coordinator supervisor. When
   * omitted or false (the default), Core serves discovery and typed execution with
   * no coordinator: model-driven job orchestration is simply unavailable, and the
   * coordinator-requiring routes return a deterministic "unavailable" outcome.
   */
  readonly coordinator_enabled?: boolean;
  /**
   * Absolute path to the one-job Hermes coordinator entry point. When omitted,
   * Node Core uses `packages/coordinator/dist/src/main.js` relative to this
   * compiled main, which matches the repository layout.
   */
  readonly coordinator_entry?: string;
}

function configPath(): string {
  const explicit = process.argv[2];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  return join(local, 'Toros', 'config.json');
}

async function loadConfig(path: string): Promise<FileConfig> {
  const text = await readFile(path, 'utf8');
  const config = JSON.parse(text.replace(/^﻿/, '')) as FileConfig;

  // Fail on a missing or short token rather than starting an unprotected
  // service. A node that binds loopback with a guessable bearer is worse than
  // one that refuses to start, because it looks like it is working.
  if (typeof config.token !== 'string' || config.token.length < 32) {
    throw new Error(`${path}: token must be at least 32 characters`);
  }
  if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
    throw new Error(`${path}: at least one workspace is required`);
  }
  return { ...config, approval_ttl_minutes: approvalTtlMinutes(config.approval_ttl_minutes, path) };
}

/**
 * The fixed, parameter-free PowerShell that reports the Windows session id of
 * the process named by the single integer argument. No caller value reaches
 * this source; the only input is the numeric pid, passed as a positional argv.
 */
const NODE_SESSION_ID_PS1 = `# toros-node-session-id.ps1 — fixed. Reads the session id of the pid in $args[0].
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class TorosSession {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);
}
"@
if ($args.Count -lt 1) { exit 2 }
$targetPid = 0
if (-not [long]::TryParse([string]$args[0], [ref]$targetPid)) { exit 2 }
$sid = 0u
if ([TorosSession]::ProcessIdToSessionId([uint32]$targetPid, [ref]$sid)) { [Console]::WriteLine([string]$sid) } else { exit 1 }
`;

/**
 * Determine Node Core's own Windows session id once at startup (amendment A8,
 * F3b): a small fixed PowerShell call to `ProcessIdToSessionId(process.pid)`.
 * Returns null on any failure — every `app` target then fails closed — after
 * writing one log line, never an error that would stop the node from serving
 * non-desktop work.
 */
export async function resolveNodeSessionId(pid: number, systemRoot: string | undefined): Promise<number | null> {
  const powershell = systemRoot !== undefined && systemRoot.length > 0
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const dir = await mkdtemp(join(tmpdir(), 'toros-session-'));
  const scriptPath = join(dir, 'session.ps1');
  try {
    await writeFile(scriptPath, NODE_SESSION_ID_PS1, 'utf8');
    const stdout = await runFixedScript(powershell, scriptPath, [String(pid)]);
    const parsed = Number(stdout.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFixedScript(powershell: string, scriptPath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, _stderr) => {
        if (error) { reject(error); return; }
        resolve(stdout);
      },
    );
  });
}

/**
 * Build the adapters this host can actually offer.
 *
 * A missing executable is skipped with a log line rather than treated as fatal:
 * Node Core must still run CLI jobs on a machine without Excel, and registration
 * failure for one adapter is explicitly survivable (SPEC §10 acceptance).
 */
function runtimePaths(config: FileConfig, adapter: CliFileConfig): readonly string[] {
  if (adapter.runtime_profile === undefined) return [];
  const profile = config.runtime_profiles?.[adapter.runtime_profile];
  if (profile === undefined) throw new Error(`Unknown runtime profile: ${adapter.runtime_profile}`);
  if (!Array.isArray(profile.path_entries) || !profile.path_entries.every((entry) => typeof entry === 'string')) {
    throw new Error(`Runtime profile ${adapter.runtime_profile} must contain string path_entries`);
  }
  return profile.path_entries;
}

function buildAdapters(config: FileConfig): readonly Adapter[] {
  const adapters: Adapter[] = [];
  const spec = config.adapters ?? {};

  if (spec.claude !== undefined) {
    adapters.push(createClaudeAdapter({
      executable: spec.claude.executable,
      args: spec.claude.args ?? [],
      // Phase 1's operator selected Claude as an independent read-only
      // reviewer. This is Claude policy (`plan` mode), not OS confinement;
      // SPEC §8.1's worker-process limitation still applies.
      sandbox: 'read-only',
      timeout_ms: 120_000,
      exchange_timeout_ms: spec.claude.exchange_timeout_ms ?? 15 * 60_000,
      read_poll_ms: spec.claude.read_poll_ms ?? 20_000,
      runtime_paths: runtimePaths(config, spec.claude),
      output_limit_bytes: 8 * 1024 * 1024,
    }));
  }
  if (spec.codex !== undefined) {
    adapters.push(createCodexAdapter({
      executable: spec.codex.executable,
      args: spec.codex.args ?? [],
      timeout_ms: 120_000,
      exchange_timeout_ms: spec.codex.exchange_timeout_ms ?? 15 * 60_000,
      read_poll_ms: spec.codex.read_poll_ms ?? 20_000,
      runtime_paths: runtimePaths(config, spec.codex),
      output_limit_bytes: 8 * 1024 * 1024,
    }));
  }
  if (spec.gemini !== undefined) {
    adapters.push(createGeminiAdapter({
      executable: spec.gemini.executable,
      launcher_args: spec.gemini.launcher_args ?? [],
      args: spec.gemini.args ?? [],
      timeout_ms: 120_000,
      exchange_timeout_ms: spec.gemini.exchange_timeout_ms ?? 15 * 60_000,
      read_poll_ms: spec.gemini.read_poll_ms ?? 20_000,
      runtime_paths: runtimePaths(config, spec.gemini),
      output_limit_bytes: 8 * 1024 * 1024,
    }));
  }
  if (spec.grok !== undefined) {
    adapters.push(createGrokAdapter({
      executable: spec.grok.executable,
      launcher_args: spec.grok.launcher_args ?? [],
      args: spec.grok.args ?? [],
      timeout_ms: 120_000,
      exchange_timeout_ms: spec.grok.exchange_timeout_ms ?? 15 * 60_000,
      read_poll_ms: spec.grok.read_poll_ms ?? 20_000,
      runtime_paths: runtimePaths(config, spec.grok),
      output_limit_bytes: 8 * 1024 * 1024,
    }));
  }
  if (spec.excel !== undefined) {
    adapters.push(createExcelAdapter({
      executable: spec.excel.executable,
      timeout_ms: 120_000,
      max_cells: 100_000,
    }));
  }
  if (spec.chrome !== undefined) {
    adapters.push(createChromeWorkerAdapter({
      allowed_domains: spec.chrome.allowed_domains,
      state_path: `${config.db_path}.chrome-worker.json`,
      ...(spec.chrome.extension_dir === undefined ? {} : { extension_dir: spec.chrome.extension_dir }),
    }));
  }
  if (spec.desktop !== undefined) {
    adapters.push(createDesktopAdapter({
      node_platform: process.platform as NodePlatform,
      authorized_apps: spec.desktop.authorized_apps,
      probe: createPowerShellUiaProbe({ timeout_ms: 30_000 }),
      max_windows: 200,
      max_controls: 2000,
      timeout_ms: 30_000,
    }));
  }
  return adapters;
}

/**
 * Correlation needs a session lookup that Node Core owns, and this entrypoint
 * has no access to it — so it does not try to construct one. It returns a
 * factory, and Node Core calls it with the real lookups once its store is open.
 *
 * The previous shape returned a fully-built observer and had to pass
 * `resolveSession: () => null` to do so. Every record then resolved to `none`,
 * which §8.2 does treat as a legitimate outcome — but that made routes 1 and 3
 * permanently dead in the deployed service while the observer's own tests
 * exercised them with a real resolver, so nothing failed.
 */
function buildObserver(config: FileConfig): (deps: ObserverDeps) => SecurityObserver {
  const recordsPath = config.numbat?.records_path;
  if (recordsPath === undefined) return () => createNullObserver();

  return (deps: ObserverDeps) => createNumbatObserver({
    records_path: recordsPath,
    resolveSession: deps.resolveSession,
    jobForSession: deps.jobForSession,
    correlation_map_limit: 10_000,
  });
}

async function main(): Promise<void> {
  const path = configPath();
  const config = await loadConfig(path);

  // Validate + normalise the desktop application config (amendment A8, F3b): a
  // bare string entry (the old basename form) refuses to start here, naming the
  // new AppRule format.
  if (config.adapters?.desktop !== undefined) {
    config.adapters.desktop.authorized_apps = validateDesktopAuthorizedApps(config.adapters.desktop.authorized_apps, path) ?? [];
  }

  // Determine Node Core's own Windows session id once at startup (F3b): policy
  // needs it to require a resolved app to live in the same session. On failure —
  // or off-Windows — it is null, so every `app` target fails closed; log one line
  // and keep serving non-desktop work.
  let desktopSessionId: number | null = null;
  if (config.adapters?.desktop !== undefined && process.platform === 'win32') {
    try {
      desktopSessionId = await resolveNodeSessionId(process.pid, process.env['SystemRoot'] ?? process.env['SYSTEMROOT']);
    } catch (error: unknown) {
      desktopSessionId = null;
    }
    if (desktopSessionId === null) {
      console.info('desktop adapter enabled but the node session id could not be resolved; desktop app targets will be denied');
    }
  }

  // Strict `=== true` is deliberate and fail-closed: an omitted key, `false`, or
  // a non-boolean (e.g. the string "false" from a hand-edited config) all leave
  // the coordinator OFF. Do not loosen this to a truthiness check.
  const coordinatorEnabled = config.coordinator_enabled === true;

  // The machine adapter reports which adapters are *registered*. Seed that set
  // with the constructed ids, then replace it after start() with the ids that
  // actually registered — an adapter whose init() throws is skipped by the
  // registry, so the constructed set would otherwise overstate readiness.
  const baseAdapters = buildAdapters(config);
  const registeredAdapterIds: { value: readonly string[] } = {
    value: baseAdapters.map((a) => a.manifest.id),
  };
  const machine = createMachineAdapter({
    node_platform: process.platform as NodePlatform,
    probes: DEFAULT_MACHINE_PROBES,
    registered_adapter_ids: () => registeredAdapterIds.value,
    timeout_ms: 30_000,
  });
  const allAdapters = [...baseAdapters, machine];

  const core = createNodeCore({
    node_id: config.node_id,
    db_path: config.db_path,
    workspaces: config.workspaces,
    port: config.port,
    token: config.token,
    ...(coordinatorEnabled
      ? {
          coordinator: createCoordinatorSupervisor(
            config.coordinator_entry ?? join(
              dirname(fileURLToPath(import.meta.url)),
              '..', '..', '..', 'coordinator', 'dist', 'src', 'main.js',
            ),
          ),
        }
      : {}),
    adapters: allAdapters,
    observer: buildObserver(config),
    approval_required: config.approval_required ?? [],
    approval_ttl_minutes: config.approval_ttl_minutes ?? 60,
    ...(config.operator_token === undefined ? {} : { operator_token: config.operator_token }),
    ...(desktopSessionId === null ? {} : { desktop_session_id: desktopSessionId }),
  });

  const { port, registered_capabilities } = await core.start();
  // Replace the seed with the adapters that actually registered (capability ids
  // are `<adapter>.<action>`; take the distinct adapter segments).
  const liveAdapterIds = new Set<string>();
  for (const capability of registered_capabilities) {
    const adapterId = capability.split('.')[0];
    if (adapterId !== undefined) liveAdapterIds.add(adapterId);
  }
  registeredAdapterIds.value = [...liveAdapterIds];
  // Never log the token, here or anywhere.
  console.info(`Toros Node Core listening on 127.0.0.1:${port} (node ${config.node_id}, coordinator ${coordinatorEnabled ? 'on' : 'off'})`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.info(`received ${signal}, stopping`);
    void core.stop().then(
      () => process.exit(0),
      (error: unknown) => { console.error('shutdown failed', error); process.exit(1); },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Start unconditionally at module load: the entrypoint must never depend on how
// `process.argv[1]` was spelled (drive-letter casing, a relative path, a junction
// or symlinked install, or a launcher shim could all make an import.meta.url
// comparison fail and silently exit). The exported config helpers live in
// `desktop-config.ts` and are imported from there for testing, so neither they
// nor any test need to import this module.
main().catch((error: unknown) => {
  console.error('Toros Node Core failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
