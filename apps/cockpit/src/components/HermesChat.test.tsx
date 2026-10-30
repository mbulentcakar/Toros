import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { resetConfig } from '../api';
import type { ConversationTurn } from '../types';
import { HermesChat } from './HermesChat';

const conversationId = 'c1';

function turn(seq: number, partial: Partial<ConversationTurn>): ConversationTurn {
  return {
    conversation_id: conversationId,
    seq,
    role: 'hermes',
    channel: 'human',
    content: '',
    job_id: null,
    recorded_at: `2026-08-10T00:00:0${seq}.000Z`,
    ...partial,
  };
}

function mockOperator(handler: (operation: string, body: unknown) => unknown, configured = true): void {
  invokeMock.mockImplementation((command: string, args?: { operation?: string; body?: unknown }) => {
    if (command === 'cockpit_status') return Promise.resolve({ approvals_configured: configured });
    if (command !== 'node_core_request' || args?.operation === undefined) return Promise.reject(new Error('unexpected IPC'));
    return Promise.resolve({ status: 200, body: handler(args.operation, args.body) });
  });
}

afterEach(() => {
  cleanup();
  resetConfig();
  invokeMock.mockReset();
});

describe('Hermes chat', () => {
  it('opens a conversation from the first thing the operator says', async () => {
    let turns: ConversationTurn[] = [];
    mockOperator((operation, body) => {
      if (operation === 'operator_catalog') return { capabilities: [], workspaces: ['work'], agents: ['codex', 'gemini', 'grok'], models: [{ id: 'openai/gpt-5.6-terra', label: 'Terra', provider: 'OpenAI' }] };
      if (operation === 'operator_conversations') return { conversations: [] };
      if (operation === 'operator_conversation_create') return {
        conversation_id: conversationId, node_id: 'n', title: 'x',
        created_at: '', updated_at: '', state: 'open',
      };
      if (operation === 'operator_conversation_send') {
        const sent = body as { message: string };
        turns = [turn(1, { role: 'operator', content: sent.message })];
        return {};
      }
      if (operation === 'operator_conversation_turns') return { turns };
      throw new Error(`unexpected operation ${operation}`);
    });

    render(<HermesChat />);
    // No envelope form: the operator is never asked for a capability id here.
    expect(await screen.findByLabelText('Message')).toBeTruthy();
    expect(screen.getByLabelText('Message').closest('.hermes-chat__composer')).toBeTruthy();
    expect(document.querySelector('.hermes-chat__thread')).toBeTruthy();
    expect(screen.getByLabelText('Agent')).toHaveProperty('value', 'codex');
    expect(screen.getByRole('option', { name: 'Gemini (AGY)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Grok' })).toBeTruthy();
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'openai/gpt-5.6-terra');
    expect(screen.queryByLabelText('Allowed capabilities')).toBeNull();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Tidy last quarter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('node_core_request', expect.objectContaining({
      operation: 'operator_conversation_create',
    })));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('node_core_request', {
      operation: 'operator_conversation_send',
      body: { conversation_id: conversationId, message: 'Tidy last quarter', agent: 'codex', model: 'openai/gpt-5.6-terra' },
    }));
    expect(await screen.findByText('Tidy last quarter')).toBeTruthy();
  });

  it('shows a read-only plan and approves only the recorded proposal', async () => {
    const proposal = {
      objective: 'Tidy the Q4 workbook',
      plan: ['Open the Q4 workbook', 'Correct the totals column', 'Verify that the totals reconcile'],
      acceptance: ['totals reconcile'],
      capabilities: [
        { id: 'excel.read', why: 'to read the sheet' },
        { id: 'excel.write', why: 'to correct the totals' },
        { id: 'codex.start', why: 'to open Codex' },
        { id: 'codex.send', why: 'to give Codex the task' },
        { id: 'codex.read', why: 'to read the result' },
        { id: 'codex.stop', why: 'to close Codex' },
      ],
      workspaces: ['work'],
      forbidden: ['push'],
      max_actions: 20,
      max_retries: 2,
      expires_in_hours: 8,
      intent: 'Tidy the totals column only',
      target: 'The Q4 workbook',
      changes: 'Correct totals; leave everything else',
    };
    const agreementDigest = 'a'.repeat(64);
    const turns = [
      turn(1, { role: 'operator', channel: 'human', content: 'Tidy last quarter' }),
      turn(2, { content: JSON.stringify({ ask: '<img src=x onerror=alert(1)> Which workbook?' }) }),
      turn(3, { channel: 'machine', content: JSON.stringify({ propose_job: proposal, agreement_digest: agreementDigest }) }),
    ];
    mockOperator((operation) => {
      if (operation === 'operator_catalog') return { capabilities: [], workspaces: ['work'], agents: ['codex', 'claude'] };
      if (operation === 'operator_conversations') return {
        conversations: [{ conversation_id: conversationId, node_id: 'n', title: 'Tidy', created_at: '', updated_at: '', state: 'open' }],
      };
      if (operation === 'operator_conversation_turns') return { turns };
      if (operation === 'operator_accept_proposal') return { job_id: 'job-9', envelope: {}, state: 'working' };
      if (operation === 'operator_hermes_start') return { run: { run_id: 'run-9', state: 'running' } };
      throw new Error(`unexpected operation ${operation}`);
    });

    const { container } = render(<HermesChat />);

    // Hostile text stays literal, and each requested capability shows its reason.
    expect(await screen.findByText('<img src=x onerror=alert(1)> Which workbook?')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/to correct the totals/)).toBeTruthy();

    expect(screen.getByText('Open the Q4 workbook')).toBeTruthy();
    expect(screen.getByText('Correct the totals column')).toBeTruthy();
    // The three agreement fields are rendered on the card.
    expect(screen.getByText(/Tidy the totals column only/)).toBeTruthy();
    expect(screen.getByText(/The Q4 workbook/)).toBeTruthy();
    expect(screen.getByText(/Correct totals; leave everything else/)).toBeTruthy();
    expect(screen.queryByLabelText('Proposed objective')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const approve = screen.getByRole('button', { name: 'Agree and run' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);

    fireEvent.click(approve);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('node_core_request', expect.objectContaining({
      operation: 'operator_accept_proposal',
    })));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('node_core_request', {
      operation: 'operator_hermes_start',
      body: { job_id: 'job-9' },
    }));
    const call = invokeMock.mock.calls.find(
      (entry) => entry[0] === 'node_core_request' && entry[1]?.operation === 'operator_accept_proposal',
    );
    expect(call![1].body).toEqual({ conversation_id: conversationId, seq: 3, agreement_digest: agreementDigest });
  });

  it('shows a retry control and re-calls startHermes with the same job when the start fails', async () => {
    const proposal = {
      objective: 'Tidy the Q4 workbook',
      plan: ['Open the Q4 workbook'],
      acceptance: ['totals reconcile'],
      capabilities: [{ id: 'codex.start', why: 'to open Codex' }, { id: 'codex.send', why: 'to send' }, { id: 'codex.read', why: 'to read' }, { id: 'codex.stop', why: 'to stop' }],
      workspaces: ['work'],
      forbidden: [],
      max_actions: 5,
      max_retries: 1,
      expires_in_hours: 8,
    };
    const agreementDigest = 'b'.repeat(64);
    const turns = [
      turn(1, { role: 'operator', channel: 'human', content: 'Tidy last quarter' }),
      turn(2, { channel: 'machine', content: JSON.stringify({ propose_job: proposal, agreement_digest: agreementDigest }) }),
    ];
    // accept succeeds; the first start fails, then succeeds on retry.
    let startAttempts = 0;
    mockOperator((operation) => {
      if (operation === 'operator_catalog') return { capabilities: [], workspaces: ['work'], agents: ['codex'] };
      if (operation === 'operator_conversations') return {
        conversations: [{ conversation_id: conversationId, node_id: 'n', title: 'Tidy', created_at: '', updated_at: '', state: 'open' }],
      };
      if (operation === 'operator_conversation_turns') return { turns };
      if (operation === 'operator_accept_proposal') return { job_id: 'job-9', envelope: {}, state: 'working' };
      if (operation === 'operator_hermes_start') {
        startAttempts += 1;
        if (startAttempts === 1) throw new Error('Hermes start failed');
        return { run: { run_id: 'run-9', state: 'running' } };
      }
      throw new Error(`unexpected operation ${operation}`);
    });

    render(<HermesChat />);
    const approve = await screen.findByRole('button', { name: 'Agree and run' });
    fireEvent.click(approve);

    // The banner does NOT claim Hermes started; a Start Hermes control appears.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('node_core_request', { operation: 'operator_hermes_start', body: { job_id: 'job-9' } }));
    const retry = await screen.findByRole('button', { name: 'Start Hermes' });
    expect(screen.queryByText('Job created and Hermes started.')).toBeNull();

    // Clicking it calls startHermes with the same job id.
    fireEvent.click(retry);
    await waitFor(() => expect(invokeMock.mock.calls.filter(
      (entry) => entry[0] === 'node_core_request' && entry[1]?.operation === 'operator_hermes_start',
    )).toHaveLength(2));
    const starts = invokeMock.mock.calls.filter(
      (entry) => entry[0] === 'node_core_request' && entry[1]?.operation === 'operator_hermes_start',
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]![1].body).toEqual({ job_id: 'job-9' });
    expect(starts[1]![1].body).toEqual({ job_id: 'job-9' });
    expect(await screen.findByText('Job created and Hermes started.')).toBeTruthy();
  });

  it('summarises machine turns without hiding their stored content', async () => {
    const turns = [
      turn(1, { role: 'operator', content: 'Inspect the workbook' }),
      turn(2, { channel: 'machine', content: JSON.stringify({ act: { capability: 'excel.read' } }) }),
      turn(3, { content: JSON.stringify({ say: 'The workbook is ready.' }) }),
    ];
    mockOperator((operation) => {
      if (operation === 'operator_conversations') return { conversations: [{ conversation_id: conversationId, node_id: 'n', title: 'Inspect', created_at: '', updated_at: '', state: 'open' }] };
      if (operation === 'operator_conversation_turns') return { turns };
      throw new Error(`unexpected operation ${operation}`);
    });

    render(<HermesChat />);
    const summary = await screen.findByText('Action · act');
    fireEvent.click(summary);
    expect(screen.getByText(/excel\.read/)).toBeTruthy();
  });
});
