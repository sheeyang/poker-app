import { expect, test } from 'vitest';
import type { ObservableGameView } from '@poker/contracts';
import { calculateDecisionScores } from '../src/index.js';
import type { ConcreteAction } from '@poker/contracts';

const view: ObservableGameView = {
  configuration: { seatCount: 2, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 1000, allowSeatChanges: true },
  state: { status: 'active-hand', buttonSeat: 1, participants: [{ participantId: 'human', seat: 1, stack: 990, sittingOut: false, wager: 10 }], board: [], pots: [], actorId: 'human', legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 40, maximum: 1000 }] },
  history: [],
};
test('an accepted unsized action uses its Choice probability and its rank among every legal action type', () => {
  const scores = calculateDecisionScores(view, [{ action: { type: 'fold' }, probability: .75 }, { action: { type: 'call' }, probability: .25 }], { type: 'call' });
  expect(scores).toEqual({ decisionScore: .25, actionRankScore: .5, actionProbabilities: [{ type: 'fold', probability: .75 }, { type: 'call', probability: .25 }, { type: 'raise', probability: 0 }] });
});
test.each([
  { action: { type: 'call' } as ConcreteAction, choices: [{ action: { type: 'raise', raiseTo: 100 } as ConcreteAction, probability: 1 }], score: 0, rank: 0 },
  { action: { type: 'raise', raiseTo: 70 } as ConcreteAction, choices: [{ action: { type: 'call' } as ConcreteAction, probability: 1 }], score: 0, rank: 0 },
  { action: { type: 'raise', raiseTo: 100 } as ConcreteAction, choices: [{ action: { type: 'raise', raiseTo: 40 } as ConcreteAction, probability: .6 }, { action: { type: 'raise', raiseTo: 100 } as ConcreteAction, probability: .4 }], score: .4, rank: 1 },
  { action: { type: 'fold' } as ConcreteAction, choices: [{ action: { type: 'fold' } as ConcreteAction, probability: .25 }, { action: { type: 'call' } as ConcreteAction, probability: .25 }, { action: { type: 'raise', raiseTo: 40 } as ConcreteAction, probability: .5 }], score: .25, rank: 0 },
  { action: { type: 'fold' } as ConcreteAction, choices: [{ action: { type: 'fold' } as ConcreteAction, probability: .2 }, { action: { type: 'raise', raiseTo: 40 } as ConcreteAction, probability: .8 }], score: .2, rank: .5 },
  { action: { type: 'call' } as ConcreteAction, choices: [{ action: { type: 'fold' } as ConcreteAction, probability: 1 / 3 }, { action: { type: 'call' } as ConcreteAction, probability: 1 / 3 }, { action: { type: 'raise', raiseTo: 40 } as ConcreteAction, probability: 1 / 3 }], score: 1 / 3, rank: 1 },
])('legal action scoring preserves missing types, exact sizes, aggregation and tied ranks: %j', ({ action, choices, score, rank }) => {
  expect(calculateDecisionScores(view, choices, action)).toMatchObject({ decisionScore: score, actionRankScore: rank });
});
test('a Bet uses its exact total while a single legal action has one rank', () => {
  const betView: ObservableGameView = { ...view, state: { ...view.state, participants: [{ ...view.state.participants[0]!, wager: 0 }], legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 1000 }] } };
  expect(calculateDecisionScores(betView, [{ action: { type: 'check' }, probability: .2 }, { action: { type: 'bet', betTo: 100 }, probability: .8 }], { type: 'bet', betTo: 50 })).toMatchObject({ decisionScore: .4, actionRankScore: 1 });
  expect(calculateDecisionScores({ ...view, state: { ...view.state, legalActions: [{ type: 'call' }] } }, [{ action: { type: 'call' }, probability: 1 }], { type: 'call' })).toMatchObject({ decisionScore: 1, actionRankScore: 1 });
});
test('decimal-equivalent aggregate probabilities share a rank rather than introducing a floating-point rank', () => {
  const scores = calculateDecisionScores(view, [{ action: { type: 'fold' }, probability: .3 }, { action: { type: 'call' }, probability: .4 }, { action: { type: 'raise', raiseTo: 40 }, probability: .1 }, { action: { type: 'raise', raiseTo: 100 }, probability: .2 }], { type: 'raise', raiseTo: 40 });
  expect(scores.actionRankScore).toBe(0);
});
test.each([
  [40, .6], [70, .3], [100, .2],
])('Raise-to %s compares additional street commitment against every reference size', (raiseTo, expected) => {
  const scores = calculateDecisionScores(view, [{ action: { type: 'call' }, probability: .3 }, { action: { type: 'raise', raiseTo: 40 }, probability: .6 }, { action: { type: 'raise', raiseTo: 100 }, probability: .1 }], { type: 'raise', raiseTo });
  expect(scores.decisionScore).toBeCloseTo(expected!);
  expect(scores.actionRankScore).toBe(1);
});
