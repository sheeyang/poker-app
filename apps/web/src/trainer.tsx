import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, retainNewestTable, useTableSynchronization } from '@poker/client';
import { Icon } from './icons.js';
import { SessionBrowser } from './session-browser.js';
import { useCommand, useSession } from './session.js';
import { usePracticeSetup } from './practice-setup.js';
import { PokerTable } from './poker-table.js';
import { ActionTray, CommandFeedback } from './controls.js';
import { TableSettings } from './settings.js';
import { useDecisionAnalysis } from './analysis.js';
import { useHandSummary, useTableSessionSummary } from './summaries.js';
import { AnalysisPanel, FinishSession } from './analysis-panel.js';
import { HandReview } from './hand-review.js';
import { actionLabel, chips } from './table-model.js';

export function Trainer() {
  const selected = useSession(s => s.selectedId), select = useSession(s => s.select);
  const analysisOpen = useSession(s => s.analysisOpen), animations = useSession(s => s.animations);
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
  const setup = usePracticeSetup(table.data, command);
  const preparing = setup?.tableId === selected && !!setup;
  const lastSelected = useRef(selected);
  useEffect(() => { if (lastSelected.current !== selected) { setBrowse(false); setSettings(false); setFinish(false); useSession.setState({ analysisOpen: false }); window.scrollTo({ top: 0 }); lastSelected.current = selected; } }, [selected]);
  useEffect(() => { if (browse) window.scrollTo({ top: 0 }); }, [browse]);
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
  const handDecisions = analysis.acceptedDecisions.filter(d => d.handId === current?.view.state.handId);
  function review(id?: string) {
    if (id) analysis.selectDecision(id);
    else if (handDecisions.length) analysis.selectView('hand');
    useSession.setState({ analysisOpen: true });
    requestAnimationFrame(() => document.getElementById('analysis-panel')?.focus({ preventScroll: true }));
  }
  function closeAnalysis() {
    useSession.setState({ analysisOpen: false });
    requestAnimationFrame(() => document.getElementById('play-controls')?.focus({ preventScroll: true }));
  }
  return <div className={`app-shell${selected && !browse ? ' table-active' : ''}`}>
    <a className="skip-link" href="#main-table">Skip to table</a>
    <header className="app-header"><button className="brand" onClick={() => setBrowse(true)} aria-label="Poker Trainer · practice"><span className="brand-mark"><Icon name="spade" size={23} /></span><strong>Poker<span className="brand-divider" /> <span>Trainer</span></strong></button><nav aria-label="Practice navigation"><button className={browse || !selected ? 'nav-active' : ''} onClick={() => setBrowse(true)}><Icon name="tables" size={18} /><span>Practice</span></button>{selected && <button onClick={() => setBrowse(false)} className={!browse ? 'nav-active' : ''}><Icon name="cards" size={18} /><span>Your table</span></button>}</nav><span className="identity-status">{identity.isError ? 'Connection unavailable' : identity.isSuccess ? 'Progress saved automatically' : 'Connecting…'}</span></header>
    <CommandFeedback command={command} />
    {identity.isError && <div className="global-notice notice-error" role="alert"><div><strong>Couldn’t connect to the poker server.</strong><p>Your saved table is still selected.</p></div><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
    {!selected || browse ? <SessionBrowser command={command} ready={identity.isSuccess} close={selected ? () => setBrowse(false) : undefined} /> : <main id="main-table" className={`play-workspace ${analysisOpen ? 'with-analysis' : ''}`}>
      <div className="play-area">
        <div className="table-toolbar"><div className="table-title"><h1>{current ? current.view.configuration.seatCount === 2 ? 'Heads-up' : `${current.view.configuration.seatCount}-player table` : 'Your table'}</h1><span>No-limit Hold’em{current ? ` · ${chips(current.view.configuration.smallBlind)} / ${chips(current.view.configuration.bigBlind)}` : ''}</span></div><div className="toolbar-actions"><button className="quiet-button" aria-expanded={analysisOpen} aria-controls="analysis-panel" onClick={() => analysisOpen ? closeAnalysis() : review()}><Icon name="chart" size={18} /><span>{analysisOpen ? 'Return to play' : handDecisions.length ? 'Review decisions' : 'Analysis'}</span></button><button className="icon-button" disabled={!current || preparing} aria-label="Table options" onClick={() => setSettings(true)}><Icon name="settings" /></button></div></div>
        {!current && !table.error && <div className="table-loading" role="status"><div className="loading-oval" /><p>Opening your table…</p></div>}
        {table.error && <div className="table-error notice-error" role="alert"><h2>Couldn’t open this table.</h2><p>{table.error.message}</p><div className="button-row"><button onClick={() => void table.refetch()}>Retry</button><button onClick={() => setBrowse(true)}>Choose another table</button></div></div>}
        {current && <>
          <div className="hand-status"><span><strong>{current.view.state.handId ? `Hand ${String(handNumber).padStart(2, '0')}` : 'Your practice'}</strong><span className="status-separator">·</span>{current.view.state.status === 'completed-hand' ? 'Complete' : current.view.state.status === 'between-hands' ? 'Getting ready' : current.view.state.street ? current.view.state.street[0]!.toUpperCase() + current.view.state.street.slice(1) : 'In play'}</span></div>
          {live.connection !== 'connected' && <div className="connection-notice" role="status"><span>{live.connection === 'reconnecting' ? 'Reconnecting… Your confirmed table is still visible.' : 'Connecting live updates…'}</span><button onClick={() => void table.refetch()}>Refresh table</button></div>}
          {runtime?.phase === 'recovering' && <div className="notice-error" role="status"><strong>Confirming the last request.</strong><p>{runtime.message ?? 'This table is paused until its outcome is known.'}</p><button onClick={() => void table.refetch()}>Check table status</button></div>}
          {runtime?.phase === 'failed' && runtime.participantId && <div className="notice-error" role="alert"><strong>A bot’s decision is paused.</strong><p>{runtime.message}</p><button disabled={command.busy} onClick={() => command.submit({ tableId: current.tableSessionId, kind: 'retry-bot', body: { requestId: crypto.randomUUID(), expectedSessionRevision: current.sessionRevision, participantId: runtime.participantId! } })}>Retry bot decision</button></div>}
          {preparing ? <section className="practice-preparing" role="status"><Icon name="cards" size={38} /><h2>{setup.paused ? 'Your setup is saved.' : setup.afterHandId === undefined ? 'Getting everyone to the table…' : 'Preparing the next hand…'}</h2><p>{setup.paused ?? (setup.afterHandId === undefined ? `${current.view.state.participants.filter(p => p.seat !== null).length} of ${current.bindings.length} players seated. Your hand starts next.` : 'Returning players and refilling empty stacks before the deal.')}</p>{setup.paused && <div className="button-row"><button className="primary" disabled={command.busy} onClick={() => { command.dismiss(); useSession.getState().setSetup({ ...setup, paused: undefined }); }}>Continue setup</button><button onClick={() => { useSession.getState().setSetup(null); setSettings(true); }}>Table options</button></div>}</section> : <>
            <PokerTable table={current} events={live.recentEvents} eventCount={live.eventCount} animate={animations} openSettings={() => setSettings(true)} />
            {current.view.state.status === 'completed-hand' && <HandReview table={current} summary={summary} />}
            <div id="play-controls" className="play-controls" tabIndex={-1}><ActionTray table={current} command={command} openSettings={() => setSettings(true)} review={review} /></div>
          </>}
          <div className="below-table"><details className="hand-activity"><summary>Hand activity{currentHistory ? <span>{currentHistory.decisions.length} actions</span> : null}</summary><ol>{currentHistory?.decisions.map(d => <li key={d.decisionId}><span>{d.state.street}</span><strong>{d.action.participantId === humanId ? 'You' : current.bindings.find(b => b.participantId === d.action.participantId)?.name}</strong><span>{actionLabel(d.action.action)}</span></li>)}</ol>{!currentHistory?.decisions.length && <p className="muted">Actions from this hand will appear here.</p>}</details><button className="text-button" disabled={current.view.state.status === 'active-hand' || command.busy || preparing} onClick={() => { sessionSummary.request(); setFinish(true); }}><Icon name="exit" size={16} />Session summary</button></div>
          <footer className="table-footer"><span>All amounts in chips</span></footer>
        </>}
      </div>
      {current && analysisOpen && !preparing && <AnalysisPanel table={current} analysis={analysis} command={command} close={closeAnalysis} />}
    </main>}
    {settings && current && <TableSettings table={current} command={command} close={() => setSettings(false)} />}
    {finish && current && <FinishSession summary={sessionSummary} close={() => setFinish(false)} leave={() => { setFinish(false); select(null); }} />}
  </div>;
}
