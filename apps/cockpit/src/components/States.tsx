import { useState, type ReactNode } from 'react';
import { ApiError, startNodeCore } from '../api';

export const NODE_CORE_STARTED_EVENT = 'toros:node-core-started';

/**
 * ErrorState — renders an error message.
 * 401s are shown as an authentication problem, not a generic error.
 */
export function ErrorState({ error }: { error: ApiError }): ReactNode {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setStarting(true);
    setStartError(null);
    try {
      await startNodeCore();
      window.dispatchEvent(new Event(NODE_CORE_STARTED_EVENT));
    } catch (cause: unknown) {
      setStartError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  if (error.status === 401) {
    return (
      <div className="error-state error-state--auth" role="alert">
        <p className="error-state__title">Authentication failed</p>
        <p className="error-state__detail">
          Check the bearer token. Node Core returned 401.
        </p>
      </div>
    );
  }

  if (error.status === 0) {
    return (
      <div className="error-state" role="alert">
        <p className="error-state__title">Could not reach Node Core</p>
        <p className="error-state__detail">
          {error.message || 'Network error — is Node Core running on localhost?'}
        </p>
        <button className="btn btn--primary" disabled={starting} onClick={() => { void start(); }} type="button">
          {starting ? 'Starting Node Core…' : 'Start Node Core'}
        </button>
        {startError !== null && <p className="error-state__detail">Start failed: {startError}</p>}
      </div>
    );
  }

  return (
    <div className="error-state" role="alert">
      <p className="error-state__title">Error ({error.status})</p>
      <p className="error-state__detail">{error.message}</p>
    </div>
  );
}

/**
 * LoadingState — a simple loading indicator.
 */
export function LoadingState(): ReactNode {
  return <div className="loading-state" role="status">Loading…</div>;
}

/**
 * EmptyState — shown when data is absent.
 */
export function EmptyState({ message }: { message: string }): ReactNode {
  return <div className="empty-state">{message}</div>;
}