/**
 * Agent grants (spec AT): operator-issued bindings between one agent and one
 * job, stored in the node database by migration 007.
 *
 * Live rows are read back per request, so a revoke or replacement takes effect
 * for the next call. The frozen `Store` interface cannot grow (and the brief
 * forbids changing it), so this module owns a second `node:sqlite` connection
 * to the same database file — opened after `openStore` has applied the
 * migrations, with the same contention budget — and is closed with Core.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type AgentName = 'claude' | 'codex';

export const AGENT_NAMES = ['claude', 'codex'] as const;

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && (AGENT_NAMES as readonly string[]).includes(value);
}

export interface AgentGrant {
  readonly grant_id: string;
  readonly agent: AgentName;
  readonly job_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  /** Set by `create` (on replacement) or `revoke`; null while live. */
  readonly revoked_at: string | null;
}

export interface AgentGrants {
  /**
   * Replace the agent's live grant, if any, with a new one, in a single
   * `BEGIN IMMEDIATE` transaction. The partial unique index turns a lost race
   * into a failure rather than a second live grant. Retried on SQLITE_BUSY the
   * way the store retries its own `BEGIN IMMEDIATE` writers.
   */
  create(agent: AgentName, jobId: string, expiresAt: string): Promise<AgentGrant>;
  /** Revoke by id; idempotent and a no-op when the id is unknown. */
  revoke(grantId: string): void;
  /** The agent's row with `revoked_at IS NULL`, or null. */
  live(agent: AgentName): AgentGrant | null;
  /** Every grant, oldest first. */
  list(): readonly AgentGrant[];
  close(): void;
}

const SQLITE_BUSY_TIMEOUT_MS = 15_000;

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}

/**
 * Retry a grant write on SQLITE_BUSY, exactly like the store retries its own
 * `BEGIN IMMEDIATE` writers (`store.ts` `retrySqliteBusy`): `busy_timeout` makes
 * `BEGIN IMMEDIATE` wait synchronously, but SQLite can still return SQLITE_BUSY
 * early (e.g. WAL negotiation), so a contending grant writer must queue rather
 * than fail a second `create` after the first took the write lock. Exported for
 * tests, the way the store exports `retrySqliteBusy`.
 */
export async function retryGrantWrite<T>(operation: () => T): Promise<T> {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
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

export function openAgentGrants(dbPath: string): AgentGrants {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  // Same contention budget as the store: BEGIN IMMEDIATE serialises grant
  // writers, and a contending writer must queue rather than fail.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

  const revokeLive = db.prepare(
    'UPDATE agent_grants SET revoked_at = ? WHERE agent = ? AND revoked_at IS NULL',
  );
  const insert = db.prepare(
    `INSERT INTO agent_grants (grant_id, agent, job_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  );
  const revokeById = db.prepare(
    'UPDATE agent_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL',
  );
  const selectLive = db.prepare(
    'SELECT * FROM agent_grants WHERE agent = ? AND revoked_at IS NULL',
  );
  const selectAll = db.prepare('SELECT * FROM agent_grants ORDER BY created_at, rowid');

  let closed = false;

  function toGrant(row: Record<string, unknown>): AgentGrant {
    return {
      grant_id: row.grant_id as string,
      agent: row.agent as AgentName,
      job_id: row.job_id as string,
      created_at: row.created_at as string,
      expires_at: row.expires_at as string,
      revoked_at: (row.revoked_at as string | null) ?? null,
    };
  }

  return {
    async create(agent, jobId, expiresAt): Promise<AgentGrant> {
      const grantId = randomUUID();
      const createdAt = new Date().toISOString();
      await retryGrantWrite(() => {
        // BEGIN IMMEDIATE takes the write lock up front, serialising grant
        // writers. `busy_timeout` makes it wait, and `retryGrantWrite` re-runs
        // the whole transaction when SQLite still refuses with SQLITE_BUSY.
        let began = false;
        try {
          db.exec('BEGIN IMMEDIATE');
          began = true;
          // Revoke the live row first so the new grant is the only live one; the
          // partial unique index backs this up against a lost race.
          revokeLive.run(createdAt, agent);
          insert.run(grantId, agent, jobId, createdAt, expiresAt);
          db.exec('COMMIT');
        } catch (error) {
          if (began) {
            // Roll back a half-open transaction, but never let a ROLLBACK
            // failure mask the original error: `error` is what the caller must
            // see. No transaction was opened when `BEGIN IMMEDIATE` itself
            // threw, and a ROLLBACK there would only manufacture a second,
            // hiding error.
            try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
          }
          throw error;
        }
      });
      return {
        grant_id: grantId,
        agent,
        job_id: jobId,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
      };
    },

    revoke(grantId): void {
      revokeById.run(new Date().toISOString(), grantId);
    },

    live(agent): AgentGrant | null {
      const row = selectLive.get(agent) as Record<string, unknown> | undefined;
      return row === undefined ? null : toGrant(row);
    },

    list(): readonly AgentGrant[] {
      return (selectAll.all() as Record<string, unknown>[]).map(toGrant);
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}