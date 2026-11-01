import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ErrorCode, TorosError, type JsonValue, type Workspace } from '@toros/contracts';
import { openStore } from '@toros/store';

import { agreementDigest, createDraftService, redactProposal } from '../src/draft.js';

const workspaces: readonly Workspace[] = [{ id: 'work', root: '/tmp' }];

test('a capability unregistered between proposal and accept is refused with E_SCHEMA, not E_NOT_REGISTERED', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-draft-unregister-'));
  const store = await openStore({ path: join(dir, 'node.sqlite'), nodeId: 'node' });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

  // The registry is a function in the draft service's deps, so this route-level
  // test can change what it returns between the proposal and the accept.
  let registered: readonly string[] = ['mock.run'];
  const draft = createDraftService({
    node_id: 'node',
    workspaces,
    registeredCapabilities: () => registered,
    store: () => store,
    redactSecrets: (content) => content,
  });

  const conversation = await store.createConversation({ conversation_id: 'c1', node_id: 'node', title: 't', state: 'open' });
  assert.equal(conversation.conversation_id, 'c1');

  // Propose exactly as the propose_job route does, with the capability still
  // registered, and record the immutable turn.
  const proposal = draft.validateDraft({
    objective: 'Do the bounded thing',
    plan: ['Run the bounded operation'],
    acceptance: ['done'],
    capabilities: [{ id: 'mock.run', why: 'to do it' }],
    workspaces: ['work'],
    forbidden: [],
    max_actions: 2,
    max_retries: 1,
    expires_in_hours: 8,
  });
  const redacted = redactProposal(proposal, (content) => content);
  const agreement_digest = agreementDigest(redacted);
  const turn = await store.appendTurn({
    conversation_id: 'c1', role: 'hermes', channel: 'machine',
    content: JSON.stringify({ propose_job: redacted, agreement_digest }),
    job_id: null,
  });
  const seq = turn.seq;

  // While registered, the accept path re-validates cleanly.
  const live = await draft.liveProposal('c1', seq);
  assert.equal(live.agreement_digest, agreement_digest);

  // The capability is unregistered after the proposal was recorded.
  registered = [];

  // The accept path must refuse with the "proposal changed" E_SCHEMA, not the
  // raw E_NOT_REGISTERED, and it must not seal a job.
  await assert.rejects(
    () => draft.liveProposal('c1', seq),
    (error: unknown) => {
      assert(error instanceof TorosError, `expected a TorosError, got ${String(error)}`);
      assert.equal(error.code, ErrorCode.E_SCHEMA, `expected E_SCHEMA, got ${error.code}`);
      assert.equal(error.message, 'the proposal changed; review it again');
      return true;
    },
  );
  assert.equal((await store.listJobs()).length, 0);
});

test('liveProposal still surfaces E_SCHEMA for a non-proposal or stale turn', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toros-draft-stale-'));
  const store = await openStore({ path: join(dir, 'node.sqlite'), nodeId: 'node' });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const draft = createDraftService({
    node_id: 'node',
    workspaces,
    registeredCapabilities: () => ['mock.run'],
    store: () => store,
    redactSecrets: (content) => content,
  });
  await store.createConversation({ conversation_id: 'c1', node_id: 'node', title: 't', state: 'open' });

  // A conversation with no machine proposal has nothing to accept.
  await assert.rejects(
    () => draft.liveProposal('c1', 0),
    (error: unknown) => error instanceof TorosError && error.code === ErrorCode.E_SCHEMA,
  );
});