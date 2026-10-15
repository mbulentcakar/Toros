import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import fs from 'node:fs';
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
 * A synthetic WinForms fixture this test itself created. `pid` is taken from the
 * spawned child and `hwnd` from the fixture's own READY line, so tests bind the
 * probe (and therefore all enumeration/title reads) to these two identities.
 */
export interface FixtureInstance {
  readonly process: ChildProcess;
  readonly hwnd: number;
  readonly pid: number;
  readonly process_name: string;
  readonly title: string;
  readonly canaryPwd: string;
  readonly canaryTxt: string;
  readonly canaryLbl: string;
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

    const child = spawn(
      getPowershellPath(),
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

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`Fixture start timed out. Stdout: ${stdoutBuffer} Stderr: ${stderrBuffer}`));
      }
    }, 15_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('READY:')) {
          const parts = line.split(':');
          const hwnd = Number(parts[1]);
          const pid = Number(parts[2]);
          const processName = parts[3] ?? '';
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({
              process: child,
              hwnd,
              pid,
              process_name: processName,
              title,
              canaryPwd,
              canaryTxt,
              canaryLbl,
            });
          }
          return;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Fixture exited prematurely with code ${code}. Stderr: ${stderrBuffer}. Stdout: ${stdoutBuffer}`));
      }
    });
  });
}

/** Stop a fixture the test itself created. Never touches any other process. */
export function stopFixture(fixture: FixtureInstance): void {
  try {
    fixture.process.kill();
  } catch {
    // already exited
  }
}

/**
 * A real PowerShell-backed probe bound to one fixture's PID: every top-level
 * window walk skips windows owned by any other process before reading their
 * native text, so nothing outside the fixture is ever inspected.
 */
export function fixtureProbe(fixture: FixtureInstance): UiaProbe {
  return createPowerShellUiaProbe({ timeout_ms: 30_000, restrict_to_pid: fixture.pid });
}

/**
 * Probe bound to THIS test process's own PID — the locked-desktop precondition
 * check only. The PID filter makes the walk skip every other window before any
 * text is read, so an active-desktop check never inspects real applications.
 */
export function selfProbe(): UiaProbe {
  return createPowerShellUiaProbe({ timeout_ms: 30_000, restrict_to_pid: process.pid });
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