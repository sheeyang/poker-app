import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '@poker/client';
import { decisionActionTypes, decisionStreets, hasScoreFilter, historyFilterParams, historyFilterSize, withoutScoreFilter, historyModes, positions, type DecisionActionType, type HistoryBreakdown, type HistoryFilter, type Position, type Street, type TableMode } from '@poker/contracts';
import { Icon } from './icons.js';
import { Card } from './cards.js';
import { Skeleton } from './loading-skeleton.js';
import { SeatGlyph } from './felt.js';
import { usePageTitle, useShell } from './app-shell.js';
import { HistoryLink } from './table-history-screen.js';
import { breakdownOfSearch, clearedFilter, dateInputValue, dayEndMs, dayStartMs, decisionRow, filterOfSearch, percentScore, rangedBy, scoredFigures, scorePercent, searchOfFilter, toggled, withBreakdown, type DecisionRow } from './overall-history.js';
import { OverallHistorySummaryPanel } from './overall-history-summary.js';
import { streetName } from './replay.js';
import { modeLabel } from './table-model.js';

const pageSize = 50;
const actionNames: Readonly<Record<DecisionActionType, string>> = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' };

/** A group of values to choose among; every one chosen shows the decisions that match any of them. Each applies at once. */
function Choices<V extends string>({ legend, values, chosen, label, onToggle }: { legend: string; values: readonly V[]; chosen: readonly V[] | undefined; label: (value: V) => string; onToggle: (value: V) => void }) {
  return <fieldset className="og-group">
    <legend>{legend}</legend>
    <div className="og-chips">{values.map(value => {
      const on = chosen?.includes(value) ?? false;
      return <button key={value} type="button" className="og-chip" aria-pressed={on} onClick={() => onToggle(value)}>{label(value)}</button>;
    })}</div>
  </fieldset>;
}

/**
 * A field that holds what is typed until it makes sense: a half-typed "1." stays as typed, and only a whole value is
 * applied. It follows the address when that changes underneath it (Clear filters, Back).
 */
function RangeField({ id, label, kind, value, onChange, suffix }: { id: string; label: string; kind: 'date' | 'number'; value: string; onChange: (next: string) => void; suffix?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(current => (kind === 'number' ? (current === '' ? value === '' : Number(current) === Number(value)) : current === value) ? current : value); }, [value, kind]);
  return <div className="og-field">
    <label htmlFor={id}>{label}</label>
    <span className="og-input">
      <input id={id} type={kind} inputMode={kind === 'number' ? 'decimal' : undefined} min={kind === 'number' ? 0 : undefined} step={kind === 'number' ? 'any' : undefined} value={draft}
        onChange={event => { setDraft(event.target.value); onChange(event.target.value); }} />
      {suffix && <span aria-hidden="true">{suffix}</span>}
    </span>
  </div>;
}

function Filters({ filter, onChange, shown, total, waiting }: { filter: HistoryFilter; onChange: (next: HistoryFilter) => void; shown: number | undefined; total: number | undefined; waiting?: string }) {
  const number = (text: string) => text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 ? Number(text) : undefined;
  const size = historyFilterSize(filter);
  // Open where there is room, and wherever a filter is already set; a phone starts with the list in view.
  const [open, setOpen] = useState(() => size > 0 || window.matchMedia('(min-width: 861px)').matches);
  return <section className="og-filters" aria-label="Filters">
    <div className="og-filters-head">
      <button type="button" className="og-toggle" aria-expanded={open} aria-controls="og-filters-body" onClick={() => setOpen(!open)}><Icon name="settings" size={18} />Filters{size > 0 && <span className="og-count numeric">{size}</span>}<span className="og-toggle-chevron" aria-hidden="true"><Icon name="chevron" size={14} /></span></button>
      <p role="status" aria-live="polite">{shown === undefined ? waiting ?? 'Reading your decisions…' : <><strong className="numeric">{total!.toLocaleString('en')}</strong> {total === 1 ? 'decision' : 'decisions'}</>}</p>
      {size > 0 && <button type="button" className="og-clear" onClick={() => onChange(clearedFilter())}>Clear filters</button>}
    </div>
    {open && <div id="og-filters-body" className="og-filters-grid">
      <Choices legend="Street" values={decisionStreets} chosen={filter.street} label={value => streetName(value)} onToggle={(value: Street) => onChange(toggled(filter, 'street', value))} />
      <Choices legend="Action" values={decisionActionTypes} chosen={filter.action} label={value => actionNames[value]} onToggle={(value: DecisionActionType) => onChange(toggled(filter, 'action', value))} />
      <Choices legend="Table" values={historyModes} chosen={filter.mode} label={value => modeLabel(value)} onToggle={(value: TableMode) => onChange(toggled(filter, 'mode', value))} />
      <Choices legend="Position" values={positions} chosen={filter.position} label={value => value} onToggle={(value: Position) => onChange(toggled(filter, 'position', value))} />
      <fieldset className="og-group og-range">
        <legend>Completed</legend>
        <div className="og-fields">
          <RangeField id="og-from" label="From" kind="date" value={dateInputValue(filter.completed?.min)} onChange={text => onChange(rangedBy(filter, 'completed', 'min', dayStartMs(text)))} />
          <RangeField id="og-to" label="To" kind="date" value={dateInputValue(filter.completed?.max)} onChange={text => onChange(rangedBy(filter, 'completed', 'max', dayEndMs(text)))} />
        </div>
        {filter.completed && <p className="og-hint">Hands completed before dates were recorded have no date, so they are left out.</p>}
      </fieldset>
      <fieldset className="og-group og-range">
        <legend>Pot faced, in big blinds</legend>
        <div className="og-fields">
          <RangeField id="og-pot-min" label="At least" kind="number" suffix="BB" value={filter.pot?.min === undefined ? '' : String(filter.pot.min)} onChange={text => onChange(rangedBy(filter, 'pot', 'min', number(text)))} />
          <RangeField id="og-pot-max" label="At most" kind="number" suffix="BB" value={filter.pot?.max === undefined ? '' : String(filter.pot.max)} onChange={text => onChange(rangedBy(filter, 'pot', 'max', number(text)))} />
        </div>
      </fieldset>
      <fieldset className="og-group og-range og-scores">
        <legend>Score, out of 100</legend>
        <div className="og-fields">
          <RangeField id="og-ds-min" label="Decision Score, at least" kind="number" suffix="%" value={scorePercent(filter.decisionScore?.min)} onChange={text => onChange(rangedBy(filter, 'decisionScore', 'min', percentScore(text)))} />
          <RangeField id="og-ds-max" label="Decision Score, at most" kind="number" suffix="%" value={scorePercent(filter.decisionScore?.max)} onChange={text => onChange(rangedBy(filter, 'decisionScore', 'max', percentScore(text)))} />
          <RangeField id="og-ar-min" label="Action Rank Score, at least" kind="number" suffix="%" value={scorePercent(filter.actionRankScore?.min)} onChange={text => onChange(rangedBy(filter, 'actionRankScore', 'min', percentScore(text)))} />
          <RangeField id="og-ar-max" label="Action Rank Score, at most" kind="number" suffix="%" value={scorePercent(filter.actionRankScore?.max)} onChange={text => onChange(rangedBy(filter, 'actionRankScore', 'max', percentScore(text)))} />
        </div>
        <p className="og-hint">Scores are against your Reference Strategy, so a score filter waits for every decision it covers to be analyzed.</p>
      </fieldset>
    </div>}
  </section>;
}

function DecisionEntry({ row }: { row: DecisionRow }) {
  const { link } = row;
  return <li className="og-item">
    <HistoryLink className="og-row" mode={link.mode} tableSessionId={link.tableSessionId} handId={link.handId} step={link.step} label={`${row.handLabel}, ${row.street}, ${row.position}, ${row.action}, pot ${row.pot}. Open at this decision in the replay.`}>
      <span className="og-hand">
        <strong>{row.handLabel}</strong>
        <span className="og-table">{row.table}</span>
        {row.completed && <span className="og-time numeric">{row.completed}</span>}
      </span>
      <span className="og-cards" aria-hidden="true">
        <span className="og-hole">{row.holeCards.map(card => <Card key={card} card={card} small />)}</span>
        <span className="og-board">{row.board.length ? row.board.map(card => <Card key={card} card={card} small />) : <span className="history-muted">Preflop</span>}</span>
      </span>
      <span className="og-situation"><span className="history-tag">{row.street}</span><span className="history-tag is-dealt-in">{row.position}</span></span>
      <span className="og-decision"><strong>{row.action}</strong><span className="numeric">Pot {row.pot}</span></span>
      <span className="og-open" aria-hidden="true"><Icon name="chevron" size={16} /></span>
    </HistoryLink>
  </li>;
}

/**
 * The decisions a filter with score ranges admits, under the Reference Strategy. Asking starts the analyses; the state is
 * read each second while Analyzing, and the list arrives only once every analysis has succeeded. `limit` grows with Show more.
 */
function useScoredHistory(filter: HistoryFilter, enabled: boolean, limit: number) {
  const queryClient = useQueryClient();
  const key = JSON.stringify(historyFilterParams(filter));
  const created = useQuery({ queryKey: ['overall-history-scored', key], enabled, staleTime: Number.POSITIVE_INFINITY, gcTime: 0, retry: false, queryFn: () => api.askScoredOverallHistory(filter, { limit: pageSize }) });
  const requestId = created.data?.requestId;
  const current = useQuery({
    queryKey: ['overall-history-scored-state', requestId, limit], enabled: !!requestId, retry: false, placeholderData: keepPreviousData,
    initialData: limit === pageSize ? created.data : undefined,
    refetchInterval: query => query.state.data?.status === 'pending' && !query.state.error ? 1000 : false,
    queryFn: ({ signal }) => api.readScoredOverallHistory(requestId!, { limit }, signal),
  });
  const retry = useMutation({ mutationFn: (id: string) => api.retryScoredOverallHistory(id, { limit }), onSuccess: next => queryClient.setQueryData(['overall-history-scored-state', next.requestId, limit], next) });
  const data = enabled ? current.data ?? created.data : undefined;
  return { data, error: created.error ?? current.error ?? retry.error, retrying: retry.isPending, retry: () => { if (data) retry.mutate(data.requestId); }, again: () => { retry.reset(); void created.refetch(); } };
}

/** What stands in for the list while a score range waits on its analyses: Analyzing with progress, Error with Retry, or a failed request. */
function ScoredState({ scored }: { scored: ReturnType<typeof useScoredHistory> }) {
  const { data } = scored;
  const figures = scoredFigures(data);
  if (scored.error && !data) return <div className="notice-error" role="alert"><p>{scored.error.message}</p><button type="button" onClick={scored.again}>Ask again</button></div>;
  if (data?.status === 'error') return <div className="notice-error" role="alert">
    <p>Some analyses failed, so there is no list for these scores. {data.progress.succeeded.toLocaleString('en')} of {data.progress.total.toLocaleString('en')} succeeded; Retry analyzes only the failed ones again.</p>
    <button type="button" disabled={scored.retrying} onClick={scored.retry}>{scored.retrying ? 'Retrying…' : 'Retry'}</button>
  </div>;
  return <div className="og-analyzing" role="status" aria-live="polite">
    <p><strong className="numeric">{figures.state}</strong></p>
    <progress max={data?.progress.total || 1} value={data?.progress.succeeded ?? 0} aria-label="Analyses succeeded" />
    <p className="og-hint">Score filters apply once every decision in the set has been analyzed. Nothing is listed until then.</p>
  </div>;
}

function ListSkeleton() {
  return <div className="history-list" role="status" aria-label="Loading your decisions"><div aria-hidden="true">{[0, 1, 2, 3].map(i => <div className="og-row og-row-skeleton" key={i}><Skeleton className="skeleton-hand-status" /><Skeleton className="skeleton-action" /><Skeleton className="skeleton-action" /></div>)}</div></div>;
}

/**
 * Overall History (ADR-0041): the Guest's own decisions from every Hand they were dealt into, at every table they can
 * read. The filters apply at once and live in the address, so a reload keeps them; each decision opens at its Replay
 * Step in its table's Table History. A Score Summary over the decisions shown, and its breakdown, sits above them;
 * the breakdown lives in the address too. A score range waits on the analyses of the decisions the other filters admit.
 */
export function OverallHistoryScreen() {
  const { identity } = useShell();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const filter = useMemo(() => filterOfSearch(search), [search]);
  const breakdown = breakdownOfSearch(search);
  // A summary is asked for explicitly; once asked, a new filter or breakdown asks again.
  const [summarized, setSummarized] = useState(false);
  const key = JSON.stringify(searchOfFilter(filter));
  usePageTitle({ page: 'overall-history' });
  // The non-score restrictions decide the list on their own; a score range then needs the analyses of that set.
  const scoreFilter = hasScoreFilter(filter);
  const plain = useMemo(() => withoutScoreFilter(filter), [filter]);
  const [scoredLimit, setScoredLimit] = useState(pageSize);
  useEffect(() => setScoredLimit(pageSize), [key]);
  const scored = useScoredHistory(filter, identity.isSuccess && scoreFilter, scoredLimit);
  const list = useInfiniteQuery({
    queryKey: ['overall-history', JSON.stringify(searchOfFilter(plain))], enabled: identity.isSuccess, placeholderData: keepPreviousData, initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.readOverallHistory(plain, { limit: pageSize, offset: pageParam }, signal),
    getNextPageParam: last => last.offset + last.decisions.length < last.total ? last.offset + last.decisions.length : undefined,
  });
  const scoredList = scored.data?.status === 'complete' ? scored.data : undefined;
  const rows = useMemo(() => scoreFilter ? scoredList?.decisions.map(decisionRow) : list.data?.pages.flatMap(page => page.decisions.map(decisionRow)), [scoreFilter, scoredList, list.data]);
  const setSize = list.data?.pages[0]?.total;
  const total = scoreFilter ? scoredList?.total : setSize;
  const figures = scoredFigures(scored.data);
  const show = (next: HistoryFilter, by: HistoryBreakdown | undefined) => void navigate({ to: '/history', search: withBreakdown(searchOfFilter(next), by), replace: true });
  const apply = (next: HistoryFilter) => show(next, breakdown);
  const filtered = historyFilterSize(filter) > 0;
  return <main id="main-table" className="history-page og-page">
    <header className="history-heading">
      <h1>History</h1>
      <p>Your decisions in every Hand you were dealt into, at every table you can read: Practice, tables you left, and Closed Tables.</p>
    </header>
    <Filters filter={filter} onChange={apply} shown={rows?.length} total={total} waiting={scoreFilter ? figures.state : undefined} />
    <OverallHistorySummaryPanel filter={plain} breakdown={breakdown} total={setSize} scoreRanges={scoreFilter} asked={summarized} onAsk={() => setSummarized(true)} onBreakdown={by => show(filter, by)} />
    {scoreFilter && !scoredList && <ScoredState scored={scored} />}
    {!scoreFilter && list.isError && <div className="notice-error" role="alert"><p>{list.error.message}</p><button type="button" onClick={() => void list.refetch()}>Retry</button></div>}
    {!rows && !scoreFilter && !list.isError && <ListSkeleton />}
    {rows?.length === 0 && (filtered
      ? <div className="ledger-empty"><SeatGlyph seats={6} /><div><h3>No decisions match these filters</h3><p>Loosen a filter to see more.</p></div><button type="button" className="og-clear" onClick={() => apply(clearedFilter())}>Clear filters</button></div>
      : <div className="ledger-empty"><SeatGlyph seats={6} /><div><h3>No decisions yet</h3><p>Decisions you make in a Hand appear here once the Hand is complete.</p></div><Link className="og-clear" to="/practice">Practice tables</Link></div>)}
    {rows && rows.length > 0 && <>
      <ol className="history-list og-list" aria-label="Your decisions, newest Hand first" aria-busy={list.isPlaceholderData || undefined}>{rows.map(row => <DecisionEntry key={row.key} row={row} />)}</ol>
      {(scoreFilter ? total! > rows.length : list.hasNextPage) && <div className="og-more"><button type="button" disabled={!scoreFilter && list.isFetchingNextPage} onClick={() => scoreFilter ? setScoredLimit(scoredLimit + pageSize) : void list.fetchNextPage()}>{!scoreFilter && list.isFetchingNextPage ? 'Loading…' : `Show more (${(total! - rows.length).toLocaleString('en')} left)`}</button></div>}
    </>}
  </main>;
}
