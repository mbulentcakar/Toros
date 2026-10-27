// Operator-issued agent discovery grants (spec AT). One grant binds one agent to
// one job; the partial unique index enforces "one live grant per agent" at the
// storage layer, so a lost race fails rather than producing two live grants.
export const sql = `
CREATE TABLE agent_grants (
  grant_id   TEXT PRIMARY KEY,
  agent      TEXT NOT NULL CHECK (agent IN ('claude','codex')),
  job_id     TEXT NOT NULL REFERENCES jobs(job_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX agent_grants_one_live ON agent_grants(agent) WHERE revoked_at IS NULL;
`;