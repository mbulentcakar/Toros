import { randomUUID } from 'node:crypto';

import type {
  Adapter,
  AdapterContext,
  ActionResult,
  AdapterManifest,
  ActionSchema,
  AppIdentity,
  AppRule,
  JsonValue,
  NodePlatform,
  ResolvedTarget,
  TargetResolver,
} from '@toros/contracts';

// ---------------------------------------------------------------------------
// Seam — the PowerShell/UIA layer, injectable for testability
// ---------------------------------------------------------------------------

export type { RawWindow, RawControl } from './probe.js';
import type { RawWindow, RawControl } from './probe.js';

export interface UiaProbe {
  /**
   * Enumerate top-level windows in the current session, each with the owning
   * process's OS-observed identity. `locked`/`disconnected` means the session
   * is unavailable and no windows are read.
   *
   * `authorized_apps` (RR-07) is the node's global application bound; the real
   * probe evaluates it in PowerShell *before* reading a window's native title
   * and before it counts toward `max_windows`, so an out-of-scope window is
   * never read and never counted. Absent means no bound is applied (test seam).
   */
  enumerateWindows(
    opts: { max_windows: number; authorized_apps?: readonly AppRule[] },
    signal: AbortSignal,
  ): Promise<
    | { readonly session_state: 'active'; readonly windows: readonly RawWindow[]; readonly truncated: boolean }
    | { readonly session_state: 'locked' | 'disconnected' }
  >;
  /**
   * Inspect one window's accessibility subtree, bounded. `closed: true` when the
   * window is gone. When not closed, `identity` is the LIVE identity of the
   * process now owning the handle, so the adapter can re-verify pid / creation
   * time / sha-256 against what it resolved (native handles are reused by the OS),
   * and `controls` are the bounded metadata (never a name or a value).
   *
   * `expected_identity` (RR-07) lets the real probe check `sameIdentity` *before*
   * walking the UIA subtree, so a reused handle never yields the new owner's tree.
   * Absent means the check is skipped (test seam).
   */
  inspectWindow(
    nativeHandle: string,
    opts: { depth: number; max_controls: number; expected_identity?: AppIdentity },
    signal: AbortSignal,
  ): Promise<
    | { readonly closed: true }
    | { readonly closed: false; readonly identity: AppIdentity | null; readonly controls: readonly RawControl[]; readonly truncated: boolean }
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

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface DesktopAdapterOptions {
  readonly node_platform: NodePlatform;
  /**
   * The node's global outer bound (amendment A8): the same `AppRule` shapes the
   * envelope's `allowed_apps` carries. A window whose identity matches no rule is
   * never resolved as a target and never appears in output. The envelope's own
   * `allowed_apps` is then applied by Core against these resolved targets.
   */
  readonly authorized_apps: readonly AppRule[];
  /** The OS seam. Real code passes createPowerShellUiaProbe(...); tests pass a fake. */
  readonly probe: UiaProbe;
  /** Bounds. */
  readonly max_windows: number;
  readonly max_controls: number;
  readonly timeout_ms: number;
  /** Injectable clock for the handle TTL; tests inject a fake, production uses Date.now. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Global-bound matching (amicable A8): the same three shapes the envelope
// carries, applied here so out-of-global-scope windows never become targets.
// ---------------------------------------------------------------------------

function normalizeSeparators(value: string): string {
  return value.replaceAll('\\', '/');
}

function globalRuleMatches(rule: AppRule, identity: AppIdentity): boolean {
  if ('image_sha256' in rule) {
    return identity.image_sha256 === rule.image_sha256;
  }
  if ('image_path' in rule) {
    return normalizeSeparators(identity.image_path).toLowerCase() === normalizeSeparators(rule.image_path).toLowerCase();
  }
  if (identity.signature !== 'valid') return false;
  return identity.signer === rule.signer
    && identity.product_name === rule.product_name
    && identity.original_filename !== null
    && identity.original_filename.toLowerCase() === rule.original_filename.toLowerCase();
}

function isGloballyAuthorized(authorized: readonly AppRule[], identity: AppIdentity): boolean {
  return authorized.some((rule) => globalRuleMatches(rule, identity));
}

// ---------------------------------------------------------------------------
// Per-(job, actor) enumeration state (AR-05)
// ---------------------------------------------------------------------------

interface EnumerationEntry {
  native_handle: string;
  title?: string;
  identity: AppIdentity;
  z_order: number;
  foreground: boolean;
  /** Set once `desktop.inspect` has spent this window's handle. */
  consumed: boolean;
}

interface StoredEnumeration {
  /** The freshness token for this enumeration. */
  freshness_token: string;
  /** Issuance time in ms epoch; a handle is valid for at most 60 s. */
  issued_at: number;
  session_state: 'active' | 'locked' | 'disconnected';
  /** Whether the probe truncated its enumeration (the cap was hit). */
  truncated: boolean;
  /** opaque window_id → entry (windows that passed the global bound). */
  windows: Map<string, EnumerationEntry>;
}

/** A handle is valid for at most this long after issuance. */
const HANDLE_TTL_MS = 60_000;

/** At most this many live enumerations, across all (job, actor) pairs. */
const MAX_LIVE_ENUMERATIONS = 32;

function enumerationKey(jobId: string, actor: string): string {
  // `\0` cannot appear in either id (job ids are UUIDs; actor is bounded ASCII),
  // so it is a safe delimiter.
  return `${jobId}\u0000${actor}`;
}

/** Compare the TOCTOU-relevant fields of two identities: pid, creation time, sha-256. */
function sameIdentity(a: AppIdentity, b: AppIdentity): boolean {
  return a.pid === b.pid && a.created_at === b.created_at && a.image_sha256 === b.image_sha256;
}

// ---------------------------------------------------------------------------
// Per-(job, actor, window) inspect pagination (RR-06)
// ---------------------------------------------------------------------------

/**
 * One captured, already-filtered inspect result being paged through. Page 1
 * walks the UIA subtree once and captures the full filtered control list;
 * every later page slices that capture rather than re-walking the tree (so
 * pagination never reopens replay). Each continuation token is single-use and
 * bound to the (job, actor, window) that minted it.
 */
interface PaginationState {
  job_id: string;
  actor: string;
  window_id: string;
  /** The full filtered control list captured at page 1, in stable order. */
  controls: readonly RawControl[];
  /** Index of the first control not yet returned. */
  cursor: number;
  page_size: number;
  /** The depth the page-1 subtree walk used, for the receipt. */
  depth: number;
  /** Whether the page-1 probe truncated the subtree walk (cap hit). */
  probe_truncated: boolean;
  issued_at: number;
  /** Set once a page has been served; a spent token is never replayed. */
  consumed: boolean;
}

/** At most this many live pagination states, across all (job, actor, window) tuples. */
const MAX_LIVE_PAGINATIONS = 64;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;

function buildManifest(options: DesktopAdapterOptions): AdapterManifest {
  const stateAction: ActionSchema = {
    id: 'state',
    summary: 'List top-level windows in this desktop session with a freshness token.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_scope'],
      properties: { session_scope: { type: 'string', enum: ['interactive'] } },
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
      // Page 1 carries window_id + freshness_token; page N+1 carries only the
      // continuation_token minted by the previous page (RR-06). Neither pair is
      // required at the schema level so both shapes validate; the adapter
      // returns refresh_required when neither is usable.
      required: ['session_scope'],
      properties: {
        session_scope: { type: 'string', enum: ['interactive'] },
        window_id: { type: 'string' },
        freshness_token: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 10 },
        control_filter: { type: 'string' },
        page_size: { type: 'integer', minimum: 1 },
        continuation_token: { type: 'string' },
      },
    },
    path_fields: [],
    mutates: false,
    always_requires_approval: false,
    timeout_ms: options.timeout_ms,
  };

  return {
    id: 'desktop',
    version: '0.2.0',
    platforms: ['win32'],
    actions: [stateAction, inspectAction],
    // AR-11: the probe reads and writes only its own mkdtemp directory, so the
    // manifest declares fs.read + fs.write in addition to spawn and automation.
    required_permissions: ['process.spawn', 'app.automation', 'fs.read', 'fs.write'],
    allowed_resources: [],
    default_timeout_ms: options.timeout_ms,
    cancellation: 'graceful',
    receipt_fields: ['window_count', 'session', 'reason', 'truncated', 'changed', 'status', 'control_count', 'depth'],
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createDesktopAdapter(options: DesktopAdapterOptions): Adapter {
  const manifest = buildManifest(options);
  const now = options.now ?? ((): number => Date.now());

  // Per-(job, actor) current enumeration, in insertion order so the oldest can
  // be evicted at the 32-enumeration cap.
  const enumerations = new Map<string, StoredEnumeration>();

  // Per-continuation-token inspect pagination (RR-06), in insertion order so the
  // oldest can be evicted at the cap.
  const paginations = new Map<string, PaginationState>();

  function lookupEnumeration(ctx: AdapterContext): StoredEnumeration | null {
    return enumerations.get(enumerationKey(ctx.job_id, ctx.actor)) ?? null;
  }

  function storeEnumeration(ctx: AdapterContext, enumeration: StoredEnumeration): void {
    const key = enumerationKey(ctx.job_id, ctx.actor);
    enumerations.delete(key);
    enumerations.set(key, enumeration);
    while (enumerations.size > MAX_LIVE_ENUMERATIONS) {
      const oldest = enumerations.keys().next().value;
      if (oldest === undefined) break;
      enumerations.delete(oldest);
    }
  }

  function storePagination(token: string, state: PaginationState): void {
    paginations.set(token, state);
    while (paginations.size > MAX_LIVE_PAGINATIONS) {
      const oldest = paginations.keys().next().value;
      if (oldest === undefined) break;
      paginations.delete(oldest);
    }
  }

  // ---- helper: redacted window shape ----

  interface PublicWindow {
    window_id: string;
    z_order: number;
    foreground: boolean;
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

  // ---------------------------------------------------------------------------
  // resolver — the two-phase resolve (amendment A8)
  // ---------------------------------------------------------------------------

  const resolver: TargetResolver = {
    async resolve(
      actionId: string,
      args: Readonly<Record<string, JsonValue>>,
      ctx: AdapterContext,
    ): Promise<readonly ResolvedTarget[]> {
      if (actionId === 'state') {
        return resolveState(args, ctx);
      }
      if (actionId === 'inspect') {
        return resolveInspect(args, ctx);
      }
      return [];
    },
  };

  async function resolveState(
    _args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<readonly ResolvedTarget[]> {
    const result = await options.probe.enumerateWindows(
      { max_windows: options.max_windows, authorized_apps: options.authorized_apps },
      ctx.signal,
    );

    if (result.session_state !== 'active') {
      // Unavailable session: store the reason for invoke to report and resolve
      // no targets (nothing may be acted on).
      storeEnumeration(ctx, {
        freshness_token: randomUUID(),
        issued_at: now(),
        session_state: result.session_state,
        truncated: false,
        windows: new Map(),
      });
      return [];
    }

    const entries = new Map<string, EnumerationEntry>();
    const targets: ResolvedTarget[] = [];

    let z = 0;
    for (const raw of result.windows) {
      // Global outer bound: a window whose identity matches no authorized rule
      // is never a target and never appears in output.
      if (!isGloballyAuthorized(options.authorized_apps, raw.identity)) continue;
      const windowId = randomUUID();
      entries.set(windowId, {
        native_handle: raw.native_handle,
        ...(typeof raw.title === 'string' ? { title: raw.title.slice(0, 256) } : {}),
        identity: raw.identity,
        z_order: z,
        foreground: raw.foreground,
        consumed: false,
      });
      targets.push({ kind: 'app', key: windowId, identity: raw.identity });
      z++;
    }

    storeEnumeration(ctx, {
      freshness_token: randomUUID(),
      issued_at: now(),
      session_state: 'active',
      truncated: result.truncated,
      windows: entries,
    });

    return targets;
  }

  async function resolveInspect(
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<readonly ResolvedTarget[]> {
    const rawContinuation = args['continuation_token'];
    if (rawContinuation !== undefined) {
      // R4 round 3 (P2): a continuation page resolves no new target (RR-06) —
      // the window was decided and its handle spent at page 1. The token's
      // value is irrelevant here; an empty/non-string token is refused at
      // invoke. Routing on key presence (not value) so an empty token never
      // falls through to a fresh page-1 resolution.
      return [];
    }

    const windowId = typeof args['window_id'] === 'string' ? args['window_id'] : '';
    const token = typeof args['freshness_token'] === 'string' ? args['freshness_token'] : '';

    const enumeration = lookupEnumeration(ctx);
    if (enumeration === null || enumeration.session_state !== 'active') return [];
    // A reused, expired or foreign token: resolve no target, so invoke reports
    // `refresh_required` (the same shape for all three, so the caller cannot
    // tell which case it hit).
    if (enumeration.freshness_token !== token) return [];
    if (now() - enumeration.issued_at > HANDLE_TTL_MS) return [];
    const entry = enumeration.windows.get(windowId);
    if (entry === undefined || entry.consumed) return [];

    return [{ kind: 'app', key: windowId, identity: entry.identity }];
  }

  // ---------------------------------------------------------------------------
  // invoke — act only on keys Core allowed
  // ---------------------------------------------------------------------------

  async function invokeState(
    _args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<ActionResult> {
    const enumeration = lookupEnumeration(ctx);

    if (enumeration === null || enumeration.session_state !== 'active') {
      const reason = enumeration?.session_state === 'locked' ? 'locked' : 'disconnected';
      const output = JSON.stringify({ session: 'unavailable', reason, windows: [] });
      return {
        output,
        truncated: false,
        artifacts: [],
        receipt_extra: { window_count: 0, session: 'unavailable', reason, truncated: false, changed: 0 },
      };
    }

    const decisions = ctx.target_decisions;
    const windows: PublicWindow[] = [];
    let changed = 0;

    // Publish only the keys whose decision is `allowed`, re-verifying each
    // live identity (pid / creation time / sha-256) against what was resolved.
    for (const [windowId, entry] of enumeration.windows) {
      if (decisions?.get(windowId) !== 'allowed') continue;
      const live = await options.probe.inspectWindow(
        entry.native_handle,
        // R4 round 3 (P3): re-verify against the resolved identity inside the
        // probe too, so a recycled HWND is dropped BEFORE the subtree is walked,
        // not after Node drops it downstream.
        { depth: 0, max_controls: 1, expected_identity: entry.identity },
        ctx.signal,
      );
      if (live.closed || live.identity === null) {
        // The window vanished or its identity could not be read: drop it and
        // count it as changed, never fall back to the resolved identity.
        changed += 1;
        continue;
      }
      if (!sameIdentity(entry.identity, live.identity)) {
        // A reused native handle or a changed process: not what we resolved.
        changed += 1;
        continue;
      }
      const publicWindow: PublicWindow = {
        window_id: windowId,
        z_order: entry.z_order,
        foreground: entry.foreground,
      };
      if (typeof entry.title === 'string') {
        publicWindow.title = entry.title.slice(0, 256);
      }
      windows.push(publicWindow);
    }

    const output = JSON.stringify({
      session: 'active',
      freshness_token: enumeration.freshness_token,
      truncated: enumeration.truncated,
      windows,
      ...(changed > 0 ? { changed } : {}),
    });

    return {
      output,
      truncated: false,
      artifacts: [],
      receipt_extra: {
        window_count: windows.length,
        session: 'active',
        truncated: enumeration.truncated,
        changed,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // desktop.inspect
  // ---------------------------------------------------------------------------

  type InspectStatus = 'ok' | 'refresh_required' | 'denied' | 'unavailable';

  function resolveDepth(args: Readonly<Record<string, JsonValue>>): number {
    const rawDepth = args['depth'];
    return typeof rawDepth === 'number' && Number.isFinite(rawDepth) && rawDepth >= 1
      ? Math.min(Math.floor(rawDepth), 10)
      : 3;
  }

  function resolvePageSize(args: Readonly<Record<string, JsonValue>>): number {
    const rawPageSize = args['page_size'];
    return typeof rawPageSize === 'number' && Number.isFinite(rawPageSize) && rawPageSize >= 1
      ? Math.floor(rawPageSize)
      : DEFAULT_PAGE_SIZE;
  }

  /** Map a raw control to its public shape — structure only, never a value, never a name. */
  function toPublicControl(raw: RawControl): PublicControl {
    const hasValidId = isValidAutomationId(raw.automation_id);
    return {
      control_id: randomUUID(),
      type: raw.control_type,
      ...(hasValidId ? { automation_id: raw.automation_id } : {}),
      enabled: raw.enabled,
      patterns: raw.patterns,
    };
  }

  /** Filter the raw controls (substring over type and automation_id only), before paginating. */
  function filterControls(controls: readonly RawControl[], controlFilter: string): readonly RawControl[] {
    if (controlFilter.length === 0) return controls;
    const filterLower = controlFilter.toLowerCase();
    return controls.filter((c) =>
      c.control_type.toLowerCase().includes(filterLower) ||
      (typeof c.automation_id === 'string' &&
        isValidAutomationId(c.automation_id) &&
        c.automation_id.toLowerCase().includes(filterLower)),
    );
  }

  async function invokeInspect(
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<ActionResult> {
    const rawContinuation = args['continuation_token'];
    // R4 round 3 (P2): any request that carries `continuation_token`, whatever
    // its value, goes to the continuation path. An absent key means page 1; an
    // empty or non-string token fails closed with refresh_required there.
    if (rawContinuation !== undefined) {
      return invokeInspectContinuation(rawContinuation, args, ctx);
    }
    return invokeInspectFirstPage(args, ctx);
  }

  /**
   * Page 1 of `desktop.inspect` (RR-06). It consumes the window handle and
   * walks the UIA subtree once, capturing the full filtered control list; when
   * more than `page_size` controls remain, it mints a single-use continuation
   * token bound to (job, actor, window_id).
   */
  async function invokeInspectFirstPage(
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<ActionResult> {
    const windowId = typeof args['window_id'] === 'string' ? args['window_id'] : '';
    const freshnessToken = typeof args['freshness_token'] === 'string' ? args['freshness_token'] : '';
    const depth = resolveDepth(args);
    const controlFilter = typeof args['control_filter'] === 'string' ? args['control_filter'] : '';
    const pageSize = resolvePageSize(args);

    const enumeration = lookupEnumeration(ctx);
    // One shape for every rejection, so a caller cannot probe which case it hit:
    // a reused, expired or foreign pair all return refresh_required.
    const handleValid = enumeration !== null
      && enumeration.session_state === 'active'
      && enumeration.freshness_token === freshnessToken
      && now() - enumeration.issued_at <= HANDLE_TTL_MS
      && enumeration.windows.has(windowId)
      && enumeration.windows.get(windowId)!.consumed === false;

    if (!handleValid) {
      const output = JSON.stringify({ status: 'refresh_required' as InspectStatus });
      return makeInspectResult('refresh_required', output, 0, false, depth);
    }

    const entry = enumeration.windows.get(windowId)!;

    // Spend the handle (single-use) before deciding, so a denied inspect cannot
    // be replayed against a different envelope later.
    entry.consumed = true;

    // ---- scope gate (Core's decision) ----
    const decision = ctx.target_decisions?.get(windowId);
    if (decision !== 'allowed') {
      const output = JSON.stringify({ status: 'denied' as InspectStatus });
      return makeInspectResult('denied', output, 0, false, depth);
    }

    // ---- probe call (re-verifies the live identity BEFORE walking the tree) ----
    // The probe returns up to max_controls in document order; the adapter filters
    // and paginates, so a filter match on a later part of the tree is never dropped
    // by probe-side paging and page order is stable.
    const probeResult = await options.probe.inspectWindow(
      entry.native_handle,
      { depth, max_controls: options.max_controls, expected_identity: entry.identity },
      ctx.signal,
    );

    if (probeResult.closed) {
      const output = JSON.stringify({ status: 'unavailable' as InspectStatus });
      return makeInspectResult('unavailable', output, 0, false, depth);
    }

    // Re-verify at execution (TOCTOU): the handle may now belong to a different
    // process or the image may have changed. Compare pid, creation time and
    // sha-256 against the resolved identity — a mismatch is `unavailable`, never
    // a leak of the new owner's tree.
    if (probeResult.identity === null || !sameIdentity(entry.identity, probeResult.identity)) {
      const output = JSON.stringify({ status: 'unavailable' as InspectStatus });
      return makeInspectResult('unavailable', output, 0, false, depth);
    }

    // Capture the full filtered list once, then page over it.
    const filtered = filterControls(probeResult.controls, controlFilter);
    const pageSlice = filtered.slice(0, pageSize);
    const morePages = filtered.length > pageSize;

    let continuationToken: string | undefined;
    if (morePages) {
      continuationToken = randomUUID();
      storePagination(continuationToken, {
        job_id: ctx.job_id,
        actor: ctx.actor,
        window_id: windowId,
        controls: filtered,
        cursor: pageSize,
        page_size: pageSize,
        depth,
        probe_truncated: probeResult.truncated,
        issued_at: now(),
        consumed: false,
      });
    }

    const publicControls = pageSlice.map(toPublicControl);
    const truncated = probeResult.truncated || morePages;

    const output = JSON.stringify({
      status: 'ok' as InspectStatus,
      controls: publicControls,
      truncated,
      ...(continuationToken !== undefined ? { continuation_token: continuationToken } : {}),
    });

    return makeInspectResult('ok', output, publicControls.length, truncated, depth);
  }

  /**
   * Page N+1 of `desktop.inspect` (RR-06). The previous page's continuation
   * token is required; it is single-use, bound to (job, actor, window_id), and
   * valid for 60 s. A reused, foreign, expired or unknown token all return the
   * same `refresh_required`, so the caller cannot probe which case it hit.
   */
  async function invokeInspectContinuation(
    token: JsonValue,
    args: Readonly<Record<string, JsonValue>>,
    ctx: AdapterContext,
  ): Promise<ActionResult> {
    const depth = resolveDepth(args);

    // R4 round 3 (P2): an empty or non-string token is refused the same way as
    // an unknown, reused, expired or foreign one — a single refresh_required
    // shape, so the caller cannot probe which case it hit.
    if (typeof token !== 'string' || token.length === 0) {
      const output = JSON.stringify({ status: 'refresh_required' as InspectStatus });
      return makeInspectResult('refresh_required', output, 0, false, depth);
    }

    const state = paginations.get(token);

    // R4 round 3 (P2): the token is bound to (job, actor, window_id). A caller
    // naming a different window than the token's must not receive that window's
    // controls under the requested window id.
    const windowIdArg = args['window_id'];
    const windowMatches = windowIdArg === undefined || windowIdArg === state?.window_id;

    const valid = state !== undefined
      && windowMatches
      && state.job_id === ctx.job_id
      && state.actor === ctx.actor
      && !state.consumed
      && now() - state.issued_at <= HANDLE_TTL_MS;

    if (!valid) {
      const output = JSON.stringify({ status: 'refresh_required' as InspectStatus });
      return makeInspectResult('refresh_required', output, 0, false, depth);
    }

    // Spend the token before serving, so a replay of page 2's token cannot
    // re-serve page 3.
    state.consumed = true;

    const pageSlice = state.controls.slice(state.cursor, state.cursor + state.page_size);
    const newCursor = state.cursor + pageSlice.length;
    const morePages = newCursor < state.controls.length;

    let nextToken: string | undefined;
    if (morePages) {
      nextToken = randomUUID();
      storePagination(nextToken, {
        job_id: ctx.job_id,
        actor: ctx.actor,
        window_id: state.window_id,
        controls: state.controls,
        cursor: newCursor,
        page_size: state.page_size,
        depth: state.depth,
        probe_truncated: state.probe_truncated,
        // R4 round 3 (P2): the NEXT token keeps the ORIGINAL issued_at, so the
        // whole pagination chain lives at most 60 s from page 1, never extended
        // page over page.
        issued_at: state.issued_at,
        consumed: false,
      });
    }

    const publicControls = pageSlice.map(toPublicControl);
    const truncated = morePages || state.probe_truncated;

    const output = JSON.stringify({
      status: 'ok' as InspectStatus,
      controls: publicControls,
      truncated,
      ...(nextToken !== undefined ? { continuation_token: nextToken } : {}),
    });

    return makeInspectResult('ok', output, publicControls.length, truncated, state.depth);
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

  const adapter: Adapter = {
    manifest,
    resolver,

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
      enumerations.clear();
      paginations.clear();
    },
  };

  return adapter;
}