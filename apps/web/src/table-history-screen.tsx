import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api, RequestFailure, retainNewestTable } from '@poker/client';
import { strategyToken, type ReplayStep, type StrategyDescriptor, type Street, type TableHandReplay, type TableMode } from '@poker/contracts';
import { Icon } from './icons.js';
import { Card } from './cards.js';
import { SeatGlyph } from './felt.js';
import { Skeleton } from './loading-skeleton.js';
import { usePageTitle, useShell } from './app-shell.js';
import { usePresentation } from './use-presentation.js';
import { handRows, historyStanding, returnBar, type HandRow } from './table-history.js';
import { comparedStrategies, historyPath, historySearch, listPath } from './table-address.js';
import { actedLabel, openStep, replayControls, stepKey, stepLabel, streetName } from './replay.js';
import { ReplayFelt } from './replay-felt.js';
import type { ReplayMove } from './replay-motion.js';
import { actionLabel, blindsLabel, modeLabel, tableFormat } from './table-model.js';
import { AnalysisDetails, DecisionResult, DecisionScores } from './analysis-panel.js';
import { AnalysisSkeleton, ScoreSkeleton } from './loading-skeleton.js';
import { strategyName } from './strategy-select.js';
import { useReplayComparison, useStrategyAnalysis } from './replay-analysis.js';
import { TableHistorySummaryPanel } from './table-history-summary.js';
import { addableStrategies, comparisonOrder, type ComparisonTarget } from './comparison.js';
import { ColumnHead } from './summary-comparison.js';

/** A link back to a table's own page. */
function TableLink({ mode, tableSessionId, className, children }: { mode: TableMode; tableSessionId: string; className?: string; children: React.ReactNode }) {
  return mode === 'online'
    ? <Link className={className} to="/online/$tableSessionId" params={{ tableSessionId }}>{children}</Link>
    : <Link className={className} to="/practice/$tableSessionId" params={{ tableSessionId }}>{children}</Link>;
}

/** A link into a table's Table History, at one Hand's replay when given, and at one of its Replay Steps. */
export function HistoryLink({ mode, tableSessionId, handId, step, className, label, children }: { mode: TableMode; tableSessionId: string; handId?: string; step?: string; className?: string; label?: string; children: React.ReactNode }) {
  const search = handId ? { hand: handId, ...(step ? { step } : {}) } : {};
  return mode === 'online'
    ? <Link className={className} aria-label={label} to="/online/$tableSessionId/history" params={{ tableSessionId }} search={search}>{children}</Link>
    : <Link className={className} aria-label={label} to="/practice/$tableSessionId/history" params={{ tableSessionId }} search={search}>{children}</Link>;
}

/** Whether the reader was dealt into a Hand: they may not have been at the table for one they were not. */
function DealtInTag({ dealtIn }: { dealtIn: boolean }) {
  return <span className={`history-tag${dealtIn ? ' is-dealt-in' : ''}`}>{dealtIn ? 'You were dealt in' : 'Not dealt in'}</span>;
}

/** One Hand of the list. Its number opens its replay; the whole row is the link's target. */
function HandEntry({ row, selected, mode, tableSessionId }: { row: HandRow; selected: boolean; mode: TableMode; tableSessionId: string }) {
  return <li id={row.key} className="history-hand" data-selected={selected ? '' : undefined} aria-current={selected ? 'true' : undefined}>
    <div className="history-hand-head">
      <h2><HistoryLink className="history-hand-link" mode={mode} tableSessionId={tableSessionId} handId={row.key}>{row.label}<Icon name="chevron" size={14} /></HistoryLink></h2>
      {row.completed && <span className="history-time numeric">{row.completed}</span>}
      <DealtInTag dealtIn={row.dealtIn} />
    </div>
    <div className="history-board" role="group" aria-label={row.board.length ? 'Final board' : 'No board was dealt'}>
      {row.board.length ? row.board.map(card => <Card key={card} card={card} small />) : <span className="history-muted">No board</span>}
    </div>
    <ul className="history-participants" aria-label="Dealt in">{row.participants.map(dealt => <li key={dealt.participantId}>
      <span className="history-participant-name">{dealt.name}</span>
      {dealt.cards && <span className="history-participant-cards" role="group" aria-label={`${dealt.name === 'You' ? 'Your' : `${dealt.name}’s`} cards`}>{dealt.cards.map(card => <Card key={card} card={card} small />)}</span>}
    </li>)}</ul>
    <p className="history-result"><strong>{row.result}</strong><span>{row.ending}</span></p>
  </li>;
}

const streets: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];

/**
 * One Strategy's analysis of the decision on show: its scores and its distribution, sizings and selected action. Its
 * pending, failed and Retry states are its own, so one Strategy failing leaves the others as they are.
 */
function StrategyColumn({ replay, target, reference, hub, step, onRemove }: { replay: TableHandReplay; target: ComparisonTarget; reference: boolean; hub: ReturnType<typeof useReplayComparison>['hub']; step: ReplayStep; onRemove: () => void }) {
  const analysis = useStrategyAnalysis(replay, target, reference, hub);
  const { display } = analysis;
  const data = display?.data;
  const complete = data?.status === 'complete' ? data : undefined;
  const failed = data?.status === 'error' ? data : undefined;
  const name = strategyName(target.strategy);
  const waiting = !complete && !failed && !display?.error;
  return <article className="strategy-column" aria-labelledby={`strategy-${strategyToken(target.strategy)}`} aria-busy={waiting || undefined}>
    <ColumnHead headingId={`strategy-${strategyToken(target.strategy)}`} name={name} reference={reference} onRemove={onRemove} level={4} />
    {display?.error ? <div className="notice-error" role="alert"><p>{display.error}</p><button type="button" onClick={analysis.request}>Retry analysis</button></div>
      : failed ? <div className="notice-error" role="alert"><strong>Analysis unavailable</strong><p>{failed.error.message}</p><button type="button" disabled={display?.retrying} onClick={analysis.retry}>{display?.retrying ? 'Retrying…' : 'Retry analysis'}</button></div>
      : <div className="strategy-body">
        <div className="strategy-scores">
          {complete?.scores ? <DecisionScores scores={complete.scores} /> : <div className="decision-scores" role="status" aria-label={`Loading the scores under ${name}`}><div className="score-main"><span>Decision Score</span><strong><ScoreSkeleton /><small>/100</small></strong></div><div className="score-secondary"><span>Action Rank Score</span><strong><ScoreSkeleton /><small>/100</small></strong></div></div>}
          {complete && <AnalysisDetails data={complete} />}
        </div>
        <div className="strategy-result">
          {complete ? <DecisionResult data={complete} reference={reference} /> : <AnalysisSkeleton actions={step.state.legalActions} scores={false} sampled={target.strategy.selector.id === 'seeded-sampling'} />}
        </div>
      </div>}
  </article>;
}

/**
 * The analysis of the reader's own decision at the step on show (Counterfactual Comparison): their Reference Strategy
 * first, then up to 3 more Strategies they add, each on the same frozen inputs. The action they took is shown once, above
 * them all. It sits under the step dock, so stepping never moves the felt or the controls. Only numbers: nothing here
 * calls a decision good or bad, and adding a Strategy never changes the Trainer Configuration.
 */
function ReplayAnalysis({ replay, analysis, step, compared, onCompare }: { replay: TableHandReplay; analysis: ReturnType<typeof useReplayComparison>; step: ReplayStep; compared: readonly StrategyDescriptor[]; onCompare: (strategies: readonly StrategyDescriptor[]) => void }) {
  const { reference, targets } = analysis;
  const street = streetName(step.state.street ?? 'preflop');
  const action = targets[0]?.action;
  const shown = reference ? comparisonOrder(reference, compared).slice(1) : [];
  const addable = reference ? addableStrategies(reference, compared) : [];
  return <section className="replay-analysis" aria-labelledby="replay-analysis-title">
    <header className="replay-analysis-head">
      <h3 id="replay-analysis-title">Your {street.toLowerCase()} decision</h3>
      {action && <p className="replay-your-action"><span>Your action</span><strong>{actionLabel(action)}</strong></p>}
    </header>
    {analysis.configurationError ? <div className="notice-error" role="alert"><p>Your Trainer Configuration couldn’t be read, so this decision can’t be analyzed yet.</p><button type="button" onClick={analysis.retryConfiguration}>Try again</button></div>
      : <>
        {reference && <div className="compare-bar">
          <label htmlFor="compare-add">Compare with</label>
          {addable.length > 0
            ? <select id="compare-add" value="" onChange={event => { const added = addable.find(strategy => strategyToken(strategy) === event.target.value); if (added) onCompare([...shown, added]); }}>
              <option value="">Add a Strategy…</option>
              {addable.map(strategy => <option key={strategyToken(strategy)} value={strategyToken(strategy)}>{strategyName(strategy)}</option>)}
            </select>
            : <span className="compare-full" id="compare-add">Every other Strategy is shown.</span>}
          <p>Same inputs and seeds for each. This doesn’t change your Trainer Configuration.</p>
        </div>}
        <div className="replay-strategies">
          {targets.map((target, position) => <StrategyColumn key={target.key} replay={replay} target={target} reference={position === 0} hub={analysis.hub} step={step} onRemove={() => onCompare(shown.filter(strategy => strategyToken(strategy) !== strategyToken(target.strategy)))} />)}
        </div>
      </>}
  </section>;
}

/**
 * One completed Hand, replayed one Replay Step at a time on the table's own felt. Back and Next (and the arrow keys) play
 * the step's motion, forward or reversed; a jump to a street or a decision, or a new address, draws its step at once. The address
 * holds the Hand and the step, so a reload reopens both. Under the felt, the step dock: what the step shows and what led
 * to it, Back and Next, a jump to each street the Hand reached, and to the reader's next decision. On a phone the dock
 * stays at the bottom of the screen while the felt is in view, so the cards and the controls are seen together.
 */
function HandReplay({ mode, tableSessionId, handId, step, compare }: { mode: TableMode; tableSessionId: string; handId: string; step: string | undefined; compare: string | undefined }) {
  const { identity } = useShell();
  const navigate = useNavigate();
  const section = useRef<HTMLElement>(null);
  // A completed Hand never changes, so its replay is read once.
  const read = useQuery({ queryKey: ['hand-replay', tableSessionId, handId], queryFn: ({ signal }) => api.readHandReplay(tableSessionId, handId, signal), enabled: identity.isSuccess, staleTime: Infinity });
  const replay = read.data;
  const index = replay ? openStep(replay, step) : 0;
  // The Strategies compared beside the Reference Strategy live in the address, so a reload reproduces the comparison.
  const compared = useMemo(() => comparedStrategies(compare), [compare]);
  const controls = replay && replayControls(replay, index);
  // How the reader asked for the step the address goes to next: Back and Next step, anything else jumps.
  const intent = useRef<{ readonly to: string; readonly how: ReplayMove }>(undefined);
  const go = (key: string | undefined, how: ReplayMove = 'jump') => {
    if (!key) return;
    intent.current = { to: key, how };
    void navigate({ href: historyPath(mode, tableSessionId, handId, key, compared), replace: true });
  };
  // Opening a Hand (this replay is keyed by it) brings its felt into view; stepping never scrolls.
  useEffect(() => { section.current?.scrollIntoView({ block: 'nearest' }); }, []);
  // The arrow keys step, unless a field or a menu has them.
  const keys = useRef({ previous: controls?.previous, next: controls?.next, go });
  keys.current = { previous: controls?.previous, next: controls?.next, go };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target instanceof Element && event.target.closest('input, select, textarea, [role="menu"], dialog'))) return;
      if (event.key === 'ArrowLeft' && keys.current.previous) { event.preventDefault(); keys.current.go(keys.current.previous, 'step'); }
      if (event.key === 'ArrowRight' && keys.current.next) { event.preventDefault(); keys.current.go(keys.current.next, 'step'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const notFound = read.error instanceof RequestFailure && read.error.code === 'hand-not-found';
  const row = replay && handRows([replay.hand], replay.viewerParticipantId)[0];
  const current = replay?.steps[index];
  const analysis = useReplayComparison(replay, index, compared);
  // Choosing Strategies changes the address only, at the step on show: never the Guest's Trainer Configuration.
  const changeCompared = (strategies: readonly StrategyDescriptor[]) => { if (current) void navigate({ href: historyPath(mode, tableSessionId, handId, stepKey(current, handId), strategies), replace: true }); };
  // What led to this step, and at the result who won.
  const happened = replay && current ? [actedLabel(replay, current), current.kind === 'result' ? row?.result : undefined].filter(Boolean).join(' · ') : '';
  return <section ref={section} className="replay" aria-labelledby="replay-title">
    <header className="replay-head">
      <h2 id="replay-title">{row?.label ?? (handId.startsWith('hand-') ? `Hand ${handId.slice(5)}` : 'Hand')}</h2>
      {row?.completed && <span className="history-time numeric">{row.completed}</span>}
      {row && <DealtInTag dealtIn={row.dealtIn} />}
      <HistoryLink className="replay-close" mode={mode} tableSessionId={tableSessionId}>All hands</HistoryLink>
    </header>
    {notFound ? <div className="replay-missing"><p>This hand isn’t in the table’s history yet. A hand can be replayed once it is complete.</p></div>
      : read.isError ? <div className="notice-error" role="alert"><p>{read.error.message}</p><button type="button" onClick={() => void read.refetch()}>Retry</button></div>
      : !replay || !current || !controls ? <div className="replay-skeleton" role="status" aria-label="Loading the replay"><div className="loading-oval" aria-hidden="true" /><div className="replay-dock" aria-hidden="true"><Skeleton className="skeleton-action" /></div></div>
      : <>
        <ReplayFelt replay={replay} index={index} move={intent.current?.to === stepKey(current, handId) ? intent.current.how : 'jump'} />
        <div className="replay-dock">
          <p className="replay-step" aria-live="polite">
            <strong>{stepLabel(replay, current)}</strong>
            {happened && <span className="replay-acted">{happened}</span>}
            <span className="replay-count numeric">Step {index + 1} of {replay.steps.length}</span>
          </p>
          <div className="replay-controls">
            <button type="button" className="replay-back" disabled={!controls.previous} onClick={() => go(controls.previous, 'step')} aria-keyshortcuts="ArrowLeft"><span className="replay-back-arrow"><Icon name="arrow" size={18} /></span>Back</button>
            <fieldset className="replay-streets" aria-label="Jump to a street">{streets.map(street => {
              const open = controls.streets.find(s => s.street === street);
              return <button type="button" key={street} className="replay-street" disabled={!open} aria-current={open?.current ? 'step' : undefined} onClick={() => go(open?.step)}>{streetName(street)}</button>;
            })}</fieldset>
            {replay.hand.viewerDealtIn && <button type="button" className="replay-mine" disabled={!controls.nextDecision} onClick={() => go(controls.nextDecision)}>{controls.nextDecision ? 'Your next decision' : 'No more decisions'}</button>}
            <button type="button" className="primary replay-next" disabled={!controls.next} onClick={() => go(controls.next, 'step')} aria-keyshortcuts="ArrowRight">Next<Icon name="arrow" size={18} /></button>
          </div>
        </div>
        {analysis.offered && <ReplayAnalysis key={index} replay={replay} analysis={analysis} step={current} compared={compared} onCompare={changeCompared} />}
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
 *
 * Anyone who has ever been a Participant at the table reads it, after leaving and at a Closed Table (ADR-0041). They
 * cannot read the live table, so the history itself names the table, and the screen says why they cannot play.
 */
export function TableHistoryScreen({ mode, tableSessionId }: { mode: TableMode; tableSessionId: string }) {
  const { identity } = useShell();
  const navigate = useNavigate();
  const { hand: selectedHand, step, compare } = historySearch(useSearch({ strict: false }));
  // The table's Score Summary is asked for explicitly; the Strategies compared in it live in the address.
  const [summarized, setSummarized] = useState(false);
  const comparedSummaries = useMemo(() => comparedStrategies(compare), [compare]);
  const compareSummaries = (strategies: readonly StrategyDescriptor[]) => void navigate({ href: historyPath(mode, tableSessionId, selectedHand, step, strategies), replace: true });
  // The shell's live connection keeps this table current; its view tells the viewer's turn and names the table.
  const read = useQuery({ queryKey: ['table-session', tableSessionId], queryFn: ({ signal }) => api.readSession(tableSessionId, signal), enabled: identity.isSuccess, structuralSharing: retainNewestTable });
  const table = read.data;
  const answered = read.isSuccess || read.isError;
  const completedHands = table?.view.history.filter(hand => hand.result).length;
  // A Hand that completes while the screen is open is read in: the key changes with the count.
  const list = useQuery({ queryKey: ['table-history', tableSessionId, completedHands], queryFn: ({ signal }) => api.readTableHistory(tableSessionId, signal), enabled: identity.isSuccess && answered, placeholderData: keepPreviousData });
  const presentation = usePresentation(table, table?.viewerParticipantId);
  const bar = table && presentation ? returnBar(table, presentation.serverNow) : undefined;
  // Only the history decides who may read it: a former Participant cannot read the live table, and is not refused here.
  const missing = list.error instanceof RequestFailure && list.error.code === 'not-found';
  const facts = list.data;
  const rows = useMemo(() => facts ? handRows(facts.hands, facts.viewerParticipantId) : undefined, [facts]);
  const standing = facts && historyStanding(facts);
  const tableMode = facts?.mode ?? table?.mode;
  const correctedTo = tableMode && tableMode !== mode ? historyPath(tableMode, tableSessionId, selectedHand, step, comparedStrategies(compare)) : undefined;
  useEffect(() => { if (correctedTo) void navigate({ href: correctedTo, replace: true }); }, [correctedTo, navigate]);
  const format = facts ? { seatCount: facts.seatCount, smallBlind: facts.stakes.smallBlind, bigBlind: facts.stakes.bigBlind } : table?.view.configuration;
  usePageTitle(format ? { page: 'history', seatCount: format.seatCount, smallBlind: format.smallBlind, bigBlind: format.bigBlind } : missing ? { page: 'missing-table' } : undefined);
  if (missing) return <main id="main-table" className="address-missing">
    <Icon name="cards" size={34} />
    <h1>This table doesn’t exist.</h1>
    <p>Check the address you were given. A table’s history opens only for the people who have played at it.</p>
    <Link className="primary address-missing-link" to={listPath(mode)}>Go to {modeLabel(mode)} tables <Icon name="arrow" size={18} /></Link>
  </main>;
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
        {standing?.kind === 'closed'
          ? <Link className="history-back" to={listPath(mode)}><span className="history-back-arrow"><Icon name="arrow" size={16} /></span>{modeLabel(mode)} tables</Link>
          : <TableLink className="history-back" mode={mode} tableSessionId={tableSessionId}><span className="history-back-arrow"><Icon name="arrow" size={16} /></span>{standing ? 'Return to table' : 'Back to table'}</TableLink>}
        <h1>Table History</h1>
        {format && tableMode && <p>{tableFormat(format.seatCount)} Hold’em · {blindsLabel(format.smallBlind, format.bigBlind)} · {modeLabel(tableMode)}{rows ? ` · ${rows.length} ${rows.length === 1 ? 'hand' : 'hands'}` : ''}</p>}
      </header>
      {standing && <div className={`history-standing is-${standing.kind}`} role="note"><Icon name={standing.kind === 'closed' ? 'lock' : 'exit'} size={18} /><div><strong>{standing.title}</strong><p>{standing.detail}</p></div></div>}
      {selectedHand && <HandReplay key={selectedHand} mode={mode} tableSessionId={tableSessionId} handId={selectedHand} step={step} compare={compare} />}
      {rows && rows.length > 0 && facts?.hands.some(hand => hand.viewerDealtIn) && <TableHistorySummaryPanel tableSessionId={tableSessionId} completedHands={completedHands} compared={comparedSummaries} onCompare={compareSummaries} asked={summarized} onAsk={() => setSummarized(true)} />}
      {list.isError && !missing && <div className="notice-error" role="alert"><p>{list.error.message}</p><button onClick={() => { if (read.isError) void read.refetch(); void list.refetch(); }}>Retry</button></div>}
      {!rows && !list.isError && <HistorySkeleton />}
      {rows?.length === 0 && <div className="ledger-empty"><SeatGlyph seats={format?.seatCount ?? 6} /><div><h3>No completed hands yet</h3><p>A Hand appears here as soon as it is complete.</p></div></div>}
      {rows && rows.length > 0 && <ol className="history-list" aria-label="Completed hands, newest first">{rows.map(row => <HandEntry key={row.key} row={row} selected={row.key === selectedHand} mode={mode} tableSessionId={tableSessionId} />)}</ol>}
    </main>
  </>;
}
