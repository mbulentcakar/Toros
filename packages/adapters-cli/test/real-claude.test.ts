/**
 * Integration tests against the REAL Claude binary.
 *
 * The adapter must be proven against Claude's actual stream-json protocol,
 * including continuation by session id. Unattended CI skips the suite, with a
 * visible reason, when its binary or credential marker is absent.
 * TOROS_REAL_TESTS=1 forces execution and retains fail-loud setup behavior.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AdapterContext, SessionAdapter, Workspace } from '@toros/contracts';

import { createClaudeAdapter } from '../src/index.js';
import { REAL_CLAUDE_EXECUTABLE } from './real-binary-paths.js';
import { claudeRealTestPreflight } from './real-test-preflight.js';

const CLAUDE = REAL_CLAUDE_EXECUTABLE;

const TIMEOUT_MS = 180_000;
const REAL_CLAUDE = claudeRealTestPreflight(CLAUDE);
const realClaudeTestOptions = { skip: REAL_CLAUDE.skip };

let root: string;
let workspace: Workspace;
let adapter: SessionAdapter;

function context(sessionId: string, correlationId: string): AdapterContext {
  return {
    job_id: 'real-claude-test',
    session_id: sessionId,
    correlation_id: correlationId,
    workspace,
    signal: new AbortController().signal,
    actor: 'coordinator',
  };
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

describe('claude adapter against the real binary', { timeout: TIMEOUT_MS * 3 }, () => {
  before(async () => {
    if (!REAL_CLAUDE.run) return;
    assert.ok(
      existsSync(CLAUDE),
      `claude.exe not found at ${CLAUDE}. TOROS_REAL_TESTS=1 requires all real-test prerequisites.`,
    );
    root = await mkdtemp(join(tmpdir(), 'toros-realclaude-'));
    workspace = { id: 'test', root };
    adapter = createClaudeAdapter({
      executable: CLAUDE,
      // Keep the protocol test non-mutating and independent of ambient
      // CLAUDE.md files, hooks, plugins, skills, and MCP configuration.
      //
      // `--safe-mode` did this until the CLI removed it; against 2.1.62 it
      // fails the exchange with "unknown option", which is what made these
      // three tests red while STATUS.md still blamed a Codex quota. The
      // isolation is now spelled out: no setting sources at all, and no MCP
      // configuration beyond an explicit --mcp-config, which is not passed.
      // Non-mutating is already covered by sandbox: 'read-only', which the
      // adapter pins to --permission-mode plan.
      args: ['--setting-sources', '', '--strict-mcp-config'],
      sandbox: 'read-only',
      timeout_ms: TIMEOUT_MS,
      output_limit_bytes: 8 * 1024 * 1024,
    });
    await adapter.init();
  });

  after(async () => {
    await adapter?.dispose().catch(() => undefined);
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('send parses assistant text from Claude stream-json', realClaudeTestOptions, async () => {
    await adapter.start(context('s1', 'c1'));
    await adapter.send('s1', 'Reply with the single word ALPHA and do nothing else.');
    const { chunk, cursor } = await readToCompletion('s1');
    assert.match(chunk, /ALPHA/);
    assert.ok(cursor > 0);
  });

  it('a second exchange resumes the Claude conversation', realClaudeTestOptions, async () => {
    const before = await adapter.read('s1', 0);
    await adapter.send('s1', 'What word did you just say? Reply with that word only.');
    const after = await readToCompletion('s1', before.cursor);
    assert.match(after.chunk, /ALPHA/);
  });

  it('keeps the raw Claude JSONL of every exchange for audit', realClaudeTestOptions, async () => {
    const directory = join(workspace.root, 'c1');
    const entries = await readdir(directory);
    const raw = entries.filter((name) => name.startsWith('exchange-') && name.endsWith('.jsonl'));
    assert.equal(raw.length, 2, `expected one raw log per exchange, got ${raw.join(', ')}`);
    const first = await readFile(join(directory, 'exchange-1.jsonl'), 'utf8');
    assert.match(first, /\"type\":\"system\"/);
    assert.match(first, /\"session_id\":/);
  });

  it('stop closes the conversation and refuses a later send', realClaudeTestOptions, async () => {
    await adapter.stop('s1');
    await assert.rejects(() => adapter.send('s1', 'anything'));
  });

  it('interrupt on an idle Claude conversation is a no-op', realClaudeTestOptions, async () => {
    await adapter.start(context('s2', 'c2'));
    await adapter.interrupt('s2');
    await adapter.stop('s2');
  });
});
