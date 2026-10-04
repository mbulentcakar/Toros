// Migration 004: bind a job to the conversation it belongs to (spec Y).
//
// Nullable because every job created before this migration has no conversation,
// and because a job may exist before its first Hermes run mints one.

export const sql = `
ALTER TABLE jobs ADD COLUMN conversation_id TEXT;
`;
