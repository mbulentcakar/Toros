import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ConnectionsView } from './components/ConnectionsView';
import { HomeView, type WorkMode } from './components/HomeView';
import { InboxView } from './components/InboxView';
import { JobWorkspaceView } from './components/JobWorkspaceView';
import { JobsView } from './components/JobsView';
import { NODE_CORE_STARTED_EVENT } from './components/States';
import { WorkView } from './components/WorkView';
import { useCockpitOverview } from './useCockpitOverview';
import './components/HermesChat.css';

type PrimaryView = 'home' | 'work' | 'inbox' | 'audit' | 'connections';

const PRIMARY_NAV: ReadonlyArray<{ readonly id: PrimaryView; readonly label: string; readonly icon: string }> = [
  { id: 'home', label: 'Home', icon: 'H' },
  { id: 'work', label: 'Work', icon: 'W' },
  { id: 'inbox', label: 'Inbox', icon: 'I' },
  { id: 'audit', label: 'Audit', icon: 'A' },
  { id: 'connections', label: 'Setup', icon: 'S' },
];

const TITLE: Record<PrimaryView, string> = {
  home: 'Operator home', work: 'Work', inbox: 'Inbox', audit: 'Audit', connections: 'Connections',
};

export function App(): ReactNode {
  const [primary, setPrimary] = useState<PrimaryView>('home');
  const [workMode, setWorkMode] = useState<WorkMode>('assistant');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [nodeGeneration, setNodeGeneration] = useState(0);
  const overview = useCockpitOverview();

  useEffect(() => {
    const remount = (): void => {
      setNodeGeneration((current) => current + 1);
      overview.refresh();
    };
    window.addEventListener(NODE_CORE_STARTED_EVENT, remount);
    return () => window.removeEventListener(NODE_CORE_STARTED_EVENT, remount);
  }, [overview.refresh]);

  function navigate(view: PrimaryView): void {
    setPrimary(view);
    setSelectedJobId(null);
  }

  function openWork(mode: WorkMode): void {
    setWorkMode(mode);
    setPrimary('work');
    setSelectedJobId(null);
  }

  const paused = overview.pipelines.filter((item) => item.state === 'paused').length
    + overview.captures.filter((item) => item.state === 'paused').length
    + overview.jobs.filter((item) => item.state === 'checkpoint').length;
  const attentionCount = overview.approvals.length + paused;
  const contentTitle = selectedJobId === null ? TITLE[primary] : 'Work item';
  const nodeReady = !overview.loading && overview.error === null;
  const nodeLabel = overview.loading ? 'Checking Node Core' : nodeReady ? 'Node Core online' : 'Node Core offline';

  return (
    <div className="cockpit-shell">
      <aside className="sidebar">
        <button className="sidebar__brand" onClick={() => navigate('home')} type="button"><span className="sidebar__mark">T</span><span><strong>Toros</strong><small>Operator cockpit</small></span></button>
        <nav className="sidebar__nav" aria-label="Cockpit areas">
          {PRIMARY_NAV.map((item) => <button aria-current={primary === item.id && selectedJobId === null ? 'page' : undefined} className={primary === item.id && selectedJobId === null ? 'is-active' : ''} key={item.id} onClick={() => navigate(item.id)} type="button"><span className="sidebar__nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>{item.id === 'inbox' && attentionCount > 0 && <em>{attentionCount}</em>}</button>)}
        </nav>
        <footer className="sidebar__footer"><span className={`node-dot${nodeReady ? ' is-ready' : ''}`} /><span><strong>{nodeLabel}</strong><small>Local authority</small></span></footer>
      </aside>

      <main className="cockpit-main">
        <header className="topbar"><div><span>Toros Cockpit</span><strong>{contentTitle}</strong></div><div className="topbar__status"><span className={`node-dot${nodeReady ? ' is-ready' : ''}`} />{overview.loading ? 'Checking local node' : nodeReady ? 'Local node ready' : 'Local node unavailable'}</div></header>
        {attentionCount > 0 && <div className="attention-strip" role="status"><div><strong>{attentionCount} item{attentionCount === 1 ? '' : 's'} need your attention</strong><span>{overview.approvals.length > 0 && `${overview.approvals.length} approval${overview.approvals.length === 1 ? '' : 's'}`}{overview.approvals.length > 0 && paused > 0 ? ' · ' : ''}{paused > 0 && `${paused} paused`}</span></div><button onClick={() => navigate('inbox')} type="button">Open inbox →</button></div>}

        <div className="cockpit-content" key={nodeGeneration}>
          {selectedJobId !== null && <JobWorkspaceView jobId={selectedJobId} onBack={() => setSelectedJobId(null)} />}
          {selectedJobId === null && primary === 'home' && <HomeView overview={overview} onOpenInbox={() => navigate('inbox')} onOpenJob={setSelectedJobId} onOpenWork={openWork} />}
          <div hidden={selectedJobId !== null || primary !== 'work'}><WorkView active={selectedJobId === null && primary === 'work'} mode={workMode} onModeChange={setWorkMode} onOpenJob={setSelectedJobId} /></div>
          {selectedJobId === null && primary === 'inbox' && <InboxView active overview={overview} onOpenJob={setSelectedJobId} onOpenWork={openWork} onRefresh={overview.refresh} />}
          {selectedJobId === null && primary === 'audit' && <JobsView onSelectJob={setSelectedJobId} />}
          {selectedJobId === null && primary === 'connections' && <ConnectionsView overview={overview} onOpenWork={openWork} />}
        </div>
      </main>
    </div>
  );
}
