import { compareParam, comparedStrategies } from './table-address.js';
import { decisionStep, decodeHistoryFilter, historyFilterParams, isHistoryBreakdown, normalizeHistoryFilter, type Card, type HistoryBreakdown, type HistoryScoreSummary, type StrategyDescriptor, type DecisionActionType, type HistoryFilter, type OverallHistoryDecision, type OverallHistorySummary, type Position, type ScoredOverallHistory, type TableMode, type Street } from '@poker/contracts';
import type { Followed } from './request-progress.js';
import { progressFigures } from './summary-figures.js';
import { completedLabel } from './table-history.js';
import { streetName } from './replay.js';
import { actionLabel, modeLabel, tableFormat, blindsLabel } from './table-model.js';

/**
 * Overall History's model (ADR-0041), pure. The address holds the filters in the one encoding the server's query uses
 * (`historyFilterParams`): choices as comma-separated lists, ranges as numbers. A date is the Guest's own calendar day.
 */
export type OverallHistorySearch = { street?: string; position?: string; action?: string; mode?: string; completedFrom?: number; completedTo?: number; potMin?: number; potMax?: number; decisionScoreMin?: number; decisionScoreMax?: number; actionRankScoreMin?: number; actionRankScoreMax?: number; breakdown?: HistoryBreakdown; compare?: string };

/** The filter an address holds, as `decodeHistoryFilter` reads it. */
export const filterOfSearch = (search: Readonly<Record<string, unknown>>): HistoryFilter => decodeHistoryFilter(search);
/** A filter as address search parameters: strings for choices, numbers for ranges, so the router writes them plainly. */
export function searchOfFilter(filter: HistoryFilter): OverallHistorySearch {
  const search: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(historyFilterParams(filter))) search[key] = /^(?:completed|pot|decisionScore|actionRankScore)/.test(key) ? Number(value) : value;
  return search as OverallHistorySearch;
}
/** The Score Summary breakdown an address holds: one dimension, or none. */
export const breakdownOfSearch = (search: Readonly<Record<string, unknown>>): HistoryBreakdown | undefined => isHistoryBreakdown(search.breakdown) ? search.breakdown : undefined;
/** `search` holding `breakdown` in place of whatever breakdown it held, or none. */
export function withBreakdown(search: OverallHistorySearch, breakdown: HistoryBreakdown | undefined): OverallHistorySearch {
  const { breakdown: _previous, ...rest } = search;
  return breakdown ? { ...rest, breakdown } : rest;
}
/** The Strategies a side-by-side Score Summary compares beside the Reference Strategy, as the address holds them (`compare`). */
export const compareOfSearch = (search: Readonly<Record<string, unknown>>): StrategyDescriptor[] => comparedStrategies(search.compare);
/** `search` holding `compare` in place of whatever it held, or none. */
export function withCompare(search: OverallHistorySearch, compared: readonly StrategyDescriptor[]): OverallHistorySearch {
  const { compare: _previous, ...rest } = search;
  const compare = compareParam(compared);
  return compare ? { ...rest, compare } : rest;
}
/** The route's search validation: whatever the address held, as its normalized filter, breakdown and compared Strategies. */
export const overallHistorySearch = (search: Record<string, unknown>): OverallHistorySearch => withCompare(withBreakdown(searchOfFilter(filterOfSearch(search)), breakdownOfSearch(search)), compareOfSearch(search));
/** The History tab's address, holding `filter`, the Score Summary's `breakdown` and its compared Strategies. Commas stay readable. */
export function overallHistoryPath(filter: HistoryFilter, breakdown?: HistoryBreakdown, compared: readonly StrategyDescriptor[] = []): string {
  const compare = compareParam(compared);
  const query = Object.entries({ ...historyFilterParams(filter), ...(breakdown ? { breakdown } : {}), ...(compare ? { compare } : {}) }).map(([key, value]) => `${key}=${encodeURIComponent(value).replaceAll('%2C', ',').replaceAll('%3A', ':')}`).join('&');
  return '/history' + (query ? '?' + query : '');
}

type ChoiceField = 'street' | 'position' | 'action' | 'mode';
type RangeField = 'completed' | 'pot' | 'decisionScore' | 'actionRankScore';
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
/** The filter without its score ranges: the recorded-facts part, which the plain list is asked for with. */
export function withoutScoreFilter(filter: HistoryFilter): HistoryFilter {
  const { decisionScore: _decision, actionRankScore: _rank, ...rest } = filter;
  return rest;
}
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
/** A score (0 to 1) as a field shows it: a percentage, without float noise; empty for none. */
export const scorePercent = (score: number | undefined): string => score === undefined ? '' : String(Number((score * 100).toFixed(4)));
/** The score (0 to 1) a percentage field holds, kept within 0 to 100; nothing for text that is not a number. */
export function percentScore(text: string): number | undefined {
  if (text.trim() === '' || !Number.isFinite(Number(text)) || Number(text) < 0) return undefined;
  return Number((Math.min(100, Number(text)) / 100).toFixed(6));
}
/**
 * What a breakdown row shows in place of its means until it is complete: "Analyzing" with no count, since only the
 * whole set's count follows progress and a bucket's would stand still between reads, or "Error", or "—" for no score.
 */
export function bucketWaiting(summary: HistoryScoreSummary): string {
  return summary.status === 'pending' ? 'Analyzing' : summary.status === 'error' ? 'Error' : '—';
}

/** Every summary of an Overall History summary request: the whole set's, then each bucket's. */
const summariesOf = (request: OverallHistorySummary) => [request.summary, ...request.buckets?.map(bucket => bucket.summary) ?? []];
/**
 * An Overall History summary request as the Trainer follows it on the user channel. Its count is the whole set's
 * summary's, which covers every bucket's decisions, so progress applies while that summary is Analyzing; a bucket still
 * Analyzing after it is read again when its own notice comes.
 */
export const followedSummary: Followed<OverallHistorySummary> = {
  resource: 'overall-history-summary',
  pending: request => request.summary.status === 'pending',
  settled: request => summariesOf(request).every(summary => summary.status !== 'pending'),
  count: request => request.summary.progress,
  withCount: (request, progress) => ({ ...request, summary: { ...request.summary, progress } }),
};
/** A score-filtered list as the Trainer follows it on the user channel: Analyzing, with its count, until it is decided. */
export const followedScored: Followed<ScoredOverallHistory> = {
  resource: 'overall-history-scored',
  pending: scored => scored.status === 'pending',
  settled: scored => scored.status !== 'pending',
  count: scored => scored.progress,
  withCount: (scored, progress) => ({ ...scored, progress }),
};

/** What a score-filtered list reports until it can list anything: its Analyzing count, or Error. Nothing once complete. */
export function scoredFigures(scored: Pick<ScoredOverallHistory, 'status' | 'progress'> | undefined): { state: string | undefined; fraction?: number } {
  return scored ? progressFigures(scored) : { state: 'Starting analysis…' };
}
