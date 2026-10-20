import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppRule } from '@toros/contracts';

/**
 * Desktop configuration parsing (amendment A8, F3b).
 *
 * Kept in its own module so it can be unit-tested without importing `main.ts`,
 * which now starts the service unconditionally at module load. `main.ts` and
 * the tests both import it from here.
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)/;

/**
 * Validate the node's `desktop.authorized_apps` config (amendment A8, F3b).
 *
 * It becomes the same `AppRule[]` shapes the envelope's `allowed_apps` carries —
 * hash, signer+product, or path — instead of the bare basename strings the
 * pilot adapter accepted. A bare string entry (the old basename form) makes Node
 * Core refuse to start with a message naming the new format, because a basename
 * allowlist is spoofable (AR-10) and silently accepting it would suggest the
 * stronger identity bound is in force when it is not.
 */
export function validateDesktopAuthorizedApps(value: unknown, configPath: string): AppRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${configPath}: adapters.desktop.authorized_apps must be an array of application rules`);
  }
  const rules: AppRule[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    // The old basename form: a bare string naming a process file name. Name the
    // new format explicitly rather than a generic "invalid" message.
    if (typeof item === 'string') {
      throw new Error(
        `${configPath}: adapters.desktop.authorized_apps[${i}] "${item}" is a bare string; ` +
        `the new format is an object with exactly one of { image_sha256 }, { signer, product_name }, or { image_path }`,
      );
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] must be an application rule object`);
    }
    const rule = item as Record<string, unknown>;
    for (const key of Object.keys(rule)) {
      if (key !== 'image_sha256' && key !== 'signer' && key !== 'product_name' && key !== 'image_path') {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] unknown property: ${key}`);
      }
    }
    const hasSha = 'image_sha256' in rule;
    const hasSigner = 'signer' in rule;
    const hasProduct = 'product_name' in rule;
    const hasPath = 'image_path' in rule;

    if (hasSha) {
      if (hasSigner || hasProduct || hasPath) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] must have exactly one rule shape`);
      }
      const sha = rule['image_sha256'];
      if (typeof sha !== 'string' || !SHA256_PATTERN.test(sha)) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].image_sha256 must be 64 lower-case hex characters`);
      }
      rules.push({ image_sha256: sha });
      continue;
    }
    if (hasSigner || hasProduct) {
      if (!hasSigner || !hasProduct || hasPath) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] signer and product_name must appear together`);
      }
      const signer = rule['signer'];
      const product = rule['product_name'];
      if (typeof signer !== 'string' || signer.length === 0 || signer.length > 512) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].signer must be a non-empty string ≤ 512 characters`);
      }
      if (typeof product !== 'string' || product.length === 0 || product.length > 512) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].product_name must be a non-empty string ≤ 512 characters`);
      }
      rules.push({ signer, product_name: product });
      continue;
    }
    if (hasPath) {
      const p = rule['image_path'];
      if (typeof p !== 'string' || p.length === 0 || p.length > 512) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].image_path must be a non-empty string ≤ 512 characters`);
      }
      if (!ABSOLUTE_PATH_PATTERN.test(p)) {
        throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}].image_path must be absolute`);
      }
      rules.push({ image_path: p });
      continue;
    }
    throw new Error(`${configPath}: adapters.desktop.authorized_apps[${i}] must have exactly one rule shape`);
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Node session id (amendment A8, F3b): a small fixed PowerShell call.
// ---------------------------------------------------------------------------

/**
 * The fixed, parameter-free PowerShell that reports the Windows session id of
 * the process named by the single integer argument. No caller value reaches
 * this source; the only input is the numeric pid, passed as a positional argv.
 *
 * Written for Windows PowerShell 5.1: the `u` numeric-literal suffix does not
 * exist there, and `[ref]` requires the target variable to be the exact type
 * `TryParse` writes, so both are declared `[uint32]` before use.
 */
export const NODE_SESSION_ID_PS1 = `# toros-node-session-id.ps1 — fixed. Reads the session id of the pid in $args[0].
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class TorosSession {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);
}
"@
if ($args.Count -lt 1) { exit 2 }
[uint32]$targetPid = 0
if (-not [uint32]::TryParse([string]$args[0], [ref]$targetPid) -or $targetPid -eq 0) { exit 2 }
[uint32]$sid = 0
if ([TorosSession]::ProcessIdToSessionId($targetPid, [ref]$sid)) { [Console]::WriteLine([string]$sid) } else { exit 1 }
`;

/**
 * Runs the fixed session-id script. `execFile` is wrapped so a test can inject
 * a fake runner without spawning PowerShell or writing a temp directory.
 */
export type NodeSessionIdRunner = (
  powershell: string,
  scriptPath: string,
  args: readonly string[],
) => Promise<string>;

/** The real runner: a fixed PowerShell process, shell-less, bounded. */
export function defaultNodeSessionIdRunner(): NodeSessionIdRunner {
  return (powershell: string, scriptPath: string, args: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
        { shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout, _stderr) => {
          if (error) { reject(error); return; }
          resolve(stdout);
        },
      );
    });
}

/**
 * Determine Node Core's own Windows session id once at startup (amendment A8,
 * F3b): a small fixed PowerShell call to `ProcessIdToSessionId(process.pid)`.
 * Returns null on any failure — every `app` target then fails closed — after
 * writing one log line, never an error that would stop the node from serving
 * non-desktop work.
 */
export async function resolveNodeSessionId(
  pid: number,
  systemRoot: string | undefined,
  runner: NodeSessionIdRunner = defaultNodeSessionIdRunner(),
): Promise<number | null> {
  const powershell = systemRoot !== undefined && systemRoot.length > 0
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const dir = await mkdtemp(join(tmpdir(), 'toros-session-'));
  const scriptPath = join(dir, 'session.ps1');
  try {
    await writeFile(scriptPath, NODE_SESSION_ID_PS1, 'utf8');
    const stdout = await runner(powershell, scriptPath, [String(pid)]);
    const parsed = Number(stdout.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}