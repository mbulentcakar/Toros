// Migration 002: persist adapter-declared audit values on receipts.

export const sql = `
ALTER TABLE receipts ADD COLUMN adapter_fields TEXT NOT NULL DEFAULT '{}';
`;
