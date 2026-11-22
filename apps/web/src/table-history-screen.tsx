import { useEffect, useMemo, useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api, RequestFailure, retainNewestTable } from '@poker/client';
import type { ReplayStep, Street, TableMode } from '@poker/contracts';
import { Icon } from './icons.js';
import { Card } from './cards.js';
import { SeatGlyph } from './felt.js';
import { Skeleton } from './loading-skeleton.js';
import { usePageTitle, useShell } from './app-shell.js';
import { usePresentation } from './use-presentation.js';
import { handRows, returnBar, type HandRow } from './table-history.js';
import { historyPath, historySearch, listPath } from './table-address.js';
import { PokerTable } from './poker-table.js';
import { actedLabel, openStep, replayControls, replayTable, stepLabel, streetName } from './replay.js';
import { actionLabel, blindsLabel, modeLabel, tableFormat } from './table-model.js';
import { AnalysisDetails, DecisionResult, DecisionScores } from './analysis-panel.js';
import { AnalysisSkeleton, ScoreSkeleton } from './loading-skeleton.js';
import { strategyName } from './strategy-select.js';
import { useReplayAnalysis } from './replay-analysis.js';

/** A link back to a table's own page. */
function TableLink({ mode, tableSessionId, className, children }: { mode: TableMode; tableSessionId: string; className?: string; children: React.ReactNode }) {
  return mode === 'online'
    ? <Link className={className} to="/online/$tableSessionId" params={{ tableSessionId }}>{children}</Link>
    : <Link className={className} to="/practice/$tableSessionId" params={{ tableSessionId }}>{children}</Link>;
}

/** A link into a table's Table History, at one Hand's replay when given, and at one of its Replay Steps. */
export function HistoryLink({ mode, tableSessionId, handId, step, className, children }: { mode: TableMode; tableSessionId: string; handId?: string; step?: string; className?: string; children: React.ReactNode }) {
  const search = handId ? { hand: handId, ...(step ? { step } : {}) } : {};
  return mode === 'online'
    ? <Link className={className} to="/online/$tableSessionId/history" params={{ tableSessionId }} search={search}>{children}</Link>
    : <Link className={className} to="/practice/$tableSessionId/history" params={{ tableSessionId }} search={search}>{children}</Link>;
}

/** One Hand of the list. Its number opens its replay; the whole row is the link's target. */
function HandEntry({ row, selected, mode, tableSessionId }: { row: HandRow; selected: boolean; mode: TableMode; tableSessionId: string }) {
  return <li id={row.key} className="history-hand" data-selected={selected ? '' : undefined} aria-current={selected ? 'true' : undefined}>
    <div className="history-hand-head">
      <h2><HistoryLink className="history-hand-link" mode={mode} tableSessionId={tableSessionId} handId={row.key}>{row.label}<Icon name="chevron" size={14} /></HistoryLink></h2>
      {row.completed && <span className="history-time numeric">{row.completed}</span>}
      <span className={`history-tag${row.dealtIn ? ' is-dealt-in' : ''}`}>{row.dealtIn ? 'You were dealt in' : 'You watched'}</span>
    </div>
    <div className="history-board" role="group" aria-label={row.board.length ? 'Final board' : 'No board was dealt'}>
      {row.board.length ? row.board.map(card => <Card key={card} card={card} small />) : <span className="history-muted">No board</span>}
    </div>
    <ul className="history-players" aria-label="Dealt in">{row.players.map(player => <li key={player.participantId}>
      <span className="history-player-name">{player.name}</span>
      {player.cards && <span className="history-player-cards" role="group" aria-label={`${player.name === 'You' ? 'Your' : `${player.name}’s`} cards`}>{player.cards.map(card => <Card key={card} card={card} small />)}</span>}
    </li>)}</ul>
    <p className="history-result"><strong>{row.result}</strong><span>{row.ending}</span></p>
  </li>;
}

const streets: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
const ignore = () => {};

/**
 * The analysis of the reader's own decision at the step on show, under their current Reference Strategy: the scores
 * and their action beside the Reference Policy's distribution, sizings and action. It sits under the step dock, so
 * stepping never moves the felt or the controls. Only numbers: nothing here calls a decision good or bad.
 */
function ReplayAnalysis({ analysis, step }: { analysis: ReturnType<typeof useReplayAnalysis>; step: ReplayStep }) {
  const { decision, display } = analysis;
  const data = display?.data;
  const complete = data?.status === 'complete' ? data : undefined;
  const failed = data?.status === 'error' ? data : undefined;
  const reference = data?.referenceStrategy ?? analysis.reference;
  const street = streetName(step.state.street ?? 'preflop');
  const waiting = !complete && !failed && !display?.error && !analysis.configurationError;
  return <section className="replay-analysis" aria-labelledby="replay-analysis-title" aria-busy={waiting || undefined}>
    <header className="replay-analysis-head">
      <h3 id="replay-analysis-title">Your {street.toLowerCase()} decision</h3>
      {reference && <span className="replay-analysis-reference">Reference: <strong>{strategyName(reference)}</strong></span>}
    </header>
    {analysis.configurationError ? <div className="notice-error" role="alert"><p>Your Trainer Configuration couldn’t be read, so this decision can’t be analyzed yet.</p><button type="button" onClick={analysis.retryConfiguration}>Try again</button></div>
      : display?.error ? <div className="notice-error" role="alert"><p>{display.error}</p><button type="button" onClick={analysis.request}>Retry analysis</button></div>
      : failed ? <div className="notice-error" role="alert"><strong>Analysis unavailable</strong><p>{failed.error.message}</p><button type="button" disabled={display?.retrying} onClick={analysis.retry}>{display?.retrying ? 'Retrying…' : 'Retry analysis'}</button></div>
      : <div className="replay-analysis-body">
        <div className="replay-analysis-mine">
          {complete?.scores ? <DecisionScores scores={complete.scores} /> : <div className="decision-scores" role="status" aria-label="Loading your scores"><div className="score-main"><span>Decision Score</span><strong><ScoreSkeleton /><small>/100</small></strong></div><div className="score-secondary"><span>Action Rank Score</span><strong><ScoreSkeleton /><small>/100</small></strong></div></div>}
          {decision && <p className="replay-your-action"><span>Your action</span><strong>{actionLabel(decision.action)}</strong></p>}
          {complete && <AnalysisDetails data={complete} />}
        </div>
        <div className="replay-analysis-reference-side">
          {complete ? <DecisionResult data={complete} /> : <AnalysisSkeleton actions={step.state.legalActions} scores={false} sampled={reference?.selector.id === 'seeded-sampling'} />}
        </div>
      </div>}
  </section>;
}

/**
 * One completed Hand, replayed one Replay Step at a time on the table's own felt, each step drawn at once. The address
 * holds the Hand and the step, so a reload reopens both. Under the felt, the step dock: what the step shows and what led
 * to it, Back and Next, a jump to each street the Hand reached, and to the reader's next decision. On a phone the dock
 * stays at the bottom of the screen while the felt is in view, so the cards and the controls are seen together.
 */
function HandReplay({ mode, tableSessionId, handId, step }: { mode: TableMode; tableSessionId: string; handId: string; step: string | undefined }) {
  const { identity } = useShell();
  const navigate = useNavigate();
  const section = useRef<HTMLElement>(null);
  // A completed Hand never changes, so its replay is read once.
  const read = useQuery({ queryKey: ['hand-replay', tableSessionId, handId], queryFn: ({ signal }) => api.readHandReplay(tableSessionId, handId, signal), enabled: identity.isSuccess, staleTime: Infinity });
  const replay = read.data;
  const index = replay ? openStep(replay, step) : 0;
  const controls = replay && replayControls(replay, index);
  const go = (key: string | undefined) => { if (key) void navigate({ href: historyPath(mode, tableSessionId, handId, key), replace: true }); };
  // Opening a Hand (this replay is keyed by it) brings its felt into view; stepping never scrolls.
  useEffect(() => { section.current?.scrollIntoView({ block: 'nearest' }); }, []);
  // The arrow keys step, unless a field or a menu has them.
  const keys = useRef({ previous: controls?.previous, next: controls?.next, go });
  keys.current = { previous: controls?.previous, next: controls?.next, go };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target instanceof Element && event.target.closest('input, select, textarea, [role="menu"], dialog'))) return;
      if (event.key === 'ArrowLeft' && keys.current.previous) { event.preventDefault(); keys.current.go(keys.current.previous); }
      if (event.key === 'ArrowRight' && keys.current.next) { event.preventDefault(); keys.current.go(keys.current.next); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const notFound = read.error instanceof RequestFailure && read.error.code === 'hand-not-found';
  const row = replay && handRows([replay.hand], replay.viewerParticipantId)[0];
  const current = replay?.steps[index];
  const analysis = useReplayAnalysis(replay, index);
  const felt = useMemo(() => replay?.steps[index] ? replayTable(replay, index) : undefined, [replay, index]);
  // What led to this step, and at the result who won.
  const happened = replay && current ? [actedLabel(replay, current), current.kind === 'result' ? row?.result : undefined].filter(Boolean).join(' · ') : '';
  return <section ref={section} className="replay" aria-labelledby="replay-title">
    <header className="replay-head">
      <h2 id="replay-title">{row?.label ?? (handId.startsWith('hand-') ? `Hand ${handId.slice(5)}` : 'Hand')}</h2>
      {row?.completed && <span className="history-time numeric">{row.completed}</span>}
      {row && <span className={`history-tag${row.dealtIn ? ' is-dealt-in' : ''}`}>{row.dealtIn ? 'You were dealt in' : 'You watched'}</span>}
      <HistoryLink className="replay-close" mode={mode} tableSessionId={tableSessionId}>All hands</HistoryLink>
    </header>
    {notFound ? <div className="replay-missing"><p>This hand isn’t in the table’s history yet. A hand can be replayed once it is complete.</p></div>
      : read.isError ? <div className="notice-error" role="alert"><p>{read.error.message}</p><button type="button" onClick={() => void read.refetch()}>Retry</button></div>
      : !replay || !current || !controls || !felt ? <div className="replay-skeleton" role="status" aria-label="Loading the replay"><div className="loading-oval" aria-hidden="true" /><div className="replay-dock" aria-hidden="true"><Skeleton className="skeleton-action" /></div></div>
      : <>
        <PokerTable replay table={felt} serverNow={Date.now()} actorWindowOpen={current.kind === 'decision'} handOpen={false} choosing={false} openSeat={ignore} openParticipant={ignore} />
        <div className="replay-dock">
          <p className="replay-step" aria-live="polite">
            <strong>{stepLabel(replay, current)}</strong>
            {happened && <span className="replay-acted">{happened}</span>}
            <span className="replay-count numeric">Step {index + 1} of {replay.steps.length}</span>
          </p>
          <div className="replay-controls">
            <button type="button" className="replay-back" disabled={!controls.previous} onClick={() => go(controls.previous)} aria-keyshortcuts="ArrowLeft"><span className="replay-back-arrow"><Icon name="arrow" size={18} /></span>Back</button>
            <fieldset className="replay-streets" aria-label="Jump to a street">{streets.map(street => {
              const open = controls.streets.find(s => s.street === street);
              return <button type="button" key={street} className="replay-street" disabled={!open} aria-current={open?.current ? 'step' : undefined} onClick={() => go(open?.step)}>{streetName(street)}</button>;
            })}</fieldset>
            {replay.hand.viewerDealtIn && <button type="button" className="replay-mine" disabled={!controls.nextDecision} onClick={() => go(controls.nextDecision)}>{controls.nextDecision ? 'Your next decision' : 'No more decisions'}</button>}
            <button type="button" className="primary replay-next" disabled={!controls.next} onClick={() => go(controls.next)} aria-keyshortcuts="ArrowRight">Next<Icon name="arrow" size={18} /></button>
          </div>
        </div>
        {analysis.offered && <ReplayAnalysis key={index} analysis={analysis} step={current} />}
      </>}
  </section>;
}

function HistorySkeleton() {
  return <div className="history-list" role="status" aria-label="Loading Table History"><div aria-hidden="true">{[0, 1, 2].map(i => <div className="history-hand history-hand-skeleton" key={i}><Skeleton className="skeleton-hand-status" /><Skeleton className="skeleton-action" /><Skeleton className="skeleton-action" /></div>)}</div></div>;
}

/**
 * A table's Table History, `/practice/<id>/history` or `/online/<id>/history`: every completed Hand of the Table
 * Session, newest first, as the viewer may see it. It is its own screen, so opening it from a live table leaves play:
 * while the viewer is seated, a "Your turn" bar follows them here whenever their Action Window opens, with their Action
 * Deadline running beside it. A Hand opens from its row into its replay, above the list, at the step its address names.
 */
export function TableHistoryScreen({ mode, tableSessionId }: { mode: TableMode; tableSessionId: string }) {
  const { identity } = useShell();
  const navigate = useNavigate();
  const { hand: selectedHand, step } = historySearch(useSearch({ strict: false }));
  // The shell's live connection keeps this table current; its view tells the viewer's turn and names the table.
  const read = useQuery({ queryKey: ['table-session', tableSessionId], queryFn: ({ signal }) => api.readSession(tableSessionId, signal), enabled: identity.isSuccess, structuralSharing: retainNewestTable });
  const table = read.data;
  const answered = read.isSuccess || read.isError;
  const completedHands = table?.view.history.filter(hand => hand.result).length;
  // A Hand that completes while the screen is open is read in: the key changes with the count.
  const list = useQuery({ queryKey: ['table-history', tableSessionId, completedHands], queryFn: ({ signal }) => api.readTableHistory(tableSessionId, signal), enabled: identity.isSuccess && answered, placeholderData: keepPreviousData });
  const presentation = usePresentation(table, table?.viewerParticipantId);
  const bar = table && presentation ? returnBar(table, presentation.serverNow) : undefined;
  const missing = (read.error instanceof RequestFailure && read.error.code === 'not-found') || (list.error instanceof RequestFailure && list.error.code === 'not-found');
  const rows = useMemo(() => list.data ? handRows(list.data.hands, list.data.viewerParticipantId) : undefined, [list.data]);
  const correctedTo = table && table.mode !== mode ? historyPath(table.mode, tableSessionId, selectedHand, step) : undefined;
  useEffect(() => { if (correctedTo) void navigate({ href: correctedTo, replace: true }); }, [correctedTo, navigate]);
  usePageTitle(table ? { page: 'history', ...table.view.configuration } : missing ? { page: 'missing-table' } : undefined);
  if (missing) return <main id="main-table" className="address-missing">
    <Icon name="cards" size={34} />
    <h1>This table doesn’t exist.</h1>
    <p>Check the address you were given. A table’s history opens only for the people who have played at it.</p>
    <Link className="primary address-missing-link" to={listPath(mode)}>Go to {modeLabel(mode)} tables <Icon name="arrow" size={18} /></Link>
  </main>;
  const configuration = table?.view.configuration;
  return <>
    {bar && <aside className="live-strip is-turn history-return" aria-label="Your turn">
      <span className="live-strip-dot" aria-hidden="true" />
      <p className="live-strip-facts"><strong aria-live="polite">Your turn — return</strong>
        {bar.countdown !== undefined && <span className={`history-deadline numeric${bar.countdown <= 5 ? ' deadline-near' : ''}`} role="timer"><strong>{bar.countdown > 0 ? `${bar.countdown}s` : 'Time’s up'}</strong>{bar.countdown > 0 ? ' to act' : ''}</span>}
      </p>
      <div className="live-strip-actions"><TableLink className="live-strip-back" mode={mode} tableSessionId={tableSessionId}>Return to table<Icon name="arrow" size={16} /></TableLink></div>
    </aside>}
    <main id="main-table" className="history-page">
      <header className="history-heading">
        <TableLink className="history-back" mode={mode} tableSessionId={tableSessionId}><span className="history-back-arrow"><Icon name="arrow" size={16} /></span>Back to table</TableLink>
        <h1>Table History</h1>
        {configuration && table && <p>{tableFormat(configuration.seatCount)} Hold’em · {blindsLabel(configuration.smallBlind, configuration.bigBlind)} · {modeLabel(table.mode)}{rows ? ` · ${rows.length} ${rows.length === 1 ? 'hand' : 'hands'}` : ''}</p>}
      </header>
      {selectedHand && <HandReplay key={selectedHand} mode={mode} tableSessionId={tableSessionId} handId={selectedHand} step={step} />}
      {(read.isError || list.isError) && !table && <div className="notice-error" role="alert"><p>{(list.error ?? read.error)?.message}</p><button onClick={() => { void read.refetch(); void list.refetch(); }}>Retry</button></div>}
      {list.isError && table && <div className="notice-error" role="alert"><p>{list.error.message}</p><button onClick={() => void list.refetch()}>Retry</button></div>}
      {!rows && !list.isError && !(read.isError && !table) && <HistorySkeleton />}
      {rows?.length === 0 && <div className="ledger-empty"><SeatGlyph seats={configuration?.seatCount ?? 6} /><div><h3>No completed hands yet</h3><p>A Hand appears here as soon as it is complete.</p></div></div>}
      {rows && rows.length > 0 && <ol className="history-list" aria-label="Completed hands, newest first">{rows.map(row => <HandEntry key={row.key} row={row} selected={row.key === selectedHand} mode={mode} tableSessionId={tableSessionId} />)}</ol>}
    </main>
  </>;
}
