import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  createBrowserAcquisition,
  createChromePairingCode,
  getBrowserStatus,
  getOperatorCatalog,
  listBrowserAcquisitions,
  pauseBrowserAcquisition,
  resumeBrowserAcquisition,
  stopBrowserAcquisition,
} from '../api';
import './BrowserAcquisitionsView.css';
import { ErrorState } from './States';
import type {
  BrowserAcquisitionRecord,
  BrowserDocumentRule,
  ChromePairingCode,
  ChromeWorkerStatus,
  OperatorCatalog,
} from '../types';

const SDS_RULE: BrowserDocumentRule = {
  kind: 'sds', text_contains: ['safety data sheet', 'sds'], url_contains: ['/sds/'], required: false, max_files: 1,
};
const SPEC_RULE: BrowserDocumentRule = {
  kind: 'specification', text_contains: ['specification sheet', 'specification', 'spec sheet'], url_contains: ['specification', 'spec-sheet'], required: false, max_files: 2,
};

function parseSources(text: string): Array<{ item_id: string; url: string }> {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const separator = line.indexOf('|');
    const url = (separator >= 0 ? line.slice(separator + 1) : line).trim();
    const explicit = separator >= 0 ? line.slice(0, separator).trim() : '';
    let fallback = `item-${index + 1}`;
    try {
      const parsed = new URL(url);
      fallback = parsed.pathname.split('/').filter(Boolean).at(-1) ?? fallback;
    } catch { /* Node Core returns the authoritative validation error. */ }
    return { item_id: explicit || fallback, url };
  });
}

function stateLabel(state: BrowserAcquisitionRecord['state']): string {
  return ({ running: 'Working', waiting: 'Paced wait', paused: 'Needs attention', completed: 'Completed', stopped: 'Stopped' })[state];
}

export function BrowserAcquisitionsView({ active = true }: { readonly active?: boolean } = {}): ReactNode {
  const [worker, setWorker] = useState<ChromeWorkerStatus | null>(null);
  const [catalog, setCatalog] = useState<OperatorCatalog | null>(null);
  const [runs, setRuns] = useState<readonly BrowserAcquisitionRecord[]>([]);
  const [pairing, setPairing] = useState<ChromePairingCode | null>(null);
  const [name, setName] = useState('Document capture');
  const [sourceText, setSourceText] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [includeSds, setIncludeSds] = useState(true);
  const [includeSpec, setIncludeSpec] = useState(true);
  const [minDelay, setMinDelay] = useState(45);
  const [maxDelay, setMaxDelay] = useState(90);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [maxBackoff, setMaxBackoff] = useState(180);
  const [maxConsecutiveRateLimits, setMaxConsecutiveRateLimits] = useState(2);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | string | null>(null);
  const sources = useMemo(() => parseSources(sourceText), [sourceText]);

  async function refresh(): Promise<void> {
    const [status, inventory, available] = await Promise.all([getBrowserStatus(), listBrowserAcquisitions(), getOperatorCatalog()]);
    setWorker(status); setRuns(inventory); setCatalog(available);
    setWorkspace((current) => current || available.workspaces[0] || '');
  }

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try { await refresh(); }
      catch (cause: unknown) { if (mounted) setError(cause instanceof ApiError ? cause : cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted && document.visibilityState !== 'hidden') timer = setTimeout(() => { void poll(); }, 3000); }
    }
    function visibilityChanged(): void {
      if (document.visibilityState === 'hidden') { if (timer !== null) clearTimeout(timer); timer = null; }
      else if (timer === null) void poll();
    }
    if (document.visibilityState !== 'hidden') void poll();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => { mounted = false; if (timer !== null) clearTimeout(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [active]);

  async function act(action: () => Promise<unknown>, message: string): Promise<void> {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); setNotice(message); await refresh(); }
    catch (cause: unknown) { setError(cause instanceof ApiError ? cause : cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const selectedRules = [includeSds ? SDS_RULE : null, includeSpec ? SPEC_RULE : null].filter((rule): rule is BrowserDocumentRule => rule !== null);
  const connected = worker?.connected === true && worker.tab !== null;
  const limitsValid = Number.isFinite(minDelay) && minDelay >= 1
    && Number.isFinite(maxDelay) && maxDelay >= minDelay
    && Number.isFinite(maxAttempts) && maxAttempts >= 1
    && Number.isFinite(maxBackoff) && maxBackoff >= 1
    && Number.isFinite(maxConsecutiveRateLimits) && maxConsecutiveRateLimits >= 1;

  return <section className="browser-capture">
    <header className="browser-hero">
      <div><span className="eyebrow">Operator-attached Chrome</span><h2>Capture documents from an allowlisted site</h2><p>Toros uses one tab from your normal Chrome profile, works through the pages sequentially, and checkpoints every item.</p></div>
      <div className={`browser-connection ${connected ? 'is-connected' : ''}`}><span className="connection-dot"/><div><strong>{connected ? 'Chrome is ready' : 'Chrome needs pairing'}</strong><small>{worker?.tab?.title ?? 'No allowed tab is connected'}</small></div></div>
    </header>

    {error instanceof ApiError && error.status === 0
      ? <ErrorState error={error} />
      : error !== null && <div className="notice notice--error">{error instanceof Error ? error.message : error}</div>}
    {notice && <div className="notice notice--success">{notice}</div>}

    <div className="browser-grid">
      <article className="browser-panel setup-panel">
        <div className="step-heading"><span>1</span><div><h3>Connect your Chrome tab</h3><p>One-time setup, then select the target tab from the extension.</p></div></div>
        <ol className="setup-steps">
          <li>Open <code>chrome://extensions</code> and enable Developer mode.</li>
          <li>Choose <strong>Load unpacked</strong> and select:</li>
        </ol>
        <div className="path-box"><code>{worker?.extension_dir ?? 'Chrome worker extension path is not configured.'}</code>{worker?.extension_dir && <button type="button" onClick={() => { void navigator.clipboard.writeText(worker.extension_dir ?? ''); setNotice('Extension folder copied.'); }}>Copy</button>}</div>
        <ol className="setup-steps" start={3}>
          <li>Open a tab on an allowlisted site, open the Toros extension, and enter this code:</li>
        </ol>
        {pairing ? <div className="pairing-code"><strong>{pairing.code}</strong><small>Expires {new Date(pairing.expires_at).toLocaleTimeString()}</small></div> : <button className="btn" disabled={busy || worker === null} type="button" onClick={() => { void act(async () => setPairing(await createChromePairingCode()), 'Pairing code created.'); }}>Create pairing code</button>}
        <p className="boundary-note">The extension receives only the current site permission you grant. It cannot inspect passwords, cookies, local storage, or browser history.</p>
      </article>

      <article className="browser-panel capture-builder">
        <div className="step-heading"><span>2</span><div><h3>Describe the run</h3><p>Paste up to 100 page URLs on allowlisted domains. Start with a short two-item run.</p></div></div>
        <label><span>Run name</span><input value={name} maxLength={200} onChange={(event) => setName(event.target.value)}/></label>
        <label><span>Page URLs <small>{sources.length}/100</small></span><textarea rows={7} placeholder={'ITEM-1 | https://www.example.com/products/item-1\nITEM-2 | https://www.example.com/products/item-2'} value={sourceText} onChange={(event) => setSourceText(event.target.value)}/><small>Optional format: item ID | URL. Without an ID, Toros derives one from the URL.</small></label>
        <div className="document-choices">
          <label><input type="checkbox" checked={includeSds} onChange={(event) => setIncludeSds(event.target.checked)}/><span><strong>Safety Data Sheets</strong><small>Matches SDS links and /sds/ URLs.</small></span></label>
          <label><input type="checkbox" checked={includeSpec} onChange={(event) => setIncludeSpec(event.target.checked)}/><span><strong>Specifications</strong><small>Matches specification and spec-sheet links.</small></span></label>
        </div>
        <details>
          <summary>Run limits and pacing</summary>
          <div className="advanced-grid">
            <label><span>Workspace</span><select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>{catalog?.workspaces.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label><span>Delay, minimum seconds</span><input type="number" min={1} max={3600} value={minDelay} onChange={(event) => setMinDelay(Number(event.target.value))}/></label>
            <label><span>Delay, maximum seconds</span><input type="number" min={minDelay} max={7200} value={maxDelay} onChange={(event) => setMaxDelay(Number(event.target.value))}/></label>
            <label><span>Attempts per item</span><input type="number" min={1} max={10} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))}/></label>
            <label><span>Maximum backoff, minutes</span><input type="number" min={1} max={1440} value={maxBackoff} onChange={(event) => setMaxBackoff(Number(event.target.value))}/></label>
            <label><span>Pause after consecutive HTTP 429s</span><input type="number" min={1} max={5} value={maxConsecutiveRateLimits} onChange={(event) => setMaxConsecutiveRateLimits(Number(event.target.value))}/></label>
          </div>
        </details>
        <div className="capture-submit"><div><strong>{sources.length} item{sources.length === 1 ? '' : 's'} · {selectedRules.length} document rule{selectedRules.length === 1 ? '' : 's'}</strong><small>{!limitsValid ? 'Correct the run limits before starting.' : connected ? 'Ready to run in the paired tab.' : 'Pair Chrome before starting.'}</small></div><button className="btn btn--primary" disabled={busy || !connected || sources.length < 1 || sources.length > 100 || selectedRules.length < 1 || !workspace || !name.trim() || !limitsValid} type="button" onClick={() => { void act(() => createBrowserAcquisition({ name: name.trim(), workspace_id: workspace, site_profile: 'generic', sources, fields: [{ name: 'product_name', selector: 'h1' }], documents: selectedRules, min_delay_seconds: minDelay, max_delay_seconds: maxDelay, max_attempts: maxAttempts, max_backoff_minutes: maxBackoff, max_consecutive_rate_limits: maxConsecutiveRateLimits, max_document_bytes: 50 * 1024 * 1024 }), 'Web capture started. You may leave Cockpit open or close it; Node Core owns the run.'); }}>Start web capture</button></div>
      </article>
    </div>

    <section className="capture-runs">
      <div className="section-heading"><div><span className="eyebrow">Durable activity</span><h3>Web captures</h3></div><button className="text-button" type="button" onClick={() => { void refresh(); }}>Refresh</button></div>
      {runs.length === 0 && <div className="empty-state"><strong>No web captures yet</strong><p>Pair a Chrome tab, paste page URLs, and start with a short two-item run.</p></div>}
      {runs.map((run) => {
        const completedItems = run.items.filter((item) => item.state === 'completed').length;
        const downloads = run.items.flatMap((item) => item.documents).filter((document) => document.state === 'completed').length;
        const percent = run.items.length === 0 ? 0 : Math.round(completedItems / run.items.length * 100);
        const current = run.items[run.current_item];
        return <article className={`capture-run capture-run--${run.state}`} key={run.acquisition_id}>
          <header><div><span className={`state-pill state-pill--${run.state}`}>{stateLabel(run.state)}</span><h4>{run.name}</h4><p>{completedItems}/{run.items.length} items · {downloads} document{downloads === 1 ? '' : 's'}</p></div><strong>{percent}%</strong></header>
          <div className="progress-track"><span style={{ width: `${percent}%` }}/></div>
          {(run.state === 'paused' || run.state === 'waiting') && <div className="capture-attention"><strong>{run.state === 'paused' ? 'Toros needs your attention' : 'Pacing before the next request'}</strong><p>{run.error ?? (run.next_run_at ? `Next attempt ${new Date(run.next_run_at).toLocaleString()}` : 'Waiting safely.')}</p>{run.state === 'paused' && <button className="btn btn--primary" disabled={busy || !connected} type="button" onClick={() => { void act(() => resumeBrowserAcquisition(run.acquisition_id), 'Web capture resumed.'); }}>Resume from {current?.item_id ?? 'checkpoint'}</button>}</div>}
          <div className="run-facts"><span><small>Current item</small><strong>{current?.item_id ?? 'Finished'}</strong></span><span><small>Manifest</small><code>{run.manifest_path}</code></span><span><small>Pacing</small><strong>{run.min_delay_seconds}–{run.max_delay_seconds}s · stop after {run.max_consecutive_rate_limits} HTTP 429s</strong></span></div>
          <details><summary>Items and downloaded documents</summary><div className="capture-items">{run.items.map((item) => <div key={item.item_id}><span className={`item-dot item-dot--${item.state}`}/><div><strong>{item.item_id}</strong><small>{item.documents.map((document) => `${document.kind}: ${document.outcome}${document.path ? ' · ' + document.path : ''}`).join(' · ') || item.error || item.final_url || item.url}</small></div></div>)}</div></details>
          {(run.state === 'running' || run.state === 'waiting') && <div className="run-actions"><button className="btn" disabled={busy} type="button" onClick={() => { void act(() => pauseBrowserAcquisition(run.acquisition_id), 'Web capture will pause after the current browser action.'); }}>Pause after current action</button><button className="btn btn--danger" disabled={busy} type="button" onClick={() => { void act(() => stopBrowserAcquisition(run.acquisition_id), 'Web capture stopped.'); }}>Stop</button></div>}
        </article>;
      })}
    </section>
  </section>;
}
