import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';

const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'seat-changes-fixture' };
function game(allowSeatChanges = true) {
  const created = CashGame.create({ ...configuration, allowSeatChanges });
  if (!created.ok) throw new Error('Expected valid CashGame.');
  created.game.seatParticipant('alice', 1); created.game.seatParticipant('bob', 4);
  return created.game;
}

test('the seat-change permission changes between Hands and the Observable Game Configuration shows the current value', () => {
  const cashGame = game();
  expect(cashGame.forParticipant('alice').getView().configuration.allowSeatChanges).toBe(true);
  expect(cashGame.setSeatChanges(false)).toEqual({ ok: true, events: [{ type: 'seat-changes-changed', allowSeatChanges: false }] });
  for (const participant of ['alice', 'bob', 'late']) expect(cashGame.forParticipant(participant).getView().configuration.allowSeatChanges).toBe(false);
  expect(cashGame.moveParticipant('alice', 3)).toMatchObject({ ok: false, rejection: { code: 'seat-changes-disabled' } });
  expect(cashGame.setSeatChanges(true).ok).toBe(true);
  expect(cashGame.forParticipant('alice').getView().configuration.allowSeatChanges).toBe(true);
  expect(cashGame.moveParticipant('alice', 3).ok).toBe(true);
  expect(cashGame.toRecord().commands.slice(-3)).toEqual([{ type: 'set-seat-changes', allowSeatChanges: false }, { type: 'set-seat-changes', allowSeatChanges: true }, { type: 'move-participant', participantId: 'alice', seat: 3 }]);
});

test('a table that started without seat changes can allow them later', () => {
  const cashGame = game(false);
  expect(cashGame.moveParticipant('alice', 3)).toMatchObject({ ok: false, rejection: { code: 'seat-changes-disabled' } });
  expect(cashGame.setSeatChanges(true).ok).toBe(true);
  expect(cashGame.moveParticipant('alice', 3).ok).toBe(true);
});

test('the permission cannot change during a Hand, and rejections change nothing', () => {
  const cashGame = game();
  cashGame.startHand();
  const record = cashGame.toRecord(), view = cashGame.forParticipant('alice').getView();
  expect(cashGame.setSeatChanges(false)).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
  expect(cashGame.toRecord()).toEqual(record);
  expect(cashGame.forParticipant('alice').getView()).toEqual(view);
  cashGame.act('alice', { type: 'fold' });
  // A completed Hand is between Hands for management.
  expect(cashGame.setSeatChanges(false).ok).toBe(true);
  const settled = cashGame.toRecord();
  expect(cashGame.setSeatChanges(false)).toMatchObject({ ok: false, rejection: { code: 'seat-changes-unchanged' } });
  for (const value of ['no', 1, null, undefined]) expect(cashGame.setSeatChanges(value as never)).toMatchObject({ ok: false, rejection: { code: 'invalid-seat-changes', field: 'allowSeatChanges' } });
  expect(cashGame.toRecord()).toEqual(settled);
});

test('the permission survives replay, forking and restoration, and every Participant sees its history unchanged', () => {
  const cashGame = game();
  cashGame.setSeatChanges(false);
  cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  cashGame.setSeatChanges(true);
  const restored = CashGame.fromRecord(cashGame.toRecord());
  if (!restored.ok) throw new Error('Expected restoration.');
  expect(restored.game.toRecord()).toEqual(cashGame.toRecord());
  expect(restored.game.forParticipant('bob').getView()).toEqual(cashGame.forParticipant('bob').getView());
  const fork = cashGame.fork();
  expect(fork.forParticipant('bob').getView().configuration.allowSeatChanges).toBe(true);
  fork.setSeatChanges(false);
  expect(cashGame.forParticipant('bob').getView().configuration.allowSeatChanges).toBe(true);
  expect(fork.forParticipant('bob').getView().configuration.allowSeatChanges).toBe(false);
  // The decision snapshot of the earlier Hand shows the permission as it stood then.
  const decision = cashGame.forParticipant('alice').getView().history[0]!.decisions[0]!;
  expect(cashGame.forParticipant('alice').getView({ at: { decisionId: decision.decisionId } }).configuration.allowSeatChanges).toBe(false);
});

test('the event is public to every Participant, joined or not, and version-1 records cannot contain the command', () => {
  const cashGame = game();
  const result = cashGame.setSeatChanges(false);
  if (!result.ok) throw new Error('Expected acceptance.');
  expect(cashGame.forParticipant('stranger').projectEvents(result.events)).toEqual([{ type: 'seat-changes-changed', allowSeatChanges: false }]);
  const record = cashGame.toRecord();
  expect(CashGame.fromRecord({ ...record, schemaVersion: 1 })).toMatchObject({ ok: false, rejection: { code: 'invalid-record' } });
  expect(CashGame.fromRecord({ ...record, commands: [...record.commands, { type: 'set-seat-changes', allowSeatChanges: 'yes' }] })).toMatchObject({ ok: false });
  expect(CashGame.fromRecord({ ...record, commands: [...record.commands, { type: 'set-seat-changes', allowSeatChanges: true, extra: 1 }] })).toMatchObject({ ok: false });
});
