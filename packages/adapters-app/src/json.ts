/**
 * PowerShell on Windows writes a UTF-8 BOM (`U+FEFF`) in front of every file
 * it produces — `Out-File`, `Set-Content`, and `>` all emit one by default.
 * `JSON.parse` throws `SyntaxError: Unexpected token '﻿'` on a leading BOM,
 * which is misleading: the Excel automation has already succeeded and the
 * file contains exactly the right content; only the read fails.
 *
 * Route every `JSON.parse` of script output through this single helper rather
 * than repeating the strip inline. Missing one site produces an intermittent
 * failure that looks like a different bug each time. See
 * `docs/specs/F-adapters-app.md` §"PowerShell writes a UTF-8 BOM".
 *
 * The write side is unaffected: `fs.writeFile` from Node emits no BOM, and
 * `ConvertFrom-Json` on the PowerShell side reads it fine.
 */
const BOM_RE = /^\uFEFF/;

export function parseScriptJson(text: string): unknown {
  return JSON.parse(BOM_RE.test(text) ? text.replace(BOM_RE, '') : text);
}
