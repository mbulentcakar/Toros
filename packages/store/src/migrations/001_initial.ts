// Migration 001: initial schema
// Each table derives its columns from the record types in @toros/contracts.

export const sql = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id        TEXT PRIMARY KEY,
  envelope      TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  state         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  actions_used  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(job_id),
  adapter_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  pid          INTEGER,
  started_at   TEXT NOT NULL,
  stopped_at   TEXT,
  read_cursor  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id           TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL,
  node_id              TEXT NOT NULL,
  session_id           TEXT,
  actor                TEXT NOT NULL,
  capability           TEXT NOT NULL,
  arguments_normalized TEXT,
  arguments_digest     TEXT,
  decision             TEXT NOT NULL,
  envelope_digest      TEXT NOT NULL,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  outcome              TEXT NOT NULL,
  artifact_refs        TEXT NOT NULL,
  finding_refs         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  finding_id   TEXT PRIMARY KEY,
  receipt_id   TEXT,
  job_id       TEXT,
  session_id   TEXT,
  correlation  TEXT NOT NULL,
  rule_id      TEXT NOT NULL,
  severity     TEXT NOT NULL,
  title        TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  detail       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id   TEXT NOT NULL,
  job_id    TEXT,
  kind      TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_head (
  node_id    TEXT PRIMARY KEY,
  head_hash  TEXT NOT NULL,
  row_count  INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;