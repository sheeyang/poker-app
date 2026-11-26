import { expect, test } from 'vitest';
import type { ConcreteAction, DecisionFacts, ObservableCashGameState, ObservableHandReplay, ObservableHistoryEntry, ObservableParticipant, OverallHistoryDecision, ReplayStep } from '@poker/contracts';
import {
  admittedByScores, filteredDecisions, historyBreakdownValue, inListOrder, matchesHistoryFilter, matchesScoreFilter, newestFirst, ownDecisionIds, ownDecisions,
  scoreAdmission, summarySets, tableHandReplay, tableHistoryHands, type CompletedHand, type HistoryViewer,
} from '../src/index.js';

/*
 * A hand-built three-seat Practice Table, as the Participant `viewer` reads its Observable Session History: `viewer` at seat 1,
 * `opp` at seat 2, a Bot `bot` at seat 3; blinds 5/10. Only `viewer`'s own hole cards appear, except where a showdown
 * revealed `opp`'s in its own Hand's result.
 */
const participant = (participantId: string, seat: number, extra: Partial<ObservableParticipant> = {}): ObservableParticipant =>
  ({ participantId, seat, stack: 1_000, sittingOut: false, inHand: true, handSeat: seat, folded: false, contribution: 0, ...extra });
const state = (extra: Partial<ObservableCashGameState>): ObservableCashGameState =>
  ({ status: 'active-hand', buttonSeat: 1, participants: [], board: [], pots: [], actorId: null, legalActions: [], ...extra });
const decision = (decisionId: string, participantId: string, action: ConcreteAction, at: ObservableCashGameState): ObservableHistoryEntry['decisions'][number] =>
  ({ decisionId, state: { ...at, actorId: participantId, decisionId }, action: { participantId, action } });
const mine = ['As', 'Kd'] as const;

/** Hand 1, completed at 1,000: `viewer` on the button raises, `opp` folds, `bot` calls; on the flop `bot` checks, `viewer` bets and `bot` folds. */
const hand1: CompletedHand = {
  handNumber: 1, completedAt: 1_000,
  entry: {
    handId: 'hand-1', description: 'Hand 1',
    decisions: [
      decision('hand-1/decision-1', 'viewer', { type: 'raise', raiseTo: 30 }, state({ handId: 'hand-1', street: 'preflop', participants: [participant('viewer', 1, { holeCards: mine }), participant('opp', 2, { contribution: 5, wager: 5 }), participant('bot', 3, { contribution: 10, wager: 10 })] })),
      decision('hand-1/decision-2', 'opp', { type: 'fold' }, state({ handId: 'hand-1', street: 'preflop', participants: [participant('viewer', 1, { holeCards: mine, contribution: 30, wager: 30 }), participant('opp', 2, { contribution: 5, wager: 5 }), participant('bot', 3, { contribution: 10, wager: 10 })] })),
      decision('hand-1/decision-3', 'bot', { type: 'call' }, state({ handId: 'hand-1', street: 'preflop', participants: [participant('viewer', 1, { holeCards: mine, contribution: 30, wager: 30 }), participant('opp', 2, { contribution: 5, folded: true }), participant('bot', 3, { contribution: 10, wager: 10 })] })),
      decision('hand-1/decision-4', 'bot', { type: 'check' }, state({ handId: 'hand-1', street: 'flop', board: ['2c', '7h', 'Jd'], participants: [participant('viewer', 1, { holeCards: mine, contribution: 30 }), participant('opp', 2, { contribution: 5, folded: true }), participant('bot', 3, { contribution: 30 })] })),
      decision('hand-1/decision-5', 'viewer', { type: 'bet', betTo: 40 }, state({ handId: 'hand-1', street: 'flop', board: ['2c', '7h', 'Jd'], participants: [participant('viewer', 1, { holeCards: mine, contribution: 30 }), participant('opp', 2, { contribution: 5, folded: true }), participant('bot', 3, { contribution: 30 })] })),
      decision('hand-1/decision-6', 'bot', { type: 'fold' }, state({ handId: 'hand-1', street: 'flop', board: ['2c', '7h', 'Jd'], participants: [participant('viewer', 1, { holeCards: mine, contribution: 70, wager: 40 }), participant('opp', 2, { contribution: 5, folded: true }), participant('bot', 3, { contribution: 30 })] })),
    ],
    result: state({ status: 'completed-hand', handId: 'hand-1', board: ['2c', '7h', 'Jd'], participants: [participant('bot', 3, { folded: true, contribution: 30 }), participant('viewer', 1, { holeCards: mine, contribution: 70 }), participant('opp', 2, { folded: true, contribution: 5 })], payouts: [{ participantId: 'viewer', amount: 105 }] }),
  },
};
/** Hand 2, completed before completion times were recorded: the button moves to `opp`; `viewer` in the big blind checks to a showdown that reveals `opp`'s cards. */
const hand2: CompletedHand = {
  handNumber: 2,
  entry: {
    handId: 'hand-2', description: 'Hand 2',
    decisions: [
      decision('hand-2/decision-1', 'opp', { type: 'call' }, state({ handId: 'hand-2', buttonSeat: 2, street: 'preflop', participants: [participant('viewer', 1, { holeCards: mine, contribution: 10, wager: 10 }), participant('opp', 2), participant('bot', 3, { contribution: 5, wager: 5 })] })),
      decision('hand-2/decision-2', 'bot', { type: 'fold' }, state({ handId: 'hand-2', buttonSeat: 2, street: 'preflop', participants: [participant('viewer', 1, { holeCards: mine, contribution: 10, wager: 10 }), participant('opp', 2, { contribution: 10, wager: 10 }), participant('bot', 3, { contribution: 5, wager: 5 })] })),
      decision('hand-2/decision-3', 'viewer', { type: 'check' }, state({ handId: 'hand-2', buttonSeat: 2, street: 'preflop', participants: [participant('viewer', 1, { holeCards: mine, contribution: 10, wager: 10 }), participant('opp', 2, { contribution: 10, wager: 10 }), participant('bot', 3, { contribution: 5, folded: true })] })),
    ],
    result: state({ status: 'completed-hand', handId: 'hand-2', buttonSeat: 2, board: ['2c', '7h', 'Jd', 'Qs', '3h'], participants: [participant('viewer', 1, { holeCards: mine, contribution: 10 }), participant('opp', 2, { holeCards: ['9c', '9d'], contribution: 10 }), participant('bot', 3, { folded: true, contribution: 5 })], payouts: [{ participantId: 'opp', amount: 25 }] }),
  },
};
const viewer: HistoryViewer = {
  tableSessionId: 'table-a', mode: 'practice', participantId: 'viewer', seatCount: 3, stakes: { smallBlind: 5, bigBlind: 10, ante: 0 },
  names: new Map([['viewer', 'Mia'], ['opp', 'Olu'], ['bot', 'Bot 1']]), bots: new Set(['bot']),
};

test('a Table History row shows everyone dealt in, in seat order and by name, with only the hole cards the viewer saw, the board and the payouts', () => {
  const [first, second] = tableHistoryHands([hand1, hand2], viewer);
  expect(first).toEqual({
    handId: 'hand-1', handNumber: 1, completedAt: 1_000,
    dealtIn: [{ participantId: 'viewer', name: 'Mia', holeCards: ['As', 'Kd'] }, { participantId: 'opp', name: 'Olu' }, { participantId: 'bot', name: 'Bot 1' }],
    viewerDealtIn: true, board: ['2c', '7h', 'Jd'], showdown: false, payouts: [{ participantId: 'viewer', amount: 105 }],
  });
  // A showdown reveals the cards it showed in its own Hand's result; an undated Hand has no completion time at all.
  expect(second).toEqual({
    handId: 'hand-2', handNumber: 2,
    dealtIn: [{ participantId: 'viewer', name: 'Mia', holeCards: ['As', 'Kd'] }, { participantId: 'opp', name: 'Olu', holeCards: ['9c', '9d'] }, { participantId: 'bot', name: 'Bot 1' }],
    viewerDealtIn: true, board: ['2c', '7h', 'Jd', 'Qs', '3h'], showdown: true, payouts: [{ participantId: 'opp', amount: 25 }],
  });
  expect(second).not.toHaveProperty('completedAt');
});

test('a viewer who was not dealt in sees the row as not theirs, a Participant not dealt in is not listed, and a missing name shows none', () => {
  const sitting = { ...hand1, entry: { ...hand1.entry, result: { ...hand1.entry.result, participants: [...hand1.entry.result.participants, { participantId: 'late', seat: 4, stack: 1_000, sittingOut: false }] } } };
  const [row] = tableHistoryHands([sitting], { ...viewer, participantId: 'late', names: new Map([['viewer', 'Mia']]) });
  expect(row!.viewerDealtIn).toBe(false);
  expect(row!.dealtIn.map(participant => [participant.participantId, participant.name])).toEqual([['viewer', 'Mia'], ['opp', ''], ['bot', '']]);
});

test("a Hand's replay carries the engine's steps unchanged, the list row, and everyone seated at any step in seat order at their first step, each a Bot or not", () => {
  const step = (participants: ObservableParticipant[], kind: ReplayStep['kind'] = 'decision'): ReplayStep => ({ kind, state: state({ handId: 'hand-1', participants }), transition: {} });
  const replay: ObservableHandReplay = {
    handId: 'hand-1', configuration: { seatCount: 3, smallBlind: 5, bigBlind: 10, ante: 0, minimumBuyIn: 400, defaultBuyIn: 1_000, maximumBuyIn: 2_000, allowSeatChanges: false },
    steps: [
      step([participant('bot', 3), participant('viewer', 1), { participantId: 'watcher', seat: null, stack: 0, sittingOut: true }]),
      // `opp` sits down later at seat 2, and `viewer` moves to seat 3 after `bot` leaves: each keeps the seat of their first step.
      step([participant('viewer', 3), participant('opp', 2)], 'result'),
    ],
  };
  const [hand] = tableHistoryHands([hand1], viewer);
  const replayed = tableHandReplay(replay, hand!, viewer);
  expect(replayed).toEqual({
    ...replay, tableSessionId: 'table-a', mode: 'practice', viewerParticipantId: 'viewer',
    // The row it carries says who was dealt in, and nothing of how the Hand ended.
    hand: { handId: 'hand-1', handNumber: 1, completedAt: 1_000, viewerDealtIn: true, dealtIn: [{ participantId: 'viewer', name: 'Mia' }, { participantId: 'opp', name: 'Olu' }, { participantId: 'bot', name: 'Bot 1' }] },
    participants: [{ participantId: 'viewer', name: 'Mia', bot: false }, { participantId: 'opp', name: 'Olu', bot: false }, { participantId: 'bot', name: 'Bot 1', bot: true }],
    steps: [replay.steps[0], { ...replay.steps[1], result: { board: ['2c', '7h', 'Jd'], showdown: false, payouts: [{ participantId: 'viewer', amount: 105 }], holeCards: [{ participantId: 'viewer', cards: ['As', 'Kd'] }] } }],
  });
  expect(replayed.steps[0]).toBe(replay.steps[0]);
});

test("a Hand's replay holds how the Hand ended on its result step alone, a showdown's revealed cards included", () => {
  const [, second] = tableHistoryHands([hand1, hand2], viewer);
  const decisionStep: ReplayStep = { kind: 'decision', state: state({ handId: 'hand-2', participants: [participant('viewer', 1, { holeCards: mine }), participant('opp', 2)] }), transition: {} };
  const streetStep: ReplayStep = { kind: 'street', state: state({ handId: 'hand-2', street: 'flop', board: ['2c', '7h', 'Jd'], participants: [participant('viewer', 1, { holeCards: mine }), participant('opp', 2)] }), transition: {} };
  const resultStep: ReplayStep = { kind: 'result', state: hand2.entry.result, transition: {} };
  const replayed = tableHandReplay({ handId: 'hand-2', configuration: {} as ObservableHandReplay['configuration'], steps: [decisionStep, streetStep, resultStep] }, second!, viewer);
  expect(replayed.steps.map(step => 'result' in step)).toEqual([false, false, true]);
  expect(replayed.steps[2]!.result).toEqual({
    board: ['2c', '7h', 'Jd', 'Qs', '3h'], showdown: true, payouts: [{ participantId: 'opp', amount: 25 }],
    holeCards: [{ participantId: 'viewer', cards: ['As', 'Kd'] }, { participantId: 'opp', cards: ['9c', '9d'] }],
  });
  // Outside the result step, nothing but the table as the step shows it: the flop's board, the viewer's own cards.
  const before = JSON.stringify({ ...replayed, steps: replayed.steps.slice(0, 2) });
  for (const spoiler of ['Qs', '3h', '9c', '9d', 'payouts', 'showdown']) expect(before).not.toContain(spoiler);
});

test("the viewer's own decisions are theirs alone, in decision order, with the facts the filters read from each recorded state", () => {
  const decisions = ownDecisions([hand1, hand2], viewer);
  expect(decisions.map(listed => listed.decisionId)).toEqual(['hand-1/decision-1', 'hand-1/decision-5', 'hand-2/decision-3']);
  expect(decisions[0]).toEqual({
    tableSessionId: 'table-a', mode: 'practice', seatCount: 3, stakes: { smallBlind: 5, bigBlind: 10, ante: 0 },
    handId: 'hand-1', handNumber: 1, completedAt: 1_000, decisionId: 'hand-1/decision-1', action: { type: 'raise', raiseTo: 30 },
    holeCards: ['As', 'Kd'], board: [], street: 'preflop', position: 'BTN', pot: 15, potBigBlinds: 1.5,
  });
  // The pot as faced counts every chip committed so far, the current street's included; the board is as it was then.
  expect(decisions[1]).toMatchObject({ street: 'flop', position: 'BTN', pot: 65, potBigBlinds: 6.5, board: ['2c', '7h', 'Jd'] });
  expect(decisions[2]).toMatchObject({ handNumber: 2, street: 'preflop', position: 'BB', pot: 25, potBigBlinds: 2.5 });
  expect(decisions[2]).not.toHaveProperty('completedAt');
  // A viewer who made no decision has none, and nobody else's decision is ever listed as theirs.
  expect(ownDecisions([hand1, hand2], { ...viewer, participantId: 'watcher' })).toEqual([]);
  expect(ownDecisions([hand1, hand2], { ...viewer, participantId: 'opp' }).map(listed => listed.decisionId)).toEqual(['hand-1/decision-2', 'hand-2/decision-1']);
});

test("a table-scoped Score Summary covers the viewer's own decisions in one Hand, or in every completed Hand of the Table Session", () => {
  const inProgress: ObservableHistoryEntry = { handId: 'hand-3', description: 'Hand 3', decisions: [decision('hand-3/decision-1', 'viewer', { type: 'fold' }, state({ handId: 'hand-3', street: 'preflop' }))] };
  const history = [hand1.entry, hand2.entry, inProgress];
  expect(ownDecisionIds(history, 'viewer', { scope: 'table-session' })).toEqual(['hand-1/decision-1', 'hand-1/decision-5', 'hand-2/decision-3']);
  expect(ownDecisionIds(history, 'viewer', { scope: 'hand', handId: 'hand-1' })).toEqual(['hand-1/decision-1', 'hand-1/decision-5']);
  // A Hand scope covers that Hand whether or not it has completed.
  expect(ownDecisionIds(history, 'viewer', { scope: 'hand', handId: 'hand-3' })).toEqual(['hand-3/decision-1']);
  expect(ownDecisionIds(history, 'bot', { scope: 'hand', handId: 'hand-2' })).toEqual(['hand-2/decision-2']);
  expect(ownDecisionIds(history, 'viewer', { scope: 'hand', handId: 'hand-9' })).toEqual([]);
});

/** A listed decision with only what ordering, filtering and bucketing read. */
const listed = (decisionId: string, extra: Partial<OverallHistoryDecision>): OverallHistoryDecision => ({
  tableSessionId: 'table-a', mode: 'practice', seatCount: 6, stakes: { smallBlind: 5, bigBlind: 10, ante: 0 }, handId: 'hand-1', handNumber: 1,
  decisionId, action: { type: 'check' }, holeCards: [], board: [], street: 'preflop', position: 'BTN', pot: 15, potBigBlinds: 1.5, ...extra,
});

test('Overall History lists the most recently completed Hand first, undated Hands last, then by table and Hand number, decisions in the order made', () => {
  const decisions = [
    listed('a-1', { handNumber: 1, completedAt: 100 }), listed('a-2', { handNumber: 1, completedAt: 100 }),
    listed('a-3', { handNumber: 2 }), listed('a-4', { handNumber: 3, completedAt: 300 }),
    listed('b-1', { tableSessionId: 'table-b', handNumber: 7, completedAt: 100 }), listed('b-2', { tableSessionId: 'table-b', handNumber: 8 }),
  ];
  const expected = ['a-4', 'a-1', 'a-2', 'b-1', 'a-3', 'b-2'];
  expect(newestFirst(decisions).map(decision => decision.decisionId)).toEqual(expected);
  // A set of decisions, each with what was frozen for it, keeps the same order.
  expect(inListOrder(decisions.map(decision => ({ decision, input: decision.decisionId.toUpperCase() }))).map(studied => studied.input)).toEqual(expected.map(id => id.toUpperCase()));
});

const facts = (override: Partial<DecisionFacts> = {}): DecisionFacts => ({ street: 'flop', position: 'CO', action: { type: 'raise', raiseTo: 60 }, mode: 'practice', completedAt: 1_000, potBigBlinds: 4.5, ...override });

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
  // The recorded facts never decide a score range.
  expect(matchesHistoryFilter({ street: ['flop'], decisionScore: { min: 0.99 }, actionRankScore: { max: 0 } }, facts())).toBe(true);
});

test("filtering the viewer's own decisions keeps those every non-score restriction admits, in order", () => {
  const decisions = ownDecisions([hand1, hand2], viewer);
  expect(filteredDecisions(decisions, { street: ['preflop'] }).map(decision => decision.decisionId)).toEqual(['hand-1/decision-1', 'hand-2/decision-3']);
  expect(filteredDecisions(decisions, { position: ['BB'] }).map(decision => decision.decisionId)).toEqual(['hand-2/decision-3']);
  expect(filteredDecisions(decisions, { completed: { min: 0 } }).map(decision => decision.decisionId)).toEqual(['hand-1/decision-1', 'hand-1/decision-5']);
  expect(filteredDecisions(decisions, { pot: { min: 2, max: 7 } }).map(decision => decision.decisionId)).toEqual(['hand-1/decision-5', 'hand-2/decision-3']);
  expect(filteredDecisions(decisions, { mode: ['online'] })).toEqual([]);
});

test('score ranges admit scores inclusively; a filter with none admits every finished analysis', () => {
  const filter = { street: ['flop'], decisionScore: { min: 0.25, max: 0.75 }, actionRankScore: { max: 0.5 } } as const;
  expect(matchesScoreFilter(filter, { decisionScore: 0.5, actionRankScore: 0.5 })).toBe(true);
  expect(matchesScoreFilter(filter, { decisionScore: 0.75, actionRankScore: 0.51 })).toBe(false);
  expect(matchesScoreFilter(filter, { decisionScore: 0.2, actionRankScore: 0 })).toBe(false);
  expect(matchesScoreFilter({}, { decisionScore: 0, actionRankScore: 0 })).toBe(true);
  const admits = scoreAdmission(filter)!;
  expect(admits({ decisionScore: 0.25, actionRankScore: 0 })).toBe(true);
  expect(admits({ decisionScore: 0.8, actionRankScore: 0 })).toBe(false);
  expect(scoreAdmission({ street: ['flop'] })).toBeUndefined();
  expect(scoreAdmission({})).toBeUndefined();
});

test('of a finished set, the score ranges admit the members whose scores pass, in order; a member without scores is never admitted', () => {
  const scores = [{ decisionScore: 0.9, actionRankScore: 1 }, { decisionScore: 0.1, actionRankScore: 0 }, undefined, { decisionScore: 0.5, actionRankScore: 0.5 }];
  expect(admittedByScores({ decisionScore: { min: 0.5 } }, ['a', 'b', 'c', 'd'], scores)).toEqual(['a', 'd']);
  expect(admittedByScores({}, ['a', 'b', 'c', 'd'], scores)).toEqual(['a', 'b', 'd']);
  expect(admittedByScores({ actionRankScore: { max: 0.2 } }, [], [])).toEqual([]);
});

test('a breakdown puts each decision in the bucket of its street, Position, action type or table mode', () => {
  expect(historyBreakdownValue('street', facts())).toBe('flop');
  expect(historyBreakdownValue('position', facts())).toBe('CO');
  expect(historyBreakdownValue('action', facts())).toBe('raise');
  expect(historyBreakdownValue('mode', facts({ mode: 'online' }))).toBe('online');
});

test("a summary's sets hold every decision's frozen input in the list's order, and with a breakdown one set per value the decisions have, in declared order", () => {
  const studied = [
    { decision: listed('a', { handNumber: 1, completedAt: 100, street: 'river', action: { type: 'bet', betTo: 20 } }), input: 'A' },
    { decision: listed('b', { handNumber: 2, completedAt: 200, street: 'preflop' }), input: 'B' },
    { decision: listed('c', { handNumber: 3, completedAt: 300, street: 'river', mode: 'online' }), input: 'C' },
    { decision: listed('d', { handNumber: 4, street: 'flop', action: { type: 'fold' } }), input: 'D' },
  ];
  const whole = summarySets(studied);
  expect(whole).toEqual({ members: ['C', 'B', 'A', 'D'] });
  expect(whole).not.toHaveProperty('buckets');
  expect(summarySets(studied, 'street')).toEqual({ members: ['C', 'B', 'A', 'D'], buckets: [{ value: 'preflop', members: ['B'] }, { value: 'flop', members: ['D'] }, { value: 'river', members: ['C', 'A'] }] });
  expect(summarySets(studied, 'action').buckets).toEqual([{ value: 'fold', members: ['D'] }, { value: 'check', members: ['C', 'B'] }, { value: 'bet', members: ['A'] }]);
  expect(summarySets(studied, 'mode').buckets).toEqual([{ value: 'practice', members: ['B', 'A', 'D'] }, { value: 'online', members: ['C'] }]);
  expect(summarySets(studied, 'position').buckets).toEqual([{ value: 'BTN', members: ['C', 'B', 'A', 'D'] }]);
  // An empty set has no members and, under any breakdown, no buckets.
  expect(summarySets([], 'street')).toEqual({ members: [], buckets: [] });
});
