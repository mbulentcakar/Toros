import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A Claude-shaped one-shot JSONL fixture.
 *
 * It deliberately reads stdin to EOF and exits after one answer. The previous
 * line-oriented fixture implemented the imaginary REPL contract that hid the
 * production defect. This fixture speaks the process and output protocol the
 * adapter actually consumes while remaining deterministic and offline.
 */

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const protocolAt = process.argv.indexOf('--fixture-protocol');
const protocol = protocolAt >= 0 ? process.argv[protocolAt + 1] : 'claude';
let message = input.replace(/\r?\n$/, '');

if (protocol === 'gemini') {
  const event = JSON.parse(message) as { readonly message?: { readonly content?: unknown } };
  message = typeof event.message?.content === 'string' ? event.message.content : '';
}
if (protocol === 'grok') {
  const promptAt = process.argv.indexOf('--prompt-file');
  const promptPath = promptAt >= 0 ? process.argv[promptAt + 1] : undefined;
  message = promptPath === undefined ? '' : await readFile(promptPath, 'utf8');
}

const resumeAt = process.argv.indexOf('--resume');
const conversationAt = process.argv.indexOf('--conversation');
const sessionId = resumeAt >= 0 && process.argv[resumeAt + 1] !== undefined
  ? process.argv[resumeAt + 1]!
  : conversationAt >= 0 && process.argv[conversationAt + 1] !== undefined
    ? process.argv[conversationAt + 1]!
    : `fixture-${process.pid}`;

await writeFile(join(process.cwd(), 'exchange.pid'), String(process.pid), 'utf8');
if (protocol === 'gemini') process.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: sessionId })}\n`);
else if (protocol !== 'grok') process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`);

function event(text: string): string {
  if (protocol === 'gemini') return `${JSON.stringify({ event: 'result', result: { conversation_id: sessionId, status: 'SUCCESS', response: text } })}\n`;
  if (protocol === 'grok') {
    // Grok Build 1.0.40 streams the reply as one `text` event per token, with
    // `thought` events interleaved before it and `end` last. Split the answer
    // the way the real CLI does so the adapter is proven to reassemble it.
    const fragments = text.match(/.{1,2}/gs) ?? [];
    const lines = [
      JSON.stringify({ type: 'thought', data: 'thinking' }),
      ...fragments.map((data) => JSON.stringify({ type: 'text', data })),
      JSON.stringify({ type: 'end', sessionId }),
    ];
    return `${lines.join('\n')}\n`;
  }
  return `${JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text }] },
  })}\n`;
}

if (message === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  process.stdout.write(event('awake'));
} else if (message === 'partial' && protocol === 'grok') {
  // Fragments of a reply, then no `end`: what an interrupted Grok leaves behind.
  process.stdout.write(`${JSON.stringify({ type: 'text', data: 'PART' })}\n${JSON.stringify({ type: 'text', data: 'IAL' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
} else if (message === 'argv') {
  process.stdout.write(event(`argv:${process.argv.slice(2).join(' ')}`));
} else if (message === 'cwd') {
  process.stdout.write(event(`cwd:${process.cwd()}`));
} else if (message === 'runtime-path') {
  process.stdout.write(event(process.env['PATH'] ?? ''));
} else if (message === 'pathext') {
  process.stdout.write(event(`pathext:${process.env['PATHEXT'] ?? ''}`));
} else if (message === 'env') {
  process.stdout.write(event(`env:${Object.keys(process.env).sort().join(',')}`));
} else if (message === 'interleave') {
  process.stdout.write(event('out'));
  process.stderr.write(event('err'));
} else if (message === 'utf8') {
  process.stdout.write(event('🙂漢字'));
} else if (message === 'flood') {
  process.stdout.write(event('x'.repeat(100_000)));
} else {
  process.stdout.write(event(message));
}
