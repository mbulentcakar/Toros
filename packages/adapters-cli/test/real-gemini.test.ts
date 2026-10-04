import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AdapterContext, SessionAdapter, Workspace } from '@toros/contracts';
import { createGeminiAdapter } from '../src/index.js';

const enabled = process.env['TOROS_REAL_TESTS'] === '1';
const executable = join(process.env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'wsl.exe');
let root: string;
let adapter: SessionAdapter;
let workspace: Workspace;

async function answer(sessionId: string, cursor = 0): Promise<{ readonly text: string; readonly cursor: number }> {
  let text = ''; let next = cursor;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await adapter.read(sessionId, next); text += result.chunk; next = result.cursor;
    if (result.exchange_state !== 'running') return { text, cursor: next };
  }
  throw new Error('Gemini exchange did not finish');
}

describe('gemini adapter against Antigravity CLI', { skip: enabled ? false : 'Set TOROS_REAL_TESTS=1 to run authenticated CLI tests.' }, () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'toros-real-gemini-')); workspace = { id: 'real', root };
    adapter = createGeminiAdapter({ executable, launcher_args: ['-e', '/snap/bin/agy'], args: ['--model', 'gemini-3.8-flash-low'], timeout_ms: 180_000, exchange_timeout_ms: 180_000, read_poll_ms: 2_000, output_limit_bytes: 8 * 1024 * 1024 });
    await adapter.init();
  });
  after(async () => { await adapter?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  it('starts and resumes a real Gemini conversation', async () => {
    const ctx: AdapterContext = { job_id: 'real-gemini', session_id: 'gemini', correlation_id: 'gemini', workspace, signal: new AbortController().signal };
    await adapter.start(ctx); await adapter.send('gemini', 'Reply with the single word ALPHA.');
    const first = await answer('gemini'); assert.match(first.text, /ALPHA/);
    await adapter.send('gemini', 'What word did you just say? Reply with that word only.');
    assert.match((await answer('gemini', first.cursor)).text, /ALPHA/);
  });
});
