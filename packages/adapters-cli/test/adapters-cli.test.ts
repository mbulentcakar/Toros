import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { ErrorCode, TorosError, type AdapterContext, type SessionAdapter } from '@toros/contracts';
import { createClaudeAdapter, createCodexAdapter, createGeminiAdapter, createGrokAdapter } from '../src/index.js';

const fixture = join(import.meta.dirname, 'fixture.js');

async function setup(id: string, options: Partial<{
  timeout_ms: number;
  exchange_timeout_ms: number;
  read_poll_ms: number;
  output_limit_bytes: number;
  runtime_paths: readonly string[];
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'toros-cli-'));
  const executable = process.execPath;
  const adapter = createClaudeAdapter({
    executable,
    launcher_args: [fixture],
    args: [],
    timeout_ms: options.timeout_ms ?? 5_000,
    ...(options.exchange_timeout_ms === undefined ? {} : { exchange_timeout_ms: options.exchange_timeout_ms }),
    read_poll_ms: options.read_poll_ms ?? 100,
    ...(options.runtime_paths === undefined ? {} : { runtime_paths: options.runtime_paths }),
    output_limit_bytes: options.output_limit_bytes ?? 1_000_000,
  });
  await adapter.init();
  const controller = new AbortController();
  const ctx: AdapterContext = { job_id: 'job', session_id: id, workspace: { id: 'ws', root }, correlation_id: id, signal: controller.signal };
  return { root, executable, adapter, ctx, controller };
}

async function setupProtocol(id: string, protocol: 'gemini' | 'grok') {
  const root = await mkdtemp(join(tmpdir(), `toros-${protocol}-`));
  const factory = protocol === 'gemini' ? createGeminiAdapter : createGrokAdapter;
  const adapter = factory({
    executable: process.execPath,
    launcher_args: [fixture, '--fixture-protocol', protocol],
    args: [], timeout_ms: 5_000, read_poll_ms: 100, output_limit_bytes: 1_000_000,
  });
  await adapter.init();
  const ctx: AdapterContext = { job_id: 'job', session_id: id, workspace: { id: 'ws', root }, correlation_id: id, signal: new AbortController().signal };
  return { root, adapter, ctx };
}

async function teardown(adapter: SessionAdapter, root: string): Promise<void> {
  await adapter.dispose();
  await rm(root, { recursive: true, force: true });
}

async function readToCompletion(adapter: SessionAdapter, sessionId: string, cursor = 0): Promise<{ chunk: string; cursor: number; state: string; error: string | null }> {
  let chunk = '';
  let next = cursor;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await adapter.read(sessionId, next);
    chunk += result.chunk;
    next = result.cursor;
    const state = result.exchange_state ?? 'succeeded';
    if (state !== 'running') return { chunk, cursor: next, state, error: result.exchange_error ?? null };
  }
  throw new Error('exchange did not complete');
}

async function output(adapter: SessionAdapter, ctx: AdapterContext, message: string): Promise<string> {
  if (ctx.session_id === null) throw new Error('test context has no session id');
  await adapter.send(ctx.session_id, message);
  return (await readToCompletion(adapter, ctx.session_id)).chunk;
}

test('send spawns the fixture with the session directory as cwd', async () => {
  const s = await setup('cwd-session');
  try { await s.adapter.start(s.ctx); assert.match(await output(s.adapter, s.ctx, 'cwd'), /cwd:.*cwd-session/); } finally { await teardown(s.adapter, s.root); }
});

test('start creates a per-session directory named for the correlation id', async () => {
  const s = await setup('correlation');
  try { await s.adapter.start(s.ctx); assert.match(await output(s.adapter, s.ctx, 'cwd'), /correlation$/m); } finally { await teardown(s.adapter, s.root); }
});

test('a raw audit failure is reported by polling and terminalises the session', async () => {
  const s = await setup('audit-write-failure');
  try {
    await s.adapter.start(s.ctx);
    await mkdir(join(s.root, 'audit-write-failure', 'exchange-1.jsonl'));
    await s.adapter.send('audit-write-failure', 'hello');
    await assert.rejects(readToCompletion(s.adapter, 'audit-write-failure'), (error: unknown) =>
      error instanceof TorosError && error.code === ErrorCode.E_ADAPTER_FAILURE);
    await assert.rejects(s.adapter.send('audit-write-failure', 'resume'), (error: unknown) =>
      error instanceof TorosError && error.code === ErrorCode.E_ADAPTER_FAILURE);
  } finally {
    await teardown(s.adapter, s.root);
  }
});

test('two concurrent sessions get different directories', async () => {
  const a = await setup('one'); const b = await setup('two');
  try { await Promise.all([a.adapter.start(a.ctx), b.adapter.start(b.ctx)]); assert.notEqual((await output(a.adapter, a.ctx, 'cwd')), (await output(b.adapter, b.ctx, 'cwd'))); } finally { await Promise.all([teardown(a.adapter, a.root), teardown(b.adapter, b.root)]); }
});

test('refuses a .cmd executable at init with E_ADAPTER_FAILURE', async () => {
  const adapter = createClaudeAdapter({ args: [], executable: 'bad.cmd', timeout_ms: 100, output_limit_bytes: 10 });
  await assert.rejects(adapter.init(), (error: unknown) => error instanceof TorosError && error.code === ErrorCode.E_ADAPTER_FAILURE);
});

test('refuses a Claude permission-mode override in operator arguments', async () => {
  const adapter = createClaudeAdapter({
    args: ['--permission-mode', 'acceptEdits'], executable: process.execPath,
    sandbox: 'read-only', timeout_ms: 100, output_limit_bytes: 10,
  });
  await assert.rejects(adapter.init(), (error: unknown) =>
    error instanceof TorosError && error.code === ErrorCode.E_ADAPTER_FAILURE);
});

test('refuses a Codex sandbox override in operator arguments', async () => {
  const adapter = createCodexAdapter({
    args: ['--sandbox=danger-full-access'], executable: process.execPath,
    sandbox: 'read-only', timeout_ms: 100, output_limit_bytes: 10,
  });
  await assert.rejects(adapter.init(), (error: unknown) =>
    error instanceof TorosError && error.code === ErrorCode.E_ADAPTER_FAILURE);
});

test('refuses a Gemini mode override in operator arguments', async () => {
  const adapter = createGeminiAdapter({
    args: ['--mode', 'accept-edits'], executable: process.execPath,
    sandbox: 'read-only', timeout_ms: 100, output_limit_bytes: 10,
  });
  await assert.rejects(adapter.init(), (error: unknown) =>
    error instanceof TorosError && error.code === ErrorCode.E_ADAPTER_FAILURE);
});

test('refuses Grok permission and sandbox overrides in operator arguments', async () => {
  for (const args of [['--permission-mode', 'dontAsk'], ['--sandbox=off']]) {
    const adapter = createGrokAdapter({
      args, executable: process.execPath,
      sandbox: 'read-only', timeout_ms: 100, output_limit_bytes: 10,
    });
    await assert.rejects(adapter.init(), (error: unknown) =>
      error instanceof TorosError && error.code === ErrorCode.E_ADAPTER_FAILURE);
  }
});

test('spawns with shell false and does not interpret shell metacharacters in a message', async () => {
  const s = await setup('shell');
  try { await s.adapter.start(s.ctx); assert.equal(await output(s.adapter, s.ctx, 'a&b|c^d'), 'a&b|c^d\n'); } finally { await teardown(s.adapter, s.root); }
});

test('PATHEXT reaches the child with the supervisor value', async () => {
  // Windows resolves `git` to `git.exe` through PATHEXT; a worker shell without
  // it cannot find native executables by bare name. Plant a distinctive value
  // so the assertion proves forwarding, not inheritance.
  const previous = process.env['PATHEXT'];
  process.env['PATHEXT'] = '.COM;.EXE;.TOROSTEST';
  const s = await setup('pathext');
  try {
    await s.adapter.start(s.ctx);
    assert.equal((await output(s.adapter, s.ctx, 'pathext')).trim(), 'pathext:.COM;.EXE;.TOROSTEST');
  } finally {
    if (previous === undefined) delete process.env['PATHEXT']; else process.env['PATHEXT'] = previous;
    await teardown(s.adapter, s.root);
  }
});

test('passes only the allowlisted environment variables', async () => {
  // Windows CreateProcess injects these into every child whatever environment
  // block is supplied — measured on the target machine, not assumed. They are
  // fixed identity values, not secrets. Asserting an exact key set against the
  // allowlist can therefore never pass here, and would not demonstrate safety
  // if it did: what SPEC §8.1 actually asks is that no CREDENTIAL reaches the
  // child. So assert the property, and prove it with a planted value.
  const WINDOWS_INJECTED = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME'];
  const ALLOWED = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'USERPROFILE'];

  const canary = 'TOROS_CANARY_SECRET';
  process.env[canary] = 'must-not-reach-the-child';
  const s = await setup('environment');
  try {
    await s.adapter.start(s.ctx);
    const keys = (await output(s.adapter, s.ctx, 'env')).trim().slice(4).split(',').filter(Boolean);

    const unexpected = keys.filter((key) => !ALLOWED.includes(key) && !WINDOWS_INJECTED.includes(key));
    assert.deepEqual(unexpected, [], `child saw unexpected variables: ${unexpected.join(', ')}`);

    // The control that matters: a variable present in the supervisor does not
    // reach the child.
    assert.ok(!keys.includes(canary), 'a parent environment variable leaked into the child');
  } finally {
    delete process.env[canary];
    await teardown(s.adapter, s.root);
  }
});

test('send then read returns the fixture output', async () => {
  const s = await setup('send');
  try { await s.adapter.start(s.ctx); assert.equal(await output(s.adapter, s.ctx, 'hello'), 'hello\n'); } finally { await teardown(s.adapter, s.root); }
});

for (const protocol of ['gemini', 'grok'] as const) {
  test(`${protocol} framing sends output and resumes its conversation`, async () => {
    const s = await setupProtocol(`${protocol}-resume`, protocol);
    try {
      await s.adapter.start(s.ctx);
      assert.equal(await output(s.adapter, s.ctx, 'ALPHA'), 'ALPHA\n');
      const cursor = (await s.adapter.read(s.ctx.session_id!, 0)).cursor;
      await s.adapter.send(s.ctx.session_id!, 'ALPHA');
      assert.equal((await readToCompletion(s.adapter, s.ctx.session_id!, cursor)).chunk, 'ALPHA\n');
      if (protocol === 'grok') {
        const files = await readdir(join(s.root, `${protocol}-resume`));
        assert.equal(files.some((file) => file.endsWith('.prompt.txt')), false);
      }
    } finally { await teardown(s.adapter, s.root); }
  });
}

test('grok read-only launches without the shell tool; workspace mode keeps it', async () => {
  for (const [sandbox, expectDisallowed] of [['read-only', true], ['workspace-write', false]] as const) {
    const root = await mkdtemp(join(tmpdir(), 'toros-grok-shell-'));
    const adapter = createGrokAdapter({
      executable: process.execPath, launcher_args: [fixture, '--fixture-protocol', 'grok'],
      args: [], sandbox, timeout_ms: 5_000, read_poll_ms: 100, output_limit_bytes: 1_000_000,
    });
    await adapter.init();
    const ctx: AdapterContext = { job_id: 'job', session_id: `grok-shell-${sandbox}`, workspace: { id: 'ws', root }, correlation_id: sandbox, signal: new AbortController().signal };
    try {
      await adapter.start(ctx);
      const argv = await output(adapter, ctx, 'argv');
      assert.equal(argv.includes('--disallowed-tools run_terminal_cmd'), expectDisallowed, `${sandbox}: ${argv}`);
      assert.ok(argv.includes(sandbox === 'read-only' ? '--permission-mode plan' : '--permission-mode dontAsk'), argv);
    } finally { await teardown(adapter, root); }
  }
});

test('grok framing closes a reply line that an interrupt cut off before `end`', async () => {
  const s = await setupProtocol('grok-partial', 'grok');
  try {
    await s.adapter.start(s.ctx);
    const exchange = s.adapter.send('grok-partial', 'partial');
    await exchangePid(s.root, 'grok-partial');
    // Wait for the fragments to be appended before cutting the run off.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const chunk = (await s.adapter.read('grok-partial', 0)).chunk;
      if (chunk.includes('PARTIAL')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await s.adapter.interrupt('grok-partial');
    await exchange;
    const cursor = (await s.adapter.read('grok-partial', 0)).cursor;
    await s.adapter.send('grok-partial', 'NEXT');
    const next = await readToCompletion(s.adapter, 'grok-partial', cursor);
    assert.equal(next.chunk, 'NEXT\n');
    assert.equal((await s.adapter.read('grok-partial', 0)).chunk, 'PARTIAL\nNEXT\n');
  } finally { await teardown(s.adapter, s.root); }
});

test('an explicit runtime profile is prepended to the minimal child PATH', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'toros-runtime-'));
  const s = await setup('runtime-profile', { runtime_paths: [runtime] });
  try {
    await s.adapter.start(s.ctx);
    const path = (await output(s.adapter, s.ctx, 'runtime-path')).trim();
    assert.equal(path.split(delimiter)[0]?.toLowerCase(), runtime.toLowerCase());
  } finally {
    await teardown(s.adapter, s.root);
    await rm(runtime, { recursive: true, force: true });
  }
});

test('read is incremental and does not repeat bytes across two calls', async () => {
  const s = await setup('incremental');
  try { await s.adapter.start(s.ctx); await s.adapter.send('incremental', 'one'); const first = await readToCompletion(s.adapter, 'incremental'); await s.adapter.send('incremental', 'two'); const second = await readToCompletion(s.adapter, 'incremental', first.cursor); assert.equal(first.chunk + second.chunk, 'one\ntwo\n'); } finally { await teardown(s.adapter, s.root); }
});

test('read past the end returns idle state with the same cursor', async () => { const s = await setup('past-end'); try { await s.adapter.start(s.ctx); assert.deepEqual(await s.adapter.read('past-end', 99), { chunk: '', cursor: 99, exchange_state: 'idle', exchange_error: null }); } finally { await teardown(s.adapter, s.root); } });
test('read with a negative cursor throws E_SCHEMA', async () => { const s = await setup('negative'); try { await s.adapter.start(s.ctx); await assert.rejects(s.adapter.read('negative', -1), (e: unknown) => e instanceof TorosError && e.code === ErrorCode.E_SCHEMA); } finally { await teardown(s.adapter, s.root); } });

test('read slices on byte offsets and does not corrupt a multi-byte character split across a cursor', async () => {
  const s = await setup('bytes');
  const original = '🙂漢字\n';
  try {
    await s.adapter.start(s.ctx);
    await s.adapter.send('bytes', 'utf8');
    const completed = await readToCompletion(s.adapter, 'bytes');

    // The cursor is a byte cursor.  Exercise the read boundary immediately
    // before the end of the first multi-byte character, then continue from
    // the cursor returned by that read.  The expected text comes from the
    // original string, never from the bytes under test.
    const split = Buffer.byteLength('🙂') - 1;
    const first = { chunk: completed.chunk, cursor: completed.cursor };
    const fromSplit = await s.adapter.read('bytes', split);
    const second = await s.adapter.read('bytes', fromSplit.cursor);
    assert.equal(first.chunk, original);
    assert.equal(first.chunk.includes('\uFFFD'), false);
    assert.equal(fromSplit.chunk + second.chunk, original);
    assert.equal((fromSplit.chunk + second.chunk).includes('\uFFFD'), false);
  } finally { await teardown(s.adapter, s.root); }
});
test('interleaves stdout and stderr in arrival order', async () => { const s = await setup('interleave'); try { await s.adapter.start(s.ctx); assert.equal(await output(s.adapter, s.ctx, 'interleave'), 'out\nerr\n'); } finally { await teardown(s.adapter, s.root); } });

test('exceeding the output limit is reported by a poll after the exchange is killed', async () => {
  const s = await setup('limit', { output_limit_bytes: 10 });
  try {
    await s.adapter.start(s.ctx);
    await s.adapter.send('limit', 'flood');
    await assert.rejects(readToCompletion(s.adapter, 'limit'), (e: unknown) => e instanceof TorosError && e.code === ErrorCode.E_OUTPUT_LIMIT);
  } finally { await teardown(s.adapter, s.root); }
});

test('send acknowledges a live exchange without waiting for process completion', async () => {
  const s = await setup('async-send', { exchange_timeout_ms: 10_000 });
  try {
    await s.adapter.start(s.ctx);
    const started = Date.now();
    await s.adapter.send('async-send', 'sleep');
    assert.ok(Date.now() - started < 2_000, 'send waited for the worker to finish');
    const pid = await exchangePid(s.root, 'async-send');
    assert.equal(alive(pid), true);
    await s.adapter.interrupt('async-send');
  } finally { await teardown(s.adapter, s.root); }
});

test('an exchange timeout is reported as resumable failed state', async () => {
  const s = await setup('timeout', { exchange_timeout_ms: 2_000 });
  try {
    await s.adapter.start(s.ctx);
    await s.adapter.invoke('send', { message: 'sleep' }, s.ctx);
    const result = await readToCompletion(s.adapter, 'timeout');
    assert.equal(result.state, 'failed');
    assert.equal(result.error, ErrorCode.E_TIMEOUT);
    await s.adapter.send('timeout', 'recovered');
    assert.equal((await readToCompletion(s.adapter, 'timeout', result.cursor)).chunk, 'recovered\n');
  } finally { await teardown(s.adapter, s.root); }
});
test('aborting ctx.signal kills the child and throws E_CANCELLED', async () => { const s = await setup('cancel'); try { await s.adapter.start(s.ctx); s.controller.abort(); await assert.rejects(s.adapter.read('cancel', 0), (e: unknown) => e instanceof TorosError && e.code === ErrorCode.E_CANCELLED); } finally { await teardown(s.adapter, s.root); } });

// The three tests below assert process death with NO intervening sleep and no
// polling, and that is the whole point of them.
//
// "a timeout kills the child and throws E_TIMEOUT" above asserts only the error
// code, so it passed while the kill ran in the background and the child
// outlived the rejection. Node Core releases its per-job lock the moment the
// action settles and the next action may reuse the same session directory, so
// the guarantee these need to hold is not "the child dies eventually" but "the
// child is already dead when the call returns".
function alive(pid: number): boolean {
  // Signal 0 performs the permission and existence check without delivering
  // anything, on Windows as well as POSIX.
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function exchangePid(root: string, correlationId: string): Promise<number> {
  const path = join(root, correlationId, 'exchange.pid');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* the child has not written its pid yet */ }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fixture did not write ${path}`);
}

test('a timeout poll does not report failure until its child has actually exited', async () => {
  const s = await setup('timeout-death', { exchange_timeout_ms: 250 });
  try {
    await s.adapter.start(s.ctx);
    await s.adapter.invoke('send', { message: 'sleep' }, s.ctx);
    const pid = await exchangePid(s.root, 'timeout-death');
    const result = await readToCompletion(s.adapter, 'timeout-death');
    assert.equal(result.error, ErrorCode.E_TIMEOUT);
    assert.equal(alive(pid), false, `child ${pid} was still running when the timeout was reported`);
  } finally { await teardown(s.adapter, s.root); }
});

test('a cancelled poll does not settle until its child has actually exited', async () => {
  const s = await setup('cancel-death');
  try {
    await s.adapter.start(s.ctx);
    await s.adapter.invoke('send', { message: 'sleep' }, s.ctx);
    const pid = await exchangePid(s.root, 'cancel-death');
    s.controller.abort();
    await assert.rejects(readToCompletion(s.adapter, 'cancel-death'), (e: unknown) => e instanceof TorosError && e.code === ErrorCode.E_CANCELLED);
    assert.equal(alive(pid), false, `child ${pid} was still running when the cancellation was reported`);
  } finally { await teardown(s.adapter, s.root); }
});

test('stop does not return until its child has actually exited', async () => {
  const s = await setup('stop-death');
  try {
    await s.adapter.start(s.ctx);
    const exchange = s.adapter.send('stop-death', 'sleep');
    const pid = await exchangePid(s.root, 'stop-death');
    await s.adapter.stop('stop-death');
    assert.equal(alive(pid), false, `child ${pid} was still running after stop returned`);
    await exchange;
  } finally { await teardown(s.adapter, s.root); }
});
test('interrupt kills the active exchange and waits for its exit', async () => {
  const s = await setup('interrupt');
  try {
    await s.adapter.start(s.ctx);
    const exchange = s.adapter.send('interrupt', 'sleep');
    const pid = await exchangePid(s.root, 'interrupt');
    await s.adapter.interrupt('interrupt');
    assert.equal(alive(pid), false, `child ${pid} was still running after interrupt returned`);
    await exchange;
  } finally { await teardown(s.adapter, s.root); }
});
test('stop is idempotent', async () => { const s = await setup('idempotent'); try { await s.adapter.start(s.ctx); await s.adapter.stop('idempotent'); await s.adapter.stop('idempotent'); } finally { await teardown(s.adapter, s.root); } });
test('dispose stops every live session', async () => { const a = await setup('dispose-a'); const b = await setup('dispose-b'); try { await a.adapter.start(a.ctx); await b.adapter.start(b.ctx); await a.adapter.dispose(); await b.adapter.dispose(); } finally { await teardown(a.adapter, a.root); await teardown(b.adapter, b.root); } });
test('no active exchange process survives dispose', async () => {
  const a = await setup('pids-a');
  const b = await setup('pids-b');
  try {
    await a.adapter.start(a.ctx);
    await b.adapter.start(b.ctx);
    const exchanges = [a.adapter.send('pids-a', 'sleep'), b.adapter.send('pids-b', 'sleep')];
    const pids = await Promise.all([exchangePid(a.root, 'pids-a'), exchangePid(b.root, 'pids-b')]);
    await Promise.all([a.adapter.dispose(), b.adapter.dispose()]);
    await Promise.all(exchanges);
    for (const pid of pids) assert.equal(alive(pid), false, `child ${pid} survived dispose`);
  } finally {
    await teardown(a.adapter, a.root);
    await teardown(b.adapter, b.root);
  }
});
