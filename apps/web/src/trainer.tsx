import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, retainNewestTable, useTableSynchronization } from '@poker/client';
import { Icon } from './icons.js';
import { SessionBrowser } from './session-browser.js';
import { useCommand, useSession } from './session.js';
import { usePracticeSetup } from './practice-setup.js';
import { PokerTable } from './poker-table.js';
import { ActionTray, CommandFeedback } from './controls.js';
import { TableSettings } from './settings.js';
import { JoinLinkDialog } from './join-table.js';
import { handResult } from './hand-result.js';
import { nextHandLabel } from './online-status.js';
import { useTableInteractions } from './table-interactions.js';
import { openSeats, presentBindings } from './owner-controls.js';
import { participantActions } from './participant-actions.js';
import { useDecisionAnalysis } from './analysis.js';
import { useHandSummary, useTableSessionSummary } from './summaries.js';
import { AnalysisPanel, AnalysisPanelSkeleton } from './analysis-panel.js';
import { TableSkeleton } from './loading-skeleton.js';
import { actionLabel, chips, modeLabel, playerName } from './table-model.js';
import { usePresentation } from './use-presentation.js';

export function Trainer() {
  const selected = useSession(s => s.selectedId);
  const analysisOpen = useSession(s => s.analysisOpen), animations = useSession(s => s.animations);
  const [browse, setBrowse] = useState(false), [settings, setSettings] = useState<false | 'all'>(false), [joinLinkOpen, setJoinLinkOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const identity = useQuery({ queryKey: ['identity'], queryFn: api.establishIdentity });
  const table = useQuery({ queryKey: ['table-session', selected], queryFn: ({ signal }) => api.readSession(selected!, signal), enabled: identity.isSuccess && !!selected, structuralSharing: retainNewestTable });
  const analysis = useDecisionAnalysis(table.data), summary = useHandSummary(table.data), sessionSummary = useTableSessionSummary(table.data);
  const live = useTableSynchronization(selected, identity.isSuccess, {
    // Left after the Hand: the server says so when it happens, and this client returns to the saved tables.
    onMembershipEnded: ended => {
      useSession.getState().select(null);
      queryClient.removeQueries({ queryKey: ['table-session', ended.tableSessionId] });
      void queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
      setNotice(ended.reason === 'left' ? 'You left the table.' : 'The Table Owner removed you from that table.');
    },
    onReady: lifecycle => { analysis.consumers.onReady?.(lifecycle); summary.consumers.onReady?.(lifecycle); sessionSummary.consumers.onReady?.(lifecycle); },
    onAnalysisUpdate: (update, lifecycle) => { analysis.consumers.onAnalysisUpdate?.(update, lifecycle); summary.consumers.onAnalysisUpdate?.(update, lifecycle); sessionSummary.consumers.onAnalysisUpdate?.(update, lifecycle); },
  });
  useEffect(() => { const generation = live.userChannel?.generation ?? null; analysis.connectionChanged(generation); summary.connectionChanged(generation); sessionSummary.connectionChanged(generation); }, [live.userChannel?.generation, analysis.connectionChanged, summary.connectionChanged, sessionSummary.connectionChanged]);
  const command = useCommand();
  const setup = usePracticeSetup(table.data, command);
  const preparing = setup?.tableId === selected && !!setup;
  const lastSelected = useRef(selected);
  useEffect(() => { if (lastSelected.current !== selected) { setBrowse(false); setSettings(false); setJoinLinkOpen(false); useSession.setState({ analysisOpen: false }); window.scrollTo({ top: 0 }); lastSelected.current = selected; } }, [selected]);
  useEffect(() => { if (browse) window.scrollTo({ top: 0 }); }, [browse]);
  const runtime = live.runtimeStatus ?? table.data?.runtimeStatus;
  // Runtime status and who is connected are transient: the live connection's latest word wins over the cached view.
  const connected = live.connectedParticipantIds;
  const current = table.data && (runtime || connected) ? { ...table.data, ...(runtime ? { runtimeStatus: runtime } : {}), ...(connected ? { connectedParticipantIds: connected } : {}) } : table.data;
  const handIndex = current ? current.view.history.findIndex(h => h.handId === current.view.state.handId) : -1;
  const handNumber = handIndex >= 0 ? handIndex + 1 : (current?.view.history.length ?? 0) + 1;
  const currentHistory = current?.view.history.find(h => h.handId === current.view.state.handId);
  const humanId = current?.viewerParticipantId;
  // The table as the server's schedule presents it now; `current` stays the committed authority.
  const presentation = usePresentation(current, humanId);
  const shown = presentation?.table;
  const handDecisions = analysis.acceptedDecisions.filter(d => d.handId === current?.view.state.handId);
  const handOpen = current?.view.state.status === 'active-hand' || presentation?.payoutEnded === false;
  // At an Online Table: whose table it is, who is watching, and the ways in for a Guest without a Seat.
  const online = current?.mode === 'online';
  const owner = !!current && current.viewerParticipantId === current.ownerParticipantId;
  const ownerName = current?.bindings.find(b => b.participantId === current.ownerParticipantId)?.name;
  const watching = current ? presentBindings(current).filter(binding => !current.view.state.participants.some(p => p.participantId === binding.participantId && p.seat !== null)) : [];
  const interactions = useTableInteractions(current, command, handOpen);
  const onlineActions = online ? { chooseSeat: () => interactions.chooseSeats(), rebuy: interactions.rebuy, ...(current?.joinToken ? { openJoinLink: () => setJoinLinkOpen(true) } : {}), ...(owner && current && openSeats(current).length > 0 ? { addBot: () => interactions.chooseSeats() } : {}) } : undefined;
  const result = shown ? handResult(shown) : undefined;
  const nextHandShort = online && shown?.view.state.handId ? nextHandLabel(presentation?.nextHand) : undefined;
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
    <header className="app-header"><button className="brand" onClick={() => setBrowse(true)} aria-label="Poker Trainer · tables"><span className="brand-mark"><Icon name="spade" size={23} /></span><strong>Poker<span className="brand-divider" /> <span>Trainer</span></strong></button><nav aria-label="Table navigation"><button className={browse || !selected ? 'nav-active' : ''} onClick={() => setBrowse(true)}><Icon name="tables" size={18} /><span>Tables</span></button>{selected && <button onClick={() => setBrowse(false)} className={!browse ? 'nav-active' : ''}><Icon name="cards" size={18} /><span>Your table</span></button>}</nav><span className="identity-status">{identity.isError ? 'Connection unavailable' : identity.isSuccess ? 'Progress saved automatically' : 'Connecting…'}</span></header>
    {!(selected && !browse) && <CommandFeedback command={command} />}
    {identity.isError && !(selected && !browse) && <div className="global-notice notice-error" role="alert"><div><strong>Couldn’t connect to the poker server.</strong><p>Your saved table is still selected.</p></div><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
    {notice && !selected && <div className="global-notice" role="status"><div><strong>{notice}</strong></div><button onClick={() => setNotice(null)}>Dismiss</button></div>}
    {!selected || browse ? <SessionBrowser command={command} ready={identity.isSuccess} connecting={identity.isPending} close={selected ? () => setBrowse(false) : undefined} /> : <main id="main-table" className={`play-workspace ${analysisOpen ? 'with-analysis' : ''}`}>
      <div className="play-area">
        <div className="table-notices">
          <CommandFeedback command={command} />
          {identity.isError && <div className="global-notice notice-error" role="alert"><div><strong>Couldn’t connect to the poker server.</strong><p>Your saved table is still selected.</p></div><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
          {current && <>
            {live.connection !== 'connected' && <div className="connection-notice" role="status"><span>{live.connection === 'reconnecting' ? 'Reconnecting… Your confirmed table is still visible.' : 'Connecting live updates…'}</span><button onClick={() => void table.refetch()}>Refresh table</button></div>}
            {runtime?.phase === 'recovering' && <div className="notice-error" role="status"><strong>Confirming the last request.</strong><p>{runtime.message ?? 'This table is paused until its outcome is known.'}</p><button onClick={() => void table.refetch()}>Check table status</button></div>}
            {runtime?.phase === 'failed' && runtime.participantId && (current.mode === 'online'
              // At an Online Table the server has already played the Bot's Timeout Action: everyone is told, nobody repairs it mid-Hand.
              ? <div className="notice-error" role="status"><strong>{current.bindings.find(b => b.participantId === runtime.participantId)?.name ?? 'A bot'}’s decision failed.</strong><p>{runtime.message}</p></div>
              : <div className="notice-error" role="alert"><strong>A bot’s decision is paused.</strong><p>{runtime.message}</p><button disabled={command.busy} onClick={() => command.submit({ tableId: current.tableSessionId, kind: 'retry-bot', body: { requestId: crypto.randomUUID(), expectedSessionRevision: current.sessionRevision, participantId: runtime.participantId! } })}>Retry bot decision</button></div>)}
          </>}
          {current && interactions.choosing && <div className="seat-selection-prompt"><span role="status">Choose an open seat{interactions.choosing === current.viewerParticipantId ? '.' : ` for ${current.bindings.find(b => b.participantId === interactions.choosing)?.name ?? 'the participant'}.`}</span><button className="text-button" onClick={interactions.cancelChoosing}>Cancel</button></div>}
        </div>
        <div className="table-toolbar"><div className="table-title"><h1>{current ? current.view.configuration.seatCount === 2 ? 'Heads-up' : `${current.view.configuration.seatCount}-player table` : 'Your table'}</h1><span>No-limit Hold’em{current ? ` · ${chips(current.view.configuration.smallBlind)} / ${chips(current.view.configuration.bigBlind)}` : ''}{online && !owner && ownerName ? ` · ${ownerName}’s table` : ''}</span>{current && <span className={`mode-badge mode-${current.mode}`}>{modeLabel(current.mode)}{current.options.actionTimeLimitSeconds ? ` · ${current.options.actionTimeLimitSeconds}s to act` : ''}</span>}</div><div className="toolbar-actions">{current?.joinToken && <button className="quiet-button" onClick={() => setJoinLinkOpen(true)}><Icon name="link" size={18} /><span>Join link</span></button>}<button className="quiet-button" aria-expanded={analysisOpen} aria-controls="analysis-panel" onClick={() => analysisOpen ? closeAnalysis() : review()}><Icon name="chart" size={18} /><span>{analysisOpen ? 'Return to play' : handDecisions.length ? 'Review decisions' : 'Analysis'}</span></button><button className="icon-button" disabled={!current || preparing} aria-label="Table options" onClick={() => setSettings('all')}><Icon name="settings" /></button></div></div>
        {!current && !table.error && !identity.isError && <TableSkeleton />}
        {table.error && <div className="table-error notice-error" role="alert"><h2>Couldn’t open this table.</h2><p>{table.error.message}</p><div className="button-row"><button onClick={() => void table.refetch()}>Retry</button><button onClick={() => setBrowse(true)}>Choose another table</button></div></div>}
        {current && shown && presentation && <>
          <div className="hand-status">{!shown.view.state.handId && online
            // A Hand the viewer was not dealt into reaches them without its identity: they only see that one ended.
            ? <span><strong>{shown.view.state.status === 'completed-hand' ? 'Between hands' : 'No hands yet'}</strong></span>
            : <span><strong>{shown.view.state.handId ? `Hand ${String(handNumber).padStart(2, '0')}` : 'Your practice'}</strong><span className="status-separator">·</span>{shown.view.state.status === 'completed-hand' ? 'Complete' : shown.view.state.status === 'between-hands' ? 'Getting ready' : shown.view.state.street ? shown.view.state.street[0]!.toUpperCase() + shown.view.state.street.slice(1) : 'In play'}{result && <><span className="status-separator">·</span><span className="hand-status-result">{result.headline} {result.detail}</span></>}</span>}
            {/* The tray announces the next Hand; this is its glanceable echo beside the Hand it follows. */}
            {nextHandShort && <span className="hand-status-next" aria-hidden="true">{nextHandShort}</span>}</div>
          {preparing ? <section className="practice-preparing" role="status"><Icon name="cards" size={38} /><h2>{setup.paused ? 'Your setup is saved.' : setup.afterHandId === undefined ? 'Getting everyone to the table…' : 'Preparing the next hand…'}</h2><p>{setup.paused ?? (setup.afterHandId === undefined ? `${current.view.state.participants.filter(p => p.seat !== null).length} of ${current.bindings.length} players seated. Your hand starts next.` : 'Returning players and refilling empty stacks before the deal.')}</p>{setup.paused && <div className="button-row"><button className="primary" disabled={command.busy} onClick={() => { command.dismiss(); useSession.getState().setSetup({ ...setup, paused: undefined }); }}>Continue setup</button><button onClick={() => { useSession.getState().setSetup(null); setSettings('all'); }}>Table options</button></div>}</section> : <>
            <PokerTable table={shown} actorWindowOpen={presentation.actorWindowOpen} countdown={presentation.countdown} countdownLength={presentation.countdownLength} nextHand={presentation.nextHand} events={live.recentEvents} eventCount={live.eventCount} animate={animations} handOpen={handOpen} choosing={!!interactions.choosing} openSeat={interactions.openSeat} openParticipant={interactions.openParticipant} />

          </>}
          <div className="table-dock"><div className="table-dock-inner">
            {!preparing && <div id="play-controls" className="play-controls" data-timed={shown.options.actionTimeLimitSeconds ? '' : undefined} tabIndex={-1}><ActionTray table={shown} actionOpen={presentation.actionOpen} countdown={presentation.countdown} countdownLength={presentation.countdownLength} dealOpen={presentation.dealOpen} nextHand={presentation.nextHand} command={command} openSettings={() => interactions.chooseSeats()} review={review} online={onlineActions} /></div>}
          <div className="below-table">{watching.length > 0 && <p className="table-watchers"><span>Watching</span>{watching.map(binding => participantActions(current, binding.participantId, handOpen).length ? <button key={binding.participantId} className="watching-player" data-table-participant={binding.participantId} aria-label={`${playerName(current, binding)} actions`} aria-haspopup="menu" onClick={event => interactions.openParticipant(binding.participantId, event.currentTarget)}>{playerName(current, binding)}</button> : <span key={binding.participantId}>{playerName(current, binding)}</span>)}</p>}<details className="hand-activity"><summary>Hand activity{currentHistory ? <span>{currentHistory.decisions.length} actions</span> : null}</summary><ol>{currentHistory?.decisions.map(d => <li key={d.decisionId}><span>{d.state.street}</span><strong>{d.action.participantId === humanId ? 'You' : current.bindings.find(b => b.participantId === d.action.participantId)?.name}</strong><span>{actionLabel(d.action.action)}</span></li>)}</ol>{!currentHistory?.decisions.length && <p className="muted">Actions from this hand will appear here.</p>}</details></div>
          <footer className="table-footer"><span>All amounts in chips</span></footer>
          </div></div>
        </>}
      </div>
      {current && analysisOpen && !preparing && <AnalysisPanel table={current} analysis={analysis} summary={summary} sessionSummary={sessionSummary} command={command} close={closeAnalysis} />}
      {!current && analysisOpen && !table.error && !identity.isError && <AnalysisPanelSkeleton close={closeAnalysis} />}
    </main>}
    {joinLinkOpen && current?.joinToken && <JoinLinkDialog table={current} command={command} close={() => setJoinLinkOpen(false)} />}
    {settings && current && <TableSettings table={current} command={command} handOpen={handOpen} close={() => setSettings(false)} />}
    {interactions.overlays}
  </div>;
}
