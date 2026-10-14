import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, TorosError } from '@toros/contracts';

import { runPowerShell, type ProbeSpawn } from '../src/probe.js';

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