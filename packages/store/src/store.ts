import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  canonicalize,
  chainHash,
  GENESIS_HASH,
  type AppendEventInput,
  type ArtifactRecord,
  type CapabilityId,
  type ChainHead,
  type ChainVerification,
  type EventRow,
  type FindingRecord,
  type JsonValue,
  type JobRecord,
  type ModelUsageRecord,
  type Receipt,
  type SealedEnvelope,
  type SessionRecord,
  type Store,
  type WorkItemState,
} from '@toros/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

/** Parse a JSON text column that may be null. */
function parseJsonOrNull(text: string | null | undefined): unknown {
  if (text == null) return null;
  return JSON.parse(text);
}

/** Parse a JSON array text column (artifact_refs, finding_refs) that is always a string. */
function parseStringArray(text: string): readonly string[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  return parsed as string[];
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

import { sql as MIGRATION_1_SQL } from './migrations/001_initial.js';
import { sql as MIGRATION_2_SQL } from './migrations/002_receipt_adapter_fields.js';
import { sql as MIGRATION_3_SQL } from './migrations/003_conversations.js';
import { sql as MIGRATION_4_SQL } from './migrations/004_job_conversation.js';
import { sql as MIGRATION_5_SQL } from './migrations/005_receipt_query_indexes.js';
import { sql as MIGRATION_6_SQL } from './migrations/006_conversation_lifecycle_and_usage.js';
import { sql as MIGRATION_7_SQL } from './migrations/007_agent_grants.js';

const MIGRATIONS = [
  [1, MIGRATION_1_SQL],
  [2, MIGRATION_2_SQL],
  [3, MIGRATION_3_SQL],
  [4, MIGRATION_4_SQL],
  [5, MIGRATION_5_SQL],
  [6, MIGRATION_6_SQL],
  [7, MIGRATION_7_SQL],
] as const;

export const COUNT_RETRIES_SQL = `SELECT COUNT(*) AS count
  FROM receipts
  WHERE job_id = ?
    AND capability = ?
    AND arguments_digest = ?
    AND outcome IN ('failed', 'terminated')
    AND started_at > COALESCE((
      SELECT started_at
      FROM receipts
      WHERE job_id = ?
        AND capability = ?
        AND arguments_digest = ?
        AND outcome = 'succeeded'
      ORDER BY started_at DESC
      LIMIT 1
    ), '')`;

export const LATEST_RUNNING_RECEIPT_SQL = `SELECT *
  FROM receipts
  WHERE session_id = ?
    AND outcome = 'running'
    AND job_id = ?
    AND capability = ?
  ORDER BY started_at DESC
  LIMIT 1`;

function currentSchemaVersion(db: DatabaseSync): number {
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
  ).get() as { name: string } | undefined;
  if (tableCheck === undefined) return 0;
  const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

function applyMigrations(db: DatabaseSync): void {
  // Acquire the migration writer lock before reading schema_version. If two
  // processes read version 1 first and only then queue for the lock, the loser
  // would replay ALTER TABLE after version 2 had already committed.
  db.exec('BEGIN IMMEDIATE');
  try {
    let applied = currentSchemaVersion(db);
    for (const [version, sql] of MIGRATIONS) {
      if (applied >= version) continue;
      db.exec(sql);
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
      applied = version;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

const SQLITE_BUSY_TIMEOUT_MS = 15_000;

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}

export async function retrySqliteBusy<T>(operation: () => T, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error: unknown) {
      if (!isSqliteBusy(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      const delay = Math.min(50 * 2 ** Math.min(attempt, 5), 1_000, remaining);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function enableWal(db: DatabaseSync): Promise<void> {
  await retrySqliteBusy(() => db.exec('PRAGMA journal_mode = WAL'), SQLITE_BUSY_TIMEOUT_MS);
}

export interface StoreOptions {
  /** Absolute path to the database file, or ':memory:' for tests. */
  readonly path: string;
  /** This node's id. Every chain is per-node. */
  readonly nodeId: string;
}

export async function openStore(options: StoreOptions): Promise<Store> {
  const db = new DatabaseSync(options.path);

  db.exec('PRAGMA foreign_keys = ON');
  // BEGIN IMMEDIATE takes the write lock up front, which is what stops two
  // writers forking the chain — but on its own it makes the LOSER fail
  // immediately with SQLITE_BUSY ("database is locked") rather than wait. That
  // turns a serialisation guarantee into a lost append.
  //
  // Serialised means queued, not refused, so give a contending writer time to
  // acquire the lock. Fifteen seconds is far longer than any append here, which
  // writes one row and one head update in a single transaction — but the
  // margin matters: under a loaded machine (the full suite runs test files in
  // parallel) a five-second ceiling was reached and the append failed.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  // Set the wait policy before WAL negotiation. Two processes can open the
  // same fresh database concurrently, and `journal_mode = WAL` itself needs a
  // lock; setting this afterwards left that first operation free to fail with
  // SQLITE_BUSY before the protection existed. SQLite may still refuse this
  // particular pragma without honoring the timeout when several connections
  // negotiate WAL together, so retry only that lock error with bounded backoff
  // through the same fifteen-second contention budget.
  await enableWal(db);

  applyMigrations(db);

  const store = createStore(db, options.nodeId);
  return store;
}

function createStore(db: DatabaseSync, nodeId: string): Store {
  let closed = false;

  // -----------------------------------------------------------------------
  // Prepared statements
  // -----------------------------------------------------------------------

  // Jobs
  const insertJob = db.prepare(
    `INSERT INTO jobs (job_id, envelope, envelope_digest, state, created_at, updated_at, actions_used, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const selectJob = db.prepare('SELECT * FROM jobs WHERE job_id = ?');
  const selectJobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, job_id DESC');
  const updateJobState = db.prepare(
    `UPDATE jobs SET state = ?, updated_at = ? WHERE job_id = ?`,
  );
  const updateJobConversation = db.prepare(
    `UPDATE jobs SET conversation_id = ?, updated_at = ? WHERE job_id = ?`,
  );
  const incrementActions = db.prepare(
    `UPDATE jobs SET actions_used = actions_used + 1, updated_at = ? WHERE job_id = ?`,
  );

  // Sessions
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, job_id, adapter_id, workspace_id, pid, started_at, read_cursor)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  );
  const selectSession = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
  const selectSessionsByJob = db.prepare('SELECT * FROM sessions WHERE job_id = ? ORDER BY started_at');
  const updateReadCursor = db.prepare(
    `UPDATE sessions SET read_cursor = ? WHERE session_id = ?`,
  );
  const updateStopSession = db.prepare(
    `UPDATE sessions SET stopped_at = ?, pid = NULL WHERE session_id = ?`,
  );

  // Receipts
  const insertReceipt = db.prepare(
    // Upsert, because a receipt is written twice for every executed action:
    // once as `running` BEFORE the adapter is invoked, so a crash or a hung
    // adapter cannot leave an action that spent budget with no record of it,
    // and once again with the outcome. A plain INSERT made the second write
    // violate the primary key and lose the result.
    //
    // Note this mutates a receipt row, which is fine and is not in tension with
    // §8.1: the append-only guarantee is on the EVENT LOG, whose hash chain
    // records action.started and action.finished as separate immutable rows.
    // The receipts table is current state; the chain is the history.
    `INSERT INTO receipts (receipt_id, job_id, node_id, session_id, actor, capability,
      arguments_normalized, arguments_digest, decision, envelope_digest,
      started_at, ended_at, outcome, artifact_refs, finding_refs, adapter_fields)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(receipt_id) DO UPDATE SET
       ended_at = excluded.ended_at,
       outcome = excluded.outcome,
       artifact_refs = excluded.artifact_refs,
       finding_refs = excluded.finding_refs,
       adapter_fields = excluded.adapter_fields`,
  );
  const selectReceipt = db.prepare('SELECT * FROM receipts WHERE receipt_id = ?');
  const selectReceiptsByJob = db.prepare('SELECT * FROM receipts WHERE job_id = ? ORDER BY started_at');
  const countRetriesSinceSuccess = db.prepare(COUNT_RETRIES_SQL);
  const selectLatestRunningReceipt = db.prepare(LATEST_RUNNING_RECEIPT_SQL);

  // Artifacts
  const insertArtifact = db.prepare(
    `INSERT INTO artifacts (artifact_id, job_id, path, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectArtifactsByJob = db.prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at');

  // Findings
  const insertFinding = db.prepare(
    `INSERT INTO findings (finding_id, receipt_id, job_id, session_id,
      correlation, rule_id, severity, title, observed_at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectFindingsByJob = db.prepare('SELECT * FROM findings WHERE job_id = ? ORDER BY observed_at');

  // Events
  const insertEvent = db.prepare(
    `INSERT INTO events (node_id, job_id, kind, recorded_at, payload, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectEventsByJob = db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq');
  const selectAllEventsByNode = db.prepare('SELECT * FROM events WHERE node_id = ? ORDER BY seq');
  const selectHead = db.prepare('SELECT head_hash, row_count, updated_at FROM chain_head WHERE node_id = ?');
  const upsertHead = db.prepare(
    `INSERT INTO chain_head (node_id, head_hash, row_count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET head_hash = excluded.head_hash, row_count = excluded.row_count, updated_at = excluded.updated_at`,
  );

  // Conversations (spec Y)
  const insertConversation = db.prepare(
    `INSERT INTO conversations (conversation_id, node_id, title, created_at, updated_at, state)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectConversation = db.prepare('SELECT * FROM conversations WHERE conversation_id = ?');
  const selectAllConversations = db.prepare(
    'SELECT * FROM conversations ORDER BY updated_at DESC, conversation_id ASC',
  );
  const renameConversation = db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE conversation_id = ?');
  const updateConversationState = db.prepare('UPDATE conversations SET state = ?, updated_at = ? WHERE conversation_id = ?');
  const updateConversationPreferences = db.prepare('UPDATE conversations SET agent = ?, model = ?, updated_at = ? WHERE conversation_id = ?');
  const updateConversationTimestamp = db.prepare(
    `UPDATE conversations SET updated_at = ? WHERE conversation_id = ?`,
  );
  const selectMaxTurnSeq = db.prepare(
    'SELECT MAX(seq) AS max_seq FROM conversation_turns WHERE conversation_id = ?',
  );
  const insertTurn = db.prepare(
    `INSERT INTO conversation_turns (conversation_id, seq, role, channel, content, job_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectTurns = db.prepare(
    'SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY seq ASC',
  );
  const selectTurnsAfter = db.prepare(
    'SELECT * FROM conversation_turns WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC',
  );
  const insertModelUsage = db.prepare(`INSERT INTO model_usage
    (usage_id, conversation_id, job_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectModelUsage = db.prepare('SELECT * FROM model_usage WHERE conversation_id = ? ORDER BY recorded_at ASC, usage_id ASC');

  // -----------------------------------------------------------------------
  // Row mappers
  // -----------------------------------------------------------------------

  function jobFromRow(row: Record<string, unknown>): JobRecord {
    return {
      job_id: row.job_id as string,
      envelope: JSON.parse(row.envelope as string),
      envelope_digest: row.envelope_digest as string,
      state: row.state as WorkItemState,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      actions_used: row.actions_used as number,
      conversation_id: (row.conversation_id as string | null) ?? null,
    };
  }

  function sessionFromRow(row: Record<string, unknown>): SessionRecord {
    return {
      session_id: row.session_id as string,
      job_id: row.job_id as string,
      adapter_id: row.adapter_id as string,
      workspace_id: row.workspace_id as string,
      pid: (row.pid as number | null) ?? null,
      started_at: row.started_at as string,
      stopped_at: (row.stopped_at as string | null) ?? null,
      read_cursor: row.read_cursor as number,
    };
  }

  function receiptFromRow(row: Record<string, unknown>): Receipt {
    const argsNorm = parseJsonOrNull(row.arguments_normalized as string | null | undefined);
    const decision = JSON.parse(row.decision as string) as Receipt['decision'];

    return {
      receipt_id: row.receipt_id as string,
      job_id: row.job_id as string,
      node_id: row.node_id as string,
      session_id: (row.session_id as string | null) ?? null,
      actor: row.actor as string,
      capability: row.capability as string,
      arguments_normalized: argsNorm as Receipt['arguments_normalized'],
      arguments_digest: (row.arguments_digest as string | null) ?? null,
      decision,
      envelope_digest: row.envelope_digest as string,
      started_at: row.started_at as string,
      ended_at: (row.ended_at as string | null) ?? null,
      outcome: row.outcome as Receipt['outcome'],
      artifact_refs: parseStringArray(row.artifact_refs as string),
      finding_refs: parseStringArray(row.finding_refs as string),
      adapter_fields: JSON.parse(row.adapter_fields as string) as Receipt['adapter_fields'],
    };
  }

  function eventFromRow(row: Record<string, unknown>): EventRow {
    return {
      seq: row.seq as number,
      node_id: row.node_id as string,
      job_id: (row.job_id as string | null) ?? null,
      kind: row.kind as EventRow['kind'],
      recorded_at: row.recorded_at as string,
      payload: JSON.parse(row.payload as string),
      prev_hash: row.prev_hash as string,
      hash: row.hash as string,
    };
  }

  function conversationFromRow(row: Record<string, unknown>) {
    return {
      conversation_id: row.conversation_id as string,
      node_id: row.node_id as string,
      title: row.title as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      state: row.state as 'open' | 'archived',
      agent: (row.agent as string | null) ?? null,
      model: (row.model as string | null) ?? null,
    };
  }

  function modelUsageFromRow(row: Record<string, unknown>): ModelUsageRecord {
    return {
      usage_id: row.usage_id as string,
      conversation_id: row.conversation_id as string,
      job_id: (row.job_id as string | null) ?? null,
      provider: row.provider as string,
      model: row.model as string,
      prompt_tokens: row.prompt_tokens as number,
      completion_tokens: row.completion_tokens as number,
      total_tokens: row.total_tokens as number,
      cost_usd: (row.cost_usd as number | null) ?? null,
      recorded_at: row.recorded_at as string,
    };
  }

  function turnFromRow(row: Record<string, unknown>) {
    return {
      conversation_id: row.conversation_id as string,
      seq: row.seq as number,
      role: row.role as 'operator' | 'hermes' | 'system' | 'tool',
      channel: row.channel as 'human' | 'machine',
      content: row.content as string,
      job_id: (row.job_id as string | null) ?? null,
      recorded_at: row.recorded_at as string,
    };
  }

  // -----------------------------------------------------------------------
  // Store implementation
  // -----------------------------------------------------------------------

  /**
   * One turn-append attempt. BEGIN IMMEDIATE serialises concurrent writers so
   * two appends cannot read the same MAX(seq) and produce a duplicate or gap.
   */
  function appendTurnOnce(input: {
    readonly conversation_id: string;
    readonly role: 'operator' | 'hermes' | 'system' | 'tool';
    readonly channel: 'human' | 'machine';
    readonly content: string;
    readonly job_id: string | null;
  }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const conversation = selectConversation.get(input.conversation_id) as
        | Record<string, unknown>
        | undefined;
      if (!conversation) {
        throw new Error(`conversation not found: ${input.conversation_id}`);
      }

      const maxRow = selectMaxTurnSeq.get(input.conversation_id) as
        | { max_seq: number | null }
        | undefined;
      const nextSeq = (maxRow?.max_seq ?? 0) + 1;
      const recordedAt = nowISO();

      insertTurn.run(
        input.conversation_id,
        nextSeq,
        input.role,
        input.channel,
        input.content,
        input.job_id,
        recordedAt,
      );
      updateConversationTimestamp.run(recordedAt, input.conversation_id);

      db.exec('COMMIT');

      return {
        conversation_id: input.conversation_id,
        seq: nextSeq,
        role: input.role,
        channel: input.channel,
        content: input.content,
        job_id: input.job_id,
        recorded_at: recordedAt,
      };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** One append attempt, in a single immediate transaction. */
  function appendEventOnce(input: AppendEventInput): EventRow {
      // BEGIN IMMEDIATE serialises appends: two writers that both read the
      // same head would produce two rows sharing a prev_hash — a fork, not
      // a chain — and deferred transactions permit exactly that interleaving.
      db.exec('BEGIN IMMEDIATE');
      try {
        const headRow = selectHead.get(input.node_id) as
          | { head_hash: string; row_count: number; updated_at: string }
          | undefined;
        const prevHash: string = headRow?.head_hash ?? GENESIS_HASH;
        const rowCount: number = headRow?.row_count ?? 0;

        const payload = input.payload;
        const hash = chainHash(prevHash, payload);

        const recordedAt = nowISO();
        const insertResult = insertEvent.run(
          input.node_id,
          input.job_id,
          input.kind,
          recordedAt,
          canonicalize(payload),
          prevHash,
          hash,
        );
        const seq = Number(insertResult.lastInsertRowid);

        const newRowCount = rowCount + 1;
        const newUpdatedAt = nowISO();
        upsertHead.run(input.node_id, hash, newRowCount, newUpdatedAt);

        db.exec('COMMIT');

        return {
          seq,
          node_id: input.node_id,
          job_id: input.job_id,
          kind: input.kind,
          recorded_at: recordedAt,
          payload,
          prev_hash: prevHash,
          hash,
        };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

  const storeImpl: Store = {
    // --- Jobs -----------------------------------------------------------

    async createJob(sealed: SealedEnvelope, options?: { conversation_id?: string }): Promise<JobRecord> {
      const envelopeJson = canonicalize(sealed.envelope);
      const now = nowISO();
      const conversationId = options?.conversation_id ?? null;
      insertJob.run(
        sealed.envelope.job_id,
        envelopeJson,
        sealed.envelope_digest,
        'working',
        now,
        now,
        conversationId,
      );
      return {
        job_id: sealed.envelope.job_id,
        envelope: sealed.envelope,
        envelope_digest: sealed.envelope_digest,
        state: 'working',
        created_at: now,
        updated_at: now,
        actions_used: 0,
        conversation_id: conversationId,
      };
    },

    /**
     * Bind a job to its conversation. Set once, on the job's first Hermes run;
     * rebinding is refused because a job's history cannot move.
     */
    async setJobConversation(jobId: string, conversationId: string): Promise<JobRecord> {
      const existing = selectJob.get(jobId) as Record<string, unknown> | undefined;
      if (existing === undefined) throw new Error(`unknown job: ${jobId}`);
      const bound = (existing.conversation_id as string | null) ?? null;
      if (bound !== null && bound !== conversationId) {
        throw new Error(`job ${jobId} is already bound to conversation ${bound}`);
      }
      updateJobConversation.run(conversationId, nowISO(), jobId);
      return jobFromRow(selectJob.get(jobId) as Record<string, unknown>);
    },

    async getJob(jobId: string): Promise<JobRecord | null> {
      const row = selectJob.get(jobId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return jobFromRow(row);
    },

    async listJobs(): Promise<readonly JobRecord[]> {
      return (selectJobs.all() as Record<string, unknown>[]).map(jobFromRow);
    },

    async setJobState(jobId: string, state: WorkItemState): Promise<JobRecord> {
      const now = nowISO();
      // Read the previous state BEFORE the update. Reading it afterwards meant
      // `from` and `to` were always the same value, so the event recorded that
      // a transition happened but not what it was — and reconstructing the
      // state machine from the log, which is the point of §8.1, became
      // impossible.
      const jobBefore = await storeImpl.getJob(jobId);
      updateJobState.run(state, now, jobId);
      await storeImpl.appendEvent({
        node_id: nodeId,
        job_id: jobId,
        kind: 'job.state_changed',
        payload: { from: jobBefore?.state ?? null, to: state },
      });
      // Re-fetch to return the updated record
      const job = await storeImpl.getJob(jobId);
      // The job must exist because the UPDATE succeeded
      return job!;
    },

    async incrementActionsUsed(jobId: string): Promise<JobRecord> {
      const now = nowISO();
      incrementActions.run(now, jobId);
      const job = await storeImpl.getJob(jobId);
      return job!;
    },

    // --- Sessions -------------------------------------------------------

    async createSession(
      input: Omit<SessionRecord, 'stopped_at' | 'read_cursor'>,
    ): Promise<SessionRecord> {
      insertSession.run(
        input.session_id,
        input.job_id,
        input.adapter_id,
        input.workspace_id,
        input.pid,
        input.started_at,
      );
      return {
        session_id: input.session_id,
        job_id: input.job_id,
        adapter_id: input.adapter_id,
        workspace_id: input.workspace_id,
        pid: input.pid,
        started_at: input.started_at,
        stopped_at: null,
        read_cursor: 0,
      };
    },

    async getSession(sessionId: string): Promise<SessionRecord | null> {
      const row = selectSession.get(sessionId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return sessionFromRow(row);
    },

    async listSessions(jobId: string): Promise<readonly SessionRecord[]> {
      const rows = selectSessionsByJob.all(jobId) as Record<string, unknown>[];
      return rows.map(sessionFromRow);
    },

    async setReadCursor(sessionId: string, cursor: number): Promise<SessionRecord> {
      updateReadCursor.run(cursor, sessionId);
      const session = await storeImpl.getSession(sessionId);
      // Session must exist because the UPDATE matched a row
      return session!;
    },

    async stopSession(sessionId: string, stoppedAt: string): Promise<SessionRecord> {
      updateStopSession.run(stoppedAt, sessionId);
      const session = await storeImpl.getSession(sessionId);
      return session!;
    },

    // --- Receipts -------------------------------------------------------

    async putReceipt(receipt: Receipt): Promise<void> {
      insertReceipt.run(
        receipt.receipt_id,
        receipt.job_id,
        receipt.node_id,
        receipt.session_id,
        receipt.actor,
        receipt.capability,
        receipt.arguments_normalized != null ? canonicalize(receipt.arguments_normalized) : null,
        receipt.arguments_digest,
        canonicalize(receipt.decision as JsonValue),
        receipt.envelope_digest,
        receipt.started_at,
        receipt.ended_at,
        receipt.outcome,
        JSON.stringify(receipt.artifact_refs),
        JSON.stringify(receipt.finding_refs),
        canonicalize(receipt.adapter_fields),
      );
    },

    async getReceipt(receiptId: string): Promise<Receipt | null> {
      const row = selectReceipt.get(receiptId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return receiptFromRow(row);
    },

    async listReceipts(jobId: string): Promise<readonly Receipt[]> {
      const rows = selectReceiptsByJob.all(jobId) as Record<string, unknown>[];
      return rows.map(receiptFromRow);
    },

    async countRetries(jobId: string, capability: CapabilityId, argumentsDigest: string): Promise<number> {
      const row = countRetriesSinceSuccess.get(
        jobId,
        capability,
        argumentsDigest,
        jobId,
        capability,
        argumentsDigest,
      ) as { count: number };
      return row.count;
    },

    async latestRunningReceipt(jobId: string, sessionId: string, capability: CapabilityId): Promise<Receipt | null> {
      const row = selectLatestRunningReceipt.get(sessionId, jobId, capability) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? null : receiptFromRow(row);
    },

    // --- Artifacts ------------------------------------------------------

    async putArtifact(artifact: ArtifactRecord): Promise<void> {
      insertArtifact.run(
        artifact.artifact_id,
        artifact.job_id,
        artifact.path,
        artifact.sha256,
        artifact.bytes,
        artifact.created_at,
      );
    },

    async listArtifacts(jobId: string): Promise<readonly ArtifactRecord[]> {
      const rows = selectArtifactsByJob.all(jobId) as Record<string, unknown>[];
      return rows.map((row) => ({
        artifact_id: row.artifact_id as string,
        job_id: row.job_id as string,
        path: row.path as string,
        sha256: row.sha256 as string,
        bytes: row.bytes as number,
        created_at: row.created_at as string,
      }));
    },

    // --- Findings -------------------------------------------------------

    async putFinding(finding: FindingRecord): Promise<void> {
      insertFinding.run(
        finding.finding_id,
        finding.receipt_id,
        finding.job_id,
        finding.session_id,
        finding.correlation,
        finding.rule_id,
        finding.severity,
        finding.title,
        finding.observed_at,
        canonicalize(finding.detail),
      );
    },

    async listFindings(jobId: string): Promise<readonly FindingRecord[]> {
      const rows = selectFindingsByJob.all(jobId) as Record<string, unknown>[];
      return rows.map((row) => ({
        finding_id: row.finding_id as string,
        receipt_id: (row.receipt_id as string | null) ?? null,
        job_id: (row.job_id as string | null) ?? null,
        session_id: (row.session_id as string | null) ?? null,
        correlation: row.correlation as FindingRecord['correlation'],
        rule_id: row.rule_id as string,
        severity: row.severity as FindingRecord['severity'],
        title: row.title as string,
        observed_at: row.observed_at as string,
        detail: JSON.parse(row.detail as string),
      }));
    },

    // --- Events / Chain -------------------------------------------------

    async appendEvent(input: AppendEventInput): Promise<EventRow> {
      // BEGIN IMMEDIATE normally honors busy_timeout synchronously. The shared
      // helper's deadline starts before that call, so a native fifteen-second
      // wait consumes the budget rather than gaining another full retry window.
      //
      // If SQLite returns SQLITE_BUSY early, as WAL negotiation can, bounded
      // backoff uses only the time left in that same budget. Serialised means
      // queued, but a genuinely wedged lock must still surface instead of
      // hanging forever.
      return retrySqliteBusy(() => appendEventOnce(input), SQLITE_BUSY_TIMEOUT_MS);
    },



    async listEvents(jobId: string): Promise<readonly EventRow[]> {
      const rows = selectEventsByJob.all(jobId) as Record<string, unknown>[];
      return rows.map(eventFromRow);
    },

    async getChainHead(forNodeId: string): Promise<ChainHead> {
      const row = selectHead.get(forNodeId) as
        | { head_hash: string; row_count: number; updated_at: string }
        | undefined;
      if (!row) {
        return {
          node_id: forNodeId,
          head_hash: GENESIS_HASH,
          row_count: 0,
          updated_at: nowISO(),
        };
      }
      return {
        node_id: forNodeId,
        head_hash: row.head_hash,
        row_count: row.row_count,
        updated_at: row.updated_at,
      };
    },

    async verifyChain(forNodeId: string): Promise<ChainVerification> {
      const rows = selectAllEventsByNode.all(forNodeId) as Record<string, unknown>[];
      const events = rows.map(eventFromRow);

      let brokenAtSeq: number | null = null;
      let reason: string | null = null;
      let lastHash: string = GENESIS_HASH;
      let rowsChecked = 0;

      for (const ev of events) {
        // Check prev_hash matches previous row's hash
        if (ev.prev_hash !== lastHash) {
          brokenAtSeq = ev.seq;
          reason = `prev_hash mismatch at seq ${ev.seq}: expected ${lastHash}, got ${ev.prev_hash}`;
          break;
        }

        // Recompute hash from stored prev_hash and stored payload
        const recomputedHash = chainHash(ev.prev_hash, ev.payload);
        if (recomputedHash !== ev.hash) {
          brokenAtSeq = ev.seq;
          reason = `hash mismatch at seq ${ev.seq}: expected ${recomputedHash}, got ${ev.hash}`;
          break;
        }

        lastHash = ev.hash;
        rowsChecked++;
      }

      // Compare to anchor
      const head = await storeImpl.getChainHead(forNodeId);
      const anchorMatches = lastHash === head.head_hash && rowsChecked === head.row_count;

      const ok = brokenAtSeq === null && anchorMatches;

      return {
        ok,
        rows_checked: rowsChecked,
        broken_at_seq: brokenAtSeq,
        anchor_matches: anchorMatches,
        reason,
      };
    },

    // --- Conversations --------------------------------------------------

    async createConversation(input) {
      const now = nowISO();
      insertConversation.run(
        input.conversation_id,
        input.node_id,
        input.title,
        now,
        now,
        input.state,
      );
      return {
        conversation_id: input.conversation_id,
        node_id: input.node_id,
        title: input.title,
        created_at: now,
        updated_at: now,
        state: input.state,
        agent: input.agent ?? null,
        model: input.model ?? null,
      };
    },

    async getConversation(conversationId) {
      const row = selectConversation.get(conversationId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return conversationFromRow(row);
    },

    async listConversations() {
      const rows = selectAllConversations.all() as Record<string, unknown>[];
      return rows.map(conversationFromRow);
    },

    async renameConversation(conversationId, title) {
      renameConversation.run(title, nowISO(), conversationId);
      const conversation = await storeImpl.getConversation(conversationId);
      if (conversation === null) throw new Error(`conversation not found: ${conversationId}`);
      return conversation;
    },

    async setConversationState(conversationId, state) {
      updateConversationState.run(state, nowISO(), conversationId);
      const conversation = await storeImpl.getConversation(conversationId);
      if (conversation === null) throw new Error(`conversation not found: ${conversationId}`);
      return conversation;
    },

    async setConversationPreferences(conversationId, agent, model) {
      updateConversationPreferences.run(agent, model, nowISO(), conversationId);
      const conversation = await storeImpl.getConversation(conversationId);
      if (conversation === null) throw new Error(`conversation not found: ${conversationId}`);
      return conversation;
    },

    async appendTurn(input) {
      // Same contention discipline as appendEvent: serialised under
      // BEGIN IMMEDIATE, with busy_timeout + bounded retry so concurrent
      // writers queue rather than fork seq assignment.
      return retrySqliteBusy(() => appendTurnOnce(input), SQLITE_BUSY_TIMEOUT_MS);
    },

    async listTurns(conversationId, opts) {
      const after = opts?.after;
      if (after !== undefined) {
        const rows = selectTurnsAfter.all(conversationId, after) as Record<string, unknown>[];
        return rows.map(turnFromRow);
      }
      const rows = selectTurns.all(conversationId) as Record<string, unknown>[];
      return rows.map(turnFromRow);
    },

    async recordModelUsage(input) {
      const usage: ModelUsageRecord = { ...input, usage_id: randomUUID(), recorded_at: nowISO() };
      insertModelUsage.run(usage.usage_id, usage.conversation_id, usage.job_id, usage.provider, usage.model,
        usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, usage.cost_usd, usage.recorded_at);
      return usage;
    },

    async listModelUsage(conversationId) {
      return (selectModelUsage.all(conversationId) as Record<string, unknown>[]).map(modelUsageFromRow);
    },

    // --- Lifecycle ------------------------------------------------------

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      db.close();
    },
  };

  return storeImpl;
}
