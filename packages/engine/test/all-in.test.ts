import { expect, test } from 'vitest';
import type { ConcreteAction } from '@poker/contracts';
import { CashGame, type CashGameResult, type GameConfiguration } from '../src/index.js';

const configuration: GameConfiguration = { seatCount: 9, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'heads-up-fixture' };
function create(members: readonly (readonly [string, number, number])[], overrides: Partial<GameConfiguration> = {}) {
  const result = CashGame.create({ ...configuration, ...overrides });
  if (!result.ok) throw new Error('Expected valid CashGame.');
  for (const [id, seat, stack] of members) expect(result.game.seatParticipant(id, seat, stack).ok).toBe(true);
  expect(result.game.startHand().ok).toBe(true);
  return result.game;
}
function play(game: CashGame, id: string, action: ConcreteAction, bankroll: number): Extract<CashGameResult, { ok: true }> {
  const before = game.toRecord().commands.length;
  const result = game.act(id, action);
  if (!result.ok) throw new Error(result.rejection.code);
  expect(game.toRecord().commands).toHaveLength(before + 1);
  const state = game.forParticipant(id).getView().state;
  expect(state.participants.reduce((sum, p) => sum + p.stack + (state.status === 'active-hand' ? p.contribution ?? 0 : 0), 0)).toBe(bankroll);
  return result;
}
function replay(game: CashGame, observer: string) {
  const restored = CashGame.fromRecord(game.toRecord());
  if (!restored.ok) throw new Error('Expected complete record replay.');
  expect(restored.game.getHand('hand-1')).toEqual(game.getHand('hand-1'));
  expect(restored.game.forParticipant(observer).getView()).toEqual(game.forParticipant(observer).getView());
}

test('100/300/300 all-ins resolve the last capped Call before awarding independent main and side winners', () => {
  const game = create([['alice', 3, 100], ['bob', 2, 300], ['carol', 1, 300]]);
  play(game, 'carol', { type: 'raise', raiseTo: 300 }, 700);
  play(game, 'bob', { type: 'call' }, 700);
  const before = game.forParticipant('alice').getView();
  expect(before.state).toMatchObject({ status: 'active-hand', actorId: 'alice', amountToCall: 80, board: [], legalActions: [{ type: 'fold' }, { type: 'call' }] });
  expect(before.state.participants.filter(p => p.holeCards)).toHaveLength(1);
  const final = play(game, 'alice', { type: 'call' }, 700);
  const done = game.forParticipant('alice').getView();
  // Independent heads-up-fixture deck: Alice pairs threes; Bob's ace wins the side pot.
  expect(done.state).toMatchObject({ status: 'completed-hand', actorId: null, decisionId: null, board: ['Tc', 'Qh', 'Jc', '3c', '6d'], pots: [{ amount: 300, eligibleParticipantIds: ['alice', 'bob', 'carol'] }, { amount: 400, eligibleParticipantIds: ['bob', 'carol'] }], returns: [], payouts: [{ participantId: 'alice', amount: 300 }, { participantId: 'bob', amount: 400 }] });
  expect(done.state.participants.map(p => [p.stack, p.contribution, p.allIn])).toEqual([[300, 100, true], [400, 300, true], [0, 300, true]]);
  expect(game.getHand('hand-1')).toMatchObject({ drawnCardCount: 14, burns: ['4d', '5s', '9s'] });
  expect(final.events.map(e => e.type)).toEqual(['acted', 'hole-cards-revealed', 'hole-cards-revealed', 'hole-cards-revealed', 'card-burned', 'board-dealt', 'card-burned', 'board-dealt', 'card-burned', 'board-dealt', 'pot-awarded', 'pot-awarded', 'hand-completed']);
  expect(game.forParticipant('alice').projectEvents(final.events).filter(e => e.type === 'card-burned')).toEqual([{ type: 'card-burned', street: 'flop' }, { type: 'card-burned', street: 'turn' }, { type: 'card-burned', street: 'river' }]);
  expect(game.forParticipant('alice').getView({ at: { decisionId: before.state.decisionId! } })).toEqual(before);
  expect(JSON.stringify(done)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
  replay(game, 'alice');
  // Same normal burn/deal sequence, regardless of the automatic runout path.
  const normal = create([['alice', 3, 1000], ['bob', 2, 1000], ['carol', 1, 1000]]);
  for (const id of ['carol', 'bob', 'alice']) play(normal, id, { type: id === 'alice' ? 'check' : 'call' }, 3000);
  for (let street = 0; street < 3; street++) for (const id of ['bob', 'alice', 'carol']) play(normal, id, { type: 'check' }, 3000);
  expect(normal.getHand('hand-1')!.board).toEqual(['Tc', 'Qh', 'Jc', '3c', '6d']);
  expect(normal.getHand('hand-1')!.burns).toEqual(['4d', '5s', '9s']);
});

test('100/300 contributions award only 200 matched chips and return 200 unmatched chips', () => {
  const game = create([['alice', 2, 100], ['bob', 1, 300]]);
  play(game, 'bob', { type: 'raise', raiseTo: 300 }, 400);
  play(game, 'alice', { type: 'call' }, 400);
  expect(game.forParticipant('alice').getView().state).toMatchObject({ status: 'completed-hand', pots: [{ amount: 200, eligibleParticipantIds: ['alice', 'bob'] }], returns: [{ participantId: 'bob', amount: 200 }], payouts: [{ participantId: 'alice', amount: 200 }] });
  expect(game.forParticipant('alice').getView().state.participants.map(p => p.stack)).toEqual([200, 200]);
  replay(game, 'alice');
});

test('a folded 200-chip contributor funds both matched layers without becoming eligible or receiving a return', () => {
  const game = create([['alice', 1, 100], ['bob', 2, 400], ['carol', 3, 400]]);
  play(game, 'alice', { type: 'raise', raiseTo: 100 }, 900);
  play(game, 'bob', { type: 'call' }, 900);
  play(game, 'carol', { type: 'raise', raiseTo: 200 }, 900);
  play(game, 'bob', { type: 'call' }, 900);
  play(game, 'bob', { type: 'bet', betTo: 100 }, 900);
  const result = play(game, 'carol', { type: 'fold' }, 900);
  const done = game.forParticipant('alice').getView();
  expect(done.state).toMatchObject({ pots: [{ amount: 300, eligibleParticipantIds: ['alice', 'bob'] }, { amount: 200, eligibleParticipantIds: ['bob'] }], returns: [{ participantId: 'bob', amount: 100 }], payouts: [{ participantId: 'bob', amount: 300 }, { participantId: 'bob', amount: 200 }] });
  expect(done.state.participants.map(p => p.stack)).toEqual([0, 700, 200]);
  expect(done.state.participants[2]).toMatchObject({ folded: true, contribution: 200 });
  expect(done.state.participants[2]).not.toHaveProperty('holeCards');
  expect(result.events.filter(e => e.type === 'hole-cards-revealed').map(e => e.participantId)).toEqual(['alice', 'bob']);
  replay(game, 'alice');
});

test('folded chips above a short live cap remain a real side pot before the largest contributor receives unmatched excess', () => {
  const game = create([['alice', 1, 100], ['bob', 2, 1000], ['carol', 3, 1000]]);
  play(game, 'alice', { type: 'raise', raiseTo: 100 }, 2100);
  play(game, 'bob', { type: 'call' }, 2100);
  play(game, 'carol', { type: 'raise', raiseTo: 300 }, 2100);
  play(game, 'bob', { type: 'call' }, 2100);
  play(game, 'bob', { type: 'check' }, 2100);
  play(game, 'carol', { type: 'bet', betTo: 100 }, 2100);
  play(game, 'bob', { type: 'fold' }, 2100);
  expect(game.forParticipant('alice').getView().state).toMatchObject({ pots: [{ amount: 300, eligibleParticipantIds: ['alice', 'carol'] }, { amount: 400, eligibleParticipantIds: ['carol'] }], returns: [{ participantId: 'carol', amount: 100 }], payouts: [{ participantId: 'carol', amount: 300 }, { participantId: 'carol', amount: 400 }] });
  expect(game.forParticipant('alice').getView().state.participants.map(p => p.stack)).toEqual([0, 700, 1400]);
  replay(game, 'alice');
});

test('tied live hands split the main and side pot independently at unequal all-in caps', () => {
  const game = create([['alice', 1, 100], ['bob', 2, 300], ['carol', 3, 300]], { seed: 'all-in-board-tie-3-1441' });
  play(game, 'alice', { type: 'raise', raiseTo: 100 }, 700);
  play(game, 'bob', { type: 'raise', raiseTo: 300 }, 700);
  play(game, 'carol', { type: 'call' }, 700);
  // Independent Python vector: everyone plays the board's eight-high straight.
  expect(game.forParticipant('alice').getView().state).toMatchObject({ board: ['7h', '4c', '5c', '6c', '8s'], pots: [{ amount: 300, eligibleParticipantIds: ['alice', 'bob', 'carol'] }, { amount: 400, eligibleParticipantIds: ['bob', 'carol'] }], returns: [], payouts: [{ participantId: 'bob', amount: 100 }, { participantId: 'carol', amount: 100 }, { participantId: 'alice', amount: 100 }, { participantId: 'bob', amount: 200 }, { participantId: 'carol', amount: 200 }] });
  expect(game.forParticipant('alice').getView().state.participants.map(p => p.stack)).toEqual([100, 300, 300]);
  expect(game.getHand('hand-1')).toMatchObject({ burns: ['Qd', '5d', 'Qs'], drawnCardCount: 14 });
  replay(game, 'alice');
});

test('folded-only contribution caps form one 8-chip pot split equally between the two tied live hands', () => {
  const game = create([['bob', 3, 10], ['alice', 2, 10], ['carol', 5, 10], ['dave', 1, 10], ['eve', 4, 10]], { smallBlind: 1, bigBlind: 1, ante: 1, seed: 'all-in-board-tie-5-44' });
  play(game, 'eve', { type: 'fold' }, 50);
  play(game, 'carol', { type: 'call' }, 50);
  play(game, 'dave', { type: 'fold' }, 50);
  play(game, 'alice', { type: 'check' }, 50);
  play(game, 'bob', { type: 'check' }, 50);
  const before = game.forParticipant('alice').getView();
  play(game, 'alice', { type: 'check' }, 50);
  play(game, 'bob', { type: 'check' }, 50);
  play(game, 'carol', { type: 'fold' }, 50);
  for (let street = 0; street < 2; street++) for (const id of ['alice', 'bob']) play(game, id, { type: 'check' }, 50);
  const done = game.forParticipant('alice').getView();
  // All live hands cover every chip. Folded caps cannot create separate pots.
  expect(done.state).toMatchObject({ board: ['2s', 'Ah', '5s', '4h', '3c'], pots: [{ amount: 8, eligibleParticipantIds: ['bob', 'alice'] }], returns: [], payouts: [{ participantId: 'alice', amount: 4 }, { participantId: 'bob', amount: 4 }] });
  expect(done.state.participants.map(p => [p.stack, p.contribution])).toEqual([[12, 2], [12, 2], [8, 2], [9, 1], [9, 1]]);
  expect(game.getHand('hand-1')).toMatchObject({ drawnCardCount: 18, burns: ['Jd', 'Qd', 'Tc'] });
  expect(done.state.participants.filter(p => p.holeCards).map(p => p.participantId)).toEqual(['bob', 'alice']);
  expect(game.forParticipant('alice').getView({ at: { decisionId: before.state.decisionId! } })).toEqual(before);
  replay(game, 'alice');
});

test('genuine 5-chip and 3-chip pots retain distinct live eligibility and award each clockwise odd chip independently', () => {
  const game = create([['bob', 3, 10], ['alice', 2, 10], ['carol', 5, 2], ['dave', 1, 1], ['eve', 4, 1]], { smallBlind: 1, bigBlind: 1, ante: 1, seed: 'all-in-board-tie-5-30' });
  play(game, 'carol', { type: 'call' }, 24);
  play(game, 'alice', { type: 'check' }, 24);
  play(game, 'bob', { type: 'check' }, 24);
  const before = game.forParticipant('alice').getView();
  expect(before.state.pots).toEqual([{ amount: 5, eligibleParticipantIds: ['bob', 'alice', 'carol', 'dave', 'eve'] }, { amount: 3, eligibleParticipantIds: ['bob', 'alice', 'carol'] }]);
  expect(before.state.participants.filter(p => p.allIn).map(p => p.participantId)).toEqual(['carol', 'dave', 'eve']);
  expect(before.state.participants.filter(p => p.holeCards)).toHaveLength(1);
  for (let street = 0; street < 3; street++) for (const id of ['alice', 'bob']) play(game, id, { type: 'check' }, 24);
  const done = game.forParticipant('alice').getView();
  // Alice/Bob each use a four to make the wheel; every live short stack loses.
  expect(done.state).toMatchObject({ board: ['3s', '8d', '2c', '5s', 'Ah'], pots: [{ amount: 5, eligibleParticipantIds: ['bob', 'alice', 'carol', 'dave', 'eve'] }, { amount: 3, eligibleParticipantIds: ['bob', 'alice', 'carol'] }], returns: [], payouts: [{ participantId: 'alice', amount: 3 }, { participantId: 'bob', amount: 2 }, { participantId: 'alice', amount: 2 }, { participantId: 'bob', amount: 1 }] });
  expect(done.state.participants.map(p => [p.stack, p.contribution, p.folded])).toEqual([[11, 2, false], [13, 2, false], [0, 2, false], [0, 1, false], [0, 1, false]]);
  expect(done.state.participants.every(p => p.holeCards?.length === 2)).toBe(true);
  expect(game.getHand('hand-1')).toMatchObject({ drawnCardCount: 18, burns: ['4s', 'Js', 'Th'] });
  expect(game.forParticipant('alice').getView({ at: { decisionId: before.state.decisionId! } })).toEqual(before);
  replay(game, 'alice');
});

test('an actual-play zero stack remains seated but cannot start heads-up until a rebuy and explicit next Hand', () => {
  const game = create([['alice', 1, 15], ['bob', 4, 1000]]);
  play(game, 'alice', { type: 'call' }, 1015);
  const completed = game.forParticipant('alice').getView();
  expect(completed.state.participants.map(p => p.stack)).toEqual([0, 1015]);
  const record = game.toRecord();
  expect(game.getHand('hand-2')).toBeUndefined();
  expect(game.startHand()).toMatchObject({ ok: false, rejection: { code: 'insufficient-participants' } });
  expect(game.toRecord()).toEqual(record);
  expect(game.topUpTo('alice', 100).ok).toBe(true);
  const rebought = game.forParticipant('alice').getView();
  expect(rebought.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(rebought.state.participants[0]).toMatchObject({ participantId: 'alice', seat: 1, stack: 100 });
  expect(rebought.history).toEqual(completed.history);
  expect(game.getHand('hand-2')).toBeUndefined();
  expect(game.startHand().ok).toBe(true);
  expect(game.forParticipant('alice').getView().state).toMatchObject({ status: 'active-hand', handId: 'hand-2', buttonSeat: 4 });
  expect(game.getHand('hand-2')!.participants.map(p => p.participantId)).toEqual(['alice', 'bob']);
});
