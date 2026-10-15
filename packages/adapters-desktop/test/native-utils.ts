import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AdapterContext } from '@toros/contracts';

import { createPowerShellUiaProbe } from '../src/probe.js';
import type { UiaProbe } from '../src/adapter.js';

export function getPowershellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  if (systemRoot) {
    return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return 'powershell.exe';
}

export function fakeContext(): AdapterContext {
  return {
    job_id: 'native-job-1',
    session_id: null,
    workspace: { id: 'ws-native', root: '/tmp/ws-native' },
    correlation_id: 'corr-native-1',
    signal: new AbortController().signal,
  };
}

/**
 * A synthetic WinForms fixture this test itself created. `pid` IS the spawned
 * child's `child.pid` (the authoritative identity of the process the test
 * started) and `hwnd` comes from the fixture's own READY line, so tests bind
 * the probe (and therefore all enumeration/title reads) to these two
 * identities. The fixture does NOT run as `powershell.exe`: it runs from a
 * renamed copy of the executable in a fresh temp directory, so `process_name`
 * is unique to this test run and `authorized_apps` can name exactly that
 * process and nothing else.
 */
export interface FixtureInstance {
  readonly process: ChildProcess;
  readonly hwnd: number;
  readonly pid: number;
  readonly process_name: string;
  /** Fresh temp dir holding the renamed fixture executable; removed on stopFixture. */
  readonly tempDir: string;
  readonly title: string;
  readonly canaryPwd: string;
  readonly canaryTxt: string;
  readonly canaryLbl: string;
}

export interface FixtureReadyIdentity {
  readonly hwnd: number;
  readonly pid: number;
  readonly process_name: string;
}

/**
 * Parse and validate one fixture READY line against the spawned child's own
 * identity. Fail closed: the reported pid MUST equal the spawned `child.pid`,
 * the reported process name MUST equal the unique renamed-executable name, and
 * the HWND must be a positive integer. Any mismatch or malformation throws,
 * before any probe is built or run.
 */
export function parseFixtureReadyLine(
  line: string,
  expected: { readonly pid: number; readonly process_name: string },
): FixtureReadyIdentity {
  const parts = line.split(':');
  if (parts[0] !== 'READY' || parts.length < 4) {
    throw new Error(`Malformed fixture READY line: ${JSON.stringify(line)}`);
  }
  const rawHwnd = parts[1];
  const rawPid = parts[2];
  const processName = parts[3] ?? '';
  const hwnd = Number(rawHwnd);
  const reportedPid = Number(rawPid);
  if (!Number.isInteger(hwnd) || hwnd <= 0) {
    throw new Error(`Fixture READY reported an invalid HWND: ${JSON.stringify(rawHwnd)}`);
  }
  if (!Number.isInteger(reportedPid) || reportedPid !== expected.pid) {
    throw new Error(
      `Fixture READY pid ${JSON.stringify(rawPid)} does not equal the spawned child.pid ${expected.pid}`,
    );
  }
  if (processName !== expected.process_name) {
    throw new Error(
      `Fixture READY process name ${JSON.stringify(processName)} does not equal the copied fixture executable ${expected.process_name}`,
    );
  }
  return { hwnd, pid: reportedPid, process_name: processName };
}

export function startFixture(options: {
  title?: string;
  canaryPwd?: string;
  canaryTxt?: string;
  canaryLbl?: string;
  extraControls?: number;
  extraWindows?: number;
}): Promise<FixtureInstance> {
  return new Promise((resolve, reject) => {
    const baseDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
    let fixtureScript = path.resolve(baseDir, '../../test/fixtures/canary-form.ps1');
    if (!fs.existsSync(fixtureScript)) {
      fixtureScript = path.resolve(baseDir, '../test/fixtures/canary-form.ps1');
    }
    const title = options.title ?? `TorosFixture_${randomBytes(4).toString('hex')}`;
    const canaryPwd = options.canaryPwd ?? `CANARY_PWD_${randomBytes(8).toString('hex')}`;
    const canaryTxt = options.canaryTxt ?? `CANARY_TXT_${randomBytes(8).toString('hex')}`;
    const canaryLbl = options.canaryLbl ?? `CANARY_LBL_${randomBytes(8).toString('hex')}`;
    const extraControls = options.extraControls ?? 0;
    const extraWindows = options.extraWindows ?? 0;

    // The fixture host is a renamed copy of the Windows PowerShell executable
    // placed in a fresh, uniquely named temp directory (toros-fixture-<rand>).
    // Its process name is therefore unique to this run: authorized_apps can
    // name exactly the fixture, never a generic process such as `powershell`.
    let tempDir: string;
    let copyPath: string;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toros-fixture-'));
      copyPath = path.join(tempDir, `toros-fixture-${randomBytes(6).toString('hex')}.exe`);
      fs.copyFileSync(getPowershellPath(), copyPath);
    } catch (err) {
      reject(
        new Error(`Failed to prepare the renamed fixture executable from Windows PowerShell: ${String(err)}`),
      );
      return;
    }
    // Windows ProcessName is the image file name without the .exe suffix.
    const fixtureProcessName = path.basename(copyPath).replace(/\.exe$/i, '');

    const child = spawn(
      copyPath,
      [
        '-NoProfile',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fixtureScript,
        '-Title',
        title,
        '-Canary1',
        canaryPwd,
        '-Canary2',
        canaryTxt,
        '-Canary3',
        canaryLbl,
        '-ExtraControls',
        String(extraControls),
        '-ExtraWindows',
        String(extraWindows),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let resolved = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timeout: NodeJS.Timeout | undefined;

    const removeTempDir = (): void => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // already gone
      }
    };

    // The fixture's identity IS the spawned child. Without a live, integer
    // child.pid the helper fails before any probe can run.
    const childPid = child.pid;
    if (typeof childPid !== 'number' || !Number.isInteger(childPid) || childPid <= 0) {
      try { child.kill(); } catch { /* never started */ }
      removeTempDir();
      reject(new Error(`Spawned fixture child has no valid PID (child.pid=${String(childPid)})`));
      return;
    }

    const failStart = (err: Error): void => {
      if (resolved) return;
      resolved = true;
      if (timeout) clearTimeout(timeout);
      try { child.kill(); } catch { /* already gone */ }
      removeTempDir();
      reject(err);
    };

    timeout = setTimeout(() => {
      failStart(new Error(`Fixture start timed out. Stdout: ${stdoutBuffer} Stderr: ${stderrBuffer}`));
    }, 15_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('READY:')) {
          try {
            // The READY line's reported id must equal the spawned child.pid,
            // or the helper fails right here, before any probe runs.
            const ready = parseFixtureReadyLine(line, { pid: childPid, process_name: fixtureProcessName });
            if (!resolved) {
              resolved = true;
              if (timeout) clearTimeout(timeout);
              resolve({
                process: child,
                hwnd: ready.hwnd,
                pid: childPid,
                process_name: fixtureProcessName,
                tempDir,
                title,
                canaryPwd,
                canaryTxt,
                canaryLbl,
              });
            }
          } catch (err) {
            failStart(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('error', (err) => failStart(err));

    child.on('exit', (code) => {
      if (!resolved) {
        failStart(
          new Error(`Fixture exited prematurely with code ${code}. Stderr: ${stderrBuffer}. Stdout: ${stdoutBuffer}`),
        );
      }
    });
  });
}

/**
 * Stop a fixture the test itself created and remove its renamed executable
 * copy. Kills ONLY the process started by startFixture, waits for it to exit
 * (Windows keeps the image file locked while the process runs), then deletes
 * the temp dir — cleanup leaves no copy behind.
 */
export async function stopFixture(fixture: FixtureInstance): Promise<void> {
  const child = fixture.process;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  } catch {
    // already exited
  }
  await waitForChildExit(child, 10_000);
  // The copy may still be briefly locked by the OS right after exit; retry
  // rather than leave an executable on disk.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  } catch {
    // best effort — already removed by another cleanup path
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve();
    };
    const onExit = (): void => finish();
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    timer = setTimeout(finish, timeoutMs);
    child.on('exit', onExit);
  });
}

/**
 * A real PowerShell-backed probe bound to one fixture's PID (which IS the
 * spawned child's `child.pid`): every top-level window walk skips windows
 * owned by any other process before reading their native text, so nothing
 * outside the fixture is ever inspected.
 */
export function fixtureProbe(fixture: FixtureInstance): UiaProbe {
  return createPowerShellUiaProbe({ timeout_ms: 30_000, restrict_to_pid: fixture.pid });
}

/**
 * POST to a real Node Core tool surface (loopback). `agent: false` so the
 * keep-alive socket cannot hold `node --test` open after the suite finishes.
 */
export async function tools(
  port: number,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        agent: false,
        path: `/tools/${tool}`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(args));
  });
}