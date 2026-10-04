/**
 * Correlation engine — implements the four routes from SPEC §8.2.
 *
 * Routes tried in order, first match wins:
 *   1. exact   — project_path last segment is a known session correlation id
 *   2. cited   — every cited_event_id resolves (via route 1 on past events) to the same session
 *   3. session — run_id already bound by a prior exact resolution; both records are "hook"
 *   4. none    — store with both ids null
 *
 * Route 3 is single-valued and self-invalidating: a second exact resolution in
 * the same run naming a different session drops the binding and retroactively
 * downgrades every record already bound through it to 'none'. Route 1 results
 * survive invalidation.
 */

import type { CorrelationConfidence } from '@toros/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A raw Numbat record as parsed from NDJSON. Every field is possibly absent
 * because the schema mixes optional fields that differ by record_type.
 */
export interface RawRecord {
  readonly schema_version: string;
  readonly record_type: string;
  readonly run_id?: string;
  readonly endpoint?: string;
  readonly source_agent?: string;
  readonly source_type?: string;
  readonly confidence?: number;

  // event-specific optional fields
  readonly event_id?: string;
  readonly event_type?: string;
  readonly evidence?: unknown;
  readonly project_path?: string;
  readonly session_id?: string;
  readonly tool_call_id?: string;

  // finding-specific optional fields
  readonly finding_id?: string;
  readonly detected_at?: string;
  readonly rule_id?: string;
  readonly rule_version?: string;
  readonly severity?: string;
  readonly title?: string;
  readonly evidence_refs?: unknown;
  readonly cited_event_ids?: readonly string[];
  readonly redacted?: unknown;
  readonly project_path_hash?: string;

  // allow arbitrary extra fields
  readonly [key: string]: unknown;
}

export interface CorrelationResult {
  /** Which route resolved the record. */
  readonly route: CorrelationConfidence;
  /** Session id if route 1-3 resolved, null for none. */
  readonly session_id: string | null;
  /** Always null — the observer correlates to sessions, never to actions. */
  readonly receipt_id: null;
}

/**
 * The facts a retraction needs from the correlator: which run's binding was
 * invalidated, which session the retracted records had been attributed to,
 * and the Numbat finding_ids of the findings whose attribution is withdrawn.
 *
 * The observer stamps `observed_at` and supplies `reason`; the correlator only
 * reports what it can see, which is correlation state.
 *
 * `retracted_finding_keys` are the Numbat `finding_id` from each source record
 * — not the store-assigned `finding_id`, which the observer never sees. The
 * Numbat id is required on every finding record and is stable, so it is the
 * key the audit can join back to the original emission.
 */
export interface RetractionPayload {
  readonly run_id: string;
  readonly retracted_session_id: string;
  readonly retracted_finding_keys: readonly string[];
}

/**
 * Callback invoked when a previously-emitted route-3 finding must be
 * retracted because the run binding was invalidated. Fired once per
 * invalidation, naming every affected finding.
 */
export type RetractionCallback = (payload: RetractionPayload) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the last path segment. Returns the segment or null if path is absent/falsy. */
function lastPathSegment(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  // Handle both Unix and Windows separators
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  const segment = idx >= 0 ? normalized.slice(idx + 1) : normalized;
  return segment.length > 0 ? segment : null;
}

// ---------------------------------------------------------------------------
// Correlator
// ---------------------------------------------------------------------------

export interface CorrelatorOptions {
  /** Resolves a session correlation id to a session id, or null if unknown. */
  readonly resolveSession: (correlationId: string) => string | null;
  /** Cap on the event_id and run_id maps. Oldest entries are dropped. */
  readonly correlation_map_limit: number;
  /** Optional callback for retraction emissions. */
  readonly onRetraction?: RetractionCallback;
}

export interface Correlator {
  /**
   * Correlate a raw record. Returns the result, and may mutate internal maps.
   * For events, this populates the event_id → session_id map.
   * For route 3, this may emit a retraction via onRetraction if the binding
   * is invalidated — one retraction naming every affected finding.
   */
  correlate(record: RawRecord): CorrelationResult;

  /**
   * Return the session_id an event_id resolved to, or null.
   * Used externally for cited_event_id lookups.
   */
  lookupEventId(eventId: string): string | null;
}

export function createCorrelator(options: CorrelatorOptions): Correlator {
  const { resolveSession, correlation_map_limit, onRetraction } = options;

  // event_id → session_id for cited resolution (route 2), bounded
  const eventMap = new Map<string, string>();

  // run_id → session_id for provisional binding (route 3), bounded
  const runMap = new Map<string, string>();

  // Track which run bindings have been invalidated
  const invalidatedRuns = new Set<string>();

  // Track findings emitted via route 3 per run_id so we can retract them
  // Map<run_id, Array<{originalRawRecord: RawRecord, sessionId: string}>>
  const route3Findings = new Map<string, Array<{ readonly originalRawRecord: RawRecord; readonly sessionId: string }>>();

  // ------------------------------------------------------------------
  // Map management
  // ------------------------------------------------------------------

  function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.set(key, value);
    if (map.size > correlation_map_limit) {
      const oldest = map.keys().next();
      if (!oldest.done && oldest.value !== undefined) {
        map.delete(oldest.value);
      }
    }
  }

  // ------------------------------------------------------------------
  // Route implementations
  // ------------------------------------------------------------------

  function routeExact(record: RawRecord): CorrelationResult | null {
    const segment = lastPathSegment(record.project_path);
    if (!segment) return null;

    const sessionId = resolveSession(segment);
    if (sessionId === null) return null;

    return { route: 'exact', session_id: sessionId, receipt_id: null };
  }

  function routeCited(record: RawRecord): CorrelationResult | null {
    const cited = record.cited_event_ids;
    if (!cited || cited.length === 0) return null;

    // Resolve each cited_event_id through the event map
    let resolvedSession: string | null = null;

    for (const evId of cited) {
      const sessionId = eventMap.get(evId) ?? null;
      if (sessionId === null) {
        // Any unfound citation → route 2 fails
        return null;
      }
      if (resolvedSession === null) {
        resolvedSession = sessionId;
      } else if (resolvedSession !== sessionId) {
        // Two different sessions → route 2 fails
        return null;
      }
    }

    if (resolvedSession === null) return null;

    return { route: 'cited', session_id: resolvedSession, receipt_id: null };
  }

  /** Whether a record can be named in a retraction. */
  function hasFindingKey(record: RawRecord): boolean {
    return typeof record.finding_id === 'string' && record.finding_id.length > 0;
  }

  function routeSession(record: RawRecord): CorrelationResult | null {
    const runId = record.run_id;
    if (!runId) return null;

    // If this run was invalidated, route 3 is unavailable
    if (invalidatedRuns.has(runId)) return null;

    const sourceType = record.source_type;
    if (sourceType !== 'hook') return null;

    // Route 3 is PROVISIONAL — it can be withdrawn later, and a withdrawal
    // names the findings it withdraws by their Numbat finding_id. A finding
    // record carrying no usable finding_id can never be named, so attributing
    // it provisionally would create an attribution that cannot be retracted:
    // on invalidation it would either be silently left standing, or produce a
    // retraction with an empty key list that no reader can join back to
    // anything.
    //
    // So it does not get the provisional route at all. It still becomes a
    // finding — it falls through to route 4 and is recorded as `none`, which is
    // the honest answer for a record we cannot account for. Do not make an
    // attribution you have no way to take back.
    if (record.record_type === 'finding' && !hasFindingKey(record)) return null;

    const boundSession = runMap.get(runId);
    if (!boundSession) return null;

    return { route: 'session', session_id: boundSession, receipt_id: null };
  }

  // ------------------------------------------------------------------
  // Route 3 binding management
  // ------------------------------------------------------------------

  /**
   * If an exact resolution happens on a hook record, try to bind its run_id.
   * If the run_id is already bound to a different session, invalidate.
   * Also checks route3Findings for evicted-but-tracked bindings so that
   * map eviction does not prevent conflict detection.
   */
  function handleExactBinding(record: RawRecord, sessionId: string): void {
    const runId = record.run_id;
    if (!runId) return;

    const sourceType = record.source_type;
    if (sourceType !== 'hook') return;

    const existing = runMap.get(runId);
    if (existing !== undefined) {
      if (existing !== sessionId) {
        invalidateRun(runId);
      }
      return;
    }

    // runMap entry was evicted — check route3Findings for a previous session
    const existingFindings = route3Findings.get(runId);
    if (existingFindings && existingFindings.length > 0) {
      const priorSession = existingFindings[0]!.sessionId;
      if (priorSession !== sessionId) {
        invalidateRun(runId);
        return;
      }
      // Same session — restore the runMap binding
      boundedSet(runMap, runId, sessionId);
      return;
    }

    // New binding
    boundedSet(runMap, runId, sessionId);
  }

  /**
   * Invalidate a run_id: mark it as invalidated, delete from runMap,
   * emit a single retraction naming every route-3 finding previously
   * attributed to the now-withdrawn session.
   */
  function invalidateRun(runId: string): void {
    invalidatedRuns.add(runId);
    runMap.delete(runId);

    // Emit one retraction for every previously emitted route-3 finding.
    if (onRetraction) {
      const entries = route3Findings.get(runId);
      if (entries && entries.length > 0) {
        const retractedSessionId = entries[0]!.sessionId;
        const retractedFindingKeys = entries
          .map((e) => e.originalRawRecord.finding_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        // Unreachable now that routeSession refuses to attribute a finding it
        // cannot name — but the guard was `entries.length`, not `keys.length`,
        // and that is precisely how the empty retraction got out. A retraction
        // naming nothing cannot be joined to any observation, so it is noise in
        // the one channel that exists to correct the record.
        if (retractedFindingKeys.length === 0) {
          route3Findings.delete(runId);
          return;
        }
        onRetraction({
          run_id: runId,
          retracted_session_id: retractedSessionId,
          retracted_finding_keys: retractedFindingKeys,
        });
      }
    }
    route3Findings.delete(runId);
  }

  /** Track a route-3 emission so it can be retracted later. */
  function trackRoute3Finding(record: RawRecord, resolvedSession: string): void {
    const runId = record.run_id;
    if (!runId) return;

    let entries = route3Findings.get(runId);
    if (!entries) {
      entries = [];
      route3Findings.set(runId, entries);
    }
    entries.push({ originalRawRecord: record, sessionId: resolvedSession });
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  function correlate(record: RawRecord): CorrelationResult {
    // Route 1: exact
    const exact = routeExact(record);
    if (exact) {
      // If an exact match and it's a hook event, update run binding
      if (record.run_id && record.source_type === 'hook' && exact.session_id) {
        handleExactBinding(record, exact.session_id);
      }

      // For events, remember the event_id → session mapping
      if (record.record_type === 'event' && record.event_id && record.run_id) {
        boundedSet(eventMap, record.event_id, exact.session_id);
      }

      return exact;
    }

    // Route 2: cited (findings only)
    if (record.record_type === 'finding') {
      const cited = routeCited(record);
      if (cited) return cited;
    }

    // Route 3: session
    const session = routeSession(record);
    if (session) {
      // Track this finding for potential retraction later
      if (record.record_type === 'finding' && session.session_id) {
        trackRoute3Finding(record, session.session_id);
      }

      // For events, also remember the event_id mapping via session correlation
      if (record.record_type === 'event' && record.event_id && record.run_id) {
        if (!runMap.has(record.run_id)) {
          // If the run is bound, map the event_id too
          const boundSession = runMap.get(record.run_id);
          if (boundSession) {
            boundedSet(eventMap, record.event_id, boundSession);
          }
        }
      }

      return session;
    }

    // Route 4: none
    return { route: 'none', session_id: null, receipt_id: null };
  }

  function lookupEventId(eventId: string): string | null {
    return eventMap.get(eventId) ?? null;
  }

  return { correlate, lookupEventId };
}