// Migration 005: indexes for the two receipt queries on the action hot path.

export const sql = `
CREATE INDEX receipts_retry
  ON receipts (job_id, capability, arguments_digest, started_at);
CREATE INDEX receipts_session_outcome
  ON receipts (session_id, outcome);
`;
