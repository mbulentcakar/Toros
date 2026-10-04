// Conversation lifecycle/preferences plus durable API-model usage accounting.

export const sql = `
ALTER TABLE conversations ADD COLUMN agent TEXT;
ALTER TABLE conversations ADD COLUMN model TEXT;

CREATE TABLE IF NOT EXISTS model_usage (
  usage_id          TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(conversation_id),
  job_id             TEXT,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  prompt_tokens      INTEGER NOT NULL,
  completion_tokens  INTEGER NOT NULL,
  total_tokens       INTEGER NOT NULL,
  cost_usd           REAL,
  recorded_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_usage_conversation
  ON model_usage (conversation_id, recorded_at, usage_id);
`;
