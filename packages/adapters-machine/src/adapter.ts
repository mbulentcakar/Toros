import { access } from 'node:fs/promises';
import { delimiter, resolve as pathResolve } from 'node:path';

import type {
  Adapter,
  AdapterContext,
  ActionResult,
  AdapterManifest,
  ActionSchema,
  JsonValue,
  NodePlatform,
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

export interface MachineAdapterOptions {
  /** This node's platform. INJECTED (not read from process.platform inside invoke) so tests are deterministic. */
  readonly node_platform: NodePlatform;
  /** The fixed probe catalog. A default catalog is exported; tests pass their own. */
  readonly probes: readonly MachineProbe[];
  /** Adapter ids currently registered in Node Core (manifest loaded). INJECTED. */
  readonly registered_adapter_ids: () => readonly string[];
  /** Wall-clock ceiling per action, ms. */
  readonly timeout_ms: number;
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

interface InventoryEntry {
  id: string;
  platforms: readonly NodePlatform[];
  backs_adapter?: string;
  readiness: Readiness;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Presence detection — deterministic, touches only exact paths or PATH entries
// ---------------------------------------------------------------------------

/**
 * Check whether `probe.detect` resolves as present on this node.
 *
 * Respects `signal` so a caller that wants to abort a long scan (e.g. PATH
 * with many entries) can do so.
 */
async function detectPresent(
  probe: MachineProbe,
  nodePlatform: NodePlatform,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;

  if (probe.detect.kind === 'file') {
    try {
      await access(probe.detect.path);
      return true;
    } catch {
      return false;
    }
  }

  // executable kind — walk PATH
  const name = probe.detect.name;
  const pathEnv = process.env['PATH'] ?? '';
  const exeSuffix = nodePlatform === 'win32' ? '.exe' : '';
  const searchName = name.endsWith('.exe') ? name : `${name}${exeSuffix}`;

  const entries = pathEnv.split(delimiter);
  for (const dir of entries) {
    if (signal.aborted) return false;
    if (dir.length === 0) continue;
    const candidate = pathResolve(dir, searchName);
    try {
      await access(candidate);
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
    required_permissions: ['fs.read'],
    allowed_resources: [],
    default_timeout_ms: options.timeout_ms,
    cancellation: 'graceful',
    receipt_fields: ['probe_ms', 'probe_count'],
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createMachineAdapter(options: MachineAdapterOptions): Adapter {
  const manifest = buildManifest(options);

  const adapter: Adapter = {
    manifest,

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
      const entries: InventoryEntry[] = [];
      let probeCount = 0;

      // Process each probe in the catalog.
      for (const probe of options.probes) {
        if (ctx.signal.aborted) break;
        probeCount++;

        let readiness: Readiness;
        let reason: string | undefined;

        if (!probe.platforms.includes(options.node_platform)) {
          readiness = 'unsupported_platform';
        } else {
          const present = await detectPresent(probe, options.node_platform, ctx.signal);
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

        entries.push({
          id: probe.id,
          platforms: probe.platforms,
          ...(probe.backs_adapter !== undefined ? { backs_adapter: probe.backs_adapter } : {}),
          readiness,
          ...(reason !== undefined ? { reason } : {}),
        });
      }

      // Registered adapter ids that have no probe → `registered`.
      const registeredIds = options.registered_adapter_ids();
      for (const regId of registeredIds) {
        if (ctx.signal.aborted) break;
        const hasProbe = options.probes.some(
          (p) => p.backs_adapter === regId || p.id === regId,
        );
        if (!hasProbe) {
          entries.push({
            id: regId,
            platforms: [options.node_platform],
            readiness: 'registered',
          });
        }
      }

      // Apply capability_filter substring match on id and backs_adapter.
      let filteredEntries = entries;
      const rawFilter = args['capability_filter'];
      if (typeof rawFilter === 'string' && rawFilter.length > 0) {
        const filter = rawFilter.toLowerCase();
        filteredEntries = entries.filter((e) => {
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