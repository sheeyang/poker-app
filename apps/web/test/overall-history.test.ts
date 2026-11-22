import { expect, test } from 'vitest';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, type OverallHistoryDecision } from '@poker/contracts';
import { breakdownOfSearch, compareOfSearch, withCompare, bucketLabel, clearedFilter, dateInputValue, dayEndMs, dayStartMs, decisionRow, filterOfSearch, overallHistoryPath, overallHistorySearch, percentScore, rangedBy, scoredFigures, scorePercent, searchOfFilter, summaryFigures, toggled, withBreakdown } from '../src/overall-history.js';
import { parseAddress } from '../src/table-address.js';

const decision = (override: Partial<OverallHistoryDecision> = {}): OverallHistoryDecision => ({
  tableSessionId: '11111111-1111-4111-8111-111111111111', mode: 'practice', seatCount: 6, stakes: { smallBlind: 10, bigBlind: 20, ante: 0 },
  handId: 'hand-12', handNumber: 12, completedAt: Date.UTC(2026, 10, 22, 14, 5), decisionId: 'hand-12/decision-4', street: 'turn', position: 'UTG+1',
  action: { type: 'raise', raiseTo: 300 }, holeCards: ['Ah', 'Kd'], board: ['2c', '7d', 'Js', 'Qh'], pot: 250, potBigBlinds: 12.5, ...override,
});

test('an address holds the filters, and reading it back gives the same filter: choices as lists, ranges as numbers, nothing else', () => {
  const filter = { street: ['flop', 'river'], position: ['UTG+1', 'BTN/SB'], action: ['raise'], mode: ['online'], completed: { min: 1763769600000, max: 1763855999999 }, pot: { min: 2.5, max: 10 } } as const;
  const search = searchOfFilter(filter);
  expect(search).toEqual({ street: 'flop,river', position: 'UTG+1,BTN/SB', action: 'raise', mode: 'online', completedFrom: 1763769600000, completedTo: 1763855999999, potMin: 2.5, potMax: 10 });
  expect(filterOfSearch(search)).toEqual(filter);
  // The router hands over whatever the address held, parsed as JSON where it can be; a number or a string both read.
  expect(overallHistorySearch({ street: 'turn,flop', potMin: '4', potMax: 'nope', completedFrom: '5', junk: 1 })).toEqual({ street: 'flop,turn', potMin: 4, completedFrom: 5 });
  expect(overallHistorySearch({})).toEqual({});
});

test('the History tab is an address of its own, and a filtered one opens to the same place after a reload', () => {
  expect(overallHistoryPath({})).toBe('/history');
  expect(overallHistoryPath({ street: ['flop'], pot: { min: 3 } })).toBe('/history?street=flop&potMin=3');
  expect(overallHistoryPath({ position: ['UTG+1'] })).toBe('/history?position=UTG%2B1');
  // The History address belongs to no table's mode, so the Practice and Online tabs are not active on it.
  expect(parseAddress('/history')).toBeUndefined();
});

test('choosing and unchoosing a value changes only that dimension, keeps choices in declared order, and drops a dimension left empty', () => {
  let filter = toggled({}, 'street', 'river');
  filter = toggled(filter, 'street', 'flop');
  expect(filter).toEqual({ street: ['flop', 'river'] });
  filter = toggled(toggled(filter, 'action', 'bet'), 'street', 'flop');
  expect(filter).toEqual({ street: ['river'], action: ['bet'] });
  expect(toggled(filter, 'street', 'river')).toEqual({ action: ['bet'] });
  expect(toggled({}, 'position', 'BTN/SB')).toEqual({ position: ['BTN/SB'] });
});

test('a range edge sets and clears on its own, and a range left with no edge is no restriction', () => {
  expect(rangedBy({}, 'pot', 'min', 2)).toEqual({ pot: { min: 2 } });
  expect(rangedBy({ pot: { min: 2 } }, 'pot', 'max', 9)).toEqual({ pot: { min: 2, max: 9 } });
  expect(rangedBy({ pot: { min: 2, max: 9 } }, 'pot', 'min', undefined)).toEqual({ pot: { max: 9 } });
  expect(rangedBy({ pot: { min: 2 }, street: ['flop'] }, 'pot', 'min', undefined)).toEqual({ street: ['flop'] });
  expect(rangedBy({ completed: { min: 5 } }, 'pot', 'max', 3)).toEqual({ completed: { min: 5 }, pot: { max: 3 } });
  expect(clearedFilter()).toEqual({});
});

test('a date is the Guest\'s own calendar day: it runs from midnight to the last millisecond, and reads back as the same date', () => {
  const start = dayStartMs('2026-11-22'), end = dayEndMs('2026-11-22');
  expect(new Date(start).getHours()).toBe(0);
  expect(new Date(start).getDate()).toBe(22);
  expect(new Date(end + 1).getDate()).toBe(23);
  expect(new Date(end + 1).getHours()).toBe(0);
  expect(dateInputValue(start)).toBe('2026-11-22');
  expect(dateInputValue(end)).toBe('2026-11-22');
  expect(dayStartMs('')).toBeUndefined();
  expect(dayStartMs('not a date')).toBeUndefined();
  expect(dateInputValue(undefined)).toBe('');
});

test('a decision reads as a row: the table it was at, its Hand, when it completed, the situation, the action and the pot in big blinds', () => {
  const row = decisionRow(decision());
  expect(row).toMatchObject({ handLabel: 'Hand 12', table: 'Practice · 6-max · 10 / 20', street: 'Turn', position: 'UTG+1', action: 'Raise-to 300', pot: '12.5 BB' });
  expect(row.completed).toMatch(/Nov 22/);
  expect(row.holeCards).toEqual(['Ah', 'Kd']);
  expect(row.board).toEqual(['2c', '7d', 'Js', 'Qh']);
  // A whole number shows no decimals; a Hand with no completion time shows none.
  expect(decisionRow(decision({ potBigBlinds: 3 })).pot).toBe('3 BB');
  expect(decisionRow(decision({ potBigBlinds: 1.5 })).pot).toBe('1.5 BB');
  expect(decisionRow(decision({ potBigBlinds: 0.75 })).pot).toBe('0.8 BB');
  const { completedAt: _undated, ...undated } = decision();
  expect(decisionRow(undated).completed).toBeUndefined();
  expect(decisionRow(decision({ mode: 'online', seatCount: 2 })).table).toBe('Online · Heads-up · 10 / 20');
});

test('a listed decision opens at its Replay Step of its table, whichever mode the table has', () => {
  expect(decisionRow(decision()).link).toEqual({ mode: 'practice', tableSessionId: '11111111-1111-4111-8111-111111111111', handId: 'hand-12', step: 'decision-4' });
  expect(decisionRow(decision({ mode: 'online', decisionId: 'hand-3/decision-1', handId: 'hand-3' })).link).toMatchObject({ mode: 'online', handId: 'hand-3', step: 'decision-1' });
});

test('the address holds the breakdown beside the filters, and reading it back gives the same view; anything else is no breakdown', () => {
  const search = withBreakdown(searchOfFilter({ street: ['flop'] }), 'position');
  expect(search).toEqual({ street: 'flop', breakdown: 'position' });
  expect(breakdownOfSearch(search)).toBe('position');
  expect(filterOfSearch(search)).toEqual({ street: ['flop'] });
  expect(overallHistorySearch({ action: 'call', breakdown: 'mode' })).toEqual({ action: 'call', breakdown: 'mode' });
  expect(overallHistorySearch({ breakdown: 'hand' })).toEqual({});
  expect(breakdownOfSearch({ breakdown: 'hand' })).toBeUndefined();
  expect(withBreakdown({ street: 'flop', breakdown: 'action' }, undefined)).toEqual({ street: 'flop' });
  expect(overallHistoryPath({ street: ['flop'] }, 'street')).toBe('/history?street=flop&breakdown=street');
  expect(overallHistoryPath({}, 'action')).toBe('/history?breakdown=action');
});

test('a bucket is named the way the filters name it', () => {
  expect(bucketLabel('street', 'preflop')).toBe('Preflop');
  expect(bucketLabel('action', 'raise')).toBe('Raise');
  expect(bucketLabel('mode', 'online')).toBe('Online');
  expect(bucketLabel('position', 'BTN/SB')).toBe('BTN/SB');
});

test('a summary shows both means only once complete, its progress while Analyzing, and "—" with "No decisions" when empty', () => {
  expect(summaryFigures({ status: 'complete', decisionCount: 2000, progress: { succeeded: 2000, total: 2000 }, averages: { decisionScore: 0.6125, actionRankScore: 0.5 } }))
    .toEqual({ decisionScore: '61.3', actionRankScore: '50.0', count: '2,000 decisions', state: undefined });
  expect(summaryFigures({ status: 'pending', decisionCount: 2000, progress: { succeeded: 340, total: 2000 } }))
    .toEqual({ decisionScore: '—', actionRankScore: '—', count: '2,000 decisions', state: 'Analyzing 340 / 2,000', fraction: 0.17 });
  expect(summaryFigures({ status: 'empty', decisionCount: 0, progress: { succeeded: 0, total: 0 } }))
    .toEqual({ decisionScore: '—', actionRankScore: '—', count: 'No decisions', state: undefined });
  // Error takes precedence over Analyzing: no partial mean, however many succeeded.
  expect(summaryFigures({ status: 'error', decisionCount: 1, progress: { succeeded: 0, total: 1 }, error: { code: 'failed', message: 'x' } }))
    .toEqual({ decisionScore: '—', actionRankScore: '—', count: '1 decision', state: 'Error' });
});

test('score ranges live in the address as 0 to 1 numbers, edit like any range, and show as percentages in their fields', () => {
  const filter = rangedBy(rangedBy({ street: ['river'] }, 'decisionScore', 'min', 0.35), 'actionRankScore', 'max', 0.8);
  expect(filter).toEqual({ street: ['river'], decisionScore: { min: 0.35 }, actionRankScore: { max: 0.8 } });
  expect(searchOfFilter(filter)).toEqual({ street: 'river', decisionScoreMin: 0.35, actionRankScoreMax: 0.8 });
  expect(overallHistorySearch({ decisionScoreMin: '0.35', actionRankScoreMax: '0.8', street: 'river' })).toEqual(searchOfFilter(filter));
  expect(filterOfSearch(searchOfFilter(filter))).toEqual(filter);
  expect(overallHistoryPath(filter)).toBe('/history?street=river&decisionScoreMin=0.35&actionRankScoreMax=0.8');
  expect(rangedBy(filter, 'decisionScore', 'min', undefined)).toEqual({ street: ['river'], actionRankScore: { max: 0.8 } });
  expect(scorePercent(0.35)).toBe('35');
  expect(scorePercent(0.07)).toBe('7');
  expect(scorePercent(undefined)).toBe('');
  expect(percentScore('35')).toBe(0.35);
  expect(percentScore('7.5')).toBe(0.075);
  expect(percentScore('150')).toBe(1);
  expect(percentScore('')).toBeUndefined();
  expect(percentScore('x')).toBeUndefined();
});

test('a score-filtered list shows Analyzing with its count, Error, or the list, and never a partial list', () => {
  expect(scoredFigures({ status: 'pending', progress: { succeeded: 340, total: 2000 } })).toEqual({ state: 'Analyzing 340 / 2,000', fraction: 0.17 });
  expect(scoredFigures({ status: 'error', progress: { succeeded: 4, total: 5 } })).toEqual({ state: 'Error' });
  expect(scoredFigures({ status: 'complete', progress: { succeeded: 5, total: 5 } })).toEqual({ state: undefined });
  expect(scoredFigures(undefined)).toEqual({ state: 'Starting analysis…' });
});

test('the address holds the compared Strategies beside the filters and breakdown, in the order chosen, and a reload gives the same comparison', () => {
  const compared = [baselinePlayingStrategy, highestProbabilityPlayingStrategy];
  const address = overallHistoryPath({ street: ['flop'] }, 'street', compared);
  expect(address).toBe('/history?street=flop&breakdown=street&compare=uniform-choice:seeded-sampling,uniform-choice:highest-probability');
  const search = overallHistorySearch(Object.fromEntries(new URL(address, 'https://trainer.test').searchParams));
  expect(search).toEqual({ street: 'flop', breakdown: 'street', compare: 'uniform-choice:seeded-sampling,uniform-choice:highest-probability' });
  expect(compareOfSearch(search)).toEqual(compared);
  expect(withCompare(search, [])).toEqual({ street: 'flop', breakdown: 'street' });
  expect(withCompare({}, [highestProbabilityPlayingStrategy])).toEqual({ compare: 'uniform-choice:highest-probability' });
  // Unsupported, repeated and surplus Strategies are dropped; changing the filters keeps the comparison.
  expect(overallHistorySearch({ compare: 'nonsense,uniform-choice:highest-probability,uniform-choice:highest-probability' })).toEqual({ compare: 'uniform-choice:highest-probability' });
  expect(overallHistorySearch({ compare: 'nonsense' })).toEqual({});
  expect(overallHistoryPath({}, undefined, compared)).toBe('/history?compare=uniform-choice:seeded-sampling,uniform-choice:highest-probability');
});
