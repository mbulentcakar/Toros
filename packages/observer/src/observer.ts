/**
 * Observer implementation — creates SecurityObserver instances.
 *
 * NumbatObserver tails the NDJSON records file, correlates each record
 * through the four routes (exact, cited, session, none), redacts findings,
 * and emits them via the onFinding handler.
 *
 * NullObserver is a no-op for hosts without Numbat.
 */

import type { SecurityObserver, FindingRecord, CorrelationRetraction } from '@toros/contracts';
import { createTailer, type Tailer } from './tailer.js';
import { createCorrelator, type Correlator, type RawRecord, type RetractionPayload } from './correlator.js';
import { redactRecord } from './redactor.js';

// ---------------------------------------------------------------------------
// Options (public)
// ---------------------------------------------------------------------------

export interface NumbatObserverOptions {
  /** Path to records.ndjson. Defaults to ~/.numbat/records.ndjson. */
  readonly records_path: string;
  /** Resolves a session correlation id to a session id, or null. */
  readonly resolveSession: (correlationId: string) => string | null;
  /** Resolves a session id to its job id. */
  readonly jobForSession: (sessionId: string) => string | null;
  /** Cap on the event_id and run_id maps. Oldest entries are dropped. */
  readonly correlation_map_limit: number;
}

// ---------------------------------------------------------------------------
// NumbatObserver
// ---------------------------------------------------------------------------

function createNumbatObserver(options: NumbatObserverOptions): SecurityObserver {
  const { records_path } = options;

  let handler: ((finding: Omit<FindingRecord, 'finding_id'>) => void) | null = null;
  let retractionHandler: ((retraction: CorrelationRetraction) => void) | null = null;
  let tailer: Tailer | null = null;
  let correlator: Correlator | null = null;
  let started = false;

  // Correlator is created lazily or on start to capture options
  function getCorrelator(): Correlator {
    if (!correlator) {
      correlator = createCorrelator({
        resolveSession: options.resolveSession,
        correlation_map_limit: options.correlation_map_limit,
        onRetraction: (payload: RetractionPayload) => {
          // A retraction is a separate channel, not a re-emitted finding. A
          // duplicate finding would be indistinguishable from a second
          // observation of the same thing and could not tell the audit which
          // earlier attribution was withdrawn. Route the invalidation to the
          // retraction handler instead.
          emitRetraction(payload);
        },
      });
    }
    return correlator;
  }

  function emitFinding(record: RawRecord): void {
    const h = handler;
    if (!h) return;

    const cr = getCorrelator();
    const correlation = cr.correlate(record);
    const { detail, redacted_title } = redactRecord(record as Readonly<Record<string, unknown>>);

    const observedAt = record.detected_at as string | undefined ?? '';
    const severity = (record.severity as string | undefined) as FindingRecord['severity'] | undefined ?? 'low';

    h({
      receipt_id: correlation.receipt_id,
      job_id: correlation.session_id ? options.jobForSession(correlation.session_id) : null,
      session_id: correlation.session_id,
      correlation: correlation.route,
      rule_id: (record.rule_id as string | undefined) ?? '',
      severity,
      title: redacted_title,
      observed_at: observedAt,
      detail,
    });
  }

  function emitRetraction(payload: RetractionPayload): void {
    const h = retractionHandler;
    if (!h) return;

    h({
      run_id: payload.run_id,
      retracted_session_id: payload.retracted_session_id,
      retracted_finding_keys: payload.retracted_finding_keys,
      // The observer records when it observed the invalidation, not when the
      // retracted finding was first seen — the log already holds that.
      observed_at: new Date().toISOString(),
      reason: 'route-3 run binding invalidated by a conflicting exact resolution',
    });
  }

  function handleLine(line: string): void {
    let parsed: RawRecord;
    try {
      parsed = JSON.parse(line) as RawRecord;
    } catch {
      // Malformed JSON — skip with a log; the spec says "skipped with a log line"
      console.warn(`[observer] malformed line, skipping: ${line.slice(0, 80)}`);
      return;
    }

    // Skip records that are not schema version 0.2.0
    if (parsed.schema_version !== '0.2.0') {
      console.warn(`[observer] unknown schema_version "${parsed.schema_version}", skipping`);
      return;
    }

    // Only process event and finding record types
    if (parsed.record_type !== 'event' && parsed.record_type !== 'finding') {
      return;
    }

    const cr = getCorrelator();

    if (parsed.record_type === 'finding') {
      emitFinding(parsed);
    }

    // Events are also correlated (to populate maps), but not emitted
    if (parsed.record_type === 'event') {
      // Still run through correlator to populate event_id → session_id maps
      cr.correlate(parsed);
    }
  }

  return {
    id: 'numbat-observer',

    async start(): Promise<void> {
      if (started) return;
      started = true;

      tailer = createTailer(records_path, {
        onLine: handleLine,
        onError: (err: Error) => {
          console.error(`[observer] tailer error: ${err.message}`);
        },
      });
      await tailer.start();
    },

    onFinding(h: (finding: Omit<FindingRecord, 'finding_id'>) => void): void {
      handler = h;
    },

    onRetraction(h: (retraction: CorrelationRetraction) => void): void {
      retractionHandler = h;
    },

    async stop(): Promise<void> {
      if (tailer) {
        await tailer.stop();
        tailer = null;
      }
      started = false;
    },
  };
}

// ---------------------------------------------------------------------------
// NullObserver
// ---------------------------------------------------------------------------

function createNullObserver(): SecurityObserver {
  return {
    id: 'null-observer',

    async start(): Promise<void> {
      // No-op
    },

    onFinding(_handler: (finding: Omit<FindingRecord, 'finding_id'>) => void): void {
      // Registers the handler but never fires it — a host without Numbat
      // observes nothing.
    },

    onRetraction(_handler: (retraction: CorrelationRetraction) => void): void {
      // Registers the handler but never fires it — same rationale as onFinding.
    },

    async stop(): Promise<void> {
      // No-op
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { createNumbatObserver, createNullObserver };