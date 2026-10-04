/**
 * Redaction — a copy-allowlist over Numbat record fields.
 *
 * Copy only the named fields into detail. Never copy content_preview,
 * observed_command, or the whole record. An unrecognised field defaults to
 * excluded — this is a copy-allowlist, not a strip-denylist.
 */

import type { JsonValue } from '@toros/contracts';

// ---------------------------------------------------------------------------
// Allowlist — fields we MAY copy into FindingRecord.detail
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'rule_id',
  'rule_version',
  'severity',
  'title',
  'tags',
  'confidence',
  'detected_at',
  'source_agent',
  'source_type',
  'evidence_refs',
  'cited_event_ids',
]);

// ---------------------------------------------------------------------------
// Fields that are NEVER copied, even if they appear in the allowlist
// (these are not in the allowlist, but listing them explicitly for clarity)
// ---------------------------------------------------------------------------

// content_preview  — fragment of what the agent was doing, may contain secrets
// observed_command — command line, may contain secrets

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactedDetail {
  readonly detail: JsonValue;
  readonly redacted_title: string;
}

/**
 * Redact a raw Numbat finding record's fields into a safe detail object.
 *
 * @param record - The raw NDJSON-parsed record object.
 * @returns The redacted detail and the truncated title.
 */
/**
 * `evidence_refs` reduced to its artifact types, discarding every other member.
 *
 * The allowlist is per top-level key, which is not enough for this one: an
 * entry is an object, so copying it wholesale carries whatever Numbat put
 * inside — `observed_command`, `content_preview`, a transcript fragment — past
 * a filter that was only ever inspecting the outer name. The spec asks for
 * "evidence_refs (types only)" precisely because of that.
 *
 * Rebuild each entry rather than deleting known-bad members: a future Numbat
 * field then defaults to excluded, which is the whole point of an allowlist.
 */
function evidenceTypes(value: unknown): readonly { readonly artifact_type: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const type = (entry as Record<string, unknown>)['artifact_type'];
    return typeof type === 'string' ? [{ artifact_type: type }] : [];
  });
}

export function redactRecord(record: Readonly<Record<string, unknown>>): RedactedDetail {
  const detail: Record<string, unknown> = {};

  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) continue; // unrecognised fields excluded by default
    detail[key] = key === 'evidence_refs' ? evidenceTypes(record[key]) : record[key];
  }

  // Truncate title to 512 characters
  let title = '';
  const rawTitle = record.title;
  if (typeof rawTitle === 'string') {
    title = rawTitle.slice(0, 512);
  }

  return {
    detail: detail as JsonValue,
    redacted_title: title,
  };
}