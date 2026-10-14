import { randomUUID } from 'node:crypto';

import type {
  Adapter,
  AdapterContext,
  ActionResult,
  AdapterManifest,
  ActionSchema,
  JsonValue,
  NodePlatform,
} from '@toros/contracts';

// ---------------------------------------------------------------------------
// Seam — the PowerShell/UIA layer, injectable for testability
// ---------------------------------------------------------------------------

export type { RawWindow, RawControl } from './probe.js';
import type { RawWindow, RawControl } from './probe.js';

export interface UiaProbe {
  /** Enumerate top-level windows in the given interactive session. */
  enumerateWindows(
    sessionScope: string,
    opts: { max_windows: number },
    signal: AbortSignal,
  ): Promise<
    | { readonly session_state: 'active'; readonly windows: readonly RawWindow[]; readonly truncated?: boolean }
    | { readonly session_state: 'locked' | 'disconnected' }
  >;
  /**
   * Inspect one window's accessibility subtree, bounded. `closed: true` when the
   * window is gone. When not closed, `process_name` is the resolved window's LIVE
   * process name, so the adapter can re-validate that the handle still refers to
   * the same in-scope app it enumerated (native handles are reused by the OS).
   */
  inspectWindow(nativeHandle: string, opts: { depth: number; max_controls: number }, signal: AbortSignal): Promise<
    | { readonly closed: true }
    | { readonly closed: false; readonly process_name: string; readonly controls: readonly RawControl[]; readonly truncated: boolean }
  >;
}

/**
 * 1–128 printable ASCII characters (0x20 to 0x7E inclusive).
 */
export function isValidAutomationId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length < 1 || id.length > 128) return false;
  return /^[\x20-\x7E]+$/.test(id);
}

/**
 * Case-insensitive process match, tolerant of a trailing `.exe` on either side
 * (config may say `EXCEL.EXE`; the OS may report `EXCEL`). An empty process name
 * never matches — fail closed.
 */
function isAuthorizedApp(authorized: readonly string[], processName: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/\.exe$/, '');
  const target = norm(processName);
  return target.length > 0 && authorized.some((name) => norm(name) === target);
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface DesktopAdapterOptions {
  readonly node_platform: NodePlatform;
  /** Operator-allowlisted application scope: process names whose window titles/contents may be revealed. */
  readonly authorized_apps: readonly string[];
  /** The OS seam. Real code passes createPowerShellUiaProbe(...); tests pass a fake. */
  readonly probe: UiaProbe;
  /** Bounds. */
  readonly max_windows: number;
  readonly max_controls: number;
  readonly timeout_ms: number;
}

// ---------------------------------------------------------------------------
// Internal enumeration state
// ---------------------------------------------------------------------------

interface EnumerationEntry {
  native_handle: string;
  process_name: string;
  app_in_scope: boolean;
}

interface StoredEnumeration {
  /** The freshness token for this enumeration. */
  freshness_token: string;
  /** opaque window_id → entry. */
  windows: Map<string, EnumerationEntry>;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;

function buildManifest(options: DesktopAdapterOptions): AdapterManifest {
  const stateAction: ActionSchema = {
    id: 'state',
    summary: 'List top-level windows on this desktop session with freshness token.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_scope'],
      properties: { session_scope: { type: 'string' } },
    },
    path_fields: [],
    mutates: false,
    always_requires_approval: false,
    timeout_ms: options.timeout_ms,
  };

  const inspectAction: ActionSchema = {
    id: 'inspect',
    summary: 'Inspect the accessibility tree of one window. Metadata only — never returns control values.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['window_id', 'freshness_token'],
      properties: {
        window_id: { type: 'string' },
        freshness_token: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 10 },
        control_filter: { type: 'string' },
        page: { type: 'integer', minimum: 1 },
        page_size: { type: 'integer', minimum: 1 },
      },
    },
    path_fields: [],
    mutates: false,
    always_requires_approval: false,
    timeout_ms: options.timeout_ms,
  };

  return {
    id: 'desktop',
    version: '0.1.0',
    platforms: ['win32'],
    actions: [stateAction, inspectAction],
    required_permissions: ['process.spawn', 'app.automation'],
    allowed_resources: [],
    default_timeout_ms: options.timeout_ms,
    cancellation: 'graceful',
    receipt_fields: ['window_count', 'session_state', 'truncated', 'status', 'control_count', 'depth'],
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createDesktopAdapter(options: DesktopAdapterOptions): Adapter {
  const manifest = buildManifest(options);

  // Internal mutable state — the single current enumeration
  let currentEnumeration: StoredEnumeration | null = null;

  // ---- helper: redacted window shape ----

  interface PublicWindow {
    window_id: string;
    z_order: number;
    foreground: boolean;
    app_in_scope: boolean;
    title?: string;
  }

  // ---- helper: redacted control shape ----

  interface PublicControl {
    control_id: string;
    type: string;
    automation_id?: string;
    enabled: boolean;
    patterns: readonly string[];
  }

  const adapter: Adapter = {
    manifest,

    async init(): Promise<void> {
      // No pre-flight check needed.
    },

    async invoke(
      actionId: string,
      args: Readonly<Record<string, JsonValue>>,
      ctx: AdapterContext,
    ): Promise<ActionResult> {
      switch (actionId) {
        case 'state':
          return invokeState(args, ctx);
        case 'inspect':
          return invokeInspect(args, ctx);
        default:
          throw new Error(`desktop adapter has no action "${actionId}"`);
      }
    },

    async dispose(): Promise<void> {
      currentEnumeration = null;
    },
  };

  // ---------------------------------------------------------------------------
  // desktop.state
  // ---------------------------------------------------------------------------

  async function invokeState(
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<ActionResult> {
    const sessionScope = typeof args['session_scope'] === 'string' ? args['session_scope'] : 'default';

    const result = await options.probe.enumerateWindows(
      sessionScope,
      { max_windows: options.max_windows },
      ctx.signal,
    );

    if (result.session_state === 'locked' || result.session_state === 'disconnected') {
      // No window list for unavailable sessions. No enumeration stored.
      currentEnumeration = null;

      const output = JSON.stringify({ session_state: result.session_state, windows: [] });
      return {
        output,
        truncated: false,
        artifacts: [],
        receipt_extra: { window_count: 0, session_state: result.session_state, truncated: false },
      };
    }

    // Session is active — narrow the type.
    if (result.session_state !== 'active') {
      // Should be unreachable after the guard above, but satisfies TypeScript narrowing.
      throw new Error(`unexpected session_state: ${result.session_state}`);
    }
    const freshnessToken = randomUUID();
    const idMap = new Map<string, EnumerationEntry>();

    const windows: PublicWindow[] = [];
    const maxWindows = options.max_windows;

    for (let i = 0; i < result.windows.length; i++) {
      const raw = result.windows[i]!;

      if (windows.length >= maxWindows) {
        break;
      }

      const windowId = randomUUID();
      const processName = raw.process_name;
      const appInScope = isAuthorizedApp(options.authorized_apps, processName);

      idMap.set(windowId, {
        native_handle: raw.native_handle,
        process_name: processName,
        app_in_scope: appInScope,
      });

      const publicWindow: PublicWindow = {
        window_id: windowId,
        z_order: raw.z_order,
        foreground: raw.foreground,
        app_in_scope: appInScope,
      };

      // title is included ONLY when app_in_scope is true and raw.title is present
      if (appInScope && typeof raw.title === 'string') {
        publicWindow.title = raw.title.slice(0, 256);
      }

      windows.push(publicWindow);
    }

    const truncated = ('truncated' in result && result.truncated === true) || result.windows.length > windows.length;

    currentEnumeration = { freshness_token: freshnessToken, windows: idMap };

    const output = JSON.stringify({
      session_state: 'active',
      freshness_token: freshnessToken,
      windows,
      ...(truncated ? { truncated: true } : {}),
    });

    return {
      output,
      truncated: false,
      artifacts: [],
      receipt_extra: {
        window_count: windows.length,
        session_state: 'active',
        truncated,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // desktop.inspect
  // ---------------------------------------------------------------------------

  type InspectStatus = 'ok' | 'refresh_required' | 'denied' | 'unavailable';

  async function invokeInspect(
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<ActionResult> {
    const windowId = typeof args['window_id'] === 'string' ? args['window_id'] : '';
    const freshnessToken = typeof args['freshness_token'] === 'string' ? args['freshness_token'] : '';

    // Resolve depth from args, default 3
    const rawDepth = args['depth'];
    const depth = typeof rawDepth === 'number' && Number.isFinite(rawDepth) && rawDepth >= 1
      ? Math.min(Math.floor(rawDepth), 10)
      : 3;

    const controlFilter = typeof args['control_filter'] === 'string' ? args['control_filter'] : '';

    const rawPage = args['page'];
    const page = typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage >= 1
      ? Math.floor(rawPage)
      : 1;

    const rawPageSize = args['page_size'];
    const pageSize = typeof rawPageSize === 'number' && Number.isFinite(rawPageSize) && rawPageSize >= 1
      ? Math.floor(rawPageSize)
      : DEFAULT_PAGE_SIZE;

    // ---- freshness check ----
    if (currentEnumeration === null || freshnessToken !== currentEnumeration.freshness_token) {
      const output = JSON.stringify({ status: 'refresh_required' as InspectStatus });
      return makeInspectResult('refresh_required', output, 0, false, depth);
    }

    const entry = currentEnumeration.windows.get(windowId);
    if (entry === undefined) {
      const output = JSON.stringify({ status: 'refresh_required' as InspectStatus });
      return makeInspectResult('refresh_required', output, 0, false, depth);
    }

    // ---- scope gate ----
    if (!entry.app_in_scope) {
      const output = JSON.stringify({ status: 'denied' as InspectStatus });
      return makeInspectResult('denied', output, 0, false, depth);
    }

    // ---- probe call ----
    // The probe returns up to max_controls in document order; the adapter filters
    // and paginates, so a filter match on a later part of the tree is never dropped
    // by probe-side paging and page order is stable.
    const probeResult = await options.probe.inspectWindow(
      entry.native_handle,
      { depth, max_controls: options.max_controls },
      ctx.signal,
    );

    if (probeResult.closed) {
      const output = JSON.stringify({ status: 'unavailable' as InspectStatus });
      return makeInspectResult('unavailable', output, 0, false, depth);
    }

    // Re-validate at inspect time (TOCTOU): a native handle can be reused by a
    // different, possibly out-of-scope, process after the window we enumerated is
    // destroyed. The probe reports the resolved window's live process; require it
    // to still equal the enumerated process AND be in scope, or treat the handle
    // as no longer referring to what we authorized — unavailable, never a leak.
    const norm = (s: string): string => s.toLowerCase().replace(/\.exe$/, '');
    if (
      norm(probeResult.process_name) !== norm(entry.process_name) ||
      !isAuthorizedApp(options.authorized_apps, probeResult.process_name)
    ) {
      const output = JSON.stringify({ status: 'unavailable' as InspectStatus });
      return makeInspectResult('unavailable', output, 0, false, depth);
    }

    // Filter (substring over type and automation_id only) BEFORE paginating.
    let filtered = probeResult.controls;
    if (controlFilter.length > 0) {
      const filterLower = controlFilter.toLowerCase();
      filtered = filtered.filter((c) =>
        c.control_type.toLowerCase().includes(filterLower) ||
        (typeof c.automation_id === 'string' &&
          isValidAutomationId(c.automation_id) &&
          c.automation_id.toLowerCase().includes(filterLower)),
      );
    }

    // Paginate the filtered list, adapter-side.
    const start = (page - 1) * pageSize;
    const pageSlice = filtered.slice(start, start + pageSize);
    const morePages = start + pageSize < filtered.length;
    // `truncated` = either the probe capped the tree at max_controls, or more pages
    // of the filtered set remain. `next_page` is offered only when more pages remain.
    const truncated = probeResult.truncated || morePages;
    const nextPage = morePages ? page + 1 : undefined;

    // Map to public controls — structure only, never a value, never a name.
    const publicControls: PublicControl[] = pageSlice.map((raw) => {
      const hasValidId = isValidAutomationId(raw.automation_id);
      return {
        control_id: randomUUID(),
        type: raw.control_type,
        ...(hasValidId ? { automation_id: raw.automation_id } : {}),
        enabled: raw.enabled,
        patterns: raw.patterns,
      };
    });

    const output = JSON.stringify({
      status: 'ok' as InspectStatus,
      controls: publicControls,
      truncated,
      ...(nextPage !== undefined ? { next_page: nextPage } : {}),
    });

    return makeInspectResult('ok', output, publicControls.length, truncated, depth);
  }

  function makeInspectResult(
    status: InspectStatus,
    output: string,
    controlCount: number,
    truncated: boolean,
    depth: number,
  ): ActionResult {
    return {
      output,
      truncated: false,
      artifacts: [],
      receipt_extra: { status, control_count: controlCount, truncated, depth },
    };
  }

  return adapter;
}