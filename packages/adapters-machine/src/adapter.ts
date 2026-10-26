import { execFile } from 'node:child_process';
import { access as fsAccess } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  Adapter,
  AdapterContext,
  ActionResult,
  AdapterManifest,
  ActionSchema,
  JsonValue,
  NodePlatform,
  ResolvedTarget,
} from '@toros/contracts';

/**
 * A deterministic probe for one adapter/tool. Injected at construction so tests
 * stay independent of the host filesystem.
 */
export interface MachineProbe {
  /** Stable probe id, e.g. 'excel', 'claude-cli'. */
  readonly id: string;
  /** Platforms this tool can exist on. */
  readonly platforms: readonly NodePlatform[];
  /** The capability id this tool would back when registered, if any (e.g. 'excel.read_range' → 'excel'). */
  readonly backs_adapter?: string;
  /** How to detect presence. 'executable' = look up on PATH; 'file' = the absolute path exists. */
  readonly detect:
    | { readonly kind: 'executable'; readonly name: string }
    | { readonly kind: 'file'; readonly path: string };
}

/**
 * Returns the lowercase drive letters of the node's Fixed drives. The real
 * implementation spawns Windows PowerShell once; tests inject a fake so the
 * suite never spawns a child (AR-08).
 *
 * Fail-closed contract: a failed or aborted call returns an empty list, which
 * `isLocalFixedPath` interprets as "no drive is fixed".
 */
export type DriveTypes = (signal: AbortSignal, timeoutMs: number) => Promise<readonly string[]>;

/**
 * A filesystem presence check. Injected so tests can observe exactly which
 * paths the inventory touched without hitting the real filesystem (AR-08).
 * Resolves when the path exists; rejects otherwise.
 */
export type AccessCheck = (path: string) => Promise<void>;

export interface MachineAdapterOptions {
  /** This node's platform. INJECTED (not read from process.platform inside invoke) so tests are deterministic. */
  readonly node_platform: NodePlatform;
  /** The fixed probe catalog. A default catalog is exported; tests pass their own. */
  readonly probes: readonly MachineProbe[];
  /** Adapter ids currently registered in Node Core (manifest loaded). INJECTED. */
  readonly registered_adapter_ids: () => readonly string[];
  /**
   * Capability ids ( `<adapter>.<action>` ) registered on this node. Drives the
   * A8 resolver — one `capability` target per id — and the job-scoped inventory
   * filter (AR-09). INJECTED.
   */
  readonly registered_capabilities: () => readonly string[];
  /** Wall-clock ceiling per action, ms. */
  readonly timeout_ms: number;
  /** Fixed-drive reader (AR-08). Default spawns PowerShell; tests inject a fake. */
  readonly driveTypes?: DriveTypes;
  /** Filesystem presence check (AR-08). Default `node:fs/promises` access; tests observe it. */
  readonly access?: AccessCheck;
  /** Source of the PATH value (AR-08). Default reads `process.env.PATH`; tests inject a fixed value. */
  readonly pathEnv?: () => string;
  /**
   * Wall-clock source, ms since epoch, for the drive-reader cache (AR-F5 round
   * 2). Default `Date.now`; tests inject a fake so they can advance time without
   * sleeping past the 5-minute TTL.
   */
  readonly now?: () => number;
}

/** SPEC §12.1 — the well-known Excel installation path on Oruc / YOGA. */
const EXCEL_PATH = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';

/**
 * A small fixed catalog only. No filesystem-wide scan, no registry sweep,
 * no account/secret enumeration. Detection touches only the exact PATH lookup
 * or the exact file path.
 */
export const DEFAULT_MACHINE_PROBES: readonly MachineProbe[] = [
  {
    id: 'excel',
    platforms: ['win32'],
    backs_adapter: 'excel',
    detect: { kind: 'file', path: EXCEL_PATH },
  },
  {
    id: 'claude',
    platforms: ['win32'],
    backs_adapter: 'claude',
    detect: { kind: 'executable', name: 'claude' },
  },
  {
    id: 'codex',
    platforms: ['win32'],
    backs_adapter: 'codex',
    detect: { kind: 'executable', name: 'codex' },
  },
  {
    id: 'gemini',
    platforms: ['win32'],
    backs_adapter: 'gemini',
    detect: { kind: 'executable', name: 'gemini' },
  },
  {
    id: 'grok',
    platforms: ['win32'],
    backs_adapter: 'grok',
    detect: { kind: 'executable', name: 'grok' },
  },
];

// ---------------------------------------------------------------------------
// Readiness taxonomy (the whole point of T2)
// ---------------------------------------------------------------------------

type Readiness =
  | 'registered'
  | 'usable'
  | 'missing_adapter'
  | 'unsupported_platform'
  | 'missing_prerequisite';

/**
 * An entry as it is built during the scan, before the AR-09 job-scope filter
 * runs. `adapterId` is the adapter this entry is backed by (the probe's
 * `backs_adapter` when present, else the probe id or the registered adapter
 * id), and is the unit the filter maps to capability decisions.
 */
interface InternalEntry {
  id: string;
  platforms: readonly NodePlatform[];
  backs_adapter?: string;
  readiness: Readiness;
  reason?: string;
  adapterId: string;
}

/** The output shape. `unauthorized` is never emitted (RR-03): an out-of-job entry is omitted entirely. */
interface PublicEntry {
  id: string;
  readiness: Readiness;
  platforms?: readonly NodePlatform[];
  backs_adapter?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// AR-08 — local, fixed, absolute paths only
// ---------------------------------------------------------------------------

/**
 * Whether an absolute path points at a local fixed drive. On Windows a drive
 * letter counts only when the drive-type reader reported it Fixed; everything
 * that is not a drive-absolute path (UNC, device namespace, drive-relative,
 * relative) is rejected by shape alone. On non-Windows, absolute `/…` only and
 * never a `//` root.
 */
function isLocalFixedPath(
  entry: string,
  nodePlatform: NodePlatform,
  fixedDrives: ReadonlySet<string>,
): boolean {
  if (nodePlatform === 'win32') {
    const match = /^([A-Za-z]):[\\/]/.exec(entry);
    if (match === null) return false;
    return fixedDrives.has(match[1]!.toLowerCase());
  }
  if (!entry.startsWith('/')) return false;
  if (entry.startsWith('//')) return false;
  return true;
}

/**
 * Split PATH and drop every entry that is not a local fixed absolute path.
 * The dropped count is reported as `path_entries_skipped`, never the entries
 * themselves.
 */
function filterPathEntries(
  pathEnv: string,
  nodePlatform: NodePlatform,
  fixedDrives: ReadonlySet<string>,
): { readonly kept: readonly string[]; readonly skipped: number } {
  if (pathEnv.length === 0) return { kept: [], skipped: 0 };
  const delimiter = nodePlatform === 'win32' ? ';' : ':';
  const kept: string[] = [];
  let skipped = 0;
  for (const entry of pathEnv.split(delimiter)) {
    if (entry.length === 0 || !isLocalFixedPath(entry, nodePlatform, fixedDrives)) {
      skipped++;
    } else {
      kept.push(entry);
    }
  }
  return { kept, skipped };
}

/** The platforms' path semantics, so a win32-injected test resolves `C:\…` correctly on any host. */
function pathFor(nodePlatform: NodePlatform): typeof path.posix {
  return nodePlatform === 'win32' ? path.win32 : path.posix;
}

// ---------------------------------------------------------------------------
// AR-08 — the fixed-drive reader (PowerShell, one bounded call per invoke)
// ---------------------------------------------------------------------------

/** Fixed, parameter-free: prints one drive letter per line for Fixed drives. */
const FIXED_DRIVES_COMMAND =
  "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed } | ForEach-Object { $_.Name.Substring(0,1) }";

/** Captured stdout/stderr ceiling for the PowerShell drive query. */
const MAX_DRIVE_OUTPUT_BYTES = 1024 * 1024;

/**
 * The drive reader's own ceiling, ms, regardless of the action timeout. A slow
 * PowerShell start must not eat the whole action budget and leave nothing for
 * the probes (AR-F5 round 2); it never gets more than this.
 */
const MAX_DRIVE_READER_BUDGET_MS = 3_000;

/**
 * Successful drive reads are cached per adapter instance for this long.
 * Drive types rarely change; a failure is never cached (fail closed, so the
 * next invoke re-reads rather than reusing a stale empty result).
 */
const DRIVE_CACHE_TTL_MS = 5 * 60 * 1_000;

/** The reader's budget: `min(3_000, floor(timeout_ms / 2))` (AR-F5 round 2). */
function driveReaderBudget(timeoutMs: number): number {
  return Math.min(MAX_DRIVE_READER_BUDGET_MS, Math.floor(timeoutMs / 2));
}

/** Absolute path to Windows PowerShell, built from `SystemRoot`. */
function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'];
  if (systemRoot === undefined || systemRoot.length === 0) return 'powershell.exe';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The child environment for a Windows PowerShell 5.1 spawn (amendment A9): a
 * copy of `process.env` with `PSModulePath` removed, so 5.1 rebuilds its own
 * default module path instead of inheriting a possibly-polluted one. The copy
 * is deliberate — `process.env` is never mutated.
 */
export function powershellChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Windows environment variable names are case-insensitive, so a polluted env
  // block may carry any casing (`psmodulepath`, `PsModulePath`, …). Delete every
  // key whose lower-case form is `psmodulepath`, never just two hard-coded
  // spellings, so no casing survives into the child.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

/**
 * execFile-like spawn shape, injectable so a test can observe the exact
 * `options.env` handed to the PowerShell child without ever spawning one. Mirrors
 * `runPowerShell`'s `ProbeSpawn` in @toros/adapters-desktop.
 */
export type DriveReaderSpawn = (
  file: string,
  args: readonly string[],
  options: {
    readonly shell: false;
    readonly windowsHide: boolean;
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly env: NodeJS.ProcessEnv;
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => { readonly kill: () => void };

/**
 * The production drive reader: one `execFile` of Windows PowerShell per call,
 * `shell: false`, `-NoProfile -NonInteractive -Command` with the fixed command.
 * Honors `signal` and the action timeout, caps the output size, and fails
 * closed — any error, timeout, abort, or oversized output **rejects**, so
 * `resolveFixedDrives` never caches a failed read and every drive letter is
 * treated as non-fixed (probe nothing, count the skip).
 *
 * `spawn` is injectable for tests; the default is the real `execFile`.
 */
export function createPowerShellDriveTypes(spawn: DriveReaderSpawn = execFile): DriveTypes {
  return (signal: AbortSignal, timeoutMs: number): Promise<readonly string[]> =>
    new Promise<readonly string[]>((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(new Error('drive reader aborted before spawn'));
        return;
      }
      let settled = false;
      let child: { readonly kill: () => void } | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (err: Error | undefined, letters: readonly string[]): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (err !== undefined) rejectPromise(err);
        else resolvePromise(letters);
      };
      const onAbort = (): void => {
        child?.kill();
        finish(new Error('drive reader aborted'), []);
      };
      timer = setTimeout(() => {
        child?.kill();
        finish(new Error('drive reader timed out'), []);
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        child = spawn(
          powershellExe(),
          ['-NoProfile', '-NonInteractive', '-Command', FIXED_DRIVES_COMMAND],
          { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_DRIVE_OUTPUT_BYTES, env: powershellChildEnvironment() },
          (error, stdout) => {
            if (error) {
              finish(error, []);
              return;
            }
            const letters: string[] = [];
            for (const line of stdout.split(/\r?\n/)) {
              const trimmed = line.trim().toLowerCase();
              if (/^[a-z]$/.test(trimmed)) letters.push(trimmed);
            }
            finish(undefined, letters);
          },
        );
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)), []);
      }
    });
}

/**
 * Fail-closed resolution of the fixed-drive set (empty on any failure or
 * abort). Carries a per-instance cache: a successful read is reused for
 * `DRIVE_CACHE_TTL_MS`, a failure is never cached. The reader is given the
 * bounded `driveReaderBudget(timeout_ms)`, not the whole action timeout.
 */
async function resolveFixedDrives(
  nodePlatform: NodePlatform,
  driveReader: DriveTypes,
  signal: AbortSignal,
  timeoutMs: number,
  now: () => number,
  cache: { letters?: readonly string[]; cachedAtMs?: number },
): Promise<ReadonlySet<string>> {
  if (nodePlatform !== 'win32' || signal.aborted) return new Set<string>();

  const cachedAtMs = cache.cachedAtMs;
  const cachedLetters = cache.letters;
  if (
    cachedLetters !== undefined &&
    cachedAtMs !== undefined &&
    now() - cachedAtMs < DRIVE_CACHE_TTL_MS
  ) {
    return new Set(cachedLetters.map((letter) => letter.toLowerCase()));
  }

  try {
    const letters = await driveReader(signal, driveReaderBudget(timeoutMs));
    // Cache only a result that is non-empty AND obtained without an abort in
    // flight. Every Windows node has at least its system fixed drive, so an
    // empty list is a failure signal and must not be cached; an aborted read
    // is likewise re-run next invoke (AR-F5 round 3, P1).
    if (!signal.aborted && letters.length > 0) {
      cache.letters = letters;
      cache.cachedAtMs = now();
    }
    return new Set(letters.map((letter) => letter.toLowerCase()));
  } catch {
    return new Set<string>();
  }
}

// ---------------------------------------------------------------------------
// Presence detection — deterministic, touches only exact local-fixed paths
// ---------------------------------------------------------------------------

/**
 * Check whether `probe.detect` resolves as present on this node.
 *
 * Respects `signal` so a caller that wants to abort a long scan (e.g. PATH
 * with many entries) can do so. `keptPathEntries` is the PATH already filtered
 * to local-fixed absolutes; a `file` probe's fixed path is checked against the
 * same rule before it is touched (AR-08).
 */
async function detectPresent(
  probe: MachineProbe,
  nodePlatform: NodePlatform,
  signal: AbortSignal,
  fixedDrives: ReadonlySet<string>,
  accessFn: AccessCheck,
  keptPathEntries: readonly string[],
): Promise<boolean> {
  if (signal.aborted) return false;

  if (probe.detect.kind === 'file') {
    if (!isLocalFixedPath(probe.detect.path, nodePlatform, fixedDrives)) return false;
    try {
      await accessFn(probe.detect.path);
      return true;
    } catch {
      return false;
    }
  }

  // executable kind — walk the pre-filtered PATH
  const name = probe.detect.name;
  const exeSuffix = nodePlatform === 'win32' ? '.exe' : '';
  const searchName = name.endsWith('.exe') ? name : `${name}${exeSuffix}`;
  const pathImpl = pathFor(nodePlatform);

  for (const dir of keptPathEntries) {
    if (signal.aborted) return false;
    const candidate = pathImpl.resolve(dir, searchName);
    try {
      await accessFn(candidate);
      return true;
    } catch {
      // not here — try the next entry
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function buildManifest(options: MachineAdapterOptions): AdapterManifest {
  const action: ActionSchema = {
    id: 'inventory',
    summary: 'Report readiness of known adapters/tools on this node.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { capability_filter: { type: 'string' } },
    },
    path_fields: [],
    mutates: false,
    always_requires_approval: false,
    timeout_ms: options.timeout_ms,
  };

  return {
    id: 'machine',
    version: '0.1.0',
    platforms: ['win32'],
    actions: [action],
    required_permissions: ['process.spawn', 'fs.read'],
    allowed_resources: [],
    default_timeout_ms: options.timeout_ms,
    cancellation: 'graceful',
    receipt_fields: ['probe_ms', 'probe_count'],
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

function toPublicEntry(entry: InternalEntry): PublicEntry {
  return {
    id: entry.id,
    readiness: entry.readiness,
    platforms: entry.platforms,
    ...(entry.backs_adapter !== undefined ? { backs_adapter: entry.backs_adapter } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}

export function createMachineAdapter(options: MachineAdapterOptions): Adapter {
  const manifest = buildManifest(options);
  const driveReader: DriveTypes = options.driveTypes ?? createPowerShellDriveTypes();
  const accessFn: AccessCheck = options.access ?? fsAccess;
  const pathEnvFn: () => string = options.pathEnv ?? (() => process.env['PATH'] ?? '');
  const nowFn: () => number = options.now ?? (() => Date.now());

  // Per-adapter-instance cache for a *successful* drive read (AR-F5 round 2).
  const driveCache: { letters?: readonly string[]; cachedAtMs?: number } = {};

  const adapter: Adapter = {
    manifest,

    // AR-09 — the A8 two-phase resolver. One `capability` target per registered
    // capability id; Core decides each against the job's allowlist and hands the
    // decisions back through `ctx.target_decisions`. The key is the capability
    // id itself, so invoke can map decisions back to adapters.
    resolver: {
      async resolve(
        actionId: string,
        _args: Readonly<Record<string, JsonValue>>,
        ctx: AdapterContext,
      ): Promise<readonly ResolvedTarget[]> {
        if (actionId !== 'inventory' || ctx.signal.aborted) return [];
        return options.registered_capabilities().map((capability) => ({
          kind: 'capability',
          key: capability,
          capability,
        }));
      },
    },

    async init(): Promise<void> {
      // No pre-flight check needed; presence is checked per-invoke.
    },

    async invoke(
      actionId: string,
      args: Readonly<Record<string, JsonValue>>,
      ctx: AdapterContext,
    ): Promise<ActionResult> {
      if (actionId !== 'inventory') {
        throw new Error(`machine adapter has no action "${actionId}"`);
      }

      const probeStart = performance.now();
      const internalEntries: InternalEntry[] = [];
      let probeCount = 0;
      let pathEntriesSkipped = 0;

      // RR-03 — the allowed-adapter set is computed BEFORE any probe or
      // filesystem read, from Core's per-capability decisions. An entry whose
      // adapter has no allowed capability is omitted from the output entirely:
      // no `unauthorized` stub, no count, and its probe is never examined.
      const decisions = ctx.target_decisions ?? new Map<string, 'allowed' | 'denied'>();
      const allowedAdapters = new Set<string>();
      for (const [key, decision] of decisions) {
        if (decision === 'allowed') {
          const adapterId = key.split('.')[0];
          if (adapterId !== undefined) allowedAdapters.add(adapterId);
        }
      }

      // A pre-aborted signal means the action is over before it began: probe
      // nothing, and — because resolveFixedDrives is never reached — spawn
      // nothing and access nothing (AR-08).
      if (!ctx.signal.aborted) {
        // Only probes whose adapter is allowed are examined (RR-03): an out-of-
        // job adapter's probe is never touched — no drive read, no access.
        const allowedProbes = options.probes.filter((p) =>
          allowedAdapters.has(p.backs_adapter ?? p.id),
        );
        const needsDetection = allowedProbes.some((p) =>
          p.platforms.includes(options.node_platform),
        );

        let fixedDrives: ReadonlySet<string> = new Set<string>();
        let keptPathEntries: readonly string[] = [];
        if (needsDetection) {
          fixedDrives = await resolveFixedDrives(
            options.node_platform,
            driveReader,
            ctx.signal,
            options.timeout_ms,
            nowFn,
            driveCache,
          );
          const pathFilter = filterPathEntries(pathEnvFn(), options.node_platform, fixedDrives);
          pathEntriesSkipped = pathFilter.skipped;
          keptPathEntries = pathFilter.kept;
        }

        // Process each allowed probe in the catalog.
        for (const probe of allowedProbes) {
          if (ctx.signal.aborted) break;
          probeCount++;

          let readiness: Readiness;
          let reason: string | undefined;

          if (!probe.platforms.includes(options.node_platform)) {
            readiness = 'unsupported_platform';
          } else {
            const present = await detectPresent(
              probe,
              options.node_platform,
              ctx.signal,
              fixedDrives,
              accessFn,
              keptPathEntries,
            );
            // Abort observed during detection: stop the scan, but do not record
            // this probe as `missing_prerequisite` — a `false` from detectPresent
            // under an aborted signal means "not checked", not "not present".
            if (ctx.signal.aborted) break;

            if (present) {
              if (probe.backs_adapter !== undefined) {
                const registeredIds = options.registered_adapter_ids();
                if (registeredIds.includes(probe.backs_adapter)) {
                  readiness = 'usable';
                } else {
                  readiness = 'missing_adapter';
                }
              } else {
                readiness = 'usable';
              }
            } else {
              readiness = 'missing_prerequisite';
              reason =
                probe.detect.kind === 'executable'
                  ? `executable not found on PATH: ${probe.detect.name}`
                  : `file not found: ${probe.detect.path}`;
            }
          }

          internalEntries.push({
            id: probe.id,
            platforms: probe.platforms,
            adapterId: probe.backs_adapter ?? probe.id,
            ...(probe.backs_adapter !== undefined ? { backs_adapter: probe.backs_adapter } : {}),
            readiness,
            ...(reason !== undefined ? { reason } : {}),
          });
        }

        // Registered adapter ids that have no probe → `registered`. Only those
        // whose adapter is allowed are reported (RR-03); the rest are omitted.
        const registeredIds = options.registered_adapter_ids();
        for (const regId of registeredIds) {
          if (ctx.signal.aborted) break;
          if (!allowedAdapters.has(regId)) continue;
          const hasProbe = options.probes.some(
            (p) => p.backs_adapter === regId || p.id === regId,
          );
          if (!hasProbe) {
            internalEntries.push({
              id: regId,
              platforms: [options.node_platform],
              adapterId: regId,
              readiness: 'registered',
            });
          }
        }
      }

      // RR-03 — every entry that reached here belongs to an allowed adapter, so
      // the previous `unauthorized` reduction is gone: an entry is reported in
      // full, or not at all.
      const publicEntries: PublicEntry[] = internalEntries.map(toPublicEntry);

      // Apply capability_filter substring match on id and backs_adapter.
      let filteredEntries = publicEntries;
      const rawFilter = args['capability_filter'];
      if (typeof rawFilter === 'string' && rawFilter.length > 0) {
        const filter = rawFilter.toLowerCase();
        filteredEntries = publicEntries.filter((e) => {
          const matchId = e.id.toLowerCase().includes(filter);
          const matchBacks =
            e.backs_adapter !== undefined &&
            e.backs_adapter.toLowerCase().includes(filter);
          return matchId || matchBacks;
        });
      }

      const probeMs = performance.now() - probeStart;

      const output = JSON.stringify({
        node_platform: options.node_platform,
        observed_at: new Date().toISOString(),
        entries: filteredEntries,
        path_entries_skipped: pathEntriesSkipped,
      });

      return {
        output,
        truncated: false,
        artifacts: [],
        receipt_extra: { probe_ms: probeMs, probe_count: probeCount },
      };
    },

    async dispose(): Promise<void> {
      // Nothing persistent to release.
    },
  };

  return adapter;
}