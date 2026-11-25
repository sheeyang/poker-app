import { expect, test } from 'vitest';
import { decisionStep, decodeHistoryFilter, historyFilterParams, historyFilterSize, hasScoreFilter, normalizeHistoryFilter } from '../src/index.js';

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

test('a decision opens its Replay Step from its Decision ID', () => {
  expect(decisionStep('hand-12/decision-3')).toBe('decision-3');
});

test('score ranges join the declared filter and its encoding', () => {
  const filter = { street: ['flop'], decisionScore: { min: 0.25, max: 0.75 }, actionRankScore: { max: 0.5 } } as const;
  expect(historyFilterParams(filter)).toEqual({ street: 'flop', decisionScoreMin: '0.25', decisionScoreMax: '0.75', actionRankScoreMax: '0.5' });
  expect(decodeHistoryFilter(historyFilterParams(filter))).toEqual(filter);
  expect(decodeHistoryFilter({ decisionScoreMin: '0.9', decisionScoreMax: 0.1 })).toEqual({ decisionScore: { min: 0.1, max: 0.9 } });
  expect(historyFilterSize(filter)).toBe(3);
  expect(hasScoreFilter(filter)).toBe(true);
  expect(hasScoreFilter({ street: ['flop'] })).toBe(false);
});
