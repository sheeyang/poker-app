import { expect, test } from 'vitest';
import type { ConcreteAction } from '@poker/contracts';
import { CashGame } from '../src/index.js';

// Independent ADR-0025 fixture: A opens 100, B exhausts 150, C calls
// 150, D exhausts 199/200/201. A and C have different prior prices.
const configuration = { seatCount: 5, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1, defaultBuyIn: 1000, maximumBuyIn: 1000, allowSeatChanges: true, seed: 'all-in-board-tie-5-30' };
const view = (game: CashGame, id = 'a') => game.forParticipant(id).getView();
function accept(game: CashGame, id: string, action: ConcreteAction, bankroll: number) {
  const count = game.toRecord().commands.length;
  expect(game.act(id, action)).toMatchObject({ ok: true });
  expect(game.toRecord().commands).toHaveLength(count + 1);
  const state = view(game, id).state;
  expect(state.participants.reduce((sum, p) => sum + p.stack + (state.status === 'active-hand' ? p.contribution ?? 0 : 0), 0)).toBe(bankroll);
}
function fixture(lastPrice = 200) {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid configuration.');
  const game = created.game;
  const bankroll = 3190 + lastPrice;
  for (const [id, seat, chips] of [['e', 1, 1000], ['a', 2, 1000], ['b', 3, 170], ['c', 4, 1000], ['d', 5, lastPrice + 20]] as const)
    expect(game.seatParticipant(id, seat, chips).ok).toBe(true);
  expect(game.startHand().ok).toBe(true);
  for (const id of ['c', 'd', 'e', 'a']) accept(game, id, { type: 'call' }, bankroll);
  accept(game, 'b', { type: 'check' }, bankroll);
  accept(game, 'a', { type: 'bet', betTo: 100 }, bankroll);
  expect(view(game, 'b').state.legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 150, maximum: 150 }]);
  accept(game, 'b', { type: 'raise', raiseTo: 150 }, bankroll);
  accept(game, 'c', { type: 'call' }, bankroll);
  expect(view(game, 'd').state.legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: lastPrice, maximum: lastPrice }]);
  accept(game, 'd', { type: 'raise', raiseTo: lastPrice }, bankroll);
  return { game, bankroll };
}
function rejectUnchanged(game: CashGame, id: string, action: ConcreteAction, code: string) {
  const before = view(game, id); const record = game.toRecord(); const facts = game.getHand('hand-1');
  expect(game.act(id, action)).toMatchObject({ ok: false, rejection: { code } });
  expect(view(game, id)).toEqual(before); expect(game.toRecord()).toEqual(record); expect(game.getHand('hand-1')).toEqual(facts);
}

test('cumulative short increases below the full threshold keep acted betting closed while unacted betting retains a raise', () => {
  const { game, bankroll } = fixture(199);
  expect(view(game, 'e').state).toMatchObject({ actorId: 'e', amountToCall: 199, legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 299, maximum: 980 }] });
  accept(game, 'e', { type: 'fold' }, bankroll);
  expect(view(game).state).toMatchObject({ actorId: 'a', amountToCall: 99, legalActions: [{ type: 'fold' }, { type: 'call' }] });
  rejectUnchanged(game, 'a', { type: 'raise', raiseTo: 299 }, 'illegal-action');
  accept(game, 'a', { type: 'call' }, bankroll);
  expect(view(game, 'c').state).toMatchObject({ actorId: 'c', amountToCall: 49, legalActions: [{ type: 'fold' }, { type: 'call' }] });
  rejectUnchanged(game, 'c', { type: 'raise', raiseTo: 299 }, 'illegal-action');
});

test.each([[200, 100, 300], [201, 101, 301]] as const)('a cumulative price of %i reopens A at its exact full minimum without reopening C at the later prior price', (price, owed, minimum) => {
  const { game, bankroll } = fixture(price);
  accept(game, 'e', { type: 'fold' }, bankroll);
  const frozen = view(game);
  expect(frozen.state).toMatchObject({ actorId: 'a', amountToCall: owed, legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum, maximum: 980 }] });
  rejectUnchanged(game, 'a', { type: 'raise', raiseTo: minimum - 1 }, 'illegal-action-size');
  const raised = game.fork();
  accept(raised, 'a', { type: 'raise', raiseTo: minimum }, bankroll);
  expect(view(raised, 'c').state.legalActions).toContainEqual({ type: 'raise', minimum: minimum + 100, maximum: 980 });
  expect(view(game)).toEqual(frozen);
  accept(game, 'a', { type: 'call' }, bankroll);
  expect(view(game, 'c').state).toMatchObject({ actorId: 'c', amountToCall: price - 150, legalActions: [{ type: 'fold' }, { type: 'call' }] });
  rejectUnchanged(game, 'c', { type: 'raise', raiseTo: minimum }, 'illegal-action');
  accept(game, 'c', { type: 'call' }, bankroll);
  expect(view(game).state).toMatchObject({ street: 'turn', actorId: 'a', amountToCall: 0, legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 980 - price }] });
  expect(view(game, 'b').state.legalActions).toEqual([]);
  expect(view(game, 'd').state.legalActions).toEqual([]);
  expect(view(game, 'e').state.legalActions).toEqual([]);
  for (let street = 0; street < 2; street++) for (const id of ['a', 'c']) accept(game, id, { type: 'check' }, bankroll);
  const done = view(game);
  expect(done.state).toMatchObject({ status: 'completed-hand', board: ['3s', '8d', '2c', '5s', 'Ah'], pots: [{ amount: 700, eligibleParticipantIds: ['a', 'b', 'c', 'd'] }, { amount: (price - 150) * 3, eligibleParticipantIds: ['a', 'c', 'd'] }] });
  expect(done.state.participants.map(p => p.stack)).toEqual(price === 200 ? [980, 1280, 350, 780, 0] : [980, 1282, 350, 779, 0]);
  expect(game.forParticipant('a').getView({ at: { decisionId: frozen.state.decisionId! } })).toEqual(frozen);
  expect(done.history[0]!.decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1)).toBe(true);
  const restored = CashGame.fromRecord(game.toRecord());
  if (!restored.ok) throw new Error('Expected valid completed replay.');
  expect(view(restored.game)).toEqual(done); expect(restored.game.getHand('hand-1')).toEqual(game.getHand('hand-1'));
});

test('another full raise resets prior closure and establishes the new exact minimum', () => {
  const { game, bankroll } = fixture();
  accept(game, 'e', { type: 'fold' }, bankroll);
  const original = view(game);
  accept(game, 'a', { type: 'raise', raiseTo: 350 }, bankroll);
  expect(view(game, 'c').state).toMatchObject({ actorId: 'c', amountToCall: 200, legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 500, maximum: 980 }] });
  rejectUnchanged(game, 'c', { type: 'raise', raiseTo: 499 }, 'illegal-action-size');
  accept(game, 'c', { type: 'raise', raiseTo: 500 }, bankroll);
  expect(view(game).state.legalActions).toContainEqual({ type: 'raise', minimum: 650, maximum: 980 });
  accept(game, 'a', { type: 'call' }, bankroll);
  for (let street = 0; street < 2; street++) for (const id of ['a', 'c']) accept(game, id, { type: 'check' }, bankroll);
  expect(view(game).state.participants.map(p => p.stack)).toEqual([980, 1580, 350, 480, 0]);
  expect(game.forParticipant('a').getView({ at: { decisionId: original.state.decisionId! } })).toEqual(original);
});

test('a Check before an incomplete opening does not reopen on five chips, while an unacted Participant may raise to 25', () => {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid configuration.');
  const game = created.game;
  for (const [id, seat, chips] of [['c', 1, 1000], ['a', 2, 1000], ['b', 3, 25]] as const) expect(game.seatParticipant(id, seat, chips).ok).toBe(true);
  expect(game.startHand().ok).toBe(true);
  accept(game, 'c', { type: 'call' }, 2025); accept(game, 'a', { type: 'call' }, 2025); accept(game, 'b', { type: 'check' }, 2025);
  accept(game, 'a', { type: 'check' }, 2025);
  expect(view(game, 'b').state.legalActions).toContainEqual({ type: 'bet', minimum: 5, maximum: 5 });
  accept(game, 'b', { type: 'bet', betTo: 5 }, 2025);
  expect(view(game, 'c').state).toMatchObject({ actorId: 'c', amountToCall: 5, legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 25, maximum: 980 }] });
  const raised = game.fork();
  rejectUnchanged(raised, 'c', { type: 'raise', raiseTo: 24 }, 'illegal-action-size');
  accept(raised, 'c', { type: 'raise', raiseTo: 25 }, 2025);
  expect(view(raised).state.legalActions).toContainEqual({ type: 'raise', minimum: 45, maximum: 980 });
  accept(game, 'c', { type: 'call' }, 2025);
  expect(view(game).state).toMatchObject({ actorId: 'a', amountToCall: 5, legalActions: [{ type: 'fold' }, { type: 'call' }] });
  rejectUnchanged(game, 'a', { type: 'raise', raiseTo: 25 }, 'illegal-action');
  accept(game, 'a', { type: 'call' }, 2025);
  expect(view(game).state).toMatchObject({ street: 'turn', amountToCall: 0 });
});

test.each([[19, false], [20, true], [21, true]] as const)('a prior Check facing cumulative incomplete opening price %i uses the full 20-chip threshold', (price, reopened) => {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid configuration.');
  const game = created.game; const bankroll = 2080 + price;
  for (const [id, seat, chips] of [['e', 1, 1000], ['a', 2, 1000], ['b', 3, 25], ['c', 4, 35], ['d', 5, price + 20]] as const)
    expect(game.seatParticipant(id, seat, chips).ok).toBe(true);
  expect(game.startHand().ok).toBe(true);
  for (const id of ['c', 'd', 'e', 'a']) accept(game, id, { type: 'call' }, bankroll);
  accept(game, 'b', { type: 'check' }, bankroll); accept(game, 'a', { type: 'check' }, bankroll);
  accept(game, 'b', { type: 'bet', betTo: 5 }, bankroll);
  accept(game, 'c', { type: 'raise', raiseTo: 15 }, bankroll);
  accept(game, 'd', { type: 'raise', raiseTo: price }, bankroll);
  expect(view(game, 'e').state.legalActions).toContainEqual({ type: 'raise', minimum: price + 20, maximum: 980 });
  accept(game, 'e', { type: 'call' }, bankroll);
  expect(view(game).state).toMatchObject({ actorId: 'a', amountToCall: price });
  expect(view(game).state.legalActions.some(a => a.type === 'raise')).toBe(reopened);
  if (reopened) {
    expect(view(game).state.legalActions).toContainEqual({ type: 'raise', minimum: price + 20, maximum: 980 });
    rejectUnchanged(game, 'a', { type: 'raise', raiseTo: price + 19 }, 'illegal-action-size');
    accept(game, 'a', { type: 'raise', raiseTo: price + 20 }, bankroll);
    accept(game, 'e', { type: 'call' }, bankroll);
  } else {
    rejectUnchanged(game, 'a', { type: 'raise', raiseTo: 39 }, 'illegal-action');
    accept(game, 'a', { type: 'call' }, bankroll);
  }
  expect(view(game).state.street).toBe('turn');
  for (let street = 0; street < 2; street++) for (const id of ['a', 'e']) accept(game, id, { type: 'check' }, bankroll);
  expect(view(game).state.status).toBe('completed-hand');
});

test.each([[549, false], [550, true], [551, true]] as const)('short all-ins after a new 200-chip full increment reopen its raiser at cumulative price %i only at that new threshold', (price, reopened) => {
  const created = CashGame.create({ ...configuration, seatCount: 6 });
  if (!created.ok) throw new Error('Expected valid configuration.');
  const game = created.game; const bankroll = 3660 + price;
  for (const [id, seat, chips] of [['f', 1, 1000], ['a', 2, 1000], ['b', 3, 170], ['c', 4, 1000], ['d', 5, 470], ['e', 6, price + 20]] as const)
    expect(game.seatParticipant(id, seat, chips).ok).toBe(true);
  expect(game.startHand().ok).toBe(true);
  for (const id of ['c', 'd', 'e', 'f', 'a']) accept(game, id, { type: 'call' }, bankroll);
  accept(game, 'b', { type: 'check' }, bankroll);
  accept(game, 'a', { type: 'bet', betTo: 100 }, bankroll);
  accept(game, 'b', { type: 'raise', raiseTo: 150 }, bankroll);
  accept(game, 'c', { type: 'raise', raiseTo: 350 }, bankroll);
  accept(game, 'd', { type: 'raise', raiseTo: 450 }, bankroll);
  accept(game, 'e', { type: 'raise', raiseTo: price }, bankroll);
  accept(game, 'f', { type: 'fold' }, bankroll);
  expect(view(game).state.legalActions).toContainEqual({ type: 'raise', minimum: price + 200, maximum: 980 });
  accept(game, 'a', { type: 'call' }, bankroll);
  expect(view(game, 'c').state).toMatchObject({ actorId: 'c', amountToCall: price - 350 });
  expect(view(game, 'c').state.legalActions.some(a => a.type === 'raise')).toBe(reopened);
  if (reopened) {
    expect(view(game, 'c').state.legalActions).toContainEqual({ type: 'raise', minimum: price + 200, maximum: 980 });
    rejectUnchanged(game, 'c', { type: 'raise', raiseTo: price + 199 }, 'illegal-action-size');
    accept(game, 'c', { type: 'raise', raiseTo: price + 200 }, bankroll);
    accept(game, 'a', { type: 'call' }, bankroll);
  } else {
    rejectUnchanged(game, 'c', { type: 'raise', raiseTo: 749 }, 'illegal-action');
    accept(game, 'c', { type: 'call' }, bankroll);
  }
  for (let street = 0; street < 2; street++) for (const id of ['a', 'c']) accept(game, id, { type: 'check' }, bankroll);
  expect(view(game).state.status).toBe('completed-hand');
});
