import type { ReactNode } from 'react';
import type { Receipt, ActionOutcome } from '../types';

/**
 * OutcomeBadge — renders the outcome of a receipt action.
 *
 * Denied is rendered as prominently as succeeded. A denied action is the
 * most security-relevant row in the log; greying it out buries the signal.
 */
const OUTCOME_LABEL: Record<ActionOutcome, string> = {
  succeeded: 'Succeeded',
  denied: 'Denied',
  failed: 'Failed',
  terminated: 'Terminated',
  running: 'Running',
};

interface OutcomeBadgeProps {
  readonly outcome: ActionOutcome;
}

export function OutcomeBadge({ outcome }: OutcomeBadgeProps): ReactNode {
  // Denied is rendered with a prominent style (red/tinted, full opacity)
  // to ensure it stands out as much as a succeeded action.
  return (
    <span
      className={`outcome outcome--${outcome}`}
      data-outcome={outcome}
    >
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

/**
 * ReceiptRow — a single receipt in a job detail view.
 */
interface ReceiptRowProps {
  readonly receipt: Receipt;
  readonly index: number;
}

export function ReceiptRow({ receipt, index }: ReceiptRowProps): ReactNode {
  const isDenied = receipt.outcome === 'denied';

  return (
    <tr className={`receipt-row${isDenied ? ' receipt-row--denied' : ''}`} data-receipt-id={receipt.receipt_id}>
      <td className="receipt-row__seq">{index + 1}</td>
      <td className="receipt-row__capability">{receipt.capability}</td>
      <td className="receipt-row__actor">{receipt.actor}</td>
      <td className="receipt-row__decision">
        {receipt.decision.allow ? 'Allow' : `Deny (${receipt.decision.code})`}
      </td>
      <td className="receipt-row__outcome">
        <OutcomeBadge outcome={receipt.outcome} />
      </td>
      <td className="receipt-row__timing">
        {receipt.started_at}
        {receipt.ended_at ? ` — ${receipt.ended_at}` : ' (running)'}
      </td>
      <td className="receipt-row__adapter-fields">
        {Object.keys(receipt.adapter_fields).length === 0
          ? '—'
          : <code>{JSON.stringify(receipt.adapter_fields)}</code>}
      </td>
    </tr>
  );
}

/**
 * ReceiptList — a table of receipts.
 */
interface ReceiptListProps {
  readonly receipts: readonly Receipt[];
}

export function ReceiptList({ receipts }: ReceiptListProps): ReactNode {
  return (
    <table className="receipt-list">
      <thead>
        <tr>
          <th>#</th>
          <th>Capability</th>
          <th>Actor</th>
          <th>Decision</th>
          <th>Outcome</th>
          <th>Timing</th>
          <th>Adapter details</th>
        </tr>
      </thead>
      <tbody>
        {receipts.map((r, i) => (
          <ReceiptRow key={r.receipt_id} receipt={r} index={i} />
        ))}
      </tbody>
    </table>
  );
}