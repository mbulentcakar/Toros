import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { bounded, createCoordinatorSupervisor, type CoordinatorRunState } from '../src/coordinator-supervisor.js';

const fixture = fileURLToPath(new URL('./fixture-coordinator.js', import.meta.url));

async function waitForState(
  status: () => CoordinatorRunState | null,
  expected: CoordinatorRunState,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (status() !== expected) {
    if (Date.now() > deadline) assert.fail(`run did not reach ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a clarification reply reaches Hermes over stdin and not process arguments', async (t) => {
  const supervisor = createCoordinatorSupervisor(fixture);
  t.after(() => supervisor.stopAll());

  await supervisor.start('job-1');
  await waitForState(() => supervisor.status('job-1')?.state ?? null, 'waiting_for_input');
  assert.equal(
    supervisor.status('job-1')?.messages.some((message) => message.text.includes('Which bounded option')),
    true,
  );

  const reply = 'Use option B1; keep it bounded.';
  const runToken = 'run-token-should-never-be-visible';
  await supervisor.start('job-1', {
    operator_message: reply,
    run_token: runToken,
    conversation_id: 'conv-1',
  });
  await waitForState(() => supervisor.status('job-1')?.state ?? null, 'finished');
  const messages = supervisor.status('job-1')?.messages ?? [];
  const childArgs = messages.filter((message) => message.role === 'hermes' && message.text.startsWith('args:')).at(-1)?.text ?? '';
  assert.equal(childArgs.includes(reply), false, 'operator text leaked into the process command line');
  assert.equal(childArgs.includes(runToken), false, 'the run credential leaked into the process command line');
  assert.equal(messages.some((message) => message.text === `reply:${reply}`), true);
  assert.equal(
    messages.some((message) => message.text === 'context:{"has_run_token":true,"has_conversation":true}'),
    true,
    'the run reached its child over stdin',
  );
});

test('one job cannot have two running Hermes processes and stop leaves it resumable', async (t) => {
  const supervisor = createCoordinatorSupervisor(fixture);
  t.after(() => supervisor.stopAll());

  await supervisor.start('slow-job');
  await assert.rejects(supervisor.start('slow-job'), /already running/);
  const stopped = await supervisor.stop('slow-job');
  assert.equal(stopped?.state, 'stopped');
});

test('each run owns its own messages array; a later run is not polluted by an earlier one', async (t) => {
  const supervisor = createCoordinatorSupervisor(fixture);
  t.after(() => supervisor.stopAll());

  const first = await supervisor.start('job-1');
  await waitForState(() => supervisor.status('job-1')?.state ?? null, 'waiting_for_input');
  assert.ok((supervisor.status('job-1')?.messages.length ?? 0) > 0);

  const second = await supervisor.start('job-1', { operator_message: 'Use option B1.' });
  assert.notEqual(second.run_id, first.run_id);
  await waitForState(() => supervisor.status('job-1')?.state ?? null, 'finished');
  const messages = supervisor.status('job-1')?.messages ?? [];
  assert.equal(messages.some((message) => message.text === 'Which bounded option should I use?'), false);
});

test('stop awaits the child exit and does not resolve when kill is sent', async (t) => {
  const supervisor = createCoordinatorSupervisor(fixture);
  t.after(() => supervisor.stopAll());

  await supervisor.start('slow-job');
  let resolved = false;
  const stopPromise = supervisor.stop('slow-job').then((run) => { resolved = true; return run; });
  await Promise.resolve();
  assert.equal(resolved, false, 'stop resolved before the child process exited');
  const stopped = await stopPromise;
  assert.equal(stopped?.state, 'stopped');
});

test('stopAll awaits every child exit and does not resolve when kills are sent', async (t) => {
  const supervisor = createCoordinatorSupervisor(fixture);
  t.after(() => supervisor.stopAll());

  await supervisor.start('slow-job-a');
  await supervisor.start('slow-job-b');
  let resolved = false;
  const stopAllPromise = supervisor.stopAll().then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false, 'stopAll resolved before the child processes exited');
  await stopAllPromise;
});

test('message truncation does not split multi-byte characters', () => {
  const char = 'あ'; // 3 bytes in UTF-8
  const text = char.repeat(3_000); // 9000 bytes > 8192
  const truncated = bounded(text);
  assert.ok(Buffer.byteLength(truncated) <= 8192 + Buffer.byteLength('\n...[truncated]'));
  assert.ok(truncated.endsWith('\n...[truncated]'));
  // The character immediately before the truncation suffix must be a complete character.
  const prefix = truncated.slice(0, -'\n...[truncated]'.length);
  assert.ok(prefix.length > 0);
  assert.doesNotMatch(prefix, /\ufffd$/);
});

test('the runs map evicts old finished runs once the cap is exceeded', async (t) => {
  const supervisor = createCoordinatorSupervisor(fixture);
  t.after(() => supervisor.stopAll());

  await supervisor.start('job-cap-0');
  await waitForState(() => supervisor.status('job-cap-0')?.state ?? null, 'waiting_for_input');

  for (let i = 1; i < 65; i += 1) {
    await supervisor.start(`job-cap-${i}`);
  }
  for (let i = 0; i < 65; i += 1) {
    await waitForState(() => supervisor.status(`job-cap-${i}`)?.state ?? null, 'waiting_for_input');
  }

  assert.equal(supervisor.status('job-cap-0'), null, 'oldest finished run was not evicted');
  assert.notEqual(supervisor.status('job-cap-64'), null, 'newest finished run was evicted too early');
});

test('a supervisor whose child exits normally leaves no pending stop timers', async (t) => {
  const supervisor = createCoordinatorSupervisor(fixture);
  t.after(() => supervisor.stopAll());

  await supervisor.start('job-exit');
  await waitForState(() => supervisor.status('job-exit')?.state ?? null, 'waiting_for_input');
  // The fixture co-ordinator writes a final line and exits cleanly on SIGTERM.
  // After stopAll resolves, there should be no active timers keeping the loop alive.
  await supervisor.stopAll();
  await new Promise((resolve) => setImmediate(resolve));
  const handles = process.getActiveResourcesInfo();
  const activeTimers = handles.filter((info) => info === 'Timeout');
  assert.equal(activeTimers.length, 0, 'stopAll left active timers running');
});

test('message truncation is fast for a very long single-line message', () => {
  const char = 'x'; // 1 byte in UTF-8
  const text = char.repeat(1_100_000); // > 1 MiB
  const before = process.hrtime.bigint();
  const truncated = bounded(text);
  const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
  assert.ok(elapsedMs < 50, `truncation took ${elapsedMs} ms`);
  assert.ok(Buffer.byteLength(truncated) <= 8192 + Buffer.byteLength('\n...[truncated]'));
  assert.ok(truncated.endsWith('\n...[truncated]'));
});
