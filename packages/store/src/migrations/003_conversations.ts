// Migration 003: durable Hermes conversations and append-only turns (spec Y).

export const sql = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  state           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  content         TEXT NOT NULL,
  job_id          TEXT,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
`;
