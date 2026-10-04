import type { ReactNode } from 'react';
import type { CockpitOverview } from '../useCockpitOverview';
import type { WorkMode } from './HomeView';

interface ConnectionsViewProps {
  readonly overview: CockpitOverview & { readonly refresh: () => void };
  readonly onOpenWork: (mode: WorkMode) => void;
}

export function ConnectionsView({ overview, onOpenWork }: ConnectionsViewProps): ReactNode {
  const workerReady = overview.worker?.connected === true && overview.worker.tab !== null;
  const nodeReady = !overview.loading && overview.error === null;
  return (
    <div className="connections-view page-stack">
      <header className="page-header"><div><span className="eyebrow">Local capabilities</span><h1>Connections</h1><p>Workers and bounded workspaces available to this cockpit.</p></div><button className="btn" onClick={overview.refresh} type="button">Refresh status</button></header>
      <div className="connection-grid">
        <article className="connection-card"><header><span className={`connection-status${nodeReady ? ' is-ready' : ''}`} /><div><h2>Node Core</h2><p>{overview.loading ? 'Checking the local service' : nodeReady ? 'Reachable on the local loopback service' : 'Could not read the local service'}</p></div></header><dl><dt>Jobs visible</dt><dd>{overview.jobs.length}</dd><dt>Last checked</dt><dd>{overview.updatedAt?.toLocaleTimeString() ?? 'Checking…'}</dd></dl></article>
        <article className="connection-card"><header><span className={`connection-status${workerReady ? ' is-ready' : ''}`} /><div><h2>Chrome worker</h2><p>{workerReady ? overview.worker?.tab?.title : 'No allowed tab is attached'}</p></div></header><dl><dt>Extension</dt><dd>{overview.worker?.extension_version ?? 'Not reported'}</dd><dt>Allowed domains</dt><dd>{overview.worker?.allowed_domains.join(', ') || 'None'}</dd></dl><button className="btn btn--primary" onClick={() => onOpenWork('capture')} type="button">Open web capture setup</button></article>
      </div>
      <section className="connection-inventory"><div className="section-heading"><div><span className="eyebrow">Inventory</span><h2>Available boundaries</h2></div></div><div className="inventory-grid"><article><strong>{overview.catalog?.workspaces.length ?? 0}</strong><span>Workspaces</span><ul>{overview.catalog?.workspaces.map((item) => <li key={item}><code>{item}</code></li>)}</ul></article><article><strong>{overview.catalog?.capabilities.length ?? 0}</strong><span>Capabilities</span><ul>{overview.catalog?.capabilities.slice(0, 12).map((item) => <li key={item}><code>{item}</code></li>)}</ul>{(overview.catalog?.capabilities.length ?? 0) > 12 && <small>And {(overview.catalog?.capabilities.length ?? 0) - 12} more</small>}</article></div></section>
    </div>
  );
}
