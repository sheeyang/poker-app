import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';

test('completed-Hand enumeration is immutable and independent of Participant membership and a later active Hand', () => {
  const created = CashGame.create({ seatCount: 2, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000, allowSeatChanges: true, seed: 'heads-up-fixture' });
  if (!created.ok) throw new Error('Expected fixture.');
  const game = created.game;
  game.seatParticipant('alice', 1); game.seatParticipant('bob', 2); game.startHand();
  expect(game.getCompletedHands()).toEqual([]);
  const decision = game.forParticipant('alice').getView();
  game.act('alice', { type: 'fold' });
  const list = game.getCompletedHands();
  expect(list).toEqual([{ handId: 'hand-1', sequence: 1 }]);
  expect(() => (list as { handId: string; sequence: number }[]).push({ handId: 'fake', sequence: 2 })).toThrow();
  game.startHand();
  expect(game.getCompletedHands()).toEqual(list);
  expect(game.forParticipant('absent-owner').getView().history).toEqual([]);
  expect(game.forParticipant('alice').getView({ at: { decisionId: 'hand-1/decision-1' } })).toEqual(decision);
  const restored = CashGame.fromRecord(game.toRecord());
  if (!restored.ok) throw new Error('Expected restoration.');
  expect(restored.game.getCompletedHands()).toEqual(list);
});
