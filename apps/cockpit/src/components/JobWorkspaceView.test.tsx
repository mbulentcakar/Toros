import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { resetConfig } from '../api';
import { JobWorkspaceView } from './JobWorkspaceView';

afterEach(() => { cleanup(); resetConfig(); invokeMock.mockReset(); });

describe('job workspace', () => {
  it('keeps supervision, receipts, and findings in one contextual surface', async () => {
    invokeMock.mockImplementation((command: string, args?: { operation?: string; body?: unknown }) => {
      if (command === 'cockpit_status') return Promise.resolve({ approvals_configured: true });
      if (command !== 'node_core_request') return Promise.reject(new Error('unexpected IPC'));
      const body = ({
        job_status: {
          job_id: 'job-1', envelope: { job_id: 'job-1', objective: 'Reconcile the workbook', allowed_capabilities: ['excel.read'], allowed_workspaces: ['work'], acceptance: ['Totals agree'], forbidden: [], max_actions: 8, max_retries: 1, expires_at: '2026-08-24T00:00:00Z' },
          envelope_digest: 'digest', state: 'working', created_at: '2026-08-23T00:00:00Z', updated_at: '2026-08-23T00:00:00Z', actions_used: 1,
        },
        list_activity: { receipts: [{ receipt_id: 'r1', job_id: 'job-1', node_id: 'n', session_id: null, actor: 'hermes', capability: 'excel.read', arguments_normalized: {}, arguments_digest: 'd', decision: { allow: true, reason: 'allowed' }, envelope_digest: 'digest', started_at: '2026-08-23T00:00:00Z', ended_at: '2026-08-23T00:00:01Z', outcome: 'succeeded', artifact_refs: [], finding_refs: [], adapter_fields: {} }], events: [] },
        list_sessions: { sessions: [] },
        operator_findings: { findings: [{ finding_id: 'f1', receipt_id: 'r1', job_id: 'job-1', session_id: null, correlation: 'exact', rule_id: 'safe.read', severity: 'low', title: 'Read inspected', observed_at: '2026-08-23T00:00:01Z', detail: {} }] },
        operator_hermes_status: { run: null },
        operator_conversation: { turns: [] },
        operator_approvals: { pending: [] },
        operator_hermes_start: { run: { run_id: 'run-1', job_id: 'job-1', state: 'running', started_at: '2026-08-23T00:00:02Z', ended_at: null, exit_code: null, messages: [] } },
      } as Record<string, unknown>)[String(args?.operation)] ?? {};
      return Promise.resolve({ status: 200, body });
    });

    render(<JobWorkspaceView jobId="job-1" onBack={() => undefined} />);
    expect(await screen.findByText('Reconcile the workbook')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Hermes' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('node_core_request', { operation: 'operator_hermes_start', body: { job_id: 'job-1' } }));

    fireEvent.click(screen.getByRole('tab', { name: /Activity/ }));
    expect(await screen.findByText('excel.read')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Security/ }));
    expect(await screen.findByText('Read inspected')).toBeTruthy();
  });
});
