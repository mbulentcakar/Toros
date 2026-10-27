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
   * into a failure rather than a second live grant.
   */
  create(agent: AgentName, jobId: string, expiresAt: string): AgentGrant;
  /** Revoke by id; idempotent and a no-op when the id is unknown. */
  revoke(grantId: string): void;
  /** The agent's row with `revoked_at IS NULL`, or null. */
  live(agent: AgentName): AgentGrant | null;
  /** Every grant, oldest first. */
  list(): readonly AgentGrant[];
  close(): void;
}

const SQLITE_BUSY_TIMEOUT_MS = 15_000;

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
  const selectAll = db.prepare('SELECT * FROM agent_grants ORDER BY created_at, grant_id');

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
    create(agent, jobId, expiresAt): AgentGrant {
      const grantId = randomUUID();
      const createdAt = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        // Revoke the live row first so the new grant is the only live one; the
        // partial unique index backs this up against a lost race.
        revokeLive.run(createdAt, agent);
        insert.run(grantId, agent, jobId, createdAt, expiresAt);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
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