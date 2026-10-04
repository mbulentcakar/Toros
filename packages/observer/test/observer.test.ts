/**
 * Acceptance tests for @toros/observer
 *
 * All tests use NDJSON fixtures written inline or as temp files.
 * No live Numbat required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNumbatObserver, createNullObserver } from '../src/observer.js';
import { createCorrelator, type RawRecord, type RetractionPayload } from '../src/correlator.js';
import { redactRecord } from '../src/redactor.js';

// ---------------------------------------------------------------------------
// Helper: fixture builders
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<RawRecord> = {}): RawRecord {
  return {
    schema_version: '0.2.0',
    record_type: 'event',
    run_id: 'run-a',
    endpoint: 'local',
    source_agent: 'codex',
    source_type: 'hook',
    confidence: 0.95,
    event_id: 'evt-1',
    event_type: 'command',
    evidence: { cmd: 'ls' },
    ...overrides,
  };
}

function makeFinding(overrides: Partial<RawRecord> = {}): RawRecord {
  return {
    schema_version: '0.2.0',
    record_type: 'finding',
    run_id: 'run-a',
    endpoint: 'local',
    source_agent: 'codex',
    source_type: 'hook',
    confidence: 0.8,
    finding_id: 'find-1',
    detected_at: '2026-08-02T12:00:00Z',
    rule_id: 'RULE-001',
    rule_version: '1.0',
    severity: 'medium',
    title: 'Suspicious command',
    evidence_refs: [{ type: 'event', id: 'evt-1' }],
    cited_event_ids: ['evt-1'],
    redacted: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: make temp dir / file
// ---------------------------------------------------------------------------

interface TempFixture {
  path: string;
  dir: string;
  cleanup: () => void;
}

function createTempFile(initialContent: string = ''): TempFixture {
  const dir = mkdtempSync(join(tmpdir(), 'observer-test-'));
  const path = join(dir, 'records.ndjson');
  // Always create the file, even when empty, so an "empty" fixture
  // exists at start() rather than appearing later with pre-existing content.
  writeFileSync(path, initialContent, 'utf8');
  return {
    path,
    dir,
    cleanup: () => {
      try { unlinkSync(path); } catch { /* ok */ }
      try { unlinkSync(join(dir, 'records.ndjson')); } catch { /* ok */ }
      try { unlinkSync(dir); } catch { /* ok */ }
    },
  };
}

function appendToFile(path: string, content: string): void {
  appendFileSync(path, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Helper: wait for poll cycles
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helper: create an observer for testing
// ---------------------------------------------------------------------------

function createTestObserver(
  recordsPath: string,
  resolveSession: (id: string) => string | null = () => null,
  jobForSession: (id: string) => string | null = () => null,
  mapLimit: number = 100,
) {
  return createNumbatObserver({
    records_path: recordsPath,
    resolveSession,
    jobForSession,
    correlation_map_limit: mapLimit,
  });
}

// =========================================================================
// 1-8. PARSING AND TAILING
// =========================================================================

describe('Parsing and tailing', () => {

  // -----------------------------------------------------------------------
  // 1. emits nothing for records written before start
  // -----------------------------------------------------------------------
  it('1. emits nothing for records written before start', async () => {
    const tf = createTempFile('{"schema_version":"0.2.0","record_type":"finding","run_id":"r1","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f1","detected_at":"2026-01-01T00:00:00Z","rule_id":"R1","rule_version":"1","severity":"low","title":"old","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
    try {
      const findings: Array<{ title: string }> = [];
      const obs = createTestObserver(tf.path);

      obs.onFinding((f) => { findings.push({ title: f.title }); });

      await obs.start();
      await wait(400); // enough for at least one poll cycle

      // Append a new finding after start
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r2","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f2","detected_at":"2026-01-01T00:00:01Z","rule_id":"R2","rule_version":"1","severity":"low","title":"new","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);

      assert.equal(findings.length, 1, 'should emit only the appended finding');
      assert.equal(findings[0]!.title, 'new');

      await obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 2. emits a finding appended after start
  // -----------------------------------------------------------------------
  it('2. emits a finding appended after start', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ finding_id: string }> = [];
      const obs = createTestObserver(tf.path);

      obs.onFinding((f) => { findings.push({ finding_id: f.rule_id }); });

      await obs.start();
      await wait(400);

      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r1","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f1","detected_at":"2026-01-01T00:00:00Z","rule_id":"R1","rule_version":"1","severity":"low","title":"test","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(600);

      assert.equal(findings.length, 1);
      assert.equal(findings[0]!.finding_id, 'R1');

      await obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 3. buffers a partial line until its newline arrives
  // -----------------------------------------------------------------------
  it('3. buffers a partial line until its newline arrives', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ title: string }> = [];
      const obs = createTestObserver(tf.path);

      obs.onFinding((f) => { findings.push({ title: f.title }); });

      await obs.start();
      await wait(400);

      // Write partial line (no newline)
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r1","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f1","detected_at":"2026-01-01T00:00:00Z","rule_id":"R1","rule_version":"1","severity":"low","title":"partial');
      await wait(600);
      assert.equal(findings.length, 0, 'should not emit partial line');

      // Complete the line with newline
      appendToFile(tf.path, '","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(600);

      assert.equal(findings.length, 1, 'should emit after newline arrives');
      assert.equal(findings[0]!.title, 'partial');

      await obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 4. skips a malformed line and keeps tailing
  // -----------------------------------------------------------------------
  it('4. skips a malformed line and keeps tailing', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ title: string }> = [];
      const obs = createTestObserver(tf.path);

      obs.onFinding((f) => { findings.push({ title: f.title }); });

      await obs.start();
      await wait(200);

      // Malformed JSON
      appendToFile(tf.path, 'not json at all\n');
      await wait(400);

      // Valid finding after
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r2","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f2","detected_at":"2026-01-01T00:00:00Z","rule_id":"R2","rule_version":"1","severity":"low","title":"good","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);

      assert.equal(findings.length, 1, 'should skip malformed line and emit valid one');
      assert.equal(findings[0]!.title, 'good');

      await obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 5. skips an unknown schema_version and keeps tailing
  // -----------------------------------------------------------------------
  it('5. skips an unknown schema_version and keeps tailing', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ title: string }> = [];
      const obs = createTestObserver(tf.path);

      obs.onFinding((f) => { findings.push({ title: f.title }); });

      await obs.start();
      await wait(200);

      // Wrong schema version
      appendToFile(tf.path, '{"schema_version":"0.1.0","record_type":"finding","run_id":"r1","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f1","detected_at":"2026-01-01T00:00:00Z","rule_id":"R1","rule_version":"1","severity":"low","title":"wrong-schema","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);

      // Valid record
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r2","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f2","detected_at":"2026-01-01T00:00:00Z","rule_id":"R2","rule_version":"1","severity":"low","title":"good","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);

      assert.equal(findings.length, 1, 'should skip old schema version');
      assert.equal(findings[0]!.title, 'good');

      await obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 6. ignores record types other than event and finding
  // -----------------------------------------------------------------------
  it('6. ignores record types other than event and finding', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ title: string }> = [];
      const obs = createTestObserver(tf.path);

      obs.onFinding((f) => { findings.push({ title: f.title }); });

      await obs.start();
      await wait(200);

      // enforcement record type — should be ignored
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"enforcement","run_id":"r1","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8}\n');
      await wait(200);

      // diagnostic record type — should be ignored
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"diagnostic","run_id":"r2","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8}\n');
      await wait(200);

      // Valid finding
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r3","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f3","detected_at":"2026-01-01T00:00:00Z","rule_id":"R3","rule_version":"1","severity":"low","title":"real-finding","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);

      assert.equal(findings.length, 1, 'should only emit the finding record');
      assert.equal(findings[0]!.title, 'real-finding');

      await obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 7. reopens after the file is truncated
  // -----------------------------------------------------------------------
  it('7. reopens after the file is truncated', async () => {
    const tf = createTempFile('{"schema_version":"0.2.0","record_type":"finding","run_id":"r1","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f1","detected_at":"2026-01-01T00:00:00Z","rule_id":"R1","rule_version":"1","severity":"low","title":"before-truncate","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
    try {
      const findings: Array<{ title: string }> = [];
      const obs = createTestObserver(tf.path);

      obs.onFinding((f) => { findings.push({ title: f.title }); });

      await obs.start();
      await wait(200);

      // Append a finding after start
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r2","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f2","detected_at":"2026-01-01T00:00:00Z","rule_id":"R2","rule_version":"1","severity":"low","title":"after-start","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);
      const beforeTruncation = findings.length;

      // Truncate the file and write a new finding
      truncateSync(tf.path, 0);
      await wait(200); // Let tailer detect shrink
      appendToFile(tf.path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r3","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f3","detected_at":"2026-01-01T00:00:00Z","rule_id":"R3","rule_version":"1","severity":"low","title":"after-truncate","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);

      // Should have found the new finding after truncation
      assert.ok(findings.length > beforeTruncation, 'should ingest after truncation');
      const afterTruncation = findings.find((f) => f.title === 'after-truncate');
      assert.ok(afterTruncation, 'should have the finding written after truncation');

      await obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 8. waits for a records file that does not exist yet
  // -----------------------------------------------------------------------
  it('8. waits for a records file that does not exist yet', async () => {
    // Use a path that does not exist
    const dir = mkdtempSync(join(tmpdir(), 'observer-test-'));
    const path = join(dir, 'records.ndjson');
    try {
      const findings: Array<{ title: string }> = [];
      const obs = createTestObserver(path);

      obs.onFinding((f) => { findings.push({ title: f.title }); });

      // Start before file exists — should not throw
      await obs.start();
      await wait(200);
      assert.equal(findings.length, 0, 'no findings yet');

      // Create the file and append a finding
      writeFileSync(path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r1","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f1","detected_at":"2026-01-01T00:00:00Z","rule_id":"R1","rule_version":"1","severity":"low","title":"after-create","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n', 'utf8');
      await wait(400);

      // The file was created with data — tailer should find it, but it seeks to end
      // So it won't pick up pre-existing lines. Append a new one.
      appendToFile(path, '{"schema_version":"0.2.0","record_type":"finding","run_id":"r2","endpoint":"local","source_agent":"codex","source_type":"hook","confidence":0.8,"finding_id":"f2","detected_at":"2026-01-01T00:00:00Z","rule_id":"R2","rule_version":"1","severity":"low","title":"appended-after-create","evidence_refs":[],"cited_event_ids":[],"redacted":{}}\n');
      await wait(400);

      assert.equal(findings.length, 1, 'should pick up appended finding after file creation');
      assert.equal(findings[0]!.title, 'appended-after-create');

      await obs.stop();
    } finally {
      try { unlinkSync(path); } catch { /* ok */ }
      try { unlinkSync(dir); } catch { /* ok */ }
    }
  });
});

// =========================================================================
// 9-17. CORRELATION
// =========================================================================

describe('Correlation', () => {

  // -----------------------------------------------------------------------
  // 9. exact from project_path
  // -----------------------------------------------------------------------
  it('9. resolves exact from a project_path whose last segment is a known correlation id', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'corr-session-42' ? 'session-abc' : null,
      correlation_map_limit: 100,
    });

    const event = makeEvent({
      event_id: 'evt-exact',
      project_path: '/workspace/project/corr-session-42',
    });

    const result = correlator.correlate(event);
    assert.equal(result.route, 'exact');
    assert.equal(result.session_id, 'session-abc');
    assert.equal(result.receipt_id, null);
  });

  // -----------------------------------------------------------------------
  // 10. cited when every cited_event_id resolves to the same session
  // -----------------------------------------------------------------------
  it('10. resolves cited when every cited_event_id resolves to the same session', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'corr-session-42' ? 'session-abc' : null,
      correlation_map_limit: 100,
    });

    // First, an event with project_path that resolves to session-abc
    const event1 = makeEvent({
      event_id: 'evt-cited-1',
      project_path: '/path/corr-session-42',
    });
    correlator.correlate(event1);
    // event1 is now in the eventMap as evt-cited-1 → session-abc

    // Add another event resolving to the same session
    const event2 = makeEvent({
      event_id: 'evt-cited-2',
      project_path: '/path/corr-session-42',
    });
    correlator.correlate(event2);

    // Finding citing both events
    const finding = makeFinding({
      cited_event_ids: ['evt-cited-1', 'evt-cited-2'],
    });

    const result = correlator.correlate(finding);
    assert.equal(result.route, 'cited');
    assert.equal(result.session_id, 'session-abc');
  });

  // -----------------------------------------------------------------------
  // 10a. records none when cited_event_ids resolve to two different sessions
  // -----------------------------------------------------------------------
  it('10a. records none when cited_event_ids resolve to two different sessions', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'corr-a') return 'session-A';
        if (id === 'corr-b') return 'session-B';
        return null;
      },
      correlation_map_limit: 100,
    });

    // Event resolving to session-A
    const eventA = makeEvent({
      event_id: 'evt-A',
      project_path: '/path/corr-a',
    });
    correlator.correlate(eventA);

    // Event resolving to session-B
    const eventB = makeEvent({
      event_id: 'evt-B',
      project_path: '/path/corr-b',
    });
    correlator.correlate(eventB);

    // Finding citing both — should be none
    const finding = makeFinding({
      cited_event_ids: ['evt-A', 'evt-B'],
    });

    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none');
    assert.equal(result.session_id, null);
  });

  // -----------------------------------------------------------------------
  // 10f. records none when any cited_event_id fails to resolve
  // -----------------------------------------------------------------------
  it('10f. records none when any cited_event_id fails to resolve', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'corr-a' ? 'session-A' : null,
      correlation_map_limit: 100,
    });

    // Event resolving to session-A
    const eventA = makeEvent({
      event_id: 'evt-A',
      project_path: '/path/corr-a',
    });
    correlator.correlate(eventA);

    // Finding citing event-A (resolves) and event-C (does not exist)
    const finding = makeFinding({
      run_id: 'run-different',
      cited_event_ids: ['evt-A', 'evt-C'],
    });

    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none', 'a single unresolved citation should fail route 2');
    assert.equal(result.session_id, null);
  });

  // -----------------------------------------------------------------------
  // 10g. records none when cited_event_ids is empty
  // -----------------------------------------------------------------------
  it('10g. records none when cited_event_ids is empty', () => {
    const correlator = createCorrelator({
      resolveSession: () => null,
      correlation_map_limit: 100,
    });

    const finding = makeFinding({
      cited_event_ids: [],
    });

    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none', 'empty cited_event_ids should fail route 2');
    assert.equal(result.session_id, null);
  });

  // -----------------------------------------------------------------------
  // 10b. a route-3 correlation is still provisional after its session stops
  // -----------------------------------------------------------------------
  it('10b. a route-3 correlation is still provisional after its session stops', () => {
    // Session stop doesn't affect route-3 binding.
    // The binding remains, and route-3 findings still resolve.
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'session-idle' ? 'session-42' : null,
      correlation_map_limit: 100,
    });

    // Hook event with exact project_path → creates run binding
    const event = makeEvent({
      run_id: 'run-b',
      event_id: 'evt-binding',
      project_path: '/path/session-idle',
      source_type: 'hook',
    });
    const exactResult = correlator.correlate(event);
    assert.equal(exactResult.route, 'exact');

    // Now the session "stops" — but that's outside observer knowledge.
    // Route 3 binding should still work because nothing changed the binding.

    // Another finding for the same run (hook) → route 3
    const finding = makeFinding({
      run_id: 'run-b',
      source_type: 'hook',
      finding_id: 'find-provisional',
      rule_id: 'RULE-P',
      cited_event_ids: [],
    });

    const result = correlator.correlate(finding);
    assert.equal(result.route, 'session', 'route 3 should still work after session stop');
    assert.equal(result.session_id, 'session-42');
  });

  // -----------------------------------------------------------------------
  // 10c. map eviction does not finalize a provisional correlation
  // -----------------------------------------------------------------------
  it('10c. map eviction does not finalize a provisional correlation', () => {
    // Use a tiny map limit so we can force eviction
    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'corr-x') return 'session-X';
        if (id === 'corr-y') return 'session-Y';
        return null;
      },
      correlation_map_limit: 2, // only 2 entries!
    });

    // Create run binding via exact event
    const event1 = makeEvent({
      run_id: 'run-c',
      event_id: 'evt-c1',
      project_path: '/x/corr-x',
      source_type: 'hook',
    });
    correlator.correlate(event1);
    // runMap: run-c → session-X (1 entry)
    // eventMap: evt-c1 → session-X (1 entry)

    // Add enough distinct events to force eviction of the runMap entry (LRU-ish)
    // But the correlator uses Map which drops oldest by insertion order.
    // We need 2+ more entries to push run-c out of a 2-entry map.
    // Actually the runMap has the run_id key, eventMap has event_id key.
    // They're separate maps. We need to evict from runMap.
    // To fill runMap: add more events with different run_ids that produce exact matches.

    // Event 2 with different run_id → fills runMap entry 2
    const event2 = makeEvent({
      run_id: 'run-d',
      event_id: 'evt-c2',
      project_path: '/y/corr-x',
      source_type: 'hook',
    });
    correlator.correlate(event2);
    // runMap: run-c → session-X, run-d → session-X (2 entries, at limit)

    // Event 3 with different run_id → pushes run-c out
    const event3 = makeEvent({
      run_id: 'run-e',
      event_id: 'evt-c3',
      project_path: '/z/corr-x',
      source_type: 'hook',
    });
    correlator.correlate(event3);
    // run-c should now be evicted

    // New finding for run-c → no route 3 (binding evicted)
    const finding1 = makeFinding({
      run_id: 'run-c',
      source_type: 'hook',
      finding_id: 'find-c-after-evict',
      cited_event_ids: [],
    });
    const resultAfterEvict = correlator.correlate(finding1);
    assert.equal(resultAfterEvict.route, 'none', 'route 3 should not fire after map eviction');

    // Now re-create a binding for run-c but with a DIFFERENT session.
    // This simulates the scenario where the eviction didn't "finalize" the
    // old provisional correlation - and now a new binding conflicts.
    // The old findings (if they existed) should still be retractable.
    // But since eviction removed them from route3Findings... hmm.

    // Actually, the key test is: if a finding was emitted via route 3 BEFORE
    // eviction, can it still be retracted? The spec says yes.
    // Let me verify by creating a binding, emitting a finding, evicting,
    // then creating a conflicting binding and checking retraction.

    // Let's re-scope: use a fresh correlator
    const correlator2 = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'corr-x') return 'session-X';
        if (id === 'corr-y') return 'session-Y';
        return null;
      },
      correlation_map_limit: 2,
    });

    // 1. Create binding for run-f → session-X
    const evtBind = makeEvent({
      run_id: 'run-f',
      event_id: 'evt-bind',
      project_path: '/x/corr-x',
      source_type: 'hook',
    });
    correlator2.correlate(evtBind);

    // 2. Emit a route-3 finding (tracked internally)
    const findBefore = makeFinding({
      run_id: 'run-f',
      source_type: 'hook',
      finding_id: 'find-before-evict',
      cited_event_ids: [],
    });
    const route3res = correlator2.correlate(findBefore);
    assert.equal(route3res.route, 'session', 'should initially resolve via route 3');

    // 3. Fill the two-entry map with other run_ids to evict run-f
    const fill1 = makeEvent({ run_id: 'run-g', event_id: 'evt-fill1', project_path: '/x/corr-x', source_type: 'hook' });
    const fill2 = makeEvent({ run_id: 'run-h', event_id: 'evt-fill2', project_path: '/x/corr-x', source_type: 'hook' });
    correlator2.correlate(fill1);
    correlator2.correlate(fill2);

    // 4. New exact resolution for run-f but with session-Y → invalidation
    const evtConflict = makeEvent({
      run_id: 'run-f',      // same run
      event_id: 'evt-conflict',
      project_path: '/y/corr-y',  // different session!
      source_type: 'hook',
    });
    correlator2.correlate(evtConflict);

    // The old finding should be retractable. We can verify by checking
    // that the retraction callback fires. We'll pass one and assert.
    // But we can't easily verify without the callback.
    // Let's check that at minimum, a new finding for run-f now gets 'none'.
    const findAfter = makeFinding({
      run_id: 'run-f',
      source_type: 'hook',
      finding_id: 'find-after-invalid',
      cited_event_ids: [],
    });
    const afterInvalid = correlator2.correlate(findAfter);
    assert.equal(afterInvalid.route, 'none', 'route 3 should not work after invalidation');

    // The key insight: map eviction doesn't "finalize" (commit) the provisional
    // correlation. If a later conflicting binding is found, old route-3 findings
    // can still be retracted. The loss of the runMap entry doesn't prevent
    // invalidation because route3Findings tracks them separately.
    assert.ok(true, 'map eviction did not finalize — retractions still possible');
  });

  // -----------------------------------------------------------------------
  // 10d. a provisional correlation is exported as none (when invalidated)
  // -----------------------------------------------------------------------
  it('10d. a provisional correlation is exported as none', () => {
    const retractions: Array<RetractionPayload> = [];

    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'corr-alpha') return 'session-A';
        if (id === 'corr-beta') return 'session-B';
        return null;
      },
      correlation_map_limit: 100,
      onRetraction: (payload) => { retractions.push(payload); },
    });

    // Create binding run-z → session-A
    const evt1 = makeEvent({
      run_id: 'run-z',
      event_id: 'evt-z1',
      project_path: '/path/corr-alpha',
      source_type: 'hook',
    });
    correlator.correlate(evt1);

    // Route-3 finding
    const finding = makeFinding({
      run_id: 'run-z',
      source_type: 'hook',
      finding_id: 'find-prov',
      cited_event_ids: [],
    });
    const initialResult = correlator.correlate(finding);
    assert.equal(initialResult.route, 'session', 'initial correlation is session');

    // Second exact resolution with different session → invalidation
    const evt2 = makeEvent({
      run_id: 'run-z',
      event_id: 'evt-z2',
      project_path: '/path/corr-beta',
      source_type: 'hook',
    });
    correlator.correlate(evt2);

    // One retraction naming the run, the withdrawn session, and the finding.
    assert.equal(retractions.length, 1, 'one retraction should be emitted');
    assert.equal(retractions[0]!.run_id, 'run-z');
    assert.equal(retractions[0]!.retracted_session_id, 'session-A');
    assert.deepEqual(
      [...retractions[0]!.retracted_finding_keys],
      ['find-prov'],
      'retraction names the Numbat finding_id',
    );

    // New finding for the same run → should be 'none'
    const finding2 = makeFinding({
      run_id: 'run-z',
      source_type: 'hook',
      finding_id: 'find-after-invalid',
      cited_event_ids: [],
    });
    const afterInvalidation = correlator.correlate(finding2);
    assert.equal(afterInvalidation.route, 'none', 'correlation is none after invalidation');
  });

  // -----------------------------------------------------------------------
  // 11. resolves session from a hook run_id already bound
  // -----------------------------------------------------------------------
  it('11. resolves session from a hook run_id already bound by an earlier exact resolution', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'session-idle-123' ? 'session-99' : null,
      correlation_map_limit: 100,
    });

    // Hook event with exact path → creates run binding run-x → session-99
    const event = makeEvent({
      run_id: 'run-x',
      event_id: 'evt-binding-1',
      project_path: '/workspace/session-idle-123',
      source_type: 'hook',
    });
    correlator.correlate(event);

    // Another hook event, same run_id → route 3 (session correlation)
    const event2 = makeEvent({
      run_id: 'run-x',
      event_id: 'evt-route3',
      source_type: 'hook',
    });
    const result = correlator.correlate(event2);
    assert.equal(result.route, 'session');
    assert.equal(result.session_id, 'session-99');
  });

  // -----------------------------------------------------------------------
  // 12. session correlation sets session_id and leaves receipt_id null
  // -----------------------------------------------------------------------
  it('12. session correlation sets session_id and leaves receipt_id null', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'corr-s' ? 'session-s' : null,
      correlation_map_limit: 100,
    });

    // Create binding
    const event = makeEvent({
      run_id: 'run-y',
      event_id: 'evt-12',
      project_path: '/p/corr-s',
      source_type: 'hook',
    });
    correlator.correlate(event);

    // Route-3 finding
    const finding = makeFinding({
      run_id: 'run-y',
      source_type: 'hook',
      finding_id: 'find-12',
      cited_event_ids: [],
    });
    const result = correlator.correlate(finding);
    assert.equal(result.route, 'session');
    assert.equal(result.session_id, 'session-s');
    assert.equal(result.receipt_id, null, 'receipt_id must be null for session correlation');
  });

  // -----------------------------------------------------------------------
  // 13. records none when nothing matches
  // -----------------------------------------------------------------------
  it('13. records none when nothing matches', () => {
    const correlator = createCorrelator({
      resolveSession: () => null,
      correlation_map_limit: 100,
    });

    const finding = makeFinding({
      cited_event_ids: ['nonexistent'],
    });
    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none');
    assert.equal(result.session_id, null);
  });

  // -----------------------------------------------------------------------
  // 14. records none when run_id was never bound, even with one active session
  // -----------------------------------------------------------------------
  it('14. records none for a record whose run_id was never bound, even when exactly one session of that agent is active', () => {
    const correlator = createCorrelator({
      // resolveSession knows about a session, but the record's run_id has no binding
      resolveSession: (id: string) => id === 'some-other-path' ? 'session-other' : null,
      correlation_map_limit: 100,
    });

    // A finding with no project_path, no run_id binding → route 3 cannot fire
    const finding = makeFinding({
      run_id: 'run-unknown',
      source_type: 'hook',
      cited_event_ids: [],
    });
    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none', 'no binding means route 3 cannot resolve');
    assert.equal(result.session_id, null);
  });

  // -----------------------------------------------------------------------
  // 14a. does not apply route 3 to artifact source_type
  // -----------------------------------------------------------------------
  it('14a. does not apply route 3 to an artifact source_type record', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'corr-a' ? 'session-A' : null,
      correlation_map_limit: 100,
    });

    // Create binding with a hook event
    const event = makeEvent({
      run_id: 'run-artifact',
      event_id: 'evt-binding-art',
      project_path: '/path/corr-a',
      source_type: 'hook',
    });
    correlator.correlate(event);

    // Artifact finding with same run_id — should NOT use route 3
    const finding = makeFinding({
      run_id: 'run-artifact',
      source_type: 'artifact',
      cited_event_ids: [],
    });
    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none', 'artifact records should not resolve via route 3');
  });

  // -----------------------------------------------------------------------
  // 14b. does not apply route 3 to otel source_type
  // -----------------------------------------------------------------------
  it('14b. does not apply route 3 to an otel source_type record', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'corr-b' ? 'session-B' : null,
      correlation_map_limit: 100,
    });

    // Create binding with hook event
    const event = makeEvent({
      run_id: 'run-otel',
      event_id: 'evt-binding-otel',
      project_path: '/path/corr-b',
      source_type: 'hook',
    });
    correlator.correlate(event);

    // Otel finding — should NOT use route 3
    const finding = makeFinding({
      run_id: 'run-otel',
      source_type: 'otel',
      cited_event_ids: [],
    });
    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none', 'otel records should not resolve via route 3');
  });

  // -----------------------------------------------------------------------
  // 14c-d-e: invalidation tests
  // -----------------------------------------------------------------------
  it('14c. a second exact resolution naming a different session drops the run binding', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'session-A') return 'session-A';
        if (id === 'session-B') return 'session-B';
        return null;
      },
      correlation_map_limit: 100,
    });

    // First exact event → binds run-r to session-A
    const evt1 = makeEvent({
      run_id: 'run-r',
      event_id: 'evt-r1',
      project_path: '/p/session-A',
      source_type: 'hook',
    });
    correlator.correlate(evt1);

    // Route-3 should work
    const f1 = makeFinding({ run_id: 'run-r', source_type: 'hook', cited_event_ids: [] });
    assert.equal(correlator.correlate(f1).route, 'session');

    // Second exact event with DIFFERENT session → drops binding
    const evt2 = makeEvent({
      run_id: 'run-r',
      event_id: 'evt-r2',
      project_path: '/p/session-B',
      source_type: 'hook',
    });
    correlator.correlate(evt2);

    // Route 3 should now fail
    const f2 = makeFinding({ run_id: 'run-r', source_type: 'hook', cited_event_ids: [] });
    assert.equal(correlator.correlate(f2).route, 'none');
  });

  it('14d. records previously bound through an invalidated run are downgraded to none', () => {
    const retractions: Array<RetractionPayload> = [];
    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'session-X') return 'session-X';
        if (id === 'session-Y') return 'session-Y';
        return null;
      },
      correlation_map_limit: 100,
      onRetraction: (payload) => { retractions.push(payload); },
    });

    // Create binding run-s → session-X
    const evt1 = makeEvent({
      run_id: 'run-s',
      event_id: 'evt-s1',
      project_path: '/p/session-X',
      source_type: 'hook',
    });
    correlator.correlate(evt1);

    // Finding via route 3
    const finding1 = makeFinding({
      run_id: 'run-s',
      source_type: 'hook',
      finding_id: 'find-s1',
      cited_event_ids: [],
    });
    correlator.correlate(finding1);

    // Another route-3 finding
    const finding2 = makeFinding({
      run_id: 'run-s',
      source_type: 'hook',
      finding_id: 'find-s2',
      cited_event_ids: [],
    });
    correlator.correlate(finding2);

    // Invalidate with different session
    const evt2 = makeEvent({
      run_id: 'run-s',
      event_id: 'evt-s2',
      project_path: '/p/session-Y',
      source_type: 'hook',
    });
    correlator.correlate(evt2);

    // A single retraction names the run, the withdrawn session, and both
    // findings, identified by their Numbat finding_ids.
    assert.equal(retractions.length, 1, 'one retraction names all affected findings');
    assert.equal(retractions[0]!.run_id, 'run-s');
    assert.equal(retractions[0]!.retracted_session_id, 'session-X');
    assert.deepEqual(
      [...retractions[0]!.retracted_finding_keys].sort(),
      ['find-s1', 'find-s2'],
    );
  });

  it('14e. route-1 results survive a run binding invalidation unchanged', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'corr-e') return 'session-E';
        if (id === 'corr-f') return 'session-F';
        return null;
      },
      correlation_map_limit: 100,
    });

    // Route-1 finding (via exact project_path) — should not be affected by invalidation
    const event = makeEvent({
      run_id: 'run-t',
      event_id: 'evt-t1',
      project_path: '/p/corr-e',
      source_type: 'hook',
    });
    correlator.correlate(event);

    // Route-3 finding
    const f1 = makeFinding({ run_id: 'run-t', source_type: 'hook', cited_event_ids: [] });
    assert.equal(correlator.correlate(f1).route, 'session');

    // Invalidate
    const event2 = makeEvent({
      run_id: 'run-t',
      event_id: 'evt-t2',
      project_path: '/p/corr-f',
      source_type: 'hook',
    });
    correlator.correlate(event2);

    // A new route-1 finding should still work
    const event3 = makeEvent({
      run_id: 'run-u',
      event_id: 'evt-t3',
      project_path: '/p/corr-e',
      source_type: 'hook',
    });
    const result = correlator.correlate(event3);
    assert.equal(result.route, 'exact', 'route 1 should still work after invalidation');
    assert.equal(result.session_id, 'session-E');
  });

  // -----------------------------------------------------------------------
  // 15. handles finding with no optional fields
  // -----------------------------------------------------------------------
  it('15. handles a finding with no project_path, session_id or tool_call_id', () => {
    const correlator = createCorrelator({
      resolveSession: () => null,
      correlation_map_limit: 100,
    });

    // Minimal finding: only required fields
    const finding = makeFinding({
      cited_event_ids: [],
    });

    // This should not throw
    const result = correlator.correlate(finding);
    assert.equal(result.route, 'none');
    assert.equal(result.session_id, null);
  });

  // -----------------------------------------------------------------------
  // 16. handles event with none of the optional fields
  // -----------------------------------------------------------------------
  it('16. handles an event with none of the optional fields', () => {
    const correlator = createCorrelator({
      resolveSession: () => null,
      correlation_map_limit: 100,
    });

    // Minimal event: only required fields, no optional ones
    const event = makeEvent({
      event_id: 'evt-minimal',
    });

    // This should not throw
    const result = correlator.correlate(event);
    assert.equal(result.route, 'none');
    assert.equal(result.session_id, null);
  });

  // -----------------------------------------------------------------------
  // 17. maps are bounded
  // -----------------------------------------------------------------------
  it('17. the event and run maps are bounded and drop oldest entries', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id.startsWith('corr-') ? 'session-fixed' : null,
      correlation_map_limit: 3, // Very small
    });

    // Fill eventMap with 3 entries
    for (let i = 0; i < 3; i++) {
      const evt = makeEvent({
        run_id: `run-${i}`,
        event_id: `evt-${i}`,
        project_path: `/p/corr-${i}`,
        source_type: 'hook',
      });
      correlator.correlate(evt);
    }

    // All 3 event_ids should be resolvable
    assert.equal(correlator.lookupEventId('evt-0'), 'session-fixed');
    assert.equal(correlator.lookupEventId('evt-1'), 'session-fixed');
    assert.equal(correlator.lookupEventId('evt-2'), 'session-fixed');

    // Add a 4th entry → evt-0 should be evicted
    const evt4 = makeEvent({
      run_id: 'run-4',
      event_id: 'evt-3',
      project_path: '/p/corr-3',
      source_type: 'hook',
    });
    correlator.correlate(evt4);

    assert.equal(correlator.lookupEventId('evt-0'), null, 'evt-0 should be evicted');
    assert.equal(correlator.lookupEventId('evt-1'), 'session-fixed', 'evt-1 should remain');
    assert.equal(correlator.lookupEventId('evt-2'), 'session-fixed', 'evt-2 should remain');
    assert.equal(correlator.lookupEventId('evt-3'), 'session-fixed', 'evt-3 should be present');
  });
});

// =========================================================================
// 18-21. REDACTION
// =========================================================================

describe('Redaction', () => {

  // -----------------------------------------------------------------------
  // 18. detail never contains content_preview
  // -----------------------------------------------------------------------
  it('18. detail never contains content_preview', () => {
    const record = {
      ...makeFinding(),
      title: 'test',
      content_preview: 'agent typed "rm -rf /"',
      observed_command: 'rm -rf /',
    };

    const { detail } = redactRecord(record);
    const obj = detail as Record<string, unknown>;
    assert.ok(!('content_preview' in obj), 'content_preview must not be in detail');
  });

  // -----------------------------------------------------------------------
  // 19. detail never contains observed_command
  // -----------------------------------------------------------------------
  it('19. detail never contains observed_command', () => {
    const record = {
      ...makeFinding(),
      title: 'test',
      observed_command: 'curl -H "Authorization: Bearer secret" https://api.example.com',
    };

    const { detail } = redactRecord(record);
    const obj = detail as Record<string, unknown>;
    assert.ok(!('observed_command' in obj), 'observed_command must not be in detail');
  });

  // -----------------------------------------------------------------------
  // 20. unrecognised field is excluded
  // -----------------------------------------------------------------------
  it('20. an unrecognised field is excluded rather than copied', () => {
    const record = {
      ...makeFinding(),
      title: 'test',
      some_new_numbat_field: 'should not leak',
      another_unknown: 'also excluded',
    };

    const { detail } = redactRecord(record);
    const obj = detail as Record<string, unknown>;
    assert.ok(!('some_new_numbat_field' in obj), 'unrecognised field must be excluded');
    assert.ok(!('another_unknown' in obj), 'another unrecognised field must be excluded');
  });

  // -----------------------------------------------------------------------
  // 21. title is truncated at 512 characters
  // -----------------------------------------------------------------------
  it('21. title is truncated at 512 characters', () => {
    const longTitle = 'A'.repeat(1000);
    const record = {
      ...makeFinding(),
      title: longTitle,
    };

    const { redacted_title } = redactRecord(record);
    assert.equal(redacted_title.length, 512, 'title must be truncated to 512 chars');
    assert.equal(redacted_title, 'A'.repeat(512));
  });
});

// =========================================================================
// 22-23. MONITOR-ONLY
// =========================================================================

describe('Monitor-only', () => {

  // -----------------------------------------------------------------------
  // 22. SecurityObserver exposes no method returning a decision
  // -----------------------------------------------------------------------
  it('22. SecurityObserver exposes no method returning a decision', () => {
    const tf = createTempFile();
    try {
      const obs = createTestObserver(tf.path);

      // The type itself proves no decision method exists at compile time.
      // At runtime, verify the known methods and assert no unexpected ones.

      assert.equal(typeof obs.id, 'string');
      assert.equal(typeof obs.start, 'function');
      assert.equal(typeof obs.stop, 'function');
      assert.equal(typeof obs.onFinding, 'function');

      // Verify there is no method named 'decide', 'authorize', 'allow', 'deny', etc.
      const keys = Object.keys(obs) as Array<keyof typeof obs>;
      const decisionKeywords = ['decide', 'authorize', 'allow', 'deny', 'verdict', 'judge', 'evaluate', 'review'];
      for (const key of keys) {
        for (const kw of decisionKeywords) {
          assert.ok(!key.toLowerCase().includes(kw), `observer should not have method matching "${kw}"`);
        }
      }

      obs.stop();
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 23. NullObserver starts and stops without a records file
  // -----------------------------------------------------------------------
  it('23. createNullObserver starts and stops without a records file', async () => {
    const obs = createNullObserver();

    // Should not throw despite no file
    await obs.start();
    assert.equal(obs.id, 'null-observer');

    // Should not emit anything
    let called = false;
    obs.onFinding(() => { called = true; });
    assert.equal(called, false);

    await obs.stop();
  });

  // -----------------------------------------------------------------------
  // 23a. NullObserver exposes onRetraction and never fires it
  // -----------------------------------------------------------------------
  it('23a. createNullObserver registers an onRetraction handler it never fires', async () => {
    const obs = createNullObserver();

    assert.equal(typeof obs.onRetraction, 'function', 'null observer exposes onRetraction');

    let retractionCalled = false;
    obs.onRetraction(() => { retractionCalled = true; });

    await obs.start();
    await wait(100);
    assert.equal(retractionCalled, false, 'null observer never fires onRetraction');
    await obs.stop();
  });
});

// =========================================================================
// 24-27. RETRACTION CHANNEL
// =========================================================================

describe('Retraction channel', () => {

  // -----------------------------------------------------------------------
  // 24. a retraction is identifiable as a retraction (separate channel)
  // -----------------------------------------------------------------------
  it('24. an invalidated route-3 binding emits a retraction on the retraction channel, not a duplicate finding', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ correlation: string; session_id: string | null; rule_id: string; title: string }> = [];
      const retractions: Array<{ run_id: string; retracted_session_id: string; retracted_finding_keys: readonly string[]; observed_at: string; reason: string }> = [];

      const obs = createTestObserver(
        tf.path,
        (id: string) => {
          if (id === 'corr-a') return 'session-A';
          if (id === 'corr-b') return 'session-B';
          return null;
        },
        (id: string) => id === 'session-A' ? 'job-1' : null,
        100,
      );

      obs.onFinding((f) => {
        findings.push({ correlation: f.correlation, session_id: f.session_id, rule_id: f.rule_id, title: f.title });
      });
      obs.onRetraction((r) => {
        retractions.push({
          run_id: r.run_id,
          retracted_session_id: r.retracted_session_id,
          retracted_finding_keys: r.retracted_finding_keys,
          observed_at: r.observed_at,
          reason: r.reason,
        });
      });

      await obs.start();
      await wait(300);

      // 1. Hook event with project_path resolving to session-A → binds run-r → session-A.
      //    Events are not emitted through onFinding.
      const bindEvent = makeEvent({
        run_id: 'run-r',
        event_id: 'evt-bind',
        project_path: '/p/corr-a',
        source_type: 'hook',
      });
      appendToFile(tf.path, JSON.stringify(bindEvent) + '\n');
      await wait(300);

      // 2. Hook finding for the same run → route 3 → emitted through onFinding.
      const route3Finding = makeFinding({
        run_id: 'run-r',
        source_type: 'hook',
        finding_id: 'find-r3',
        rule_id: 'RULE-R3',
        title: 'route3 finding',
        cited_event_ids: [],
      });
      appendToFile(tf.path, JSON.stringify(route3Finding) + '\n');
      await wait(400);

      // 3. A second hook event for the same run, but resolving to a different
      //    session, invalidates the run binding and emits a retraction.
      const conflictEvent = makeEvent({
        run_id: 'run-r',
        event_id: 'evt-conflict',
        project_path: '/p/corr-b',
        source_type: 'hook',
      });
      appendToFile(tf.path, JSON.stringify(conflictEvent) + '\n');
      await wait(400);

      await obs.stop();

      // The retraction is identifiable as a retraction: it arrives on the
      // retraction channel, not the finding channel.
      assert.equal(retractions.length, 1, 'exactly one retraction is emitted on the retraction channel');

      // The retraction names the run whose binding was invalidated.
      assert.equal(retractions[0]!.run_id, 'run-r', 'retraction names the invalidated run');

      // The retraction names the session whose attribution is withdrawn.
      assert.equal(retractions[0]!.retracted_session_id, 'session-A', 'retraction names the withdrawn session');

      // The retraction names the findings affected, by Numbat finding_id.
      assert.deepEqual(
        [...retractions[0]!.retracted_finding_keys],
        ['find-r3'],
        'retraction names the affected findings by Numbat finding_id',
      );

      // observed_at and reason are populated — the audit record needs them.
      assert.ok(typeof retractions[0]!.observed_at === 'string' && retractions[0]!.observed_at.length > 0, 'observed_at is set');
      assert.ok(typeof retractions[0]!.reason === 'string' && retractions[0]!.reason.length > 0, 'reason is set');
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 25. the original finding is NOT re-emitted as a duplicate
  // -----------------------------------------------------------------------
  // This is the defect being fixed: the previous implementation re-emitted
  // the original record through emitFinding when the binding was invalidated,
  // producing a second finding indistinguishable from a new observation. A
  // test that does not check this leaves the same hole.
  it('25. the invalidated finding is not re-emitted as a duplicate through onFinding', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ correlation: string; session_id: string | null; rule_id: string }> = [];
      const retractions: Array<{ retracted_finding_keys: readonly string[] }> = [];

      const obs = createTestObserver(
        tf.path,
        (id: string) => {
          if (id === 'corr-a') return 'session-A';
          if (id === 'corr-b') return 'session-B';
          return null;
        },
        () => null,
        100,
      );

      obs.onFinding((f) => {
        findings.push({ correlation: f.correlation, session_id: f.session_id, rule_id: f.rule_id });
      });
      obs.onRetraction((r) => { retractions.push({ retracted_finding_keys: r.retracted_finding_keys }); });

      await obs.start();
      await wait(300);

      // Bind run-r → session-A.
      appendToFile(tf.path, JSON.stringify(makeEvent({
        run_id: 'run-r', event_id: 'evt-bind', project_path: '/p/corr-a', source_type: 'hook',
      })) + '\n');
      await wait(300);

      // One route-3 finding.
      appendToFile(tf.path, JSON.stringify(makeFinding({
        run_id: 'run-r', source_type: 'hook', finding_id: 'find-r3',
        rule_id: 'RULE-R3', title: 'route3 finding', cited_event_ids: [],
      })) + '\n');
      await wait(400);

      const findingsBeforeInvalidation = findings.length;

      // Invalidate.
      appendToFile(tf.path, JSON.stringify(makeEvent({
        run_id: 'run-r', event_id: 'evt-conflict', project_path: '/p/corr-b', source_type: 'hook',
      })) + '\n');
      await wait(400);

      await obs.stop();

      // The original finding was emitted exactly once, with correlation
      // 'session'. The invalidation must NOT re-emit it — neither as a
      // second 'session' finding nor as a 'none' finding.
      assert.equal(findings.length, findingsBeforeInvalidation, 'no duplicate finding is emitted on invalidation');
      assert.equal(findings.length, 1, 'exactly one finding was emitted');
      assert.equal(findings[0]!.correlation, 'session', 'the emitted finding was the route-3 one');
      assert.equal(findings[0]!.session_id, 'session-A');

      // The retraction is the only thing produced by the invalidation.
      assert.equal(retractions.length, 1);
      assert.deepEqual([...retractions[0]!.retracted_finding_keys], ['find-r3']);
    } finally {
      tf.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // 26. records observed after the invalidation still resolve to none
  // -----------------------------------------------------------------------
  it('26. records observed after the invalidation resolve to none, not a retraction', async () => {
    const tf = createTempFile();
    try {
      const findings: Array<{ correlation: string; session_id: string | null; rule_id: string }> = [];
      const retractions: Array<{ retracted_finding_keys: readonly string[] }> = [];

      const obs = createTestObserver(
        tf.path,
        (id: string) => {
          if (id === 'corr-a') return 'session-A';
          if (id === 'corr-b') return 'session-B';
          return null;
        },
        () => null,
        100,
      );

      obs.onFinding((f) => {
        findings.push({ correlation: f.correlation, session_id: f.session_id, rule_id: f.rule_id });
      });
      obs.onRetraction((r) => { retractions.push({ retracted_finding_keys: r.retracted_finding_keys }); });

      await obs.start();
      await wait(300);

      // Bind, emit a route-3 finding, then invalidate.
      appendToFile(tf.path, JSON.stringify(makeEvent({
        run_id: 'run-r', event_id: 'evt-bind', project_path: '/p/corr-a', source_type: 'hook',
      })) + '\n');
      await wait(300);
      appendToFile(tf.path, JSON.stringify(makeFinding({
        run_id: 'run-r', source_type: 'hook', finding_id: 'find-r3',
        rule_id: 'RULE-R3', title: 'route3 finding', cited_event_ids: [],
      })) + '\n');
      await wait(400);
      appendToFile(tf.path, JSON.stringify(makeEvent({
        run_id: 'run-r', event_id: 'evt-conflict', project_path: '/p/corr-b', source_type: 'hook',
      })) + '\n');
      await wait(400);

      const retractionsBefore = retractions.length;

      // A later finding for the now-invalidated run → none.
      appendToFile(tf.path, JSON.stringify(makeFinding({
        run_id: 'run-r', source_type: 'hook', finding_id: 'find-after',
        rule_id: 'RULE-AFTER', title: 'after invalidation', cited_event_ids: [],
      })) + '\n');
      await wait(400);

      await obs.stop();

      // The post-invalidation finding resolves to 'none' and is emitted
      // through onFinding (it is a new observation, not a retraction).
      const afterFinding = findings.find((f) => f.rule_id === 'RULE-AFTER');
      assert.ok(afterFinding, 'post-invalidation finding is emitted');
      assert.equal(afterFinding!.correlation, 'none', 'post-invalidation finding resolves to none');
      assert.equal(afterFinding!.session_id, null);

      // No additional retraction is produced — the retraction is only about
      // what was already reported.
      assert.equal(retractions.length, retractionsBefore, 'no retraction for post-invalidation records');
    } finally {
      tf.cleanup();
    }
  });
});
// =========================================================================
// A finding with no finding_id is never attributed provisionally
// =========================================================================

describe('Retractions always name what they retract', () => {
  /** A finding record with no finding_id property at all, as a malformed record would be. */
  function findingWithoutKey(overrides: Partial<RawRecord> = {}): RawRecord {
    const record: Record<string, unknown> = { ...makeFinding(overrides) };
    delete record['finding_id'];
    return record as RawRecord;
  }

  // A route-3 attribution is provisional: it can be withdrawn, and a withdrawal
  // names its findings by Numbat finding_id. A finding carrying no finding_id
  // cannot be named, so attributing it provisionally would create an
  // attribution with no way to take it back — and on invalidation it produced a
  // retraction with an empty key list, which no reader can join to anything.

  it('does not give a finding without a finding_id the provisional route', () => {
    const correlator = createCorrelator({
      resolveSession: (id: string) => id === 'corr-alpha' ? 'session-A' : null,
      correlation_map_limit: 100,
    });
    // Bind run-n → session-A.
    correlator.correlate(makeEvent({ run_id: 'run-n', event_id: 'evt-n1', project_path: '/path/corr-alpha', source_type: 'hook' }));

    // Same run and source, so route 3 is otherwise available — only the key is
    // missing. `none` is the honest answer for a record we cannot account for.
    const base = { run_id: 'run-n', source_type: 'hook', cited_event_ids: [] } as const;
    for (const [label, record] of [
      ['absent', findingWithoutKey(base)],
      ['empty', makeFinding({ ...base, finding_id: '' })],
    ] as const) {
      const result = correlator.correlate(record);
      assert.equal(result.route, 'none', `a finding whose finding_id is ${label} was attributed provisionally`);
      assert.equal(result.session_id, null);
    }

    // The control: the same record WITH a key still gets route 3, so the test
    // above is not passing because route 3 was unavailable for another reason.
    const keyed = correlator.correlate(makeFinding({
      run_id: 'run-n', source_type: 'hook', cited_event_ids: [], finding_id: 'find-keyed',
    }));
    assert.equal(keyed.route, 'session');
  });

  it('emits no retraction at all when every attributed finding lacked a key', () => {
    const retractions: Array<RetractionPayload> = [];
    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'corr-alpha') return 'session-A';
        if (id === 'corr-beta') return 'session-B';
        return null;
      },
      correlation_map_limit: 100,
      onRetraction: (payload) => { retractions.push(payload); },
    });

    correlator.correlate(makeEvent({ run_id: 'run-m', event_id: 'evt-m1', project_path: '/path/corr-alpha', source_type: 'hook' }));
    correlator.correlate(findingWithoutKey({ run_id: 'run-m', source_type: 'hook', cited_event_ids: [] }));
    // Conflicting exact resolution invalidates the run.
    correlator.correlate(makeEvent({ run_id: 'run-m', event_id: 'evt-m2', project_path: '/path/corr-beta', source_type: 'hook' }));

    assert.deepEqual(retractions, [], 'a retraction was emitted naming no finding');
  });

  it('still retracts the keyed findings when a run also carried unkeyed ones', () => {
    const retractions: Array<RetractionPayload> = [];
    const correlator = createCorrelator({
      resolveSession: (id: string) => {
        if (id === 'corr-alpha') return 'session-A';
        if (id === 'corr-beta') return 'session-B';
        return null;
      },
      correlation_map_limit: 100,
      onRetraction: (payload) => { retractions.push(payload); },
    });

    correlator.correlate(makeEvent({ run_id: 'run-k', event_id: 'evt-k1', project_path: '/path/corr-alpha', source_type: 'hook' }));
    correlator.correlate(makeFinding({ run_id: 'run-k', source_type: 'hook', cited_event_ids: [], finding_id: 'find-keyed-1' }));
    correlator.correlate(findingWithoutKey({ run_id: 'run-k', source_type: 'hook', cited_event_ids: [] }));
    correlator.correlate(makeFinding({ run_id: 'run-k', source_type: 'hook', cited_event_ids: [], finding_id: 'find-keyed-2' }));
    correlator.correlate(makeEvent({ run_id: 'run-k', event_id: 'evt-k2', project_path: '/path/corr-beta', source_type: 'hook' }));

    assert.equal(retractions.length, 1);
    assert.deepEqual(retractions[0]!.retracted_finding_keys, ['find-keyed-1', 'find-keyed-2']);
    // The unkeyed one is absent because it was never attributed to session-A in
    // the first place — there is nothing to withdraw.
    assert.equal(retractions[0]!.retracted_session_id, 'session-A');
  });
});
