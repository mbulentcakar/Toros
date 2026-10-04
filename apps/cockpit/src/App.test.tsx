/**
 * Acceptance tests for the cockpit.
 *
 * All 10 tests from J-cockpit.md, plus component and integration tests.
 * Tests run through vitest with jsdom.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { ApiError, getJob, resetConfig, resolveConfig } from './api';
import { CorrelationBadge } from './components/CorrelationBadge';
import { ChainStatus } from './components/ChainStatus';
import { ReceiptList } from './components/ReceiptList';
import { JobDetailView } from './components/JobDetailView';
import { ApprovalsView } from './components/ApprovalsView';
import { ActivityView } from './components/ActivityView';
import { CheckpointsRelayView } from './components/CheckpointsRelayView';
import { FindingsView } from './components/FindingsView';
import { JobsView } from './components/JobsView';
import { SessionsView } from './components/SessionsView';
import { StageGraphsView } from './components/StageGraphsView';
import { BrowserAcquisitionsView } from './components/BrowserAcquisitionsView';
import { InboxView } from './components/InboxView';
import { App } from './App';
import type { CockpitOverview } from './useCockpitOverview';

import type {
  ApprovalRequest,
  ChainVerification,
  CorrelationConfidence,
  Receipt,
  FindingRecord,
  JobRecord,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a component and return the container. */
function mount(component: ReactElement): HTMLElement {
  const { container } = render(component);
  return container;
}

interface InvokeArguments {
  readonly operation?: string;
  readonly body?: unknown;
}

type OperationResult = { readonly status: number; readonly body: unknown };

function mockInvoke(
  handler: (operation: string, body: unknown) => OperationResult | Promise<OperationResult>,
  approvalsConfigured = true,
): void {
  invokeMock.mockImplementation((command: string, args?: InvokeArguments) => {
    if (command === 'cockpit_status') {
      return Promise.resolve({ approvals_configured: approvalsConfigured });
    }
    if (command === 'node_core_request' && args?.operation !== undefined) {
      return Promise.resolve(handler(args.operation, args.body));
    }
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  });
}

function mockNodeCoreOk(data: unknown, approvalsConfigured = true): void {
  mockInvoke(() => ({ status: 200, body: data }), approvalsConfigured);
}

function mockNodeCoreError(status: number, body: unknown = ''): void {
  mockInvoke(() => ({ status, body }));
}

function pendingApproval(argumentsValue: ApprovalRequest['arguments']): ApprovalRequest {
  return {
    approval_id: 'approval-1',
    binding: {
      job_id: 'job-approval-1',
      capability: 'pilot_app.export',
      arguments_digest: 'digest-approval-1',
    },
    arguments: argumentsValue,
    requested_at: '2026-08-06T12:00:00.000Z',
    expires_at: '2026-08-06T12:05:00.000Z',
    approved: false,
  };
}

// ---------------------------------------------------------------------------
// After each test
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  invokeMock.mockReset();
  resetConfig();
});

// ===========================================================================
// Test 1: renders the four correlation confidences distinguishably
// ===========================================================================

describe('test 1 — correlation confidence', () => {
  const confidences: CorrelationConfidence[] = ['exact', 'cited', 'session', 'none'];

  for (const confidence of confidences) {
    it(`renders ${confidence} with a distinct representation`, () => {
      const container = mount(
        <CorrelationBadge confidence={confidence} receiptId={confidence === 'exact' ? 'rec-1' : null} />,
      );

      const badge = container.querySelector('.correlation-badge');
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute('data-confidence')).toBe(confidence);

      // Each confidence has a distinct class
      expect(badge!.classList.contains(`correlation-badge--${confidence}`)).toBe(true);

      // session and none have the 'weak' class
      if (confidence === 'session' || confidence === 'none') {
        expect(badge!.classList.contains('correlation-badge--weak')).toBe(true);
      } else {
        expect(badge!.classList.contains('correlation-badge--weak')).toBe(false);
      }
    });
  }

  it('renders all four badges with different text labels', () => {
    const labels: Record<CorrelationConfidence, string> = {
      exact: 'Exact',
      cited: 'Cited',
      session: 'Session-level',
      none: 'Uncorrelated',
    };

    for (const confidence of confidences) {
      const { container } = render(
        <CorrelationBadge confidence={confidence} receiptId={null} />,
      );
      expect(container.textContent).toContain(labels[confidence]);
    }
  });
});

// ===========================================================================
// Test 2: does not present a session-grade finding as attached to an action
// ===========================================================================

describe('test 2 — session-grade finding not attached to action', () => {
  it('renders session-grade finding without action attachment', () => {
    const container = mount(
      <CorrelationBadge confidence="session" receiptId={null} />,
    );

    const badge = container.querySelector('.correlation-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('not attached to a specific action');
  });

  it('renders uncorrelated finding without action attachment', () => {
    const container = mount(
      <CorrelationBadge confidence="none" receiptId={null} />,
    );

    const badge = container.querySelector('.correlation-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('not attached to a specific action');
  });

  it('renders exact finding with action attachment', () => {
    const container = mount(
      <CorrelationBadge confidence="exact" receiptId="rec-1" />,
    );

    const badge = container.querySelector('.correlation-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('attached to action');
  });
});

// ===========================================================================
// Test 3: renders a truncated chain as truncated, not as valid
// ===========================================================================

describe('test 3 — truncated chain', () => {
  it('renders tail truncation when anchor_matches is false with broken_at_seq null', () => {
    // The REAL truncation signature. `verifyChain` computes
    // `ok = broken_at_seq === null && anchor_matches`, so the `ok: true` this
    // used to pass could never come out of the store — the test exercised a
    // component path that cannot occur and said nothing about the one that
    // does. Every surviving row links correctly (broken_at_seq null) but rows
    // are missing from the end (anchor_matches false), so ok is false.
    const verification: ChainVerification = {
      ok: false,
      rows_checked: 10,
      broken_at_seq: null,
      anchor_matches: false,
      reason: null,
    };

    const container = mount(<ChainStatus verification={verification} nodeId="node-1" />);

    // Must say "truncated" in those words
    expect(container.textContent).toMatch(/truncated/i);
    expect(container.querySelector('[data-chain="truncated"]')).not.toBeNull();
    // Must NOT show a green "valid" indicator
    expect(container.querySelector('[data-chain="valid"]')).toBeNull();
  });

  it('renders valid chain correctly', () => {
    const verification: ChainVerification = {
      ok: true,
      rows_checked: 10,
      broken_at_seq: null,
      anchor_matches: true,
      reason: null,
    };

    const container = mount(<ChainStatus verification={verification} nodeId="node-1" />);

    expect(container.querySelector('[data-chain="valid"]')).not.toBeNull();
    expect(container.textContent).toContain('Chain verified');
  });

  it('renders broken chain correctly', () => {
    const verification: ChainVerification = {
      ok: false,
      rows_checked: 5,
      broken_at_seq: 3,
      anchor_matches: false,
      reason: 'hash mismatch at seq 3',
    };

    const container = mount(<ChainStatus verification={verification} nodeId="node-1" />);

    expect(container.querySelector('[data-chain="broken"]')).not.toBeNull();
    expect(container.textContent).toContain('broken at seq 3');
  });
});

// ===========================================================================
// Test 4: renders a denied action with the same prominence as a successful one
// ===========================================================================

describe('test 4 — denied action prominence', () => {
  const succeededReceipt: Receipt = {
    receipt_id: 'rec-suc',
    job_id: 'job-1',
    node_id: 'node-1',
    session_id: null,
    actor: 'model-1',
    capability: 'codex.send',
    arguments_normalized: null,
    arguments_digest: 'abc',
    decision: { allow: true, reason: 'allowed' },
    envelope_digest: 'digest-1',
    started_at: '2026-01-01T00:00:00Z',
    ended_at: '2026-01-01T00:01:00Z',
    outcome: 'succeeded',
    artifact_refs: [],
    finding_refs: [],
    adapter_fields: { conversation_id: 'thread-1', exchange: 1 },
  };

  const deniedReceipt: Receipt = {
    receipt_id: 'rec-den',
    job_id: 'job-1',
    node_id: 'node-1',
    session_id: null,
    actor: 'model-1',
    capability: 'pilot_app.export',
    arguments_normalized: null,
    arguments_digest: 'def',
    decision: { allow: false, code: 'E_CAP_NOT_ALLOWED', reason: 'capability not allowed' },
    envelope_digest: 'digest-1',
    started_at: '2026-01-01T00:02:00Z',
    ended_at: '2026-01-01T00:02:01Z',
    outcome: 'denied',
    artifact_refs: [],
    finding_refs: [],
    adapter_fields: {},
  };

  it('renders the denied row with full prominence', () => {
    const container = mount(
      <ReceiptList receipts={[succeededReceipt, deniedReceipt]} />,
    );

    // Both rows exist
    const deniedRow = container.querySelector('[data-receipt-id="rec-den"]');
    const succeededRow = container.querySelector('[data-receipt-id="rec-suc"]');

    expect(deniedRow).not.toBeNull();
    expect(succeededRow).not.toBeNull();
    expect(succeededRow!.querySelector('.receipt-row__adapter-fields')?.textContent)
      .toContain('"conversation_id":"thread-1"');


    // Denied row has the receipt-row--denied class (prominent red border, full opacity)
    expect(deniedRow!.classList.contains('receipt-row--denied')).toBe(true);

    // Denied row must NOT have any muted/dimmed class that would reduce prominence
    expect(deniedRow!.className).not.toMatch(/muted|dimmed|dim/);

    // The outcome badge for denied is present and prominent
    const outcomeBadge = deniedRow!.querySelector('.outcome--denied');
    expect(outcomeBadge).not.toBeNull();
    expect(outcomeBadge!.textContent).toBe('Denied');
  });

  it('renders the denied receipt outcome as prominently as the succeeded one', () => {
    const container = mount(
      <ReceiptList receipts={[succeededReceipt, deniedReceipt]} />,
    );

    const deniedRow = container.querySelector('[data-receipt-id="rec-den"]') as HTMLElement;

    // Both rows are visible — no opacity reduction on the denied row
    // (jsdom doesn't compute styles from CSS, but we can check that the
    // denied row has full opacity from the inline style or computed style)
    expect(deniedRow.style.opacity).not.toBe('0');
    expect(deniedRow.style.opacity).not.toBe('0.5');

    // The outcome--denied badge has opacity 1
    const deniedBadge = deniedRow.querySelector('.outcome--denied') as HTMLElement;
    expect(deniedBadge).not.toBeNull();
    expect(deniedBadge.style.opacity).not.toBe('0');
  });
});

// ===========================================================================
// Test 5: offers no control that sets accepted
// ===========================================================================

describe('test 5 — no accepted control', () => {
  it('renders a job detail view with no accept control', async () => {
    const job: JobRecord = {
      job_id: 'job-1',
      envelope: {
        job_id: 'job-1',
        objective: 'Test objective',
        allowed_capabilities: ['codex.send'],
        allowed_workspaces: ['ws-1'],
        acceptance: ['criteria met'],
        forbidden: ['push'],
        max_actions: 10,
        max_retries: 2,
        expires_at: '2026-12-31T23:59:59Z',
      },
      envelope_digest: 'digest-1',
      state: 'proposed',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T01:00:00Z',
      actions_used: 5,
    };

    mockNodeCoreOk(job);

    const { container } = render(<JobDetailView jobId="job-1" />);

    // Wait for the view to render the job data
    const detail = await screen.findByText('Test objective', {}, { timeout: 2000 });
    expect(detail).not.toBeNull();

    // Assert no button with "Accept" text (case-insensitive)
    const buttons = container.querySelectorAll('button');
    for (const button of buttons) {
      expect(button.textContent).not.toMatch(/accept/i);
    }

    // Assert no element with data-set-state="accepted"
    expect(container.querySelector('[data-set-state="accepted"]')).toBeNull();
  });
});

// ===========================================================================
// Test 6: escapes a job objective containing HTML
// ===========================================================================

describe('test 6 — job objective HTML escape', () => {
  it('renders an HTML-containing objective literally and creates no <img> element', async () => {
    const jobs: JobRecord[] = [
      {
        job_id: 'job-1',
        envelope: {
          job_id: 'job-1',
          objective: '<img src=x onerror=alert(1)>',
          allowed_capabilities: [],
          allowed_workspaces: [],
          acceptance: [],
          forbidden: [],
          max_actions: 10,
          max_retries: 2,
          expires_at: '2026-12-31T23:59:59Z',
        },
        envelope_digest: 'digest-1',
        state: 'working',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        actions_used: 0,
      },
    ];

    // Dispatch on the tool name rather than call order: the view's request
    // sequence is an implementation detail, and an order-dependent mock fed
    // the activity payload in as the job and blew up on job.envelope.
    mockInvoke((operation) => {
      const body = operation === 'job_status'
        ? jobs[0]
        : { receipts: [], events: [] };
      return { status: 200, body };
    });

    // Job detail is backed by job_status({ job_id }); the bulk Jobs view is
    // intentionally unavailable because Node Core has no list-all-jobs tool.
    const { container } = render(<JobDetailView jobId="job-1" />);

    // Wait for the view to render the job data
    const text = await screen.findByText(/<img src=x onerror=alert\(1\)>/);
    expect(text).not.toBeNull();

    // React escapes by default — no <img> element should be created
    expect(container.querySelector('img')).toBeNull();

    // The literal text is present
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
// ===========================================================================
// Test 7: findings come from the operator surface and remain escaped
// ===========================================================================

describe('test 7 — operator findings', () => {
  it('requests one job, renders Numbat fields, and escapes a hostile title', async () => {
    const finding: FindingRecord = {
      finding_id: 'finding-1',
      receipt_id: 'receipt-1',
      job_id: 'job-1',
      session_id: 'session-1',
      correlation: 'exact',
      rule_id: 'secrets.agent_read_env',
      severity: 'medium',
      title: '<img src=x onerror=alert(1)>',
      observed_at: '2026-08-09T00:00:00.000Z',
      detail: { source: 'numbat' },
    };
    mockInvoke((operation) => operation === 'operator_findings'
      ? { status: 200, body: { findings: [finding] } }
      : { status: 404, body: { error: 'Not found' } });

    const { container } = render(<FindingsView />);
    fireEvent.change(screen.getByLabelText('Job ID'), { target: { value: 'job-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show findings' }));

    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('secrets.agent_read_env')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('Exact')).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith('node_core_request', {
      operation: 'operator_findings',
      body: { job_id: 'job-1' },
    });
  });
});
// ===========================================================================
// Test 8: never renders the bearer token
// ===========================================================================

describe('test 8 — bearer tokens never cross into the WebView', () => {
  // This test used to declare two token strings, never introduce them anywhere,
  // and assert they did not appear. Both assertions were true of any string the
  // test happened to invent, and would have held even if Rust leaked a real
  // credential — the mock was independent of the implementation.
  //
  // The property that IS testable on this side of the IPC boundary: if the Rust
  // side ever hands the WebView something credential-shaped, the client must
  // neither render it nor send it back. So the token is INJECTED into the
  // mocked IPC responses, and the assertions are about what the client then
  // does with it. The Rust-side guarantee — that no token is serialised at all
  // — is asserted where it lives, in src-tauri's unit tests.
  it('does not render or re-transmit a credential even if one is handed to it', async () => {
    const leakedToken = 'super-secret-bearer-token-that-should-never-surface';

    // A hostile or regressed Rust side: both IPC responses carry a credential.
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cockpit_status') {
        return Promise.resolve({ approvals_configured: true, token: leakedToken });
      }
      return Promise.resolve({ status: 200, body: { token: leakedToken, receipts: [], events: [] } });
    });

    const { JobsView } = await import('./components/JobsView');
    const { container } = render(<JobsView />);
    await screen.findByText('There are no local jobs.', {}, { timeout: 2000 });

    await resolveConfig();
    await getJob('job-1');

    // Not rendered.
    expect(container.innerHTML).not.toContain(leakedToken);
    // Not sent back out. Every argument object the client passed to invoke is
    // checked, so a client that echoed the response into a later call fails.
    const outboundArguments = JSON.stringify(invokeMock.mock.calls.map((call) => call[1]));
    expect(outboundArguments).not.toContain(leakedToken);
  });
});

// ===========================================================================
// Test 9: sends the Authorization header and does not set an Origin header
// ===========================================================================

describe('test 9 — allowlisted operation transport', () => {
  it('names a tool operation and sends only its body through Tauri IPC', async () => {
    mockNodeCoreOk({ job_id: 'job-1' });

    await getJob('job-1');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('node_core_request', {
      operation: 'job_status',
      body: { job_id: 'job-1' },
    });
  });

  it('never calls browser fetch while rendering every view', async () => {
    const fetch = vi.fn(() => { throw new Error('browser fetch must not be called'); });
    vi.stubGlobal('fetch', fetch);
    mockInvoke((operation) => operation === 'job_status'
      ? { status: 200, body: {
          job_id: 'job-1',
          envelope: {
            job_id: 'job-1', objective: 'Transport test', allowed_capabilities: [],
            allowed_workspaces: [], acceptance: [], forbidden: [], max_actions: 1,
            max_retries: 0, expires_at: '2026-12-31T23:59:59Z',
          },
          envelope_digest: 'digest-1', state: 'working',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          actions_used: 0,
        } }
      : operation === 'list_activity'
        ? { status: 200, body: { receipts: [], events: [] } }
        : { status: 200, body: { pending: [] } });

    const staticViews: ReactElement[] = [
      <JobsView key="jobs" />,
      <SessionsView key="sessions" />,
      <ActivityView key="activity" />,
      <CheckpointsRelayView key="checkpoints" />,
      <FindingsView key="findings" />,
    ];
    for (const view of staticViews) {
      const rendered = render(view);
      rendered.unmount();
    }
    const approvals = render(<ApprovalsView />);
    await screen.findByText('There are no pending approvals.');
    approvals.unmount();
    const jobDetail = render(<JobDetailView jobId="job-1" />);
    await screen.findByText('Transport test');
    jobDetail.unmount();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves a non-2xx response status in ApiError', async () => {
    mockNodeCoreError(403, { error: 'Forbidden' });

    const error = await getJob('job-1').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403 });
  });

});

// ===========================================================================
// Test 10: surfaces a 401 as an authentication problem, not an empty view
// ===========================================================================

describe('test 10 — 401 authentication problem', () => {
  it('shows an authentication error message on 401, not an empty table', async () => {
    mockNodeCoreError(401, { error: 'Unauthorized' });

    // JobsView no longer issues a request — Node Core has no list-all-jobs
    // tool, so it is an honest empty state and can never surface a 401. Use a
    // view that actually calls the service.
    render(<JobDetailView jobId="job-1" />);

    // Wait for the error state to appear
    const authError = await screen.findByText('Authentication failed', {}, { timeout: 2000 });
    expect(authError).not.toBeNull();

    // Must mention "bearer token" in the context
    expect(screen.getByText(/bearer token/i)).not.toBeNull();

    // Must NOT show an empty table (no "No jobs found" message)
    expect(screen.queryByText('No jobs found.')).toBeNull();
  });
});

// ===========================================================================
// Tests 11–17: operator approvals
// ===========================================================================

describe('test 11 — pending approval detail', () => {
  it('renders the capability, full arguments, job, request time, and expiry', async () => {
    const approval = pendingApproval({ workbook: 'Forecast.xlsx', sheet: 'Summary', cells: ['A1', 'B2'] });
    mockNodeCoreOk({ pending: [approval] });

    render(<ApprovalsView />);

    expect(await screen.findByText('pilot_app.export')).toBeTruthy();
    expect(screen.getByText(/"workbook": "Forecast\.xlsx"/)).toBeTruthy();
    expect(screen.getByText(/"sheet": "Summary"/)).toBeTruthy();
    expect(screen.getByText('job-approval-1')).toBeTruthy();
    expect(screen.getByText('2026-08-06T12:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('2026-08-06T12:05:00.000Z')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve and resume' })).toBeTruthy();
  });
});

describe('test 12 — approval arguments HTML escape', () => {
  it('renders hostile argument text literally without creating an element', async () => {
    const approval = pendingApproval({ formula: '<img src=x onerror=alert(1)>' });
    mockNodeCoreOk({ pending: [approval] });

    const { container } = render(<ApprovalsView />);

    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('test 13 — approvals unconfigured', () => {
  it('renders the unconfigured state and makes no request', async () => {
    mockNodeCoreOk({ pending: [] }, false);

    render(<ApprovalsView />);

    expect(await screen.findByText('Approvals are not configured on this node.')).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith('cockpit_status');
    expect(invokeMock).not.toHaveBeenCalledWith('node_core_request', expect.anything());
  });

  it('shows a rejected IPC request as unavailable and offers the fixed start command', async () => {
    invokeMock.mockImplementation((command: string) => command === 'start_node_core'
      ? Promise.resolve()
      : Promise.reject(new Error('Node Core request could not be completed')));

    render(<JobDetailView jobId="job-1" />);

    expect(await screen.findByText('Could not reach Node Core')).toBeTruthy();
    expect(screen.queryByText('Authentication failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start Node Core' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('start_node_core'));
  });

  it('refreshes the operator home after Node Core starts', async () => {
    let running = false;
    invokeMock.mockImplementation((command: string, args?: InvokeArguments) => {
      if (command === 'cockpit_status') return Promise.resolve({ approvals_configured: true });
      if (command === 'start_node_core') { running = true; return Promise.resolve(); }
      if (command === 'node_core_request') {
        if (!running) return Promise.reject(new Error('Node Core request could not be completed'));
        const body = ({
          operator_jobs: { jobs: [] },
          operator_pipelines: { pipelines: [] },
          operator_browser_acquisitions: { acquisitions: [] },
          operator_browser_status: { worker: { connected: false, tab: null, allowed_domains: [] } },
          operator_catalog: { capabilities: [], workspaces: [] },
          operator_approvals: { pending: [] },
        } as Record<string, unknown>)[String(args?.operation)];
        return Promise.resolve({ status: 200, body: body ?? {} });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(<App />);
    expect(await screen.findByText('Could not reach Node Core')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Node Core' }));

    await waitFor(() => expect(screen.queryByText('Could not reach Node Core')).toBeNull());
    expect(invokeMock.mock.calls.filter((call) => call[0] === 'node_core_request' && call[1]?.operation === 'operator_jobs')).toHaveLength(2);
  });});

describe('test 14 — approvals empty', () => {
  it('distinguishes configured with nothing pending from unconfigured', async () => {
    mockNodeCoreOk({ pending: [] });

    render(<ApprovalsView />);

    expect(await screen.findByText('There are no pending approvals.')).toBeTruthy();
    expect(screen.queryByText('Approvals are not configured on this node.')).toBeNull();
  });
});

describe('test 15 — grant uses operator credential', () => {
  it('uses operator operations for listing and granting', async () => {
    const approval = pendingApproval({ action: 'export' });
    let approved = false;
    mockInvoke((operation) => {
      if (operation === 'operator_approve') {
        approved = true;
        return { status: 200, body: approval };
      }
      if (operation === 'operator_hermes_start') return { status: 200, body: { run: {} } };
      return { status: 200, body: { pending: approved ? [] : [approval] } };
    });

    render(<ApprovalsView />);
    await screen.findByRole('button', { name: 'Approve and resume' });
    screen.getByRole('button', { name: 'Approve and resume' }).click();
    await waitFor(() => expect(screen.getByText('There are no pending approvals.')).toBeTruthy());

    expect(invokeMock).toHaveBeenCalledWith('node_core_request', {
      operation: 'operator_approvals',
      body: {},
    });
    expect(invokeMock).toHaveBeenCalledWith('node_core_request', {
      operation: 'operator_approve',
      body: { approval_id: 'approval-1' },
    });
    expect(invokeMock).toHaveBeenCalledWith('node_core_request', {
      operation: 'operator_hermes_start',
      body: { job_id: 'job-approval-1', approval_id: 'approval-1' },
    });
  });
});

describe('test 16 — failed grant', () => {
  it('surfaces the error and keeps the approval row', async () => {
    const approval = pendingApproval({ action: 'export' });
    mockInvoke((operation) => operation === 'operator_approve'
      ? { status: 500, body: 'audit failed' }
      : { status: 200, body: { pending: [approval] } });

    render(<ApprovalsView />);
    await screen.findByRole('button', { name: 'Approve and resume' });
    screen.getByRole('button', { name: 'Approve and resume' }).click();

    expect(await screen.findByText(/500 Internal Server Error: audit failed/)).toBeTruthy();
    expect(screen.getByText('pilot_app.export')).toBeTruthy();
    expect(screen.getByText(/"action": "export"/)).toBeTruthy();
  });
});

describe('test 17 — operator credential is not rendered', () => {
  // Same vacuity as test 8, and a regression on top of it: before the transport
  // moved to Rust this test used setConfig to put a real operator token into
  // the client, so it verified that a credential the JS actually held stayed
  // out of the DOM. The refactor removed setConfig and the token with it,
  // leaving an assertion about a string that was never present.
  //
  // The operator surface is the one the credential belongs to, so inject it
  // there: a pending approval whose payload carries a token-shaped field.
  it('does not render a credential carried on an operator response', async () => {
    const leakedToken = 'operator-token-that-should-never-surface';
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cockpit_status') return Promise.resolve({ approvals_configured: true });
      return Promise.resolve({
        status: 200,
        body: { operator_token: leakedToken, pending: [pendingApproval({ path: 'quarterly.xlsx' })] },
      });
    });

    const { container } = render(<ApprovalsView />);
    // The approval itself must still render — otherwise this passes for the
    // trivial reason that nothing rendered at all.
    await screen.findByText(/quarterly\.xlsx/);

    expect(container.textContent).not.toContain(leakedToken);
    expect(container.innerHTML).not.toContain(leakedToken);
    expect(JSON.stringify(invokeMock.mock.calls.map((call) => call[1]))).not.toContain(leakedToken);
  });
});

describe('fixed Stage Graph configuration', () => {
  it('submits the four bounded stages with the selected role defaults', async () => {
    let submitted: Record<string, unknown> | null = null;
    mockInvoke((operation, body) => {
      if (operation === 'operator_catalog') return { status: 200, body: { capabilities: ['codex.start', 'codex.send', 'codex.read', 'codex.stop', 'claude.start', 'claude.send', 'claude.read', 'claude.stop'], workspaces: ['sandbox'] } };
      if (operation === 'operator_pipelines') return { status: 200, body: { pipelines: [] } };
      if (operation === 'operator_pipeline_create') { submitted = body as Record<string, unknown>; return { status: 200, body: {} }; }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    mount(<StageGraphsView />);
    expect(await screen.findByRole('heading', { name: /build, review, and challenge/i })).toBeTruthy();
    expect(screen.getByText('Recommended')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /quick check/i }));
    fireEvent.change(screen.getByPlaceholderText(/bounded result/i), { target: { value: 'Build the sample' } });
    const start = screen.getByRole('button', { name: 'Start 4-stage pipeline' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(submitted).not.toBeNull());
    const submittedBody: unknown = submitted;
    const stages = (submittedBody as Record<string, unknown>)['stages'] as Array<Record<string, unknown>>;
    expect((submittedBody as Record<string, unknown>)['deadline_minutes']).toBe(120);
    expect(stages.map((stage) => stage.stage_id)).toEqual(['specification', 'implementation', 'code_review', 'security_review']);
    expect(stages.map((stage) => stage.adapter_id)).toEqual(['codex', 'codex', 'codex', 'claude']);
    expect(stages.map((stage) => stage.max_actions)).toEqual([6, 10, 6, 6]);
  });

  it('turns a paused run into a clear needs-attention action', async () => {
    let resumed: Record<string, unknown> | null = null;
    const stage = (stage_id: string, state: string, index: number) => ({
      stage_id, state, adapter_id: index === 3 ? 'claude' : 'codex',
      max_actions: 8, max_action_retries: 1, timeout_minutes: 45, max_attempts: 2,
      attempt: index <= 1 ? 1 : 0, job_id: index <= 1 ? `job-${index}` : null,
      job_ids: index <= 1 ? [`job-${index}`] : [],
      started_at: index <= 1 ? '2026-08-14T08:00:00.000Z' : null, ended_at: index === 0 ? '2026-08-14T08:10:00.000Z' : null,
      artifacts: index === 0 ? [{ path: 'SPEC.md', sha256: 'a'.repeat(64), bytes: 10 }] : [],
      error: index === 1 ? 'waiting for approval' : null,
    });
    const graph = {
      pipeline_id: 'pipeline-1', objective: 'Build the sample', workspace_id: 'sandbox',
      state: 'paused', current_stage: 1, deadline_at: '2026-08-14T12:00:00.000Z',
      created_at: '2026-08-14T08:00:00.000Z', updated_at: '2026-08-14T08:10:00.000Z',
      error: 'implementation: waiting for approval',
      stages: [stage('specification', 'completed', 0), stage('implementation', 'paused', 1), stage('code_review', 'pending', 2), stage('security_review', 'pending', 3)],
    };
    mockInvoke((operation, body) => {
      if (operation === 'operator_catalog') return { status: 200, body: { capabilities: ['codex.start', 'codex.send', 'codex.read', 'codex.stop', 'claude.start', 'claude.send', 'claude.read', 'claude.stop'], workspaces: ['sandbox'] } };
      if (operation === 'operator_pipelines') return { status: 200, body: { pipelines: [graph] } };
      if (operation === 'operator_pipeline_resume') { resumed = body as Record<string, unknown>; return { status: 200, body: { ...graph, state: 'running' } }; }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    mount(<StageGraphsView />);
    expect(await screen.findByText('Toros needs your attention')).toBeTruthy();
    expect(screen.getByText('implementation: waiting for approval')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/tell Toros how to continue/i), { target: { value: 'Proceed with the approved request.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume pipeline' }));
    await waitFor(() => expect(resumed).not.toBeNull());
    expect(resumed).toEqual({ pipeline_id: 'pipeline-1', operator_message: 'Proceed with the approved request.' });
  });
});
describe('operator-attached Chrome web capture', () => {
  const worker = {
    paired: true, connected: true, extension_id: 'a'.repeat(32), extension_version: '0.1.0',
    paired_at: '2026-08-14T08:00:00.000Z', last_seen_at: '2026-08-14T08:01:00.000Z',
    tab: { id: 9, url: 'https://www.example.com/US/en', title: 'Example' },
    allowed_domains: ['example.com'], extension_dir: 'C:\Toros\chrome-worker-extension',
    queued_commands: 0, active_command: null,
  };

  it('shows the pairing boundary and creates a short-lived code', async () => {
    mockInvoke((operation) => {
      if (operation === 'operator_browser_status') return { status: 200, body: { worker: { ...worker, connected: false, tab: null } } };
      if (operation === 'operator_browser_acquisitions') return { status: 200, body: { acquisitions: [] } };
      if (operation === 'operator_catalog') return { status: 200, body: { capabilities: ['chrome.navigate', 'chrome.extract', 'chrome.download'], workspaces: ['sandbox'] } };
      if (operation === 'operator_browser_pairing') return { status: 200, body: { code: '12345678', expires_at: '2026-08-14T09:00:00.000Z' } };
      throw new Error('Unexpected operation: ' + operation);
    });
    mount(<BrowserAcquisitionsView />);
    expect(await screen.findByRole('heading', { name: /capture documents from an allowlisted site/i })).toBeTruthy();
    expect(screen.getByText(/cannot inspect passwords, cookies/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /create pairing code/i }));
    expect(await screen.findByText('12345678')).toBeTruthy();
    expect((screen.getByRole('button', { name: /start web capture/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits a paced document capture with typed rules', async () => {
    let submitted: Record<string, unknown> | null = null;
    mockInvoke((operation, body) => {
      if (operation === 'operator_browser_status') return { status: 200, body: { worker } };
      if (operation === 'operator_browser_acquisitions') return { status: 200, body: { acquisitions: [] } };
      if (operation === 'operator_catalog') return { status: 200, body: { capabilities: ['chrome.navigate', 'chrome.extract', 'chrome.download'], workspaces: ['sandbox'] } };
      if (operation === 'operator_browser_acquisition_create') { submitted = body as Record<string, unknown>; return { status: 200, body: {} }; }
      throw new Error('Unexpected operation: ' + operation);
    });
    mount(<BrowserAcquisitionsView />);
    await screen.findByText('Chrome is ready');
    fireEvent.change(screen.getByPlaceholderText(/ITEM-1/i), { target: { value: 'P-1 | https://www.example.com/products/p-1' } });
    const start = screen.getByRole('button', { name: /start web capture/i });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(submitted).not.toBeNull());
    const body = submitted as unknown as Record<string, unknown>;
    expect(body['workspace_id']).toBe('sandbox');
    expect(body['site_profile']).toBe('generic');
    expect(body['min_delay_seconds']).toBe(45);
    expect(body['max_delay_seconds']).toBe(90);
    expect(body['max_consecutive_rate_limits']).toBe(2);
    expect(body['sources']).toEqual([{ item_id: 'P-1', url: 'https://www.example.com/products/p-1' }]);
    expect((body['documents'] as Array<Record<string, unknown>>).map((rule) => rule.kind)).toEqual(['sds', 'specification']);
  });
  it('offers Node Core recovery inside Web capture', async () => {
    invokeMock.mockImplementation((command: string) => command === 'start_node_core'
      ? Promise.resolve()
      : Promise.reject(new Error('Node Core request could not be completed')));

    mount(<BrowserAcquisitionsView />);
    expect(await screen.findByText('Could not reach Node Core')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Node Core' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('start_node_core'));
  });
});

describe('operator shell redesign', () => {
  it('keeps an in-progress pipeline draft while the operator visits another area', async () => {
    mockInvoke((operation) => ({
      status: 200,
      body: ({
        operator_jobs: { jobs: [] },
        operator_pipelines: { pipelines: [] },
        operator_browser_acquisitions: { acquisitions: [] },
        operator_browser_status: { worker: { connected: false, tab: null, allowed_domains: [] } },
        operator_catalog: { capabilities: ['codex.start', 'codex.send', 'codex.read', 'codex.stop'], workspaces: ['sandbox'] },
        operator_approvals: { pending: [] },
        operator_conversations: { conversations: [] },
      } as Record<string, unknown>)[operation] ?? {},
    }));

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /^Work$/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Reviewed pipeline/i }));
    const objective = screen.getByPlaceholderText('Describe the bounded result this pipeline should produce.') as HTMLTextAreaElement;
    fireEvent.change(objective, { target: { value: 'Preserve this draft' } });

    fireEvent.click(screen.getByRole('button', { name: /^Home$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Work$/ }));

    expect((screen.getByPlaceholderText('Describe the bounded result this pipeline should produce.') as HTMLTextAreaElement).value).toBe('Preserve this draft');
  });
});

describe('inbox task closure', () => {
  const checkpoint: JobRecord = {
    job_id: 'job-close-1',
    envelope: {
      job_id: 'job-close-1', objective: 'Archive this checkpoint',
      allowed_capabilities: [], allowed_workspaces: [], acceptance: [], forbidden: [],
      max_actions: 1, max_retries: 0, expires_at: '2026-12-31T23:59:59Z',
    },
    envelope_digest: 'digest-close-1', state: 'checkpoint',
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', actions_used: 1,
  };
  const overview: CockpitOverview = {
    jobs: [checkpoint], approvals: [], pipelines: [], captures: [], worker: null, catalog: null,
    loading: false, error: null, updatedAt: new Date('2026-09-01T00:00:00Z'),
  };

  it('archives a checkpoint and removes it from the inbox immediately', async () => {
    const refresh = vi.fn();
    mockInvoke((operation, body) => {
      expect(operation).toBe('operator_job_archive');
      expect(body).toEqual({ job_id: 'job-close-1' });
      return { status: 200, body: { ...checkpoint, state: 'cancelled' } };
    });

    render(<InboxView active overview={overview} onOpenJob={vi.fn()} onOpenWork={vi.fn()} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));

    await waitFor(() => expect(screen.queryByText('Archive this checkpoint')).toBeNull());
    expect(screen.getByText('All clear')).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps the checkpoint visible and explains an archive failure', async () => {
    mockInvoke((operation) => operation === 'operator_approvals'
      ? { status: 200, body: { pending: [] } }
      : { status: 500, body: 'archive write failed' });

    render(<InboxView active overview={overview} onOpenJob={vi.fn()} onOpenWork={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));

    expect(await screen.findByText(/Could not close task/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('archive write failed');
    expect(screen.getByText('Archive this checkpoint')).toBeTruthy();
  });
});
