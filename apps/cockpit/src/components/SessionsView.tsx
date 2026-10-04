import type { ReactNode } from 'react';
import { EmptyState } from './States';

/** list_sessions is job-scoped; this Phase 1 shell has no selected job here. */
export function SessionsView(): ReactNode {
  return <div className="sessions-view">
    <h2 className="view-title">Sessions</h2>
    <EmptyState message="Sessions are not available from the Phase 1 surface without a selected job; Node Core requires job_id." />
  </div>;
}
