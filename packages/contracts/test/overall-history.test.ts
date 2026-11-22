import { expect, test } from 'vitest';
import { decisionStep, decodeHistoryFilter, historyFilterParams, historyFilterSize, hasScoreFilter, matchesHistoryFilter, matchesScoreFilter, normalizeHistoryFilter, withoutScoreFilter, type DecisionFacts } from '../src/index.js';

const facts = (override: Partial<DecisionFacts> = {}): DecisionFacts => ({ street: 'flop', position: 'CO', action: { type: 'raise', raiseTo: 60 }, mode: 'practice', completedAt: 1_000, potBigBlinds: 4.5, ...override });

test('a filter round-trips through its flat encoding, with only the restrictions it holds', () => {
  const filter = { street: ['flop', 'river'], position: ['UTG+1', 'BTN/SB'], action: ['raise'], mode: ['online'], completed: { min: 5, max: 9 }, pot: { min: 2.5 } } as const;
  expect(historyFilterParams(filter)).toEqual({ street: 'flop,river', position: 'UTG+1,BTN/SB', action: 'raise', mode: 'online', completedFrom: '5', completedTo: '9', potMin: '2.5' });
  expect(decodeHistoryFilter(historyFilterParams(filter))).toEqual(filter);
  expect(historyFilterParams({})).toEqual({});
  expect(historyFilterSize(filter)).toBe(6);
  expect(historyFilterSize({ street: [] })).toBe(0);
});

test('decoding normalizes whatever an address or query holds: unknown values dropped, choices unique and in declared order, a reversed range put right', () => {
  expect(decodeHistoryFilter({ street: 'river,flop,flop,moon', position: ['CO', 'BTN', 'nope'], action: 7, mode: '', potMin: 8, potMax: '2', completedFrom: '1.5', completedTo: 'x', unrelated: 'y' }))
    .toEqual({ street: ['flop', 'river'], position: ['BTN', 'CO'], pot: { min: 2, max: 8 } });
  expect(decodeHistoryFilter({ potMin: -3, completedFrom: '12', completedTo: 12 })).toEqual({ completed: { min: 12, max: 12 } });
  expect(normalizeHistoryFilter({ street: ['river', 'flop'] })).toEqual({ street: ['flop', 'river'] });
});

test('each restriction narrows a decision on its own recorded facts, and a date restriction excludes an undated Hand', () => {
  expect(matchesHistoryFilter({}, facts())).toBe(true);
  expect(matchesHistoryFilter({ street: ['flop'] }, facts())).toBe(true);
  expect(matchesHistoryFilter({ street: ['turn', 'river'] }, facts())).toBe(false);
  expect(matchesHistoryFilter({ position: ['CO', 'BTN'] }, facts())).toBe(true);
  expect(matchesHistoryFilter({ position: ['BB'] }, facts())).toBe(false);
  expect(matchesHistoryFilter({ action: ['bet', 'raise'] }, facts())).toBe(true);
  expect(matchesHistoryFilter({ action: ['call'] }, facts())).toBe(false);
  expect(matchesHistoryFilter({ mode: ['online'] }, facts())).toBe(false);
  expect(matchesHistoryFilter({ completed: { min: 1_000, max: 1_000 } }, facts())).toBe(true);
  expect(matchesHistoryFilter({ completed: { min: 1_001 } }, facts())).toBe(false);
  expect(matchesHistoryFilter({ completed: { max: 999 } }, facts())).toBe(false);
  const undated = facts({ completedAt: undefined });
  expect(matchesHistoryFilter({ completed: { min: 0 } }, undated)).toBe(false);
  expect(matchesHistoryFilter({ completed: { max: 9e15 } }, undated)).toBe(false);
  expect(matchesHistoryFilter({ street: ['flop'] }, undated)).toBe(true);
  expect(matchesHistoryFilter({ pot: { min: 4.5, max: 4.5 } }, facts())).toBe(true);
  expect(matchesHistoryFilter({ pot: { min: 4.6 } }, facts())).toBe(false);
  expect(matchesHistoryFilter({ street: ['flop'], pot: { max: 4 } }, facts())).toBe(false);
});

test('a decision opens its Replay Step from its Decision ID', () => {
  expect(decisionStep('hand-12/decision-3')).toBe('decision-3');
});

test('score ranges join the declared filter and its encoding, and are evaluated apart from the recorded facts', () => {
  const filter = { street: ['flop'], decisionScore: { min: 0.25, max: 0.75 }, actionRankScore: { max: 0.5 } } as const;
  expect(historyFilterParams(filter)).toEqual({ street: 'flop', decisionScoreMin: '0.25', decisionScoreMax: '0.75', actionRankScoreMax: '0.5' });
  expect(decodeHistoryFilter(historyFilterParams(filter))).toEqual(filter);
  expect(decodeHistoryFilter({ decisionScoreMin: '0.9', decisionScoreMax: 0.1 })).toEqual({ decisionScore: { min: 0.1, max: 0.9 } });
  expect(historyFilterSize(filter)).toBe(3);
  // The recorded facts never decide a score range.
  expect(matchesHistoryFilter(filter, facts())).toBe(true);
  expect(hasScoreFilter(filter)).toBe(true);
  expect(hasScoreFilter({ street: ['flop'] })).toBe(false);
  expect(withoutScoreFilter(filter)).toEqual({ street: ['flop'] });
  expect(matchesScoreFilter(filter, { decisionScore: 0.5, actionRankScore: 0.5 })).toBe(true);
  expect(matchesScoreFilter(filter, { decisionScore: 0.75, actionRankScore: 0.51 })).toBe(false);
  expect(matchesScoreFilter(filter, { decisionScore: 0.2, actionRankScore: 0 })).toBe(false);
  expect(matchesScoreFilter({}, { decisionScore: 0, actionRankScore: 0 })).toBe(true);
});
