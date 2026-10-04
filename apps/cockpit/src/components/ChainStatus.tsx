import type { ReactNode } from 'react';
import type { ChainVerification } from '../types';

/**
 * ChainStatus — renders chain verification status.
 *
 * If verifyChain reports anchor_matches: false with broken_at_seq: null,
 * that is tail truncation — say so, in those words. A green tick because
 * the links happen to verify is exactly the failure the anchor was added
 * to catch.
 */
interface ChainStatusProps {
  readonly verification: ChainVerification;
  readonly nodeId: string;
}

export function ChainStatus({ verification }: ChainStatusProps): ReactNode {
  const isTruncated = !verification.anchor_matches && verification.broken_at_seq === null;

  if (isTruncated) {
    return (
      <div className="chain-status chain-status--truncated" data-chain="truncated">
        <span className="chain-status__icon">⚠</span>
        <span className="chain-status__text">
          Tail truncated — the log's anchor does not match the recomputed chain,
          but every surviving row links correctly. Rows are missing from the end.
        </span>
      </div>
    );
  }

  if (verification.ok) {
    return (
      <div className="chain-status chain-status--valid" data-chain="valid">
        <span className="chain-status__icon">✓</span>
        <span className="chain-status__text">
          Chain verified: {verification.rows_checked} row{verification.rows_checked !== 1 ? 's' : ''}.
        </span>
      </div>
    );
  }

  if (verification.broken_at_seq !== null) {
    return (
      <div className="chain-status chain-status--broken" data-chain="broken">
        <span className="chain-status__icon">✗</span>
        <span className="chain-status__text">
          Chain broken at seq {verification.broken_at_seq}.
          {verification.reason ? ` Reason: ${verification.reason}` : ''}
        </span>
      </div>
    );
  }

  // Fallback — should not be reachable
  return null;
}