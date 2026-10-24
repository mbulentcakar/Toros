# R5 — FR-01: read OriginalFilename language-neutrally (implementation brief)

**Source:** the final native re-review, PR mbulentcakar/Toros#18 (Grok `grok-4.7`, `main` at `d429ad3`).
Verdict *do not clear*, because of one Medium finding, **FR-01**. The other eighteen findings are
closed.

**Operator decision (2026-10-22):** fix FR-01 as one slice, R5. Read OriginalFilename
**language-neutrally**, so the installed binary and its copies report the same value. The lane is
the same as before: DeepSeek implements, the orchestrator runs the native tests, and Grok reviews
the fix.

## The defect

`ReadIdentity` in `DESKTOP_UIA_PS1` (`packages/adapters-desktop/src/probe.ts`, around lines
226–236) reads `(Get-Item -LiteralPath $imagePath).VersionInfo.OriginalFilename`.
`FileVersionInfo` follows an adjacent `en-US\<image>.mui` when one exists, so the value depends on
where the file sits:

| Binary | `FileVersionInfo` (today) | Language-neutral (target) |
|---|---|---|
| `C:\Windows\System32\notepad.exe` | `NOTEPAD.EXE.MUI` | `NOTEPAD.EXE` |
| a copy in a temp folder | `NOTEPAD.EXE` | `NOTEPAD.EXE` |
| `...\WindowsPowerShell\v1.0\powershell.exe` | `PowerShell.EXE.MUI` | `PowerShell.EXE` |
| a copy in a temp folder | `PowerShell.EXE` | `PowerShell.EXE` |

The orchestrator measured these natively on 2026-10-22 (Windows 11, PowerShell 5.1). It also
checked that the defect **fails closed**: a foreign MUI planted beside a PowerShell copy (Notepad's
`notepad.exe.mui` as `en-US\x.exe.mui`) does **not** change the copy's OriginalFilename. Windows
ignores a MUI that does not belong to the binary. So the defect is that a signer rule can wrongly
**deny** a legitimate binary, never that it **admits** a different one. A click or type built on
this surface would inherit it (`AS-inherited`).

## The fix

1. **Read the language-neutral version resource.** In the `TorosNative` `Add-Type` block, add
   this helper. It is C# 5, and the orchestrator compiled and ran it natively under PowerShell 5.1:

   ```csharp
   [DllImport("version.dll", CharSet=CharSet.Unicode, SetLastError=true)]
   public static extern uint GetFileVersionInfoSizeEx(uint dwFlags, string lpwstrFilename, out uint lpdwHandle);
   [DllImport("version.dll", CharSet=CharSet.Unicode, SetLastError=true)]
   public static extern bool GetFileVersionInfoEx(uint dwFlags, string lpwstrFilename, uint dwHandle, uint dwLen, byte[] lpData);
   [DllImport("version.dll", CharSet=CharSet.Unicode, SetLastError=true)]
   public static extern bool VerQueryValue(byte[] pBlock, string lpSubBlock, out IntPtr lplpBuffer, out uint puLen);
   public const uint FILE_VER_GET_NEUTRAL = 0x02;
   public static string NeutralOriginalFilename(string path) {
     uint h;
     uint size = GetFileVersionInfoSizeEx(FILE_VER_GET_NEUTRAL, path, out h);
     if (size == 0) return null;
     byte[] data = new byte[size];
     if (!GetFileVersionInfoEx(FILE_VER_GET_NEUTRAL, path, 0, size, data)) return null;
     IntPtr p; uint len;
     if (!VerQueryValue(data, "\\VarFileInfo\\Translation", out p, out len) || len < 4) return null;
     int langCp = Marshal.ReadInt32(p);
     string key = string.Format("\\StringFileInfo\\{0:X4}{1:X4}\\OriginalFilename", langCp & 0xFFFF, (langCp >> 16) & 0xFFFF);
     IntPtr s; uint slen;
     if (!VerQueryValue(data, key, out s, out slen) || slen == 0) return null;
     return Marshal.PtrToStringUni(s);
   }
   ```

   **Careful:** the script lives in a TypeScript **template literal**, so every `\\` in the C#
   above must be written `\\\\` in the `.ts` source to reach PowerShell as `\\`. The C# string
   `"\\VarFileInfo\\Translation"` must arrive in the emitted script exactly as written above. Pin
   the emitted lines in `probe.test.ts`, the same way the earlier backslash lines are pinned.
   `Marshal`, `DllImport` and `CharSet` need `using System.Runtime.InteropServices;`, which the
   block already has. Check before adding a duplicate.
2. **Use it in `ReadIdentity`.** Replace the `VersionInfo.OriginalFilename` read with
   `[TorosNative]::NeutralOriginalFilename($imagePath)`. Keep the existing normalisation exactly:
   trim the value; it becomes `$null` when it is empty, longer than 260 characters, or contains
   `\` or `/`.
3. **Fail closed.** If the neutral read fails (returns null or throws), `original_filename` is
   `null`. The window stays publishable for hash and path rules, and signer rules never match it.
   A throw must not drop the identity: catch it, and treat it as `null`.
4. **No contract, policy or matching change.** A9's comparison (case-insensitive) and every
   validator stay as they are. Only the value read changes.
5. **Docs.** In `docs/INSTALL.md` and `docs/AR-T4-install-rollback.md`, say that `original_filename`
   is the **language-neutral** OriginalFilename (for example `NOTEPAD.EXE`, never
   `NOTEPAD.EXE.MUI`). Tell operators how to read it: copy the executable to a folder with no
   `en-US` subfolder, then read `FileVersionInfo.OriginalFilename` on the copy. Note in
   `docs/specs/00-CONTRACTS.md` §10 (A9) that the value is the language-neutral one; this is a
   clarification, not a type change.

## Tests

- **Non-native:**
  - `probe.test.ts` pins the new C# lines and the `ReadIdentity` line, backslashes included;
  - a test that the old `VersionInfo.OriginalFilename` read is gone from the emitted script.
- **Native, gated `TOROS_REAL_TESTS=1`:** the canary fixture's identity reports the neutral value.
  The fixture runs a renamed copy of Windows PowerShell, so expect `PowerShell.EXE`. A second
  assertion reads the neutral value of the **inbox** `powershell.exe` through the same helper
  (by running the emitted script's `TorosNative` type in a test-owned PowerShell, or by an
  equivalent gated check), and asserts it equals the copy's. The orchestrator runs these; the
  implementer does not.

## Acceptance

- Delete every `packages/*/dist` and `*.tsbuildinfo`, then `npm run typecheck`: 0 errors.
- `npm test`: 0 failed. Every skip has its reason.
- The orchestrator's native gated run is green.
- Grok reviews it (read-only) and approves.
- CI is green.
