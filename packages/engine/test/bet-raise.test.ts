import { expect, test } from 'vitest';
import type { ConcreteAction } from '@poker/contracts';
import { CashGame } from '../src/index.js';
import { draftFaults } from '../src/internal/draft-faults.js';

const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'heads-up-fixture' };
function game(aliceStack = 1000, bobStack = 1000) {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  expect(created.game.seatParticipant('alice', 1, aliceStack).ok).toBe(true);
  expect(created.game.seatParticipant('bob', 4, bobStack).ok).toBe(true);
  expect(created.game.startHand().ok).toBe(true);
  return created.game;
}
const state = (cashGame: CashGame, participantId: string) => cashGame.forParticipant(participantId).getView().state;
function accept(cashGame: CashGame, participantId: string, action: ConcreteAction) {
  expect(cashGame.act(participantId, action).ok).toBe(true);
  const view = state(cashGame, participantId);
  expect(view.participants.reduce((sum, p) => sum + p.stack + (view.status === 'active-hand' ? p.contribution ?? 0 : 0), 0)).toBe(2000);
}

test('exact interior total commitments, multiple full raises, and an opening Bet complete a conserved Hand and replay', () => {
  const cashGame = game();
  expect(state(cashGame, 'alice').legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 40, maximum: 1000 }]);
  accept(cashGame, 'alice', { type: 'raise', raiseTo: 53 });
  expect(state(cashGame, 'bob').legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 86, maximum: 1000 }]);
  accept(cashGame, 'bob', { type: 'raise', raiseTo: 100 });
  expect(state(cashGame, 'alice').legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 147, maximum: 1000 }]);
  accept(cashGame, 'alice', { type: 'raise', raiseTo: 147 });
  expect(state(cashGame, 'bob')).toMatchObject({ street: 'preflop', actorId: 'bob', legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 194, maximum: 1000 }] });
  expect(state(cashGame, 'bob').participants.map(p => [p.stack, p.wager, p.contribution])).toEqual([[853, 147, 147], [900, 100, 100]]);
  accept(cashGame, 'bob', { type: 'call' });
  expect(state(cashGame, 'bob')).toMatchObject({ street: 'flop', actorId: 'bob', legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 853 }] });
  accept(cashGame, 'bob', { type: 'bet', betTo: 31 });
  expect(state(cashGame, 'alice').legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 62, maximum: 853 }]);
  accept(cashGame, 'alice', { type: 'call' });
  expect(state(cashGame, 'bob')).toMatchObject({ street: 'turn', actorId: 'bob', legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 822 }] });
  for (let street = 0; street < 2; street++) { accept(cashGame, 'bob', { type: 'check' }); accept(cashGame, 'alice', { type: 'check' }); }
  // Independent known deck fixture: Bob's 2c completes the board's J-high club flush.
  expect(state(cashGame, 'alice')).toMatchObject({ status: 'completed-hand', board: ['9c', '4d', 'Tc', 'Jc', '3c'], payouts: [{ participantId: 'bob', amount: 356 }], returns: [] });
  expect(state(cashGame, 'alice').participants.map(p => p.stack)).toEqual([822, 1178]);
  expect(cashGame.toRecord().commands.filter(c => c.type === 'act').slice(0, 5)).toEqual([
    { type: 'act', participantId: 'alice', action: { type: 'raise', raiseTo: 53 } },
    { type: 'act', participantId: 'bob', action: { type: 'raise', raiseTo: 100 } },
    { type: 'act', participantId: 'alice', action: { type: 'raise', raiseTo: 147 } },
    { type: 'act', participantId: 'bob', action: { type: 'call' } },
    { type: 'act', participantId: 'bob', action: { type: 'bet', betTo: 31 } },
  ]);
  const restored = CashGame.fromRecord(cashGame.toRecord());
  if (!restored.ok) throw new Error('Expected valid replay.');
  expect(restored.game.getHand('hand-1')).toEqual(cashGame.getHand('hand-1'));
  expect(restored.game.forParticipant('alice').getView()).toEqual(cashGame.forParticipant('alice').getView());
});

test('inclusive minimum and maximum sizes agree with submission, including singleton genuine short all-ins', () => {
  for (const amount of [40, 1000]) {
    const cashGame = game();
    expect(cashGame.act('alice', { type: 'raise', raiseTo: amount }).ok).toBe(true);
    expect(state(cashGame, 'bob').participants[0]).toMatchObject({ wager: amount, contribution: amount, stack: 1000 - amount, allIn: amount === 1000 });
    expect(cashGame.act('bob', { type: 'call' }).ok).toBe(true);
    expect(state(cashGame, 'bob').status).toBe(amount === 1000 ? 'completed-hand' : 'active-hand');
  }
  for (const amount of [20, 980]) {
    const cashGame = game(); cashGame.act('alice', { type: 'call' }); cashGame.act('bob', { type: 'check' });
    expect(state(cashGame, 'bob').legalActions).toContainEqual({ type: 'bet', minimum: 20, maximum: 980 });
    expect(cashGame.act('bob', { type: 'bet', betTo: amount }).ok).toBe(true);
    expect(state(cashGame, 'alice').participants[1]).toMatchObject({ wager: amount, contribution: amount + 20, stack: 980 - amount });
    expect(cashGame.act('alice', { type: 'call' }).ok).toBe(true);
  }
  const shortRaise = game(30);
  expect(state(shortRaise, 'alice').legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 30, maximum: 30 }]);
  expect(shortRaise.act('alice', { type: 'raise', raiseTo: 29 })).toMatchObject({ ok: false, rejection: { code: 'illegal-action-size' } });
  expect(shortRaise.act('alice', { type: 'raise', raiseTo: 30 }).ok).toBe(true);
  expect(state(shortRaise, 'bob').legalActions).toEqual([{ type: 'fold' }, { type: 'call' }]);
  expect(shortRaise.act('bob', { type: 'call' }).ok).toBe(true);
  expect(state(shortRaise, 'bob').status).toBe('completed-hand');
  const shortBet = game(35);
  shortBet.act('alice', { type: 'call' }); shortBet.act('bob', { type: 'check' }); shortBet.act('bob', { type: 'check' });
  expect(state(shortBet, 'alice').legalActions).toEqual([{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 15, maximum: 15 }]);
  expect(shortBet.act('alice', { type: 'bet', betTo: 15 }).ok).toBe(true);
  expect(shortBet.act('bob', { type: 'call' }).ok).toBe(true);
  expect(state(shortBet, 'bob').status).toBe('completed-hand');
});

test('wrong actor, malformed size, wrong wagering type, and out-of-bounds intentions leave the complete game unchanged', () => {
  const cashGame = game();
  const record = cashGame.toRecord(); const facts = cashGame.getHand('hand-1'); const view = cashGame.forParticipant('alice').getView();
  const actions: unknown[] = [
    { type: 'raise', raiseTo: 39 }, { type: 'raise', raiseTo: 1001 }, { type: 'raise', raiseTo: -1 },
    { type: 'raise', raiseTo: 53.5 }, { type: 'raise', raiseTo: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'raise', raiseTo: Infinity }, { type: 'raise', raiseTo: NaN }, { type: 'raise', raiseTo: '53' },
    { type: 'raise', to: 53 }, { type: 'raise', raiseTo: 53, seed: 'extra' }, { type: 'bet', betTo: 53 },
  ];
  for (const action of actions) {
    expect(cashGame.act('alice', action as ConcreteAction)).toMatchObject({ ok: false, rejection: { code: expect.any(String) } });
    expect(cashGame.toRecord()).toEqual(record); expect(cashGame.getHand('hand-1')).toEqual(facts);
    expect(cashGame.forParticipant('alice').getView()).toEqual(view);
  }
  expect(cashGame.act('bob', { type: 'raise', raiseTo: 53 })).toMatchObject({ ok: false, rejection: { code: 'wrong-actor' } });
  cashGame.act('alice', { type: 'call' }); cashGame.act('bob', { type: 'check' });
  const flop = cashGame.toRecord(); const flopView = cashGame.forParticipant('bob').getView();
  for (const action of [{ type: 'bet', betTo: 19 }, { type: 'raise', raiseTo: 20 }] as const) {
    expect(cashGame.act('bob', action).ok).toBe(false);
    expect(cashGame.toRecord()).toEqual(flop); expect(cashGame.forParticipant('bob').getView()).toEqual(flopView);
  }
  draftFaults.afterEvaluation = () => { throw new Error('controlled sized-action defect'); };
  try { expect(() => cashGame.act('bob', { type: 'bet', betTo: 37 })).toThrow('controlled sized-action defect'); }
  finally { draftFaults.afterEvaluation = undefined; }
  expect(cashGame.toRecord()).toEqual(flop); expect(cashGame.forParticipant('bob').getView()).toEqual(flopView);
  expect(cashGame.act('bob', { type: 'bet', betTo: 37 }).ok).toBe(true);
});

test('a prior caller facing a single short all-in must match or fold without a reopened raise', () => {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  const cashGame = created.game;
  cashGame.seatParticipant('alice', 1, 1000); cashGame.seatParticipant('bob', 2, 1000); cashGame.seatParticipant('carol', 3, 110); cashGame.startHand();
  expect(cashGame.act('alice', { type: 'raise', raiseTo: 100 }).ok).toBe(true);
  expect(cashGame.act('bob', { type: 'call' }).ok).toBe(true);
  expect(state(cashGame, 'carol').legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 110, maximum: 110 }]);
  expect(cashGame.act('carol', { type: 'raise', raiseTo: 110 }).ok).toBe(true);
  expect(state(cashGame, 'alice')).toMatchObject({ street: 'preflop', actorId: 'alice', legalActions: [{ type: 'fold' }, { type: 'call' }] });
  const record = cashGame.toRecord(); const view = cashGame.forParticipant('alice').getView();
  expect(cashGame.act('alice', { type: 'raise', raiseTo: 190 })).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
  expect(cashGame.toRecord()).toEqual(record); expect(cashGame.forParticipant('alice').getView()).toEqual(view);
  expect(cashGame.act('alice', { type: 'call' }).ok).toBe(true);
  expect(state(cashGame, 'bob')).toMatchObject({ street: 'preflop', actorId: 'bob', legalActions: [{ type: 'fold' }, { type: 'call' }] });
  expect(cashGame.act('bob', { type: 'call' }).ok).toBe(true);
  expect(state(cashGame, 'bob')).toMatchObject({ street: 'flop', actorId: 'bob', legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 890 }] });
});
