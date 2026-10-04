/**
 * Secret-pattern scanning. SPEC §8.1, I-relay §"Secret scanning is a refusal".
 *
 * The contract here is refusal, not redaction: a single match rejects the whole
 * capsule with `E_SECRET_DETECTED`. A partially-redacted capsule looks safe and
 * is not, so the operator decides what to do rather than the relay guessing.
 *
 * Content rules are applied to raw bytes (latin1, which is byte-for-byte) so a
 * UTF-8 decode error never skips a file. UTF-16 files are additionally scanned
 * after BOM-directed decoding, because the raw bytes have NULs between every
 * ASCII code unit and the byte patterns would otherwise miss.
 */

const FILENAME_RULES: ReadonlyArray<{ readonly id: string; readonly match: (lower: string) => boolean }> = [
  { id: 'filename.env', match: (n) => n === '.env' },
  { id: 'filename.env.*', match: (n) => n.startsWith('.env.') },
  { id: 'filename.*.pem', match: (n) => n.endsWith('.pem') },
  { id: 'filename.*.key', match: (n) => n.endsWith('.key') },
  { id: 'filename.*.pfx', match: (n) => n.endsWith('.pfx') },
  { id: 'filename.id_rsa*', match: (n) => n.startsWith('id_rsa') },
  { id: 'filename.*.kdbx', match: (n) => n.endsWith('.kdbx') },
  { id: 'filename.credentials', match: (n) => n === 'credentials' },
];

/** All content rules, case-insensitive. Applied to the latin1 (raw byte) form. */
const CONTENT_RULES: ReadonlyArray<{ readonly id: string; readonly re: RegExp }> = [
  { id: 'content.private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { id: 'content.aws_access_key', re: /AKIA[0-9A-Z]{16}/i },
  { id: 'content.github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}/i },
  { id: 'content.openai_key', re: /sk-[A-Za-z0-9]{20,}/i },
  { id: 'content.slack_token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/i },
  { id: 'content.google_api_key', re: /AIza[0-9A-Za-z_-]{35}/i },
  { id: 'content.openssh_private_key', re: /-----BEGIN OPENSSH PRIVATE KEY-----/i },
  { id: 'content.generic_secret', re: /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/i },
];

/** Files larger than this skip content scanning but still get filename rules. */
export const CONTENT_SCAN_MAX_BYTES = 8 * 1024 * 1024;

export interface ScanHit {
  readonly rule_id: string;
}

/** Check the basename against the filename rules. Returns the first hit or null. */
export function scanFilename(filename: string): ScanHit | null {
  const lower = filename.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf('/') + 1);
  for (const rule of FILENAME_RULES) {
    if (rule.match(basename)) return { rule_id: rule.id };
  }
  return null;
}

/** Run all content rules against the given string. Returns the first hit or null. */
function scanString(text: string): ScanHit | null {
  for (const rule of CONTENT_RULES) {
    if (rule.re.test(text)) return { rule_id: rule.id };
  }
  return null;
}

/**
 * Run content rules against raw bytes. Files larger than `CONTENT_SCAN_MAX_BYTES`
 * are not scanned; the caller must record `content_scanned: false` for them.
 *
 * For UTF-16 files (BOM-directed), the bytes are additionally decoded and
 * scanned, because the ASCII byte patterns do not survive the interleaved NULs.
 */
export function scanContent(bytes: Buffer): ScanHit | null {
  // latin1 is a byte-for-byte mapping: it never throws and it never replaces
  // sequences, so a malformed UTF-8 file is not silently turned into something
  // the rules skip.
  const latin = bytes.toString('latin1');
  const hit = scanString(latin);
  if (hit) return hit;

  // UTF-16: BOM directs decoding. Without this a `-----BEGIN … PRIVATE KEY-----`
  // stored as UTF-16LE is `2D 00 2D 00 …` as raw bytes and the ASCII regex
  // would not see it.
  if (bytes.length >= 2) {
    const b0 = bytes[0]!;
    const b1 = bytes[1]!;
    if (b0 === 0xff && b1 === 0xfe) {
      const decoded = bytes.subarray(2).toString('utf16le');
      return scanString(decoded);
    }
    if (b0 === 0xfe && b1 === 0xff) {
      // UTF-16BE: swap byte pairs then decode as LE.
      const swapped = Buffer.alloc(bytes.length - 2);
      for (let i = 2; i < bytes.length; i += 2) {
        swapped[i - 2] = bytes[i + 1] ?? 0;
        swapped[i - 1] = bytes[i] ?? 0;
      }
      return scanString(swapped.toString('utf16le'));
    }
  }
  return null;
}
