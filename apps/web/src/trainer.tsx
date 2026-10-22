import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, retainNewestTable, useTableSynchronization } from '@poker/client';
import { Icon } from './icons.js';
import { SessionBrowser } from './session-browser.js';
import { useCommand, useSession } from './session.js';
import { PokerTable } from './poker-table.js';
import { ActionTray, CommandFeedback } from './controls.js';
import { TableSettings } from './settings.js';
import { useDecisionAnalysis } from './analysis.js';
import { useHandSummary, useTableSessionSummary } from './summaries.js';
import { AnalysisPanel, FinishSession } from './analysis-panel.js';
import { actionLabel, chips } from './table-model.js';

export function Trainer() {
  const selected = useSession(s => s.selectedId), select = useSession(s => s.select);
  const analysisOpen = useSession(s => s.analysisOpen), toggleAnalysis = useSession(s => s.toggleAnalysis), animations = useSession(s => s.animations);
  const [browse, setBrowse] = useState(false), [settings, setSettings] = useState(false), [finish, setFinish] = useState(false);
  const identity = useQuery({ queryKey: ['identity'], queryFn: api.establishIdentity });
  const table = useQuery({ queryKey: ['table-session', selected], queryFn: ({ signal }) => api.readSession(selected!, signal), enabled: identity.isSuccess && !!selected, structuralSharing: retainNewestTable });
  const analysis = useDecisionAnalysis(table.data), summary = useHandSummary(table.data), sessionSummary = useTableSessionSummary(table.data);
  const live = useTableSynchronization(selected, identity.isSuccess, {
    onReady: lifecycle => { analysis.consumers.onReady?.(lifecycle); summary.consumers.onReady?.(lifecycle); sessionSummary.consumers.onReady?.(lifecycle); },
    onAnalysisUpdate: (update, lifecycle) => { analysis.consumers.onAnalysisUpdate?.(update, lifecycle); summary.consumers.onAnalysisUpdate?.(update, lifecycle); sessionSummary.consumers.onAnalysisUpdate?.(update, lifecycle); },
  });
  useEffect(() => { const generation = live.userChannel?.generation ?? null; analysis.connectionChanged(generation); summary.connectionChanged(generation); sessionSummary.connectionChanged(generation); }, [live.userChannel?.generation, analysis.connectionChanged, summary.connectionChanged, sessionSummary.connectionChanged]);
  const command = useCommand();
  const lastSelected = useRef(selected);
  useEffect(() => { if (lastSelected.current !== selected) { setBrowse(false); setSettings(false); setFinish(false); lastSelected.current = selected; } }, [selected]);
  const summarized = useRef('');
  useEffect(() => {
    if (!table.data || table.data.view.state.status !== 'completed-hand') return;
    const key = `${table.data.tableSessionId}/${table.data.view.state.handId}`;
    if (summarized.current === key) return;
    summarized.current = key; summary.request();
  }, [table.data?.tableSessionId, table.data?.view.state.status, table.data?.view.state.handId, summary.request]);
  const runtime = live.runtimeStatus ?? table.data?.runtimeStatus;
  const current = table.data && runtime ? { ...table.data, runtimeStatus: runtime } : table.data;
  const handIndex = current ? current.view.history.findIndex(h => h.handId === current.view.state.handId) : -1;
  const handNumber = handIndex >= 0 ? handIndex + 1 : (current?.view.history.length ?? 0) + 1;
  const currentHistory = current?.view.history.find(h => h.handId === current.view.state.handId);
  const humanId = current?.bindings.find(b => b.controller.kind === 'human')?.participantId;
  return <div className="app-shell">
    <a className="skip-link" href="#main-table">Skip to table</a>
    <header className="app-header"><button className="brand" onClick={() => setBrowse(true)} aria-label="Poker · your tables"><span className="brand-mark"><Icon name="spade" size={23} /></span><strong>Poker<span className="brand-divider" /> <span>Trainer</span></strong></button><nav aria-label="Table navigation"><button className={browse || !selected ? 'nav-active' : ''} onClick={() => setBrowse(true)}><Icon name="tables" size={18} /><span>My tables</span></button>{selected && <button onClick={() => setBrowse(false)} className={!browse ? 'nav-active' : ''}><Icon name="cards" size={18} /><span>Play</span></button>}</nav><span className="identity-status"><i className={identity.isSuccess ? 'online-dot' : 'offline-dot'} />{identity.isSuccess ? 'Local session' : identity.isError ? 'Server unavailable' : 'Connecting…'}</span></header>
    <CommandFeedback command={command} />
    {identity.isError && <div className="global-notice notice-error" role="alert"><div><strong>Couldn’t connect to the poker server.</strong><p>Your saved table is still selected.</p></div><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
    {!selected || browse ? <SessionBrowser command={command} ready={identity.isSuccess} close={selected ? () => setBrowse(false) : undefined} /> : <main id="main-table" className={`play-workspace ${analysisOpen ? 'with-analysis' : ''}`}>
      <div className="play-area">
        <div className="table-toolbar"><div className="table-title"><h1>Cash table</h1><span>No-limit Hold’em{current ? ` · ${chips(current.view.configuration.smallBlind)} / ${chips(current.view.configuration.bigBlind)}` : ''}</span></div><div className="toolbar-actions"><button className="quiet-button" aria-expanded={analysisOpen} aria-controls="analysis-panel" onClick={toggleAnalysis}><Icon name="chart" size={18} /><span>{analysisOpen ? 'Hide analysis' : 'Analysis'}</span></button><button className="icon-button" disabled={!current} aria-label="Table settings" onClick={() => setSettings(true)}><Icon name="settings" /></button></div></div>
        {!current && !table.error && <div className="table-loading" role="status"><div className="loading-oval" /><p>Opening your table…</p></div>}
        {table.error && <div className="table-error notice-error" role="alert"><h2>Couldn’t open this table.</h2><p>{table.error.message}</p><div className="button-row"><button onClick={() => void table.refetch()}>Retry</button><button onClick={() => setBrowse(true)}>Choose another table</button></div></div>}
        {current && <>
          <div className="hand-status"><span><strong>{current.view.state.handId ? `Hand ${String(handNumber).padStart(2, '0')}` : 'New table'}</strong><span className="status-separator">/</span>{current.view.state.status === 'completed-hand' ? 'Complete' : current.view.state.status === 'between-hands' ? 'Waiting to deal' : 'In play'}</span><div className="streets" aria-label="Current betting street">{['preflop', 'flop', 'turn', 'river'].map(s => <span key={s} aria-current={s === current.view.state.street ? 'step' : undefined}>{s === 'preflop' ? 'Preflop' : s[0]!.toUpperCase() + s.slice(1)}</span>)}</div></div>
          {live.connection !== 'connected' && <div className="connection-notice" role="status"><span>{live.connection === 'reconnecting' ? 'Reconnecting… Your confirmed table is still visible.' : 'Connecting live updates…'}</span><button onClick={() => void table.refetch()}>Refresh table</button></div>}
          {runtime?.phase === 'recovering' && <div className="notice-error" role="status"><strong>Confirming the last request.</strong><p>{runtime.message ?? 'This table is paused until its outcome is known.'}</p><button onClick={() => void table.refetch()}>Check table status</button></div>}
          {runtime?.phase === 'failed' && runtime.participantId && <div className="notice-error" role="alert"><strong>A bot’s decision is paused.</strong><p>{runtime.message}</p><button disabled={command.busy} onClick={() => command.submit({ tableId: current.tableSessionId, kind: 'retry-bot', body: { requestId: crypto.randomUUID(), expectedSessionRevision: current.sessionRevision, participantId: runtime.participantId! } })}>Retry bot decision</button></div>}
          <PokerTable table={current} events={live.recentEvents} eventCount={live.eventCount} animate={animations} openSettings={() => setSettings(true)} />
          <ActionTray table={current} command={command} openSettings={() => setSettings(true)} />
          <div className="below-table"><details className="hand-activity"><summary>Hand activity{currentHistory ? <span>{currentHistory.decisions.length} actions</span> : null}</summary><ol>{currentHistory?.decisions.map((d, i) => <li key={d.decisionId}><span>{i + 1}</span><strong>{d.action.participantId === humanId ? 'You' : current.bindings.find(b => b.participantId === d.action.participantId)?.name}</strong><span>{actionLabel(d.action.action)}</span></li>)}</ol>{!currentHistory?.decisions.length && <p className="muted">Actions from this hand will appear here.</p>}</details><button className="text-button" disabled={current.view.state.status === 'active-hand' || command.busy} onClick={() => { sessionSummary.request(); setFinish(true); }}><Icon name="exit" size={16} />Finish session</button></div>
          <footer className="table-footer"><span className="live-status"><i className={live.connection === 'connected' ? 'online-dot' : 'offline-dot'} />{live.connection === 'connected' ? 'Live updates connected' : 'Live updates reconnecting'}</span><span>All amounts in chips</span></footer>
        </>}
      </div>
      {current && analysisOpen && <AnalysisPanel table={current} analysis={analysis} summary={summary} command={command} close={toggleAnalysis} />}
    </main>}
    {settings && current && <TableSettings table={current} command={command} close={() => setSettings(false)} />}
    {finish && current && <FinishSession summary={sessionSummary} close={() => setFinish(false)} leave={() => { setFinish(false); select(null); }} />}
  </div>;
}
