/**
 * PowerShell on Windows writes a UTF-8 BOM (`U+FEFF`) in front of every file
 * it produces. Route every `JSON.parse` of script output through this single
 * helper so one missed strip at one call site cannot masquerade as a different
 * bug each time.
 *
 * Copied from @toros/adapters-app per T3 specs: reuse the PowerShell
 * parameter-file + BOM-strip discipline exactly.
 */
const BOM_RE = /^\uFEFF/;

export function parseScriptJson(text: string): unknown {
  return JSON.parse(BOM_RE.test(text) ? text.replace(BOM_RE, '') : text);
}