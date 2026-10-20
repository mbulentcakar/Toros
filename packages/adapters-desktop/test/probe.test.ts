import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, TorosError } from '@toros/contracts';

import { runPowerShell, parseIdentity, type ProbeSpawn } from '../src/probe.js';

// ---------------------------------------------------------------------------
// AR-F4 acceptance for the runPowerShell wrapper: pre-abort refusal, output
// bounds, and awaited cleanup. Every child is FAKE (spawn seam) so the suite
// runs on any platform: no PowerShell is ever started here.
// ---------------------------------------------------------------------------

/** Probe temp dirs currently present in the OS temp directory. */
async function sandboxProbeDirs(): Promise<string[]> {
  const entries = await fsPromises.readdir(tmpdir());
  return entries.filter((name) => name.startsWith('toros-desktop-')).sort();
}

/**
 * Assert the run leaked no probe temp dir. The OS temp dir can hold dirs left
 * by earlier crashed runs, and Windows may remove them at any time, so only
 * NEW dirs appearing during the test are a failure.
 */
function assertNoProbeLeak(before: string[], after: string[]): void {
  const leaked = after.filter((name) => !before.includes(name));
  assert.deepEqual(leaked, [], `a probe temp dir leaked: ${leaked.join(', ')}`);
}

/**
 * The probe spawns PowerShell with `-File <scriptPath>`; the sandbox is the
 * script's directory. A fake must derive it from the LAST argument, not from
 * `file` (that is powershell.exe itself).
 */
function sandboxOf(args: readonly string[]): string {
  const scriptPath = args[args.length - 1];
  if (scriptPath === undefined) throw new Error('fake spawn: no -File argument');
  return path.dirname(scriptPath);
}

/** A spawn seam that acts inside the probe's temp dir and then reports success. */
function spawnForScript(
  act: (dir: string) => void,
  callbackDelayMs = 5,
): ProbeSpawn {
  return (file, args, _opts, callback) => {
    const dir = sandboxOf(args);
    act(dir);
    setTimeout(() => callback(null, '', ''), callbackDelayMs);
    return { kill: () => {} };
  };
}

function context(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// Acceptance 5 — a pre-aborted signal rejects without spawning anything and
// without creating a temp directory.
// ---------------------------------------------------------------------------

test('runPowerShell rejects immediately on a pre-aborted signal, spawning nothing and creating no temp dir', async () => {
  const before = await sandboxProbeDirs();
  let spawned = 0;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runPowerShell({ action: 'enumerate_windows' }, 5000, controller.signal, (_file, _args, _opts, _cb) => {
      spawned += 1;
      return { kill: () => {} };
    }),
    (err: unknown) => err instanceof Error && err.message.includes('cancelled'),
  );

  assert.equal(spawned, 0, 'a child process was spawned for a pre-aborted probe');
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

// ---------------------------------------------------------------------------
// Acceptance 6 — an output file over the limit is refused with E_OUTPUT_LIMIT
// and is never read into memory: the file CONTENT is valid JSON, so any read
// + parse would succeed and resolve instead of rejecting.
// ---------------------------------------------------------------------------

test('an oversized output file is refused with E_OUTPUT_LIMIT and is never read whole', async () => {
  const before = await sandboxProbeDirs();
  const spawn: ProbeSpawn = (_file, args, _opts, callback) => {
    const dir = sandboxOf(args);
    setTimeout(() => {
      void (async () => {
        const outPath = path.join(dir, 'output.json');
        const handle = await fsPromises.open(outPath, 'w');
        // Valid JSON followed by whitespace padding — parseable as a whole.
        await handle.write('{"session_state":"active","windows":[]}');
        await handle.write(Buffer.alloc(4 * 1024 * 1024, 0x20));
        await handle.close();
        callback(null, '', '');
      })();
    }, 0);
    return { kill: () => {} };
  };

  await assert.rejects(
    runPowerShell({ action: 'inspect_window' }, 5000, context().signal, spawn),
    (err: unknown) => err instanceof TorosError && err.code === ErrorCode.E_OUTPUT_LIMIT,
    'an oversized output must be rejected with E_OUTPUT_LIMIT, not parsed',
  );
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

// ---------------------------------------------------------------------------
// Acceptance 7 — after every probe outcome (success, timeout, abort, error)
// the temp directory no longer exists when the promise settles.
// ---------------------------------------------------------------------------

test('success settles only after the temp dir is removed', async () => {
  const before = await sandboxProbeDirs();
  const spawn = spawnForScript((dir) => {
    void fsPromises.writeFile(path.join(dir, 'output.json'), '{"session_state":"active","windows":[]}', 'utf8');
  }, 5);

  const output = await runPowerShell({ action: 'enumerate_windows' }, 5000, context().signal, spawn);
  assert.deepEqual(output, { session_state: 'active', windows: [] });
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

test('timeout rejects and removes the temp dir', async () => {
  const before = await sandboxProbeDirs();
  // The fake child never calls back, so only runPowerShell's own timer can settle it.
  const spawn: ProbeSpawn = (_file, _args, _opts, _callback) => ({ kill: () => {} });

  await assert.rejects(
    runPowerShell({ action: 'enumerate_windows' }, 40, context().signal, spawn),
    (err: unknown) => err instanceof Error && err.message.includes('timed out'),
  );
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

test('abort rejects and removes the temp dir', async () => {
  const before = await sandboxProbeDirs();
  const controller = new AbortController();
  const spawn: ProbeSpawn = (_file, _args, _opts, _callback) => ({ kill: () => {} });

  const pending = runPowerShell({ action: 'enumerate_windows' }, 5000, controller.signal, spawn);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof Error && err.message.includes('cancelled'),
  );
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

test('a child error rejects and removes the temp dir', async () => {
  const before = await sandboxProbeDirs();
  const spawn: ProbeSpawn = (_file, _args, _opts, callback) => {
    setTimeout(() => callback(new Error('child boom'), 'out', 'err'), 5);
    return { kill: () => {} };
  };

  await assert.rejects(
    runPowerShell({ action: 'enumerate_windows' }, 5000, context().signal, spawn),
    (err: unknown) => err instanceof Error && err.message.includes('powershell exited with error'),
  );
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

// ---------------------------------------------------------------------------
// Acceptance 7 (error path) — a broken output file (bad JSON) rejects with
// the read-failure error and still removes the temp dir.
// ---------------------------------------------------------------------------

test('an unparseable output file rejects and still removes the temp dir', async () => {
  const before = await sandboxProbeDirs();
  const spawn = spawnForScript((dir) => {
    void fsPromises.writeFile(path.join(dir, 'output.json'), 'not-json{', 'utf8');
  }, 5);

  await assert.rejects(
    runPowerShell({ action: 'enumerate_windows' }, 5000, context().signal, spawn),
    (err: unknown) => err instanceof Error && err.message.includes('failed to read probe output'),
  );
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

// ---------------------------------------------------------------------------
// Round 2 finding 4 (P2) — an abort landing WHILE the async setup awaits on
// the filesystem (after the entry check, before the spawn) must not let the
// child start. The post-setup recheck rejects cancelled without spawning, with
// cleanup awaited.
// ---------------------------------------------------------------------------

test('an abort during async setup rejects without spawning once the setup writes complete', async () => {
  const before = await sandboxProbeDirs();
  const controller = new AbortController();
  let spawned = 0;
  const spawn: ProbeSpawn = (_file, _args, _opts, _callback) => { spawned += 1; return { kill: () => {} }; };
  const realWriteFile = fsPromises.writeFile.bind(fsPromises);
  // Abort at the moment the script write completes — mid-setup, after the
  // entry check and before the spawn seam can run.
  fsPromises.writeFile = ((file: Parameters<typeof fsPromises.writeFile>[0], data: Parameters<typeof fsPromises.writeFile>[1], options?: Parameters<typeof fsPromises.writeFile>[2]) => {
    return realWriteFile(file, data, options).then((result) => {
      if (typeof file === 'string' && file.endsWith('action.ps1')) controller.abort();
      return result;
    });
  }) as typeof fsPromises.writeFile;
  try {
    await assert.rejects(
      runPowerShell({ action: 'enumerate_windows' }, 5000, controller.signal, spawn),
      (err: unknown) => err instanceof Error && err.message.includes('cancelled'),
    );
  } finally {
    fsPromises.writeFile = realWriteFile;
  }
  assert.equal(spawned, 0, 'a child was spawned after the probe was aborted mid-setup');
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

// ---------------------------------------------------------------------------
// Round 2 finding 5 (P2) — a SYNCHRONOUS spawn/execFile failure must reject the
// caller through the closing path (cleanup awaited), never escape the detached
// IIFE as an unhandled rejection.
// ---------------------------------------------------------------------------

test('a synchronous spawn failure rejects through the wrapper with cleanup awaited and no unhandled rejection', async () => {
  const before = await sandboxProbeDirs();
  let unhandled = 0;
  const onUnhandled = (): void => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      runPowerShell({ action: 'enumerate_windows' }, 5000, context().signal, () => { throw new Error('spawn boom'); }),
      (err: unknown) => err instanceof Error && err.message.includes('spawn boom'),
      'a synchronous spawn failure must reject the returned promise',
    );
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, 0, 'the synchronous spawn error became an unhandled rejection');
  assertNoProbeLeak(before, await sandboxProbeDirs());
});

// ---------------------------------------------------------------------------
// Round 2 finding 6 (P3) — a cleanup failure is logged once with the directory
// basename and the error CODE only (never the raw message or the full path),
// and it does not change the action's result.
// ---------------------------------------------------------------------------

test('a cleanup failure logs only the basename and the error code, and keeps the result', async () => {
  const before = await sandboxProbeDirs();
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: Parameters<typeof console.error>) => { logs.push(args.map(String).join(' ')); };
  const realRm = fsPromises.rm.bind(fsPromises);
  fsPromises.rm = ((target: Parameters<typeof fsPromises.rm>[0], options?: Parameters<typeof fsPromises.rm>[1]) => {
    if (typeof target === 'string' && target.includes('toros-desktop-')) {
      // EACCES-style removal failure whose message contains the full path.
      const err = Object.assign(new Error(`EACCES: permission denied, unlink '${target}'`), { code: 'EACCES' });
      return Promise.reject(err);
    }
    return realRm(target, options);
  }) as typeof fsPromises.rm;
  try {
    const spawn = spawnForScript((dir) => {
      void fsPromises.writeFile(path.join(dir, 'output.json'), '{"session_state":"active","windows":[]}', 'utf8');
    }, 5);
    const output = await runPowerShell({ action: 'enumerate_windows' }, 5000, context().signal, spawn);
    assert.deepEqual(output, { session_state: 'active', windows: [] }, 'a cleanup failure changed the probe result');
  } finally {
    fsPromises.rm = realRm;
    console.error = originalError;
    // The injected removal failure left the probe temp dir behind; the real rm
    // (restored above) removes it so the suite does not leak a directory.
    const leaked = (await sandboxProbeDirs()).filter((name) => !before.includes(name));
    for (const name of leaked) await fsPromises.rm(path.join(tmpdir(), name), { recursive: true, force: true });
  }

  assert.equal(logs.length, 1, `expected exactly one cleanup log, got: ${JSON.stringify(logs)}`);
  const log = logs[0]!;
  assert.ok(log.includes('desktop probe cleanup failed'), `unexpected log line: ${log}`);
  assert.ok(log.includes('EACCES'), `the cleanup log omitted the error code: ${log}`);
  assert.ok(!log.includes(tmpdir()), `the cleanup log leaked the temp directory path: ${log}`);
  assert.ok(!log.includes('permission denied'), `the cleanup log leaked the raw error message: ${log}`);
});

// ---------------------------------------------------------------------------
// F3b — parseIdentity normalises the script's identity output into the exact
// AppIdentity shape Core's validator accepts. Process-free unit tests.
// ---------------------------------------------------------------------------

function validIdentity(): Record<string, unknown> {
  return {
    pid: 4242,
    created_at: '2026-01-01T00:00:00.000Z',
    image_path: 'C:\\Program Files\\App\\app.exe',
    image_sha256: 'a'.repeat(64),
    signature: 'valid',
    signer: 'Contoso Corp',
    product_name: 'Contoso Editor',
    session_id: 2,
  };
}

test('parseIdentity accepts a well-formed identity verbatim', () => {
  const result = parseIdentity(validIdentity());
  assert.deepEqual(result, {
    pid: 4242,
    created_at: '2026-01-01T00:00:00.000Z',
    image_path: 'C:\\Program Files\\App\\app.exe',
    image_sha256: 'a'.repeat(64),
    signature: 'valid',
    signer: 'Contoso Corp',
    product_name: 'Contoso Editor',
    session_id: 2,
  });
});

test('parseIdentity maps a non-valid signature to a null signer', () => {
  const unsigned = parseIdentity({ ...validIdentity(), signature: 'unsigned', signer: null });
  assert.equal(unsigned?.signature, 'unsigned');
  assert.equal(unsigned?.signer, null);
});

test('parseIdentity rejects a malformed identity (returns null)', () => {
  assert.equal(parseIdentity({ ...validIdentity(), pid: 0 }), null);
  assert.equal(parseIdentity({ ...validIdentity(), pid: 1.5 }), null);
  assert.equal(parseIdentity({ ...validIdentity(), session_id: -1 }), null);
  assert.equal(parseIdentity({ ...validIdentity(), created_at: 'garbage' }), null);
  assert.equal(parseIdentity({ ...validIdentity(), image_sha256: 'A'.repeat(64) }), null);
  assert.equal(parseIdentity({ ...validIdentity(), signature: 'valid', signer: null }), null);
  assert.equal(parseIdentity({ ...validIdentity(), signature: 'invalid', signer: 'Contoso' }), null);
  assert.equal(parseIdentity({ ...validIdentity(), image_path: '' }), null);
});