import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';
import { draftFaults } from '../src/internal/draft-faults.js';

const configuration = {
  seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0,
  minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 2000,
  allowSeatChanges: true, seed: 'seating-fixture',
};
function game(settings = configuration) {
  const created = CashGame.create(settings);
  if (!created.ok) throw new Error('Expected a valid CashGame.');
  return created.game;
}

test('a Participant takes an empty seat with the default buy-in without changing configuration', () => {
  const cashGame = game();
  const before = cashGame.forParticipant('alice').getView();
  expect(cashGame.seatParticipant('alice', 3)).toEqual({ ok: true, events: [{ type: 'participant-seated', participantId: 'alice', seat: 3, buyIn: 1000 }] });
  expect(cashGame.forParticipant('alice').getView()).toEqual({
    ...before,
    state: { ...before.state, participants: [{ participantId: 'alice', seat: 3, stack: 1000, sittingOut: false }] },
  });
  expect(cashGame.toRecord().commands).toEqual([{ type: 'seat-participant', participantId: 'alice', seat: 3, buyIn: 1000 }]);
});

test.each([
  ['', 2, 1000, 'invalid-participant'],
  ['bob', 0, 1000, 'invalid-seat'], ['bob', 7, 1000, 'invalid-seat'], ['bob', 1.5, 1000, 'invalid-seat'],
  ['bob', 3, 1000, 'seat-occupied'], ['alice', 2, 1000, 'participant-already-seated'],
  ['bob', 2, 99, 'invalid-buy-in'], ['bob', 2, 2001, 'invalid-buy-in'], ['bob', 2, 100.5, 'invalid-buy-in'],
  ['bob', 2, Number.NaN, 'invalid-buy-in'],
])('invalid seating %s / %s / %s is rejected atomically', (participantId, seat, buyIn, code) => {
  const cashGame = game();
  cashGame.seatParticipant('alice', 3);
  const before = cashGame.toRecord();
  const view = cashGame.forParticipant('alice').getView();
  expect(cashGame.seatParticipant(participantId as string, seat as number, buyIn as number)).toMatchObject({ ok: false, rejection: { code } });
  expect(cashGame.toRecord()).toEqual(before);
  expect(cashGame.forParticipant('alice').getView()).toEqual(view);
});

test('inclusive buy-in limits are legal and an unrepresentable live bankroll is rejected without restricting empty configuration', () => {
  const cashGame = game();
  expect(cashGame.seatParticipant('minimum', 1, 100).ok).toBe(true);
  expect(cashGame.seatParticipant('maximum', 6, 2000).ok).toBe(true);
  const large = game({ ...configuration, minimumBuyIn: 1, defaultBuyIn: Number.MAX_SAFE_INTEGER, maximumBuyIn: Number.MAX_SAFE_INTEGER });
  expect(large.seatParticipant('first', 1).ok).toBe(true);
  const before = large.toRecord();
  expect(large.seatParticipant('overflow', 2, 1)).toMatchObject({ ok: false, rejection: { code: 'chip-capacity-exceeded' } });
  expect(large.toRecord()).toEqual(before);
});

test('forks preserve accepted identities and exports stay detached while divergent seating is independent', () => {
  const original = game();
  original.seatParticipant('alice', 3);
  const record = original.toRecord();
  const snapshot = original.forParticipant('alice').getView();
  const fork = original.fork();
  expect(fork.toRecord()).toEqual(record);
  expect(fork.seatParticipant('bob', 2, 100).ok).toBe(true);
  expect(original.seatParticipant('carol', 2, 2000).ok).toBe(true);
  expect(fork.forParticipant('alice').getView().state.participants.map(p => p.participantId)).toEqual(['alice', 'bob']);
  expect(original.forParticipant('alice').getView().state.participants.map(p => p.participantId)).toEqual(['alice', 'carol']);
  expect(snapshot.state.participants).toEqual([{ participantId: 'alice', seat: 3, stack: 1000, sittingOut: false }]);
  expect(record.commands).toHaveLength(1);
  expect(() => { (record.commands[0] as { seat: number }).seat = 6; }).toThrow();
  expect(() => { (snapshot.state.participants[0] as { stack: number }).stack = 1; }).toThrow();
});

test('restoration validates the entire accepted seating sequence and never returns a usable prefix', () => {
  const original = game();
  original.seatParticipant('alice', 3);
  original.seatParticipant('bob', 2, 100);
  const record = original.toRecord();
  const restored = CashGame.fromRecord(JSON.parse(JSON.stringify(record)));
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error('Expected complete restoration.');
  expect(restored.game.toRecord()).toEqual(record);
  expect(restored.game.forParticipant('alice').getView()).toEqual(original.forParticipant('alice').getView());
  for (const tail of [
    { type: 'seat-participant', participantId: 'carol', seat: 3, buyIn: 1000 },
    { type: 'seat-participant', participantId: 'carol', seat: 4 },
    { type: 'seat-participant', participantId: 'carol', seat: 4, buyIn: 1000, requestId: 'server-data' },
    { type: 'unknown' },
  ]) expect(CashGame.fromRecord({ ...record, commands: [...record.commands, tail] })).toMatchObject({ ok: false, rejection: { code: 'invalid-record' } });
});

test('an unexpected controlled defect after draft evaluation leaves seats and accepted history unchanged', () => {
  const cashGame = game();
  cashGame.seatParticipant('alice', 3);
  const before = cashGame.toRecord();
  const view = cashGame.forParticipant('alice').getView();
  draftFaults.afterEvaluation = () => { throw new Error('controlled draft defect'); };
  try { expect(() => cashGame.seatParticipant('bob', 2, 100)).toThrow('controlled draft defect'); }
  finally { draftFaults.afterEvaluation = undefined; }
  expect(cashGame.toRecord()).toEqual(before);
  expect(cashGame.forParticipant('alice').getView()).toEqual(view);
  expect(cashGame.seatParticipant('bob', 2, 100).ok).toBe(true);
});
