import type { Card, ChipAmount, ConcreteAction, DecisionId, HandId, Street, TableMode, TableSessionId } from './index.js';

/**
 * Overall History (ADR-0041): the Guest's own decisions across every table they can read. The filter below is the
 * declared set a request names, kept as data so every operation that takes a "filtered set" shares it: the list, and
 * the Score Summaries and breakdowns built over it (#109–#111). Its one flat encoding (`historyFilterParams`) is used
 * by the browser's address and by the HTTP query alike.
 */

/** A dealt-in Participant's place in a Hand (GLOSSARY: Position). Heads-up, the button posts the small blind: BTN/SB. */
export const positions = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO', 'BTN/SB'] as const;
export type Position = typeof positions[number];
export const decisionStreets: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
export const decisionActionTypes = ['fold', 'check', 'call', 'bet', 'raise'] as const;
export type DecisionActionType = typeof decisionActionTypes[number];
export const historyModes: readonly TableMode[] = ['practice', 'online'];

/** An inclusive range; either end may be open. */
export interface NumberRange { readonly min?: number; readonly max?: number }
/**
 * The non-score filters. Every field is a restriction that applies when present; a choice field lists the values it
 * admits. `completed` is in server milliseconds and excludes Hands that carry no completion time whenever it is set.
 * `pot` is in big blinds, as the decision's actor faced it: every chip committed to the Hand so far, wagers on the
 * current street included. Score ranges (#110) join this declaration.
 */
export interface HistoryFilter {
  readonly street?: readonly Street[];
  readonly position?: readonly Position[];
  readonly action?: readonly DecisionActionType[];
  readonly mode?: readonly TableMode[];
  readonly completed?: NumberRange;
  readonly pot?: NumberRange;
}

/** The recorded facts a non-score filter reads. */
export interface DecisionFacts {
  readonly street: Street;
  readonly position: Position;
  readonly action: ConcreteAction;
  readonly mode: TableMode;
  /** Absent for a Hand completed before completion times were recorded. */
  readonly completedAt?: number;
  readonly potBigBlinds: number;
}

const choiceDimensions = [
  { field: 'street', param: 'street', values: decisionStreets },
  { field: 'position', param: 'position', values: positions },
  { field: 'action', param: 'action', values: decisionActionTypes },
  { field: 'mode', param: 'mode', values: historyModes },
] as const;
const rangeDimensions = [
  { field: 'completed', min: 'completedFrom', max: 'completedTo', integer: true },
  { field: 'pot', min: 'potMin', max: 'potMax', integer: false },
] as const;
/** Every address and query parameter a filter uses, in encoding order. */
export const historyFilterParameters: readonly string[] = [...choiceDimensions.map(d => d.param), ...rangeDimensions.flatMap(d => [d.min, d.max])];

const numberOf = (value: unknown, integer: boolean): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 && (!integer || Number.isInteger(number)) ? number : undefined;
};

/**
 * The filter a set of search parameters (a browser address or an HTTP query) declares, normalized: unknown values
 * dropped, choices unique and in declared order, an empty choice list or an empty or reversed range meaning no
 * restriction at that end. A choice may arrive as a comma-separated string or as a list. Never throws.
 */
export function decodeHistoryFilter(params: Readonly<Record<string, unknown>>): HistoryFilter {
  const filter: { -readonly [K in keyof HistoryFilter]: HistoryFilter[K] } = {};
  for (const { field, param, values } of choiceDimensions) {
    const raw = params[param];
    const wanted = new Set(Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : raw === undefined || raw === null ? [] : [String(raw)]);
    const chosen = (values as readonly string[]).filter(value => wanted.has(value));
    if (chosen.length) (filter as Record<string, unknown>)[field] = chosen;
  }
  for (const { field, min, max, integer } of rangeDimensions) {
    let low = numberOf(params[min], integer), high = numberOf(params[max], integer);
    if (low !== undefined && high !== undefined && low > high) [low, high] = [high, low];
    if (low !== undefined || high !== undefined) (filter as Record<string, unknown>)[field] = { ...(low !== undefined ? { min: low } : {}), ...(high !== undefined ? { max: high } : {}) };
  }
  return filter;
}
/** A filter's flat encoding: what `decodeHistoryFilter` reads back. Only the restrictions it holds appear. */
export function historyFilterParams(filter: HistoryFilter): Record<string, string> {
  const params: Record<string, string> = {};
  for (const { field, param } of choiceDimensions) { const chosen = filter[field] as readonly string[] | undefined; if (chosen?.length) params[param] = chosen.join(','); }
  for (const { field, min, max } of rangeDimensions) {
    const range = filter[field];
    if (range?.min !== undefined) params[min] = String(range.min);
    if (range?.max !== undefined) params[max] = String(range.max);
  }
  return params;
}
/** The filter in canonical form: what decoding its own encoding gives. Two filters that admit the same decisions by declaration are equal. */
export const normalizeHistoryFilter = (filter: HistoryFilter): HistoryFilter => decodeHistoryFilter(historyFilterParams(filter));
/** How many dimensions a filter restricts. */
export const historyFilterSize = (filter: HistoryFilter): number => choiceDimensions.filter(d => filter[d.field]?.length).length + rangeDimensions.filter(d => filter[d.field]).length;

const within = (range: NumberRange | undefined, value: number) => !range || (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
/** Whether a decision's recorded facts pass every non-score restriction. A date restriction excludes undated Hands. */
export function matchesHistoryFilter(filter: HistoryFilter, facts: DecisionFacts): boolean {
  return (!filter.street?.length || filter.street.includes(facts.street))
    && (!filter.position?.length || filter.position.includes(facts.position))
    && (!filter.action?.length || filter.action.includes(facts.action.type))
    && (!filter.mode?.length || filter.mode.includes(facts.mode))
    && (!filter.completed || facts.completedAt !== undefined && within(filter.completed, facts.completedAt))
    && within(filter.pot, facts.potBigBlinds);
}

/**
 * One of the reader's own decisions as Overall History lists it: from a Hand they were dealt into, at any table they
 * can read. It carries the facts the filters use and what the list shows; opening it is `step=decision-N` of its Hand's
 * Replay (`decisionStep`).
 */
export interface OverallHistoryDecision extends DecisionFacts {
  readonly tableSessionId: TableSessionId;
  readonly seatCount: number;
  readonly stakes: { readonly smallBlind: ChipAmount; readonly bigBlind: ChipAmount; readonly ante: ChipAmount };
  readonly handId: HandId;
  /** The table-wide Hand number. */
  readonly handNumber: number;
  readonly decisionId: DecisionId;
  /** The reader's own hole cards, and the board as it was when they decided. */
  readonly holeCards: readonly Card[];
  readonly board: readonly Card[];
  /** The pot as faced, in chips; `potBigBlinds` is the same in big blinds. */
  readonly pot: ChipAmount;
}
/** The Guest-scoped list: the decisions passing `filter` (as normalized), newest Hand first, a page of them. */
export interface OverallHistory {
  readonly filter: HistoryFilter;
  /** How many decisions pass the filter, over every page. */
  readonly total: number;
  readonly offset: number;
  readonly decisions: readonly OverallHistoryDecision[];
}
/** The Replay Step address of a decision: `decision-N`, from a `hand-M/decision-N` Decision ID. */
export const decisionStep = (decisionId: DecisionId): string => decisionId.slice(decisionId.indexOf('/') + 1);
