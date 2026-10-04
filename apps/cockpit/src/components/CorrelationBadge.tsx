import type { ReactNode } from 'react';
import type { CorrelationConfidence } from '../types';

/**
 * CorrelationBadge — renders a finding's correlation confidence.
 *
 * SPEC §8.2: exact, cited, session, none must be visually distinguishable,
 * with session and none clearly weaker. A session-grade finding must not be
 * displayed as attached to a specific action.
 */
const CONFIDENCE_LABEL: Record<CorrelationConfidence, string> = {
  exact: 'Exact',
  cited: 'Cited',
  session: 'Session-level',
  none: 'Uncorrelated',
};

const CONFIDENCE_DESCRIPTION: Record<CorrelationConfidence, string> = {
  exact: 'Correlated to a specific action by project path.',
  cited: 'A finding cited an event that resolved as exact.',
  session: 'Correlated to a session window, not a specific action.',
  none: 'No correlation to any action or session.',
};

interface CorrelationBadgeProps {
  readonly confidence: CorrelationConfidence;
  readonly receiptId: string | null;
}

export function CorrelationBadge({ confidence, receiptId }: CorrelationBadgeProps): ReactNode {
  const isWeak = confidence === 'session' || confidence === 'none';
  const hasAction = receiptId !== null;

  return (
    <span
      className={`correlation-badge correlation-badge--${confidence}${isWeak ? ' correlation-badge--weak' : ''}`}
      data-confidence={confidence}
      title={CONFIDENCE_DESCRIPTION[confidence]}
    >
      <span className="correlation-badge__label">{CONFIDENCE_LABEL[confidence]}</span>
      {hasAction && confidence !== 'session' && confidence !== 'none' ? (
        <span className="correlation-badge__action"> (attached to action)</span>
      ) : (
        <span className="correlation-badge__no-action"> (not attached to a specific action)</span>
      )}
    </span>
  );
}