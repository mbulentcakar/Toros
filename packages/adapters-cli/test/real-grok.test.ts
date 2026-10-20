import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AdapterContext, SessionAdapter, Workspace } from '@toros/contracts';
import { createGrokAdapter } from '../src/index.js';

const enabled = process.env['TOROS_REAL_TESTS'] === '1';
const executable = join(process.env['USERPROFILE'] ?? '', '.grok', 'bin', 'grok.exe');
let root: string;
let adapter: SessionAdapter;
let workspace: Workspace;

async function answer(sessionId: string, cursor = 0): Promise<{ readonly text: string; readonly cursor: number }> {
  let text = ''; let next = cursor;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await adapter.read(sessionId, next); text += result.chunk; next = result.cursor;
    if (result.exchange_state !== 'running') return { text, cursor: next };
  }
  throw new Error('Grok exchange did not finish');
}

describe('grok adapter against Grok Build', { skip: enabled ? false : 'Set TOROS_REAL_TESTS=1 to run authenticated CLI tests.' }, () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'toros-real-grok-')); workspace = { id: 'real', root };
    adapter = createGrokAdapter({ executable, args: [], sandbox: 'read-only', timeout_ms: 180_000, exchange_timeout_ms: 180_000, read_poll_ms: 2_000, output_limit_bytes: 8 * 1024 * 1024 });
    await adapter.init();
  });
  // maxRetries: on Windows the Grok process tree can hold the session directory
  // for a moment after dispose(), so a bare rmdir races it with EBUSY.
  after(async () => { await adapter?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  it('starts and resumes a real Grok conversation without retaining prompt files', async () => {
    const ctx: AdapterContext = { job_id: 'real-grok', session_id: 'grok', correlation_id: 'grok', workspace, signal: new AbortController().signal, actor: 'coordinator' };
    await adapter.start(ctx); await adapter.send('grok', 'Reply with the single word ALPHA.');
    const first = await answer('grok'); assert.match(first.text, /ALPHA/);
    await adapter.send('grok', 'What word did you just say? Reply with that word only.');
    assert.match((await answer('grok', first.cursor)).text, /ALPHA/);
    assert.equal((await readdir(join(root, 'grok'))).some((name) => name.endsWith('.prompt.txt')), false);
  });
});
