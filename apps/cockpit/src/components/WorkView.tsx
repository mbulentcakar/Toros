import type { ReactNode } from 'react';
import { BrowserAcquisitionsView } from './BrowserAcquisitionsView';
import { HermesChat } from './HermesChat';
import type { WorkMode } from './HomeView';
import { StageGraphsView } from './StageGraphsView';

interface WorkViewProps {
  readonly active: boolean;
  readonly mode: WorkMode;
  readonly onModeChange: (mode: WorkMode) => void;
  readonly onOpenJob: (jobId: string) => void;
}

const MODES: ReadonlyArray<{ readonly id: WorkMode; readonly label: string; readonly description: string }> = [
  { id: 'assistant', label: 'Ask Hermes', description: 'Talk first, approve later' },
  { id: 'pipeline', label: 'Reviewed pipeline', description: 'Four bounded stages' },
  { id: 'capture', label: 'Web capture', description: 'Paced Chrome acquisition' },
];

/** All three work surfaces stay mounted so an operator can inspect another area without losing a draft. */
export function WorkView({ active, mode, onModeChange, onOpenJob }: WorkViewProps): ReactNode {
  return (
    <div className="work-view page-stack">
      <header className="work-view__header">
        <div><span className="eyebrow">Create and supervise</span><h1>Work</h1><p>Choose the lightest workflow that fits the outcome.</p></div>
        <div className="work-mode-tabs" role="tablist" aria-label="Work type">
          {MODES.map((item) => <button aria-selected={mode === item.id} className={mode === item.id ? 'is-active' : ''} key={item.id} onClick={() => onModeChange(item.id)} role="tab" type="button"><strong>{item.label}</strong><small>{item.description}</small></button>)}
        </div>
      </header>
      <div hidden={mode !== 'assistant'}><HermesChat active={active && mode === 'assistant'} onOpenJob={onOpenJob} /></div>
      <div hidden={mode !== 'pipeline'}><StageGraphsView active={active && mode === 'pipeline'} /></div>
      <div hidden={mode !== 'capture'}><BrowserAcquisitionsView active={active && mode === 'capture'} /></div>
    </div>
  );
}
