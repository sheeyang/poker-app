import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api, RequestFailure, retainNewestTable } from '@poker/client';
import type { TableMode } from '@poker/contracts';
import { Icon } from './icons.js';
import { usePageTitle, useShell } from './app-shell.js';
import { useSession } from './session.js';
import { analysisTabParam, joinPreviewWanted, listPath, tableAddress, type AnalysisTab } from './table-address.js';
import { usePracticeSetup } from './practice-setup.js';
import { PokerTable } from './poker-table.js';
import { ActionTray, CommandFeedback } from './controls.js';
import { TableSettings } from './settings.js';
import { JoinLinkDialog, JoinTable, JoinTableSkeleton } from './join-table.js';
import { handResult } from './hand-result.js';
import { nextHandLabel } from './online-status.js';
import { useTableInteractions } from './table-interactions.js';
import { openSeats, presentBindings } from './owner-controls.js';
import { participantActions } from './participant-actions.js';
import { ownershipChange } from './ownership.js';
import { useDecisionAnalysis } from './analysis.js';
import { useHandSummary, useTableSessionSummary } from './summaries.js';
import { AnalysisPanel, AnalysisPanelSkeleton } from './analysis-panel.js';
import { TableSkeleton } from './loading-skeleton.js';
import { SeatGlyph } from './felt.js';
import { actionLabel, chips, modeLabel, playerName } from './table-model.js';
import { usePresentation } from './use-presentation.js';
import { EASE, EASE_IN } from './motion.js';

/**
 * A table's own page, `/practice/<id>` or `/online/<id>`: the table named by the address, shown to its Participants.
 * An Online Table's address is its Join Link, so a Guest who is not at it gets the join form. Anyone else is told it
 * doesn't exist; a Participant who opened it under the other mode is moved to its one address.
 */
export function TableScreen({ mode, tableSessionId }: { mode: TableMode; tableSessionId: string }) {
  const selected = tableSessionId;
  const analysisOpen = useSession(s => s.analysisOpen);
  const [settings, setSettings] = useState<false | 'all'>(false), [joinLinkOpen, setJoinLinkOpen] = useState(false);
  const { identity, command, live, consumeLive } = useShell();
  const navigate = useNavigate(), queryClient = useQueryClient();
  const read = useQuery({ queryKey: ['table-session', selected], queryFn: ({ signal }) => api.readSession(selected, signal), enabled: identity.isSuccess, structuralSharing: retainNewestTable });
  const unread = read.error instanceof RequestFailure && read.error.code === 'not-found';
  // The table answers its Participants; only a visitor it turns away asks the Join Link what it opens.
  const preview = useQuery({ queryKey: ['join-preview', selected], queryFn: ({ signal }) => api.previewJoin(selected, signal), enabled: unread && joinPreviewWanted(mode, 'not-found') });
  const previewed = preview.error instanceof RequestFailure && (preview.error.code === 'not-found' || preview.error.code === 'table-closed')
    ? preview.error.code === 'not-found' ? 'not-found' : 'closed' : preview.data;
  const outcome = unread ? tableAddress(mode, selected, 'not-found', previewed) : read.data ? tableAddress(mode, selected, read.data) : undefined;
  const missing = outcome?.show === 'missing', closed = outcome?.show === 'closed';
  const correctedTo = outcome?.show === 'corrected' ? outcome.to : undefined;
  // The analysis tab lives in the address; choosing one replaces the history entry so Back still leaves the table.
  const addressTab = analysisTabParam(useSearch({ strict: false }).analysis);
  useEffect(() => { if (correctedTo) void navigate({ href: addressTab ? `${correctedTo}?analysis=${addressTab}` : correctedTo, replace: true }); }, [correctedTo, addressTab, navigate]);
  const chooseTab = useCallback((tab: AnalysisTab) => { void navigate({ to: '.', search: { analysis: tab }, replace: true }); }, [navigate]);
  // Only a table shown at its own address is on screen.
  const table = { ...read, data: outcome?.show === 'table' ? read.data : undefined, error: unread ? null : read.error };
  const analysis = useDecisionAnalysis(table.data, { tab: addressTab, choose: chooseTab }), summary = useHandSummary(table.data), sessionSummary = useTableSessionSummary(table.data);
  useEffect(() => consumeLive({
    onReady: lifecycle => { analysis.consumers.onReady?.(lifecycle); summary.consumers.onReady?.(lifecycle); sessionSummary.consumers.onReady?.(lifecycle); },
    onAnalysisUpdate: (update, lifecycle) => { analysis.consumers.onAnalysisUpdate?.(update, lifecycle); summary.consumers.onAnalysisUpdate?.(update, lifecycle); sessionSummary.consumers.onAnalysisUpdate?.(update, lifecycle); },
  }));
  useEffect(() => () => consumeLive(null), [consumeLive]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, []);
  // Opening a table, one this Guest is at and can see, tells the server: it keeps when, and orders the saved lists by it.
  const opened = outcome?.show === 'table';
  useEffect(() => { if (opened) void api.markOpened(selected).then(() => queryClient.invalidateQueries({ queryKey: ['table-sessions'] }), () => {}); }, [opened, selected, queryClient]);
  usePageTitle(missing ? { page: 'missing-table' } : closed ? { page: 'closed-table' } : table.data ? { page: 'table', ...table.data.view.configuration } : undefined);
  /** Joined through the Join Link: the same address is now the Guest's table, read and followed live. */
  async function joined() {
    // The form stays, its button busy, until the table can replace it.
    await queryClient.invalidateQueries({ queryKey: ['table-session', selected] });
    live.resubscribe();
    queryClient.removeQueries({ queryKey: ['join-preview', selected] });
    void queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
  }
  useEffect(() => { const generation = live.userChannel?.generation ?? null; analysis.connectionChanged(generation); summary.connectionChanged(generation); sessionSummary.connectionChanged(generation); }, [live.userChannel?.generation, analysis.connectionChanged, summary.connectionChanged, sessionSummary.connectionChanged]);
  const setup = usePracticeSetup(table.data, command);
  const preparing = setup?.tableId === selected && !!setup;
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
  // When the owner leaves and ownership passes, everyone still here is told who manages the table now.
  const [ownerNotice, setOwnerNotice] = useState<string>();
  const seenOwner = useRef<string>(undefined);
  const ownerId = current?.ownerParticipantId;
  const ownerView = useRef(current);
  ownerView.current = current;
  useEffect(() => {
    const view = ownerView.current;
    if (!view || !ownerId) return;
    const change = ownershipChange(seenOwner.current, view);
    seenOwner.current = ownerId;
    if (change) setOwnerNotice(change);
  }, [ownerId]);
  const watching = current ? presentBindings(current).filter(binding => !current.view.state.participants.some(p => p.participantId === binding.participantId && p.seat !== null)) : [];
  const interactions = useTableInteractions(current, command, handOpen);
  const onlineActions = online ? { chooseSeat: () => interactions.chooseSeats(), rebuy: interactions.rebuy, openJoinLink: () => setJoinLinkOpen(true), ...(owner && current && openSeats(current).length > 0 ? { addBot: () => interactions.chooseSeats() } : {}) } : undefined;
  const result = shown ? handResult(shown) : undefined;
  const nextHandShort = online && shown?.view.state.handId ? nextHandLabel(presentation?.nextHand) : undefined;
  function review(id?: string) {
    if (id) analysis.selectDecision(id);
    else if (handDecisions.length) analysis.selectView('hand');
    const opening = !useSession.getState().analysisOpen;
    useSession.setState({ analysisOpen: true });
    requestAnimationFrame(() => {
      const panel = document.getElementById('analysis-panel');
      // Opened, the panel slides in from the right edge; one already open stays put.
      if (opening) panel?.animate([{ translate: '60px 0', opacity: 0 }, { translate: '0 0', opacity: 1 }], { duration: 300, easing: EASE });
      panel?.focus({ preventScroll: true });
    });
  }
  const closing = useRef(false);
  function closeAnalysis() {
    const panel = document.getElementById('analysis-panel');
    const done = () => {
      closing.current = false;
      useSession.setState({ analysisOpen: false });
      requestAnimationFrame(() => document.getElementById('play-controls')?.focus({ preventScroll: true }));
    };
    if (!panel) { done(); return; }
    if (closing.current) return;
    closing.current = true;
    // It leaves the way it came, faster; the table takes the space once it has gone.
    panel.animate([{ translate: '0 0', opacity: 1 }, { translate: '40px 0', opacity: 0 }], { duration: 180, easing: EASE_IN, fill: 'forwards' }).onfinish = done;
  }
  if (outcome?.show === 'join-form' || outcome?.show === 'password-join-form') return <JoinTable tableSessionId={selected} preview={outcome.preview} joined={joined} />;
  if (unread && !outcome && !preview.error) return <JoinTableSkeleton />;
  // The Join Link answered, but not with the table: say why, and keep a way to try again when trying could help.
  if (unread && !outcome && preview.error) return <main id="main-table" className="address-missing">
    <Icon name="cards" size={34} />
    <h1>{'Couldn’t open this table.'}</h1>
    <p>{preview.error.message}</p>
    <div className="button-row address-missing-link">{!(preview.error instanceof RequestFailure && preview.error.definitive) && <button onClick={() => void preview.refetch()}>Try again</button>}<Link className="button-link" to={listPath(mode)}>Go to Online tables</Link></div>
  </main>;
  // A Closed Table: the empty felt, why nobody can open it, and the way back to the list where it is kept.
  if (closed) return <main id="main-table" className="address-missing address-closed">
    <SeatGlyph seats={0} dim />
    <h1>This table closed.</h1>
    <p>Nobody can join or play at it any more. An Online Table closes after 24 hours without play, or when its owner leaves with no one else at it. It stays in your Online tables.</p>
    <Link className="primary address-missing-link" to={listPath('online')}>Go to Online tables <Icon name="arrow" size={18} /></Link>
  </main>;
  if (missing) return <main id="main-table" className="address-missing">
    <Icon name="cards" size={34} />
    <h1>This table doesn’t exist.</h1>
    <p>Check the address you were given. A table opens only for the people at it.</p>
    <Link className="primary address-missing-link" to={listPath(mode)}>Go to {mode === 'online' ? 'Online' : 'Practice'} tables <Icon name="arrow" size={18} /></Link>
  </main>;
  return <>
    <main id="main-table" className={`play-workspace ${analysisOpen ? 'with-analysis' : ''}`}>
      <div className="play-area">
        <div className="table-notices">
          <CommandFeedback command={command} />
          {identity.isError && <div className="global-notice notice-error" role="alert"><div><strong>Couldn’t connect to the poker server.</strong><p>This table is still saved.</p></div><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
          {current && <>
            {live.connection !== 'connected' && <div className="connection-notice" role="status"><span>{live.connection === 'reconnecting' ? 'Reconnecting… Your confirmed table is still visible.' : 'Connecting live updates…'}</span><button onClick={() => void table.refetch()}>Refresh table</button></div>}
            {runtime?.phase === 'recovering' && <div className="notice-error" role="status"><strong>Confirming the last request.</strong><p>{runtime.message ?? 'This table is paused until its outcome is known.'}</p><button onClick={() => void table.refetch()}>Check table status</button></div>}
            {runtime?.phase === 'failed' && runtime.participantId && (current.mode === 'online'
              // At an Online Table the server has already played the Bot's Timeout Action: everyone is told, nobody repairs it mid-Hand.
              ? <div className="notice-error" role="status"><strong>{current.bindings.find(b => b.participantId === runtime.participantId)?.name ?? 'A bot'}’s decision failed.</strong><p>{runtime.message}</p></div>
              : <div className="notice-error" role="alert"><strong>A bot’s decision is paused.</strong><p>{runtime.message}</p><button disabled={command.busy} onClick={() => command.submit({ tableId: current.tableSessionId, kind: 'retry-bot', body: { requestId: crypto.randomUUID(), expectedSessionRevision: current.sessionRevision, participantId: runtime.participantId! } })}>Retry bot decision</button></div>)}
          </>}
          {ownerNotice && <div className="ownership-notice" role="status"><Icon name="info" size={18} /><span>{ownerNotice}</span><button type="button" className="text-button" onClick={() => setOwnerNotice(undefined)}>Dismiss</button></div>}
          {current && interactions.choosing && <div className="seat-selection-prompt"><span role="status">Choose an open seat{interactions.choosing === current.viewerParticipantId ? '.' : ` for ${current.bindings.find(b => b.participantId === interactions.choosing)?.name ?? 'the participant'}.`}</span><button className="text-button" onClick={interactions.cancelChoosing}>Cancel</button></div>}
        </div>
        <div className="table-toolbar"><div className="table-title"><h1>{current ? current.view.configuration.seatCount === 2 ? 'Heads-up' : `${current.view.configuration.seatCount}-player table` : 'Your table'}</h1><span>No-limit Hold’em{current ? ` · ${chips(current.view.configuration.smallBlind)} / ${chips(current.view.configuration.bigBlind)}` : ''}{online && !owner && ownerName ? ` · ${ownerName}’s table` : ''}</span>{current && <span className={`mode-badge mode-${current.mode}`}>{modeLabel(current.mode)}{current.options.actionTimeLimitSeconds ? ` · ${current.options.actionTimeLimitSeconds}s to act` : ''}</span>}</div><div className="toolbar-actions">{online && <button className="quiet-button" onClick={() => setJoinLinkOpen(true)}><Icon name="link" size={18} /><span>Join link</span></button>}{online && current && <button className="quiet-button" disabled={!participantActions(current, current.viewerParticipantId, handOpen).some(item => item.id === 'leave')} onClick={interactions.leave}><span>Leave table</span></button>}<button className="icon-button" disabled={!current || preparing} aria-label="Table options" onClick={() => setSettings('all')}><Icon name="settings" /></button></div></div>
        {!current && !table.error && !identity.isError && <TableSkeleton />}
        {table.error && <div className="table-error notice-error" role="alert"><h2>Couldn’t open this table.</h2><p>{table.error.message}</p><div className="button-row"><button onClick={() => void table.refetch()}>Retry</button><Link className="button-link" to={listPath(mode)}>Choose another table</Link></div></div>}
        {current && shown && presentation && <>
          <div className="hand-status">{!shown.view.state.handId && online
            // A Hand the viewer was not dealt into reaches them without its identity: they only see that one ended.
            ? <span><strong>{shown.view.state.status === 'completed-hand' ? 'Between hands' : 'No hands yet'}</strong></span>
            : <span><strong>{shown.view.state.handId ? `Hand ${String(handNumber).padStart(2, '0')}` : 'Your practice'}</strong><span className="status-separator">·</span>{shown.view.state.status === 'completed-hand' ? 'Complete' : shown.view.state.status === 'between-hands' ? 'Getting ready' : shown.view.state.street ? shown.view.state.street[0]!.toUpperCase() + shown.view.state.street.slice(1) : 'In play'}{result && <><span className="status-separator">·</span><span className="hand-status-result">{result.headline} {result.detail}</span></>}</span>}
            {/* The tray announces the next Hand; this is its glanceable echo beside the Hand it follows. */}
            {nextHandShort && <span className="hand-status-next" aria-hidden="true">{nextHandShort}</span>}</div>
          {preparing ? <section className="practice-preparing" role="status"><Icon name="cards" size={38} /><h2>{setup.paused ? 'Your setup is saved.' : setup.afterHandId === undefined ? 'Getting everyone to the table…' : 'Preparing the next hand…'}</h2><p>{setup.paused ?? (setup.afterHandId === undefined ? `${current.view.state.participants.filter(p => p.seat !== null).length} of ${current.bindings.length} players seated. Your hand starts next.` : 'Returning players and refilling empty stacks before the deal.')}</p>{setup.paused && <div className="button-row"><button className="primary" disabled={command.busy} onClick={() => { command.dismiss(); useSession.getState().setSetup({ ...setup, paused: undefined }); }}>Continue setup</button><button onClick={() => { useSession.getState().setSetup(null); setSettings('all'); }}>Table options</button></div>}</section> : <>
            <PokerTable table={shown} serverNow={presentation.serverNow} actorWindowOpen={presentation.actorWindowOpen} countdown={presentation.countdown} nextHand={presentation.nextHand} handOpen={handOpen} choosing={!!interactions.choosing} openSeat={interactions.openSeat} openParticipant={interactions.openParticipant} />

          </>}
          <div className="table-dock"><div className="table-dock-inner">
            {!preparing && <div id="play-controls" className="play-controls" data-timed={shown.options.actionTimeLimitSeconds ? '' : undefined} tabIndex={-1}><ActionTray table={shown} actionOpen={presentation.actionOpen} countdown={presentation.countdown} dealOpen={presentation.dealOpen} nextHand={presentation.nextHand} command={command} openSettings={() => interactions.chooseSeats()} review={review} online={onlineActions} /></div>}
          <div className="below-table">{watching.length > 0 && <p className="table-watchers"><span>Watching</span>{watching.map(binding => participantActions(current, binding.participantId, handOpen).length ? <button key={binding.participantId} className="watching-player" data-table-participant={binding.participantId} aria-label={`${playerName(current, binding)} actions`} aria-haspopup="menu" onClick={event => interactions.openParticipant(binding.participantId, event.currentTarget)}>{playerName(current, binding)}</button> : <span key={binding.participantId}>{playerName(current, binding)}</span>)}</p>}<details className="hand-activity"><summary>Hand activity{currentHistory ? <span>{currentHistory.decisions.length} actions</span> : null}</summary><ol>{currentHistory?.decisions.map(d => <li key={d.decisionId}><span>{d.state.street}</span><strong>{d.action.participantId === humanId ? 'You' : current.bindings.find(b => b.participantId === d.action.participantId)?.name}</strong><span>{actionLabel(d.action.action)}</span></li>)}</ol>{!currentHistory?.decisions.length && <p className="muted">Actions from this hand will appear here.</p>}</details></div>
          <footer className="table-footer"><span>All amounts in chips</span></footer>
          </div></div>
        </>}
      </div>
      {current && analysisOpen && !preparing && <AnalysisPanel table={current} analysis={analysis} summary={summary} sessionSummary={sessionSummary} command={command} close={closeAnalysis} />}
      {!current && analysisOpen && !table.error && !identity.isError && <AnalysisPanelSkeleton close={closeAnalysis} />}
      {(current || analysisOpen) && <button type="button" className="analysis-tab" aria-expanded={analysisOpen} aria-controls="analysis-panel" aria-label={analysisOpen ? 'Close analysis' : handDecisions.length ? 'Open analysis, review decisions' : 'Open analysis'} onClick={() => analysisOpen ? closeAnalysis() : review()}><Icon name="chart" size={18} /><span>Analysis</span><Icon name="chevron" size={14} /></button>}
    </main>
    {joinLinkOpen && online && current && <JoinLinkDialog table={current} close={() => setJoinLinkOpen(false)} />}
    {settings && current && <TableSettings table={current} command={command} handOpen={handOpen} close={() => setSettings(false)} />}
    {interactions.overlays}
  </>;
}
