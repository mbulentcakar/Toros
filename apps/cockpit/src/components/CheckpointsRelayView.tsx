import type { ReactNode } from 'react';
import { EmptyState } from './States';

/** Node Core exposes create mutations, not checkpoint/capsule list tools. */
export function CheckpointsRelayView(): ReactNode {
  return <div className="checkpoints-relay-view">
    <h2 className="view-title">Checkpoints &amp; Relay</h2>
    <EmptyState message="Checkpoints and relay capsules are not available from Node Core's Phase 1 surface: only create mutations exist, not list endpoints." />
  </div>;
}
