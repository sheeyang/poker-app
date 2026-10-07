import { expect, test } from 'vitest';
import { CashGame, type CashGameResult, type GameConfiguration } from '../src/index.js';

const configuration: GameConfiguration = { seatCount: 9, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 0, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'heads-up-fixture' };
function create(overrides: Partial<GameConfiguration> = {}) {
  const result = CashGame.create({ ...configuration, ...overrides });
  if (!result.ok) throw new Error('Expected a valid CashGame.');
  return result.game;
}
function accept(result: CashGameResult) { expect(result.ok).toBe(true); }

test('a sole able blind runs out against a short forced all-in without a fictitious Call or Check', () => {
  for (const [aliceStack, bobStack, returnedTo, returnAmount] of [[5, 100, 'bob', 15], [100, 5, 'alice', 5]] as const) {
    const game = create();
    accept(game.seatParticipant('alice', 1, aliceStack));
    accept(game.seatParticipant('bob', 4, bobStack));
    const start = game.startHand(); accept(start);
    const view = game.forParticipant('alice').getView();
    expect(view.state).toMatchObject({ status: 'completed-hand', actorId: null, decisionId: null, legalActions: [], board: ['9c', '4d', 'Tc', 'Jc', '3c'], pots: [{ amount: 10, eligibleParticipantIds: ['alice', 'bob'] }], returns: [{ participantId: returnedTo, amount: returnAmount }], payouts: [{ participantId: 'bob', amount: 10 }] });
    expect(view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(105);
    expect(game.getHand('hand-1')).toMatchObject({ drawnCardCount: 12, burns: ['3d', 'Qh', '5s'] });
    expect(game.toRecord().commands.filter(c => c.type === 'act')).toEqual([]);
    if (!start.ok) throw new Error('Expected accepted Start Hand.');
    const types = start.events.map(event => event.type);
    expect(types.indexOf('hole-cards-revealed')).toBeLessThan(types.indexOf('card-burned'));
  }
});

test('the sole able multiway actor resolves a real capped Call or Fold before a runout', () => {
  for (const action of ['call', 'fold'] as const) {
    const game = create();
    accept(game.seatParticipant('alice', 1, 100)); accept(game.seatParticipant('bob', 2, 5)); accept(game.seatParticipant('carol', 3, 15));
    accept(game.startHand());
    expect(game.forParticipant('alice').getView().state).toMatchObject({ status: 'active-hand', actorId: 'alice', amountToCall: 15, board: [], legalActions: [{ type: 'fold' }, { type: 'call' }] });
    const record = game.toRecord(); const before = game.forParticipant('alice').getView();
    expect(game.act('alice', { type: 'check' })).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
    expect(game.toRecord()).toEqual(record); expect(game.forParticipant('alice').getView()).toEqual(before);
    accept(game.act('alice', { type: action }));
    const facts = game.getHand('hand-1')!;
    expect(facts).toMatchObject({ completed: true, drawnCardCount: 14, board: ['Tc', 'Qh', 'Jc', '3c', '6d'], burns: ['4d', '5s', '9s'] });
    expect(facts.participants[0]!.contribution).toBe(action === 'call' ? 15 : 0);
    expect(game.forParticipant('alice').getView().state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(120);
  }
});

test('sparse multiway seats deal in two passes left of the button and retain clockwise action across every street', () => {
  const game = create();
  accept(game.seatParticipant('alice', 7)); accept(game.seatParticipant('bob', 9)); accept(game.seatParticipant('carol', 2));
  accept(game.seatParticipant('sitting-out', 4)); accept(game.setSittingOut('sitting-out', true)); accept(game.seatParticipant('zero', 5, 0)); accept(game.setButton(7));
  accept(game.startHand());
  expect(game.getHand('hand-1')).toMatchObject({ buttonSeat: 7, smallBlindParticipantId: 'bob', bigBlindParticipantId: 'carol', actorId: 'alice', drawnCardCount: 6, participants: [
    { participantId: 'alice', seat: 7, holeCards: ['5d', '9c'] }, { participantId: 'bob', seat: 9, holeCards: ['4s', 'Ah'] }, { participantId: 'carol', seat: 2, holeCards: ['2c', '3d'] },
  ] });
  const before = game.forParticipant('sitting-out').getView();
  expect(before.state.participants.find(p => p.participantId === 'sitting-out')).not.toHaveProperty('inHand');
  expect(before.state.participants.find(p => p.participantId === 'zero')).not.toHaveProperty('cardCount');
  expect(before.state.participants.filter(p => p.inHand).every(p => !('holeCards' in p))).toBe(true);
  for (const actor of ['alice', 'bob', 'carol']) {
    expect(game.forParticipant(actor).getView().state.actorId).toBe(actor);
    accept(game.act(actor, { type: actor === 'carol' ? 'check' : 'call' }));
  }
  for (const [index, street] of ['flop', 'turn', 'river'].entries()) {
    expect(game.forParticipant('bob').getView().state).toMatchObject({ street, actorId: 'bob', board: ['Tc', 'Qh', 'Jc', '3c', '6d'].slice(0, index + 3) });
    for (const actor of ['bob', 'carol', 'alice']) {
      expect(game.forParticipant(actor).getView().state.actorId).toBe(actor);
      accept(game.act(actor, { type: 'check' }));
    }
  }
  // Carol pairs the board's three; Alice and Bob have only high cards.
  expect(game.getHand('hand-1')).toMatchObject({ completed: true, drawnCardCount: 14, burns: ['4d', '5s', '9s'], payouts: [{ participantId: 'carol', amount: 60 }] });
  expect(game.forParticipant('alice').getView().state.participants.map(p => p.stack)).toEqual([980, 980, 1040, 1000, 0]);
  expect(before.state.board).toEqual([]);
  expect(JSON.stringify(before)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount)"\s*:/);
  const restored = CashGame.fromRecord(game.toRecord());
  if (!restored.ok) throw new Error('Expected valid replay.');
  expect(restored.game.getHand('hand-1')).toEqual(game.getHand('hand-1'));
  expect(restored.game.forParticipant('alice').getView()).toEqual(game.forParticipant('alice').getView());
});

test('nine participants receive eighteen distinct hole cards and complete a clockwise full-table Hand', () => {
  const game = create();
  for (let seat = 1; seat <= 9; seat++) accept(game.seatParticipant('p' + seat, seat));
  accept(game.startHand());
  const hand = game.getHand('hand-1')!;
  expect(hand).toMatchObject({ smallBlindParticipantId: 'p2', bigBlindParticipantId: 'p3', actorId: 'p4', drawnCardCount: 18 });
  expect(hand.participants.map(p => p.holeCards)).toEqual([['Qh', 'Ks'], ['4s', 'Jc'], ['2c', '5s'], ['5d', '3c'], ['Ah', '9s'], ['3d', '6d'], ['9c', '8d'], ['4d', '3s'], ['Tc', '7d']]);
  for (const actor of ['p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p1', 'p2', 'p3']) {
    expect(game.forParticipant(actor).getView().state.actorId).toBe(actor);
    accept(game.act(actor, { type: actor === 'p3' ? 'check' : 'call' }));
  }
  for (let street = 0; street < 3; street++) for (const actor of ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p1']) {
    expect(game.forParticipant(actor).getView().state.actorId).toBe(actor); accept(game.act(actor, { type: 'check' }));
  }
  // p5 pairs the board's ace, beating p1's kings and every other holding.
  expect(game.getHand('hand-1')).toMatchObject({ completed: true, drawnCardCount: 26, burns: ['7h', 'Jh', '7s'], board: ['Kc', 'As', '2h', '6c', 'Ts'], payouts: [{ participantId: 'p5', amount: 180 }] });
  expect(game.forParticipant('p1').getView().state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(9000);
});

test.each([2, 3, 4, 5, 6, 7, 8, 9])('%i eligible participants can complete within a nine-seat capacity', count => {
  const game = create({ ante: 1 });
  for (let seat = 1; seat <= count; seat++) accept(game.seatParticipant('p' + seat, seat));
  accept(game.startHand());
  let commands = 0;
  while (game.forParticipant('p1').getView().state.status === 'active-hand') {
    const actor = game.forParticipant('p1').getView().state.actorId!;
    const actions = game.forParticipant(actor).getView().state.legalActions;
    accept(game.act(actor, { type: actions.some(a => a.type === 'call') ? 'call' : 'check' }));
    if (++commands > 40) throw new Error('Hand did not finish.');
  }
  const view = game.forParticipant('p1').getView();
  expect(view.configuration.seatCount).toBe(9); expect(view.state.participants).toHaveLength(count);
  expect(view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(count * 1000);
  expect(game.getHand('hand-1')!.participants.every(p => p.contribution === 21)).toBe(true);
});

test('antes precede blinds, preserve short all-in membership, and remain separate from street wagers', () => {
  const game = create({ ante: 5 });
  accept(game.seatParticipant('alice', 1, 3)); accept(game.seatParticipant('bob', 2, 100)); accept(game.seatParticipant('carol', 3, 100));
  const start = game.startHand(); accept(start);
  const view = game.forParticipant('bob').getView();
  expect(view.state).toMatchObject({ buttonSeat: 1, smallBlindParticipantId: 'bob', bigBlindParticipantId: 'carol', actorId: 'bob', legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 40, maximum: 95 }] });
  expect(view.state.participants.map(p => [p.participantId, p.stack, p.contribution, p.wager, (p as { anteContribution?: number }).anteContribution, p.allIn, p.cardCount])).toEqual([
    ['alice', 0, 3, 0, 3, true, 2], ['bob', 85, 15, 10, 5, false, 2], ['carol', 75, 25, 20, 5, false, 2],
  ]);
  if (!start.ok) throw new Error('Expected accepted Start Hand.');
  expect(start.events.filter(e => e.type === 'forced-contribution')).toEqual([
    { type: 'forced-contribution', participantId: 'alice', kind: 'ante', amount: 3 },
    { type: 'forced-contribution', participantId: 'bob', kind: 'ante', amount: 5 },
    { type: 'forced-contribution', participantId: 'carol', kind: 'ante', amount: 5 },
    { type: 'forced-contribution', participantId: 'bob', kind: 'small-blind', amount: 10 },
    { type: 'forced-contribution', participantId: 'carol', kind: 'big-blind', amount: 20 },
  ]);
  accept(game.act('bob', { type: 'call' }));
  expect(game.forParticipant('carol').getView().state.legalActions).toEqual([{ type: 'fold' }, { type: 'check' }, { type: 'raise', minimum: 40, maximum: 95 }]);
  accept(game.act('carol', { type: 'check' }));
  const flop = game.forParticipant('bob').getView();
  expect(flop.state).toMatchObject({ street: 'flop', actorId: 'bob', pots: [{ amount: 9, eligibleParticipantIds: ['alice', 'bob', 'carol'] }, { amount: 44, eligibleParticipantIds: ['bob', 'carol'] }] });
  expect(flop.state.participants.map(p => [p.stack, p.wager, p.contribution, (p as { anteContribution?: number }).anteContribution])).toEqual([[0, 0, 3, 3], [75, 0, 25, 5], [75, 0, 25, 5]]);
  expect(flop.state.participants.reduce((sum, p) => sum + p.stack + (p.contribution ?? 0), 0)).toBe(203);
});
