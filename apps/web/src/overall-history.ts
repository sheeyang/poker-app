import { decisionStep, decodeHistoryFilter, historyFilterParams, isHistoryBreakdown, normalizeHistoryFilter, type Card, type HistoryBreakdown, type HistoryScoreSummary, type DecisionActionType, type HistoryFilter, type OverallHistoryDecision, type Position, type TableMode, type Street } from '@poker/contracts';
import { completedLabel } from './table-history.js';
import { streetName } from './replay.js';
import { actionLabel, modeLabel, tableFormat, blindsLabel } from './table-model.js';

/**
 * Overall History's model (ADR-0041), pure. The address holds the filters in the one encoding the server's query uses
 * (`historyFilterParams`): choices as comma-separated lists, ranges as numbers. A date is the Guest's own calendar day.
 */
export type OverallHistorySearch = { street?: string; position?: string; action?: string; mode?: string; completedFrom?: number; completedTo?: number; potMin?: number; potMax?: number; breakdown?: HistoryBreakdown };

/** The filter an address holds, as `decodeHistoryFilter` reads it. */
export const filterOfSearch = (search: Readonly<Record<string, unknown>>): HistoryFilter => decodeHistoryFilter(search);
/** A filter as address search parameters: strings for choices, numbers for ranges, so the router writes them plainly. */
export function searchOfFilter(filter: HistoryFilter): OverallHistorySearch {
  const search: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(historyFilterParams(filter))) search[key] = /^(?:completed|pot)/.test(key) ? Number(value) : value;
  return search as OverallHistorySearch;
}
/** The Score Summary breakdown an address holds: one dimension, or none. */
export const breakdownOfSearch = (search: Readonly<Record<string, unknown>>): HistoryBreakdown | undefined => isHistoryBreakdown(search.breakdown) ? search.breakdown : undefined;
/** `search` holding `breakdown` in place of whatever breakdown it held, or none. */
export function withBreakdown(search: OverallHistorySearch, breakdown: HistoryBreakdown | undefined): OverallHistorySearch {
  const { breakdown: _previous, ...rest } = search;
  return breakdown ? { ...rest, breakdown } : rest;
}
/** The route's search validation: whatever the address held, as its normalized filter and breakdown. */
export const overallHistorySearch = (search: Record<string, unknown>): OverallHistorySearch => withBreakdown(searchOfFilter(filterOfSearch(search)), breakdownOfSearch(search));
/** The History tab's address, holding `filter` and the Score Summary's `breakdown`. Commas stay readable. */
export function overallHistoryPath(filter: HistoryFilter, breakdown?: HistoryBreakdown): string {
  const query = Object.entries({ ...historyFilterParams(filter), ...(breakdown ? { breakdown } : {}) }).map(([key, value]) => `${key}=${encodeURIComponent(value).replaceAll('%2C', ',')}`).join('&');
  return '/history' + (query ? '?' + query : '');
}

type ChoiceField = 'street' | 'position' | 'action' | 'mode';
type RangeField = 'completed' | 'pot';
/** `filter` with one more value chosen in a dimension, or one fewer; a dimension left with none is dropped. */
export function toggled(filter: HistoryFilter, field: 'street', value: Street): HistoryFilter;
export function toggled(filter: HistoryFilter, field: 'position', value: Position): HistoryFilter;
export function toggled(filter: HistoryFilter, field: 'action', value: DecisionActionType): HistoryFilter;
export function toggled(filter: HistoryFilter, field: 'mode', value: TableMode): HistoryFilter;
export function toggled(filter: HistoryFilter, field: ChoiceField, value: string): HistoryFilter {
  const chosen = (filter[field] as readonly string[] | undefined) ?? [];
  const next = chosen.includes(value) ? chosen.filter(other => other !== value) : [...chosen, value];
  return normalizeHistoryFilter({ ...filter, [field]: next });
}
/** `filter` with one edge of a range set, or cleared when `value` is undefined; a range left with no edge is dropped. */
export function rangedBy(filter: HistoryFilter, field: RangeField, edge: 'min' | 'max', value: number | undefined): HistoryFilter {
  const { [field]: range, ...rest } = filter;
  const { [edge]: _replaced, ...other } = range ?? {};
  const next = { ...other, ...(value !== undefined ? { [edge]: value } : {}) };
  return normalizeHistoryFilter(Object.keys(next).length ? { ...rest, [field]: next } : rest);
}
export const clearedFilter = (): HistoryFilter => ({});
const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The first millisecond of a calendar day (`YYYY-MM-DD`) in the Guest's own time zone; nothing for anything else. */
export function dayStartMs(date: string): number | undefined {
  const [, year, month, day] = dayPattern.exec(date) ?? [];
  if (!year) return undefined;
  const start = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(start.getTime()) || start.getDate() !== Number(day) ? undefined : start.getTime();
}
/** The last millisecond of that calendar day. */
export function dayEndMs(date: string): number | undefined {
  const start = dayStartMs(date);
  if (start === undefined) return undefined;
  const [, year, month, day] = dayPattern.exec(date)!;
  return new Date(Number(year), Number(month) - 1, Number(day) + 1).getTime() - 1;
}
/** The calendar day (`YYYY-MM-DD`) a server time falls on in the Guest's time zone, for a date field; empty for none. */
export function dateInputValue(at: number | undefined): string {
  if (at === undefined) return '';
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** One decision as the list shows it. Everything a viewer sees of a table is already in the decision. */
export interface DecisionRow {
  readonly key: string;
  /** "Hand 12": the table-wide number. */
  readonly handLabel: string;
  /** "Practice · 6-max · 10 / 20". */
  readonly table: string;
  readonly completed: string | undefined;
  readonly street: string;
  readonly position: Position;
  /** "Raise-to 300". */
  readonly action: string;
  readonly actionType: DecisionActionType;
  /** The pot as faced, in big blinds: "12.5 BB". */
  readonly pot: string;
  readonly holeCards: readonly Card[];
  readonly board: readonly Card[];
  /** Where the decision opens: its table's Table History at the Hand, at the Replay Step before this decision. */
  readonly link: { readonly mode: TableMode; readonly tableSessionId: string; readonly handId: string; readonly step: string };
}
export function decisionRow(decision: OverallHistoryDecision): DecisionRow {
  return {
    key: decision.tableSessionId + '/' + decision.decisionId, handLabel: `Hand ${decision.handNumber}`,
    table: `${modeLabel(decision.mode)} · ${tableFormat(decision.seatCount)} · ${blindsLabel(decision.stakes.smallBlind, decision.stakes.bigBlind)}`,
    completed: completedLabel(decision.completedAt), street: streetName(decision.street), position: decision.position,
    action: actionLabel(decision.action), actionType: decision.action.type, pot: `${Number(decision.potBigBlinds.toFixed(1))} BB`,
    holeCards: decision.holeCards, board: decision.board,
    link: { mode: decision.mode, tableSessionId: decision.tableSessionId, handId: decision.handId, step: decisionStep(decision.decisionId) },
  };
}

const actionNames: Readonly<Record<DecisionActionType, string>> = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' };
/** A breakdown bucket's name, as the filters name the same value. */
export function bucketLabel(breakdown: HistoryBreakdown, value: string): string {
  if (breakdown === 'street') return streetName(value as Street);
  if (breakdown === 'action') return actionNames[value as DecisionActionType] ?? value;
  if (breakdown === 'mode') return modeLabel(value as TableMode);
  return value;
}
/**
 * What a Score Summary shows: both means as scores out of 100 once it is complete and "—" otherwise (never a partial
 * mean), how many decisions it covers ("No decisions" for none), and its state: "Analyzing 340 / 2,000" with the
 * fraction done while running, "Error" once any analysis has failed.
 */
export function summaryFigures(summary: HistoryScoreSummary): { decisionScore: string; actionRankScore: string; count: string; state: string | undefined; fraction?: number } {
  const score = (value: number) => (value * 100).toFixed(1);
  const count = summary.decisionCount ? `${summary.decisionCount.toLocaleString('en')} ${summary.decisionCount === 1 ? 'decision' : 'decisions'}` : 'No decisions';
  if (summary.status === 'complete') return { decisionScore: score(summary.averages.decisionScore), actionRankScore: score(summary.averages.actionRankScore), count, state: undefined };
  const none = { decisionScore: '—', actionRankScore: '—', count };
  if (summary.status === 'pending') return { ...none, state: `Analyzing ${summary.progress.succeeded.toLocaleString('en')} / ${summary.progress.total.toLocaleString('en')}`, fraction: summary.progress.total ? summary.progress.succeeded / summary.progress.total : 0 };
  return { ...none, state: summary.status === 'error' ? 'Error' : undefined };
}
