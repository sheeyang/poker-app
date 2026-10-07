import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';
import { draftFaults } from '../src/internal/draft-faults.js';

const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'heads-up-fixture' };
function game() {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  created.game.seatParticipant('alice', 1);
  created.game.seatParticipant('bob', 4);
  return created.game;
}

test('explicit Start Hand freezes heads-up positions, deals a v1 deck in clockwise passes, and creates a private first decision', () => {
  const cashGame = game();
  expect(cashGame.startHand().ok).toBe(true);
  const alice = cashGame.forParticipant('alice').getView();
  const bob = cashGame.forParticipant('bob').getView();
  expect(alice.state).toMatchObject({ status: 'active-hand', handId: 'hand-1', decisionId: 'hand-1/decision-1', street: 'preflop', buttonSeat: 1, smallBlindParticipantId: 'alice', bigBlindParticipantId: 'bob', actorId: 'alice', legalActions: [{ type: 'fold' }, { type: 'call' }] });
  expect(alice.state.participants).toEqual([
    { participantId: 'alice', seat: 1, stack: 990, sittingOut: false, inHand: true, handSeat: 1, folded: false, allIn: false, contribution: 10, wager: 10, cardCount: 2, holeCards: ['4s', '5d'] },
    { participantId: 'bob', seat: 4, stack: 980, sittingOut: false, inHand: true, handSeat: 4, folded: false, allIn: false, contribution: 20, wager: 20, cardCount: 2 },
  ]);
  expect(bob.state.participants[1]?.holeCards).toEqual(['2c', 'Ah']);
  expect(bob.state.legalActions).toEqual([]);
  const facts = cashGame.getHand('hand-1')!;
  expect(facts.participants.map(p => ({ participantId: p.participantId, seat: p.seat, holeCards: p.holeCards }))).toEqual([{ participantId: 'alice', seat: 1, holeCards: ['4s', '5d'] }, { participantId: 'bob', seat: 4, holeCards: ['2c', 'Ah'] }]);
  expect(new Set(facts.deck).size).toBe(52);
  // Independently computed with Python's hashlib/hmac, see docs/random-v1.md.
  expect(createHash('sha256').update(facts.deck.join(' ')).digest('hex')).toBe('7fbef7ad3ad9079e67fe7cf47071cbc7174f8a348444dbd5e720c7ed12705cb6');
  expect(facts.drawnCardCount).toBe(4);
  expect(cashGame.toRecord().commands.at(-1)).toEqual({ type: 'start-hand' });
});

test('a normal Fold atomically awards the matched pot, returns uncalled chips, and preserves fold-win privacy without future draws', () => {
  const cashGame = game();
  cashGame.startHand();
  const facade = cashGame.forParticipant('alice');
  const decision = facade.getView();
  const result = cashGame.act('alice', { type: 'fold' });
  expect(result).toEqual({ ok: true, events: [
    { type: 'acted', participantId: 'alice', action: { type: 'fold' } },
    { type: 'uncalled-return', participantId: 'bob', amount: 10 },
    { type: 'pot-awarded', participantId: 'bob', amount: 20 },
    { type: 'hand-completed', handId: 'hand-1' },
  ] });
  const after = facade.getView();
  expect(after.state).toMatchObject({ status: 'completed-hand', actorId: null, decisionId: null, board: [], pots: [{ amount: 20, eligibleParticipantIds: ['bob'] }], returns: [{ participantId: 'bob', amount: 10 }], payouts: [{ participantId: 'bob', amount: 20 }] });
  expect(after.state.participants.map(p => p.stack)).toEqual([990, 1010]);
  expect(JSON.stringify(after)).not.toMatch(/2c|Ah|deck|seed|burn/);
  expect(cashGame.getHand('hand-1')).toMatchObject({ completed: true, drawnCardCount: 4, burns: [], board: [] });
  expect(cashGame.toRecord().commands.at(-1)).toEqual({ type: 'act', participantId: 'alice', action: { type: 'fold' } });
  expect(decision.state.status).toBe('active-hand');
  expect(decision.state.participants.map(p => p.stack)).toEqual([990, 980]);
  expect(() => { (after.state.participants[0]!.holeCards as string[])[0] = 'As'; }).toThrow();
  const restored = CashGame.fromRecord(cashGame.toRecord());
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error('Expected full replay.');
  expect(restored.game.getHand('hand-1')).toEqual(cashGame.getHand('hand-1'));
  expect(restored.game.forParticipant('alice').getView()).toEqual(after);
});

test('Start Hand readiness, wrong actors, unsupported actions, and active-Hand setup rejections leave all facts unchanged', () => {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  expect(created.game.startHand()).toMatchObject({ ok: false, rejection: { code: 'insufficient-participants' } });
  expect(created.game.toRecord().commands).toEqual([]);
  const cashGame = game(); cashGame.startHand();
  const before = cashGame.toRecord();
  const facts = cashGame.getHand('hand-1');
  const view = cashGame.forParticipant('alice').getView();
  expect(cashGame.startHand()).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
  expect(cashGame.seatParticipant('carol', 2)).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
  expect(cashGame.act('bob', { type: 'fold' })).toMatchObject({ ok: false, rejection: { code: 'wrong-actor' } });
  expect(cashGame.act('alice', { type: 'check' })).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
  expect(cashGame.act('alice', { type: 'fold', requestId: 'leak' } as { type: 'fold' })).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
  expect(cashGame.toRecord()).toEqual(before);
  expect(cashGame.getHand('hand-1')).toEqual(facts);
  expect(cashGame.forParticipant('alice').getView()).toEqual(view);
});

test('eligibility freezes before forced bets and short all-in blinds preserve membership, cards, and configured blind sizes', () => {
  const created = CashGame.create({ ...configuration, minimumBuyIn: 0 });
  if (!created.ok) throw new Error('Expected valid CashGame.');
  const cashGame = created.game;
  cashGame.seatParticipant('zero', 1, 0); cashGame.seatParticipant('alice', 3, 5); cashGame.seatParticipant('bob', 5, 1000);
  expect(cashGame.startHand().ok).toBe(true);
  const view = cashGame.forParticipant('alice').getView();
  expect(view.configuration).toMatchObject({ smallBlind: 10, bigBlind: 20 });
  expect(view.state).toMatchObject({ buttonSeat: 3, smallBlindParticipantId: 'alice', bigBlindParticipantId: 'bob' });
  expect(view.state.participants[1]).toMatchObject({ stack: 0, contribution: 5, wager: 5, allIn: true, holeCards: ['4s', '5d'] });
  expect(cashGame.getHand('hand-1')!.participants.map(p => p.participantId)).toEqual(['alice', 'bob']);
  expect(view.state.participants[0]).not.toHaveProperty('holeCards');
});

test('Hand identities, deterministic continuation, and safe detached events are independent of setup command count', () => {
  const original = game();
  const other = CashGame.create({ ...configuration, minimumBuyIn: 0 });
  if (!other.ok) throw new Error('Expected valid CashGame.');
  other.game.seatParticipant('zero', 2, 0);
  other.game.seatParticipant('alice', 1);
  other.game.seatParticipant('bob', 4);
  other.game.startHand();
  const fork = original.fork();
  const result = original.startHand();
  expect(fork.startHand()).toEqual(result);
  if (!result.ok) throw new Error('Expected accepted Start Hand.');
  const events = original.forParticipant('alice').projectEvents(result.events);
  expect(events.filter(e => e.type === 'hole-cards-dealt')).toEqual([
    { type: 'hole-cards-dealt', participantId: 'alice', cardCount: 2, cards: ['4s', '5d'] },
    { type: 'hole-cards-dealt', participantId: 'bob', cardCount: 2 },
  ]);
  expect(JSON.stringify(events)).not.toMatch(/2c|Ah|seed|deck/);
  expect(() => { (events as unknown[]).push('injected'); }).toThrow();
  const facts = original.getHand('hand-1')!;
  expect(other.game.toRecord().commands).toHaveLength(4);
  expect(original.toRecord().commands).toHaveLength(3);
  expect(other.game.getHand('hand-1')).toEqual(facts);
  expect(() => { (facts.deck as string[])[0] = 'As'; }).toThrow();
  original.act('alice', { type: 'fold' });
  expect(fork.getHand('hand-1')!.completed).toBe(false);
  expect(original.startHand().ok).toBe(true);
  expect(original.forParticipant('alice').getView().state).toMatchObject({ handId: 'hand-2', buttonSeat: 4, actorId: 'bob' });
  expect(facts.completed).toBe(false);
  expect(original.getHand('hand-1')!.drawnCardCount).toBe(4);
  expect(original.getHand('hand-2')!.deck).not.toEqual(facts.deck);
});

test('defects after dealing or settlement do not advance identities, draw cards, transfer chips, or append commands', () => {
  const cashGame = game();
  const before = cashGame.toRecord();
  draftFaults.afterEvaluation = () => { throw new Error('controlled draft defect'); };
  try { expect(() => cashGame.startHand()).toThrow('controlled draft defect'); }
  finally { draftFaults.afterEvaluation = undefined; }
  expect(cashGame.toRecord()).toEqual(before);
  expect(cashGame.getHand('hand-1')).toBeUndefined();
  cashGame.startHand();
  const decision = cashGame.forParticipant('alice').getView();
  const record = cashGame.toRecord();
  draftFaults.afterEvaluation = () => { throw new Error('controlled settlement defect'); };
  try { expect(() => cashGame.act('alice', { type: 'fold' })).toThrow('controlled settlement defect'); }
  finally { draftFaults.afterEvaluation = undefined; }
  expect(cashGame.toRecord()).toEqual(record);
  expect(cashGame.forParticipant('alice').getView()).toEqual(decision);
  expect(cashGame.act('alice', { type: 'fold' }).ok).toBe(true);
  expect(cashGame.act('alice', { type: 'fold' })).toMatchObject({ ok: false, rejection: { code: 'no-active-hand' } });
});
