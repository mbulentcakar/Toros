import type { ReactNode } from 'react';
import { EmptyState } from './States';

/** list_activity is job-scoped and Node Core has no chain-status tool. */
export function ActivityView(): ReactNode {
  return <div className="activity-view">
    <h2 className="view-title">Activity</h2>
    <EmptyState message="Global activity and chain status are not available from Node Core's Phase 1 surface: list_activity requires job_id and there is no chain-status tool." />
  </div>;
}
