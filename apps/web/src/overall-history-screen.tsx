import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '@poker/client';
import { decisionActionTypes, decisionStreets, historyFilterSize, historyModes, positions, type DecisionActionType, type HistoryFilter, type Position, type Street, type TableMode } from '@poker/contracts';
import { Icon } from './icons.js';
import { Card } from './cards.js';
import { Skeleton } from './loading-skeleton.js';
import { SeatGlyph } from './felt.js';
import { usePageTitle, useShell } from './app-shell.js';
import { HistoryLink } from './table-history-screen.js';
import { clearedFilter, dateInputValue, dayEndMs, dayStartMs, decisionRow, filterOfSearch, rangedBy, searchOfFilter, toggled, type DecisionRow } from './overall-history.js';
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

function Filters({ filter, onChange, shown, total }: { filter: HistoryFilter; onChange: (next: HistoryFilter) => void; shown: number | undefined; total: number | undefined }) {
  const number = (text: string) => text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 ? Number(text) : undefined;
  const size = historyFilterSize(filter);
  // Open where there is room, and wherever a filter is already set; a phone starts with the list in view.
  const [open, setOpen] = useState(() => size > 0 || window.matchMedia('(min-width: 861px)').matches);
  return <section className="og-filters" aria-label="Filters">
    <div className="og-filters-head">
      <button type="button" className="og-toggle" aria-expanded={open} aria-controls="og-filters-body" onClick={() => setOpen(!open)}><Icon name="settings" size={18} />Filters{size > 0 && <span className="og-count numeric">{size}</span>}<span className="og-toggle-chevron" aria-hidden="true"><Icon name="chevron" size={14} /></span></button>
      <p role="status" aria-live="polite">{shown === undefined ? 'Reading your decisions…' : <><strong className="numeric">{total!.toLocaleString('en')}</strong> {total === 1 ? 'decision' : 'decisions'}</>}</p>
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

function ListSkeleton() {
  return <div className="history-list" role="status" aria-label="Loading your decisions"><div aria-hidden="true">{[0, 1, 2, 3].map(i => <div className="og-row og-row-skeleton" key={i}><Skeleton className="skeleton-hand-status" /><Skeleton className="skeleton-action" /><Skeleton className="skeleton-action" /></div>)}</div></div>;
}

/**
 * Overall History (ADR-0041): the Guest's own decisions from every Hand they were dealt into, at every table they can
 * read. The filters apply at once and live in the address, so a reload keeps them; each decision opens at its Replay
 * Step in its table's Table History. Score filters and Score Summaries join in later tickets.
 */
export function OverallHistoryScreen() {
  const { identity } = useShell();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const filter = useMemo(() => filterOfSearch(search), [search]);
  const key = JSON.stringify(searchOfFilter(filter));
  usePageTitle({ page: 'overall-history' });
  const list = useInfiniteQuery({
    queryKey: ['overall-history', key], enabled: identity.isSuccess, placeholderData: keepPreviousData, initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.readOverallHistory(filter, { limit: pageSize, offset: pageParam }, signal),
    getNextPageParam: last => last.offset + last.decisions.length < last.total ? last.offset + last.decisions.length : undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap(page => page.decisions.map(decisionRow)), [list.data]);
  const total = list.data?.pages[0]?.total;
  const apply = (next: HistoryFilter) => void navigate({ to: '/history', search: searchOfFilter(next), replace: true });
  const filtered = historyFilterSize(filter) > 0;
  return <main id="main-table" className="history-page og-page">
    <header className="history-heading">
      <h1>History</h1>
      <p>Your decisions in every Hand you were dealt into, at every table you can read: Practice, tables you left, and Closed Tables.</p>
    </header>
    <Filters filter={filter} onChange={apply} shown={rows?.length} total={total} />
    {list.isError && <div className="notice-error" role="alert"><p>{list.error.message}</p><button type="button" onClick={() => void list.refetch()}>Retry</button></div>}
    {!rows && !list.isError && <ListSkeleton />}
    {rows?.length === 0 && (filtered
      ? <div className="ledger-empty"><SeatGlyph seats={6} /><div><h3>No decisions match these filters</h3><p>Loosen a filter to see more.</p></div><button type="button" className="og-clear" onClick={() => apply(clearedFilter())}>Clear filters</button></div>
      : <div className="ledger-empty"><SeatGlyph seats={6} /><div><h3>No decisions yet</h3><p>Decisions you make in a Hand appear here once the Hand is complete.</p></div><Link className="og-clear" to="/practice">Practice tables</Link></div>)}
    {rows && rows.length > 0 && <>
      <ol className="history-list og-list" aria-label="Your decisions, newest Hand first" aria-busy={list.isPlaceholderData || undefined}>{rows.map(row => <DecisionEntry key={row.key} row={row} />)}</ol>
      {list.hasNextPage && <div className="og-more"><button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : `Show more (${(total! - rows.length).toLocaleString('en')} left)`}</button></div>}
    </>}
  </main>;
}
