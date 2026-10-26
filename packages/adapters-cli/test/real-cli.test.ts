/**
 * Integration tests against the REAL codex binary.
 *
 * These exist because the defect they cover was invisible to every mock: the
 * old adapter and its `echo-cli.mjs` stub agreed with each other, and neither
 * matched the CLI. A stub may not be the only evidence that this adapter
 * works — see `docs/finding-cli-adapter-one-shot.md`.
 *
 * They need an authenticated codex on the machine. Unattended CI skips the
 * suite, with a visible reason, when its binary or credential marker is absent.
 * TOROS_REAL_TESTS=1 forces execution and retains fail-loud setup behavior.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AdapterContext, SessionAdapter, Workspace } from '@toros/contracts';

import { createCodexAdapter } from '../src/index.js';
import { REAL_CODEX_EXECUTABLE } from './real-binary-paths.js';
import { codexRealTestPreflight } from './real-test-preflight.js';

const CODEX = REAL_CODEX_EXECUTABLE;

/** Generous: a real model turn is seconds, but a cold start plus auth is not. */
const TIMEOUT_MS = 180_000;
const REAL_CODEX = codexRealTestPreflight(CODEX);
const realCodexTestOptions = { skip: REAL_CODEX.skip };

let workspace: Workspace;
let adapter: SessionAdapter;

function context(sessionId: string | null, correlationId: string): AdapterContext {
  return {
    job_id: 'real-cli-test',
    session_id: sessionId,
    correlation_id: correlationId,
    workspace,
    signal: new AbortController().signal,
    actor: 'coordinator',
  } as AdapterContext;
}

async function readToCompletion(sessionId: string, cursor = 0): Promise<{ chunk: string; cursor: number }> {
  let chunk = '';
  let next = cursor;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await adapter.read(sessionId, next);
    chunk += result.chunk;
    next = result.cursor;
    if (result.exchange_state !== 'running') {
      assert.equal(result.exchange_state, 'succeeded', `exchange failed: ${result.exchange_error ?? 'unknown'}`);
      return { chunk, cursor: next };
    }
  }
  throw new Error('exchange did not complete');
}

describe('codex adapter against the real binary', { timeout: TIMEOUT_MS * 4 }, () => {
  before(async () => {
    if (!REAL_CODEX.run) return;
    assert.ok(
      existsSync(CODEX),
      `codex.exe not found at ${CODEX}. TOROS_REAL_TESTS=1 requires all real-test prerequisites.`,
    );
    const root = await mkdtemp(join(tmpdir(), 'toros-realcli-'));
    workspace = { id: 'test', root };
    adapter = createCodexAdapter({
      executable: CODEX,
      args: [],
      timeout_ms: TIMEOUT_MS,
      output_limit_bytes: 8 * 1024 * 1024,
    });
    await adapter.init();
  });

  after(async () => {
    await adapter?.dispose().catch(() => undefined);
  });

  it('start opens a conversation without spawning a process', realCodexTestOptions, async () => {
    const result = await adapter.start(context('s1', 'c1'));
    // No process exists between exchanges, and the pid must not claim one.
    assert.equal(result.pid, -1);
  });

  it('send runs the CLI to completion and read returns its answer', realCodexTestOptions, async () => {
    await adapter.send('s1', 'Reply with the single word ALPHA and do nothing else.');
    const { chunk, cursor } = await readToCompletion('s1');
    assert.ok(chunk.includes('ALPHA'), `expected ALPHA in output, got: ${chunk}`);
    assert.ok(cursor > 0);
  });

  it('a second exchange remembers the first', realCodexTestOptions, async () => {
    // The one assertion no mock can fake, and the reason `exec resume` is the
    // continuation mechanism rather than a fresh process each time.
    const before = await adapter.read('s1', 0);
    await adapter.send('s1', 'What word did you just say? Reply with that word only.');
    const after = await readToCompletion('s1', before.cursor);
    assert.ok(after.chunk.includes('ALPHA'), `expected the CLI to recall ALPHA, got: ${after.chunk}`);
  });

  it('the raw JSONL of every exchange is kept for audit', realCodexTestOptions, async () => {
    const entries = await readdir(join(workspace.root, 'c1'));
    const raw = entries.filter((name) => name.startsWith('exchange-') && name.endsWith('.jsonl'));
    assert.equal(raw.length, 2, `expected one raw log per exchange, got ${raw.join(', ')}`);
    const first = await readFile(join(workspace.root, 'c1', 'exchange-1.jsonl'), 'utf8');
    assert.ok(first.includes('thread.started'), 'raw log should contain the CLI event stream');
  });

  it('the CLI can write a file in its session directory', realCodexTestOptions, async () => {
    const before = await adapter.read('s1', 0);
    await adapter.send('s1', 'Create a file named hello-toros.md containing exactly one line: hello from toros. Then stop.');
    await readToCompletion('s1', before.cursor);
    const entries = await readdir(join(workspace.root, 'c1'));
    assert.ok(
      entries.includes('hello-toros.md'),
      `expected hello-toros.md in the session directory, got: ${entries.join(', ')}`,
    );
  });

  it('stop closes the conversation and a later send is refused', realCodexTestOptions, async () => {
    await adapter.stop('s1');
    await assert.rejects(() => adapter.send('s1', 'anything'));
  });

  it('interrupt on an idle conversation is a no-op, not an error', realCodexTestOptions, async () => {
    await adapter.start(context('s2', 'c2'));
    await adapter.interrupt('s2');
    await adapter.stop('s2');
  });
});
