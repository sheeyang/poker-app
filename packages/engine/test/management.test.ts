import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';

const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'management-fixture' };
function game(settings = configuration) {
  const created = CashGame.create(settings);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  const cashGame = created.game;
  cashGame.seatParticipant('alice', 1); cashGame.seatParticipant('bob', 4);
  return cashGame;
}

test('leaving cashes out winnings without changing completed Hand facts, and reseating retains Participant identity', () => {
  const cashGame = game(); cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  const completed = cashGame.getHand('hand-1');
  const observed = cashGame.forParticipant('bob').getView();
  expect(cashGame.leaveParticipant('bob')).toEqual({ ok: true, events: [{ type: 'participant-left', participantId: 'bob', seat: 4, cashOut: 1010 }] });
  expect(cashGame.forParticipant('bob').getView().state.participants[1]).toMatchObject({ participantId: 'bob', seat: null, stack: 0 });
  expect(cashGame.seatParticipant('bob', 2, 100).ok).toBe(true);
  expect(cashGame.forParticipant('bob').getView().state.participants).toHaveLength(2);
  expect(cashGame.getHand('hand-1')).toEqual(completed);
  expect(observed.state.participants[1]).toMatchObject({ seat: 4, stack: 1010 });
  expect(cashGame.toRecord().commands.slice(-2)).toEqual([{ type: 'leave-participant', participantId: 'bob' }, { type: 'seat-participant', participantId: 'bob', seat: 2, buyIn: 100 }]);
  expect(cashGame.forParticipant('alice').getView().state.participants.map(p => p.stack)).toEqual([990, 100]);
});

test('movement respects the seat-change policy and sitting out changes next-Hand eligibility without removing identity', () => {
  const cashGame = game();
  const before = cashGame.toRecord();
  expect(cashGame.moveParticipant('alice', 4)).toMatchObject({ ok: false, rejection: { code: 'seat-occupied' } });
  expect(cashGame.moveParticipant('alice', 7)).toMatchObject({ ok: false, rejection: { code: 'invalid-seat' } });
  expect(cashGame.toRecord()).toEqual(before);
  expect(cashGame.moveParticipant('alice', 3)).toEqual({ ok: true, events: [{ type: 'participant-moved', participantId: 'alice', fromSeat: 1, seat: 3 }] });
  expect(cashGame.setSittingOut('bob', true).ok).toBe(true);
  expect(cashGame.startHand()).toMatchObject({ ok: false, rejection: { code: 'insufficient-participants' } });
  expect(cashGame.forParticipant('bob').getView().state.participants[1]).toMatchObject({ participantId: 'bob', seat: 4, stack: 1000, sittingOut: true });
  expect(cashGame.setSittingOut('bob', false).ok).toBe(true);
  expect(cashGame.startHand().ok).toBe(true);
  expect(cashGame.getHand('hand-1')!.participants.map(p => p.seat)).toEqual([3, 4]);
  const disabled = game({ ...configuration, allowSeatChanges: false });
  const fixed = disabled.toRecord();
  expect(disabled.moveParticipant('alice', 3)).toMatchObject({ ok: false, rejection: { code: 'seat-changes-disabled' } });
  expect(disabled.toRecord()).toEqual(fixed);
});

test('topUpTo adds only the amount needed to reach the target and respects external chip limits', () => {
  const cashGame = game(); cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  expect(cashGame.topUpTo('alice', 1200)).toEqual({ ok: true, events: [{ type: 'participant-topped-up', participantId: 'alice', targetStack: 1200, amount: 210 }] });
  expect(cashGame.forParticipant('alice').getView().state.participants.map(p => p.stack)).toEqual([1200, 1010]);
  const before = cashGame.toRecord();
  for (const target of [1200, 1199, 2001, 1200.5, Number.NaN]) expect(cashGame.topUpTo('alice', target)).toMatchObject({ ok: false, rejection: { code: 'invalid-top-up' } });
  expect(cashGame.toRecord()).toEqual(before);
  const short = game({ ...configuration, minimumBuyIn: 1000 }); short.startHand(); short.act('alice', { type: 'fold' });
  expect(short.topUpTo('alice', 995).ok).toBe(true);
  expect(short.startHand().ok).toBe(true);
  const zero = game({ ...configuration, minimumBuyIn: 0 }); zero.leaveParticipant('alice'); zero.seatParticipant('alice', 2, 0);
  expect(zero.startHand()).toMatchObject({ ok: false, rejection: { code: 'insufficient-participants' } });
  expect(zero.topUpTo('alice', 100).ok).toBe(true);
  expect(zero.startHand().ok).toBe(true);
  const huge = game({ ...configuration, minimumBuyIn: 1, defaultBuyIn: 1, maximumBuyIn: Number.MAX_SAFE_INTEGER });
  const safe = huge.toRecord();
  expect(huge.topUpTo('alice', Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false, rejection: { code: 'chip-capacity-exceeded' } });
  expect(huge.toRecord()).toEqual(safe);
  const winnings = game({ ...configuration, maximumBuyIn: 1000 }); winnings.startHand(); winnings.act('alice', { type: 'fold' });
  expect(winnings.leaveParticipant('bob')).toMatchObject({ ok: true, events: [{ cashOut: 1010 }] });
});

test('button rotation starts clockwise from the frozen previous button, skips ineligible seats, and accepts an explicit eligible override', () => {
  const cashGame = game({ ...configuration, minimumBuyIn: 0 });
  cashGame.seatParticipant('carol', 3); cashGame.seatParticipant('zero', 2, 0); cashGame.setSittingOut('carol', true);
  cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  const completed = cashGame.getHand('hand-1');
  cashGame.leaveParticipant('alice'); cashGame.seatParticipant('dave', 5);
  expect(cashGame.startHand().ok).toBe(true);
  expect(cashGame.getHand('hand-2')).toMatchObject({ buttonSeat: 4, smallBlindParticipantId: 'bob' });
  cashGame.act('bob', { type: 'fold' });
  expect(cashGame.setButton(2)).toMatchObject({ ok: false, rejection: { code: 'ineligible-button' } });
  expect(cashGame.setButton(3)).toMatchObject({ ok: false, rejection: { code: 'ineligible-button' } });
  expect(cashGame.setButton(6)).toMatchObject({ ok: false, rejection: { code: 'ineligible-button' } });
  expect(cashGame.setButton(0)).toMatchObject({ ok: false, rejection: { code: 'invalid-seat' } });
  expect(cashGame.setButton(4)).toEqual({ ok: true, events: [{ type: 'button-set', seat: 4 }] });
  expect(cashGame.getHand('hand-1')).toEqual(completed);
  cashGame.startHand();
  expect(cashGame.getHand('hand-3')).toMatchObject({ buttonSeat: 4 });
  cashGame.act('bob', { type: 'fold' }); cashGame.startHand();
  expect(cashGame.getHand('hand-4')).toMatchObject({ buttonSeat: 5 });
});

test('Participant observations follow identity across movement and rejoining, exclude absence, and include seated sit-out observation', () => {
  const cashGame = game(); cashGame.seatParticipant('observer', 3); cashGame.setSittingOut('observer', true);
  cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  const old = cashGame.forParticipant('alice').getView().history;
  expect(old.map(h => h.handId)).toEqual(['hand-1']);
  expect(cashGame.forParticipant('observer').getView().history.map(h => h.handId)).toEqual(['hand-1']);
  expect(cashGame.forParticipant('stranger').getView().history).toEqual([]);
  cashGame.moveParticipant('alice', 2); cashGame.leaveParticipant('alice');
  cashGame.seatParticipant('newcomer', 1);
  cashGame.startHand(); cashGame.act('bob', { type: 'fold' });
  expect(cashGame.forParticipant('alice').getView().history).toEqual(old);
  expect(cashGame.forParticipant('newcomer').getView().history.map(h => h.handId)).toEqual(['hand-2']);
  cashGame.seatParticipant('alice', 5); cashGame.startHand();
  while (cashGame.forParticipant('bob').getView().state.actorId) cashGame.act(cashGame.forParticipant('bob').getView().state.actorId!, { type: 'fold' });
  expect(cashGame.forParticipant('alice').getView().history).toMatchObject([old[0], { handId: 'hand-3', description: 'Completed Hand 3' }]);
  expect(old).toHaveLength(1);
  const restored = CashGame.fromRecord(cashGame.toRecord());
  if (!restored.ok) throw new Error('Expected complete management replay.');
  expect(restored.game.forParticipant('alice').getView()).toEqual(cashGame.forParticipant('alice').getView());
});

test('every between-Hand command rejects active changes atomically and complete command replay and forks stay independent', () => {
  const cashGame = game(); cashGame.startHand();
  const before = cashGame.toRecord(); const view = cashGame.forParticipant('alice').getView(); const facts = cashGame.getHand('hand-1');
  for (const submit of [() => cashGame.leaveParticipant('alice'), () => cashGame.moveParticipant('alice', 2), () => cashGame.setSittingOut('alice', true), () => cashGame.topUpTo('alice', 1200), () => cashGame.setButton(4)]) {
    expect(submit()).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
    expect(cashGame.toRecord()).toEqual(before); expect(cashGame.forParticipant('alice').getView()).toEqual(view); expect(cashGame.getHand('hand-1')).toEqual(facts);
  }
  cashGame.act('alice', { type: 'fold' });
  const fork = cashGame.fork();
  cashGame.moveParticipant('alice', 2); cashGame.setSittingOut('alice', true); cashGame.topUpTo('alice', 1500); cashGame.setButton(4); cashGame.leaveParticipant('bob'); cashGame.seatParticipant('bob', 6, 200);
  expect(fork.forParticipant('alice').getView().state.participants.map(p => ({ seat: p.seat, stack: p.stack, sittingOut: p.sittingOut }))).toEqual([{ seat: 1, stack: 990, sittingOut: false }, { seat: 4, stack: 1010, sittingOut: false }]);
  const replayed = CashGame.fromRecord(JSON.parse(JSON.stringify(cashGame.toRecord())));
  if (!replayed.ok) throw new Error('Expected complete accepted-command replay.');
  expect(replayed.game.forParticipant('alice').getView()).toEqual(cashGame.forParticipant('alice').getView());
  expect(replayed.game.getHand('hand-1')).toEqual(cashGame.getHand('hand-1'));
  for (const tail of [{ type: 'top-up-to', participantId: 'alice', targetStack: 1000 }, { type: 'move-participant', participantId: 'alice', seat: 6 }, { type: 'set-sitting-out', participantId: 'alice', sittingOut: 'false' }, { type: 'leave-participant', participantId: 'bob', requestId: 'server' }, { type: 'set-button', seat: 6, expectedPokerRevision: 0 }])
    expect(CashGame.fromRecord({ ...cashGame.toRecord(), commands: [...cashGame.toRecord().commands, tail] })).toMatchObject({ ok: false, rejection: { code: 'invalid-record' } });
});
