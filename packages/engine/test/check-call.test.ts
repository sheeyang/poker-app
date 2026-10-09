import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';
import { draftFaults } from '../src/internal/draft-faults.js';

const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'heads-up-fixture' };
function game(aliceStack = 1000, bobStack = 1000, seed = configuration.seed) {
  const created = CashGame.create({ ...configuration, seed });
  if (!created.ok) throw new Error('Expected valid CashGame.');
  created.game.seatParticipant('alice', 1, aliceStack);
  created.game.seatParticipant('bob', 4, bobStack);
  created.game.startHand();
  return created.game;
}

test('Call matches the blind and preserves the big blind option; its Check burns and deals the flop with the non-button first', () => {
  const cashGame = game();
  expect(cashGame.forParticipant('alice').getView().state.legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 40, maximum: 1000 }]);
  expect(cashGame.act('alice', { type: 'call' }).ok).toBe(true);
  const option = cashGame.forParticipant('bob').getView();
  expect(option.state).toMatchObject({ street: 'preflop', actorId: 'bob', decisionId: 'hand-1/decision-2', board: [], legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'raise', minimum: 40, maximum: 1000 }] });
  expect(option.state.participants.map(p => [p.stack, p.wager, p.contribution])).toEqual([[980, 20, 20], [980, 20, 20]]);
  const result = cashGame.act('bob', { type: 'check' });
  expect(result.ok).toBe(true);
  expect(cashGame.forParticipant('bob').getView().state).toMatchObject({ street: 'flop', actorId: 'bob', decisionId: 'hand-1/decision-3', board: ['9c', '4d', 'Tc'], legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 980 }] });
  expect(cashGame.forParticipant('alice').getView().state.participants.map(p => [p.stack, p.wager, p.contribution])).toEqual([[980, 0, 20], [980, 0, 20]]);
  // Literal draws from the independent Python v1 vector in docs/random-v1.md.
  expect(cashGame.getHand('hand-1')).toMatchObject({ drawnCardCount: 8, burns: ['3d'], board: ['9c', '4d', 'Tc'] });
});

test('a board-playing tie splits equal contributions without a suit tiebreak and conserves the bankroll', () => {
  // Independent Python shuffle: board-tie-4656 draws Ts Jc 8h 6h 7s Jh Ks Ah Ad Tc 3c Qd.
  const cashGame = game(1000, 1000, 'board-tie-4656');
  cashGame.act('alice', { type: 'call' }); cashGame.act('bob', { type: 'check' });
  for (let street = 0; street < 3; street++) {
    expect(cashGame.act('bob', { type: 'check' }).ok).toBe(true);
    expect(cashGame.act('alice', { type: 'check' }).ok).toBe(true);
  }
  const after = cashGame.forParticipant('alice').getView();
  expect(after.state).toMatchObject({ status: 'completed-hand', board: ['Jh', 'Ks', 'Ah', 'Tc', 'Qd'], payouts: [{ participantId: 'bob', amount: 20 }, { participantId: 'alice', amount: 20 }], returns: [] });
  expect(after.state.participants.map(p => p.stack)).toEqual([1000, 1000]);
});

test('wrong actors, Check while owing, Call while matched, and malformed unsized actions are atomic rejections', () => {
  const cashGame = game();
  const decision = cashGame.forParticipant('alice').getView();
  const facts = cashGame.getHand('hand-1'); const record = cashGame.toRecord();
  expect(cashGame.act('bob', { type: 'call' })).toMatchObject({ ok: false, rejection: { code: 'wrong-actor' } });
  expect(cashGame.act('alice', { type: 'check' })).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
  expect(cashGame.act('alice', { type: 'call', amount: 10 } as { type: 'call' })).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
  expect(cashGame.forParticipant('alice').getView()).toEqual(decision);
  expect(cashGame.getHand('hand-1')).toEqual(facts); expect(cashGame.toRecord()).toEqual(record);
  cashGame.act('alice', { type: 'call' });
  const option = cashGame.forParticipant('bob').getView();
  expect(cashGame.act('bob', { type: 'call' })).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
  expect(cashGame.forParticipant('bob').getView()).toEqual(option);
});

test('defects after a street deal or showdown transfer preserve cards, chips, identities, commands, and immutable prior views', () => {
  const cashGame = game(); cashGame.act('alice', { type: 'call' });
  for (const [actor, transition] of [['bob', 'flop'], ['alice', 'turn'], ['alice', 'river'], ['alice', 'showdown']] as const) {
    const record = cashGame.toRecord(); const facts = cashGame.getHand('hand-1'); const view = cashGame.forParticipant('alice').getView();
    draftFaults.afterEvaluation = () => { throw new Error('controlled ' + transition + ' defect'); };
    try { expect(() => cashGame.act(actor, { type: 'check' })).toThrow('controlled ' + transition + ' defect'); }
    finally { draftFaults.afterEvaluation = undefined; }
    expect(cashGame.toRecord()).toEqual(record); expect(cashGame.getHand('hand-1')).toEqual(facts);
    expect(cashGame.forParticipant('alice').getView()).toEqual(view);
    expect(cashGame.act(actor, { type: 'check' }).ok).toBe(true);
    if (transition !== 'showdown') expect(cashGame.act('bob', { type: 'check' }).ok).toBe(true);
  }
  expect(cashGame.forParticipant('alice').getView().state.status).toBe('completed-hand');
});

test('a Fold after the flop stops dealing and leaves the winning opponent private', () => {
  const cashGame = game();
  cashGame.act('alice', { type: 'call' }); cashGame.act('bob', { type: 'check' }); cashGame.act('bob', { type: 'check' });
  expect(cashGame.act('alice', { type: 'fold' }).ok).toBe(true);
  expect(cashGame.getHand('hand-1')).toMatchObject({ completed: true, drawnCardCount: 8, burns: ['3d'], board: ['9c', '4d', 'Tc'] });
  expect(cashGame.forParticipant('alice').getView().state.participants[1]).not.toHaveProperty('holeCards');
  expect(cashGame.forParticipant('alice').getView().state.participants.map(p => p.stack)).toEqual([980, 1020]);
});

test('a short Call commits only the remaining stack, gives all-in hands no turns, and returns unmatched excess at automatic showdown', () => {
  const cashGame = game(15);
  const result = cashGame.act('alice', { type: 'call' });
  expect(result.ok).toBe(true);
  const view = cashGame.forParticipant('alice').getView();
  expect(view.state).toMatchObject({ status: 'completed-hand', actorId: null, legalActions: [], street: 'river', board: ['9c', '4d', 'Tc', 'Jc', '3c'], pots: [{ amount: 30, eligibleParticipantIds: ['alice', 'bob'] }], returns: [{ participantId: 'bob', amount: 5 }], payouts: [{ participantId: 'bob', amount: 30 }] });
  expect(view.state.participants.map(p => [p.stack, p.contribution])).toEqual([[0, 15], [1015, 20]]);
  expect(cashGame.getHand('hand-1')).toMatchObject({ drawnCardCount: 12, burns: ['3d', 'Qh', '5s'] });
  if (!result.ok) throw new Error('Expected accepted Call.');
  expect(result.events.map(e => e.type)).toEqual(['acted', 'hole-cards-revealed', 'hole-cards-revealed', 'card-burned', 'board-dealt', 'card-burned', 'board-dealt', 'card-burned', 'board-dealt', 'uncalled-return', 'pot-awarded', 'hand-completed']);
  expect(cashGame.forParticipant('alice').projectEvents(result.events).filter(e => e.type === 'card-burned')).toEqual([{ type: 'card-burned', street: 'flop' }, { type: 'card-burned', street: 'turn' }, { type: 'card-burned', street: 'river' }]);
});

test('Check progresses every street and the last river decision reveals live hands, settles the strongest five, and replays immutable facts', () => {
  const cashGame = game();
  const facade = cashGame.forParticipant('alice');
  const before = facade.getView();
  const beforeFacts = cashGame.getHand('hand-1')!;
  cashGame.act('alice', { type: 'call' });
  cashGame.act('bob', { type: 'check' });
  expect(cashGame.act('bob', { type: 'check' }).ok).toBe(true);
  expect(facade.getView().state).toMatchObject({ street: 'flop', actorId: 'alice', board: ['9c', '4d', 'Tc'] });
  expect(cashGame.act('alice', { type: 'check' }).ok).toBe(true);
  expect(facade.getView().state).toMatchObject({ street: 'turn', actorId: 'bob', board: ['9c', '4d', 'Tc', 'Jc'] });
  cashGame.act('bob', { type: 'check' });
  expect(cashGame.act('alice', { type: 'check' }).ok).toBe(true);
  expect(facade.getView().state).toMatchObject({ street: 'river', actorId: 'bob', board: ['9c', '4d', 'Tc', 'Jc', '3c'] });
  cashGame.act('bob', { type: 'check' });
  const result = cashGame.act('alice', { type: 'check' });
  expect(result).toEqual({ ok: true, events: [
    { type: 'acted', handId: 'hand-1', participantId: 'alice', action: { type: 'check' } },
    { type: 'hole-cards-revealed', handId: 'hand-1', participantId: 'alice', cards: ['4s', '5d'] },
    { type: 'hole-cards-revealed', handId: 'hand-1', participantId: 'bob', cards: ['2c', 'Ah'] },
    // Bob's 2c completes the J-high club flush; Alice has a pair of fours.
    { type: 'pot-awarded', handId: 'hand-1', participantId: 'bob', amount: 40 },
    { type: 'hand-completed', handId: 'hand-1' },
  ] });
  const after = facade.getView();
  expect(after.state).toMatchObject({ status: 'completed-hand', actorId: null, decisionId: null, legalActions: [], pots: [{ amount: 40, eligibleParticipantIds: ['alice', 'bob'] }], returns: [], payouts: [{ participantId: 'bob', amount: 40 }] });
  expect(after.state.participants.map(p => [p.stack, p.holeCards])).toEqual([[980, ['4s', '5d']], [1020, ['2c', 'Ah']]]);
  expect(cashGame.getHand('hand-1')).toMatchObject({ completed: true, drawnCardCount: 12, burns: ['3d', 'Qh', '5s'], board: ['9c', '4d', 'Tc', 'Jc', '3c'] });
  expect(JSON.stringify(after)).not.toMatch(/"(?:burns|deck|seed|drawnCardCount)"\s*:/);
  expect(JSON.stringify(before)).not.toMatch(/2c|Ah/);
  expect(beforeFacts).toMatchObject({ completed: false, drawnCardCount: 4, burns: [], board: [] });
  expect(() => { (after.state.board as string[])[0] = 'As'; }).toThrow();
  const restored = CashGame.fromRecord(cashGame.toRecord());
  if (!restored.ok) throw new Error('Expected replay.');
  expect(restored.game.getHand('hand-1')).toEqual(cashGame.getHand('hand-1'));
  expect(restored.game.forParticipant('alice').getView()).toEqual(after);
});
