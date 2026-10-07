import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';

const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'restore-history-fixture' };
function game() {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid restoration fixture.');
  created.game.seatParticipant('alice', 1);
  created.game.seatParticipant('bob', 4);
  return created.game;
}

test('trusted construction rejects configuration that cannot form a supported replay record', () => {
  expect(CashGame.create({ ...configuration, deck: ['As'] } as typeof configuration)).toMatchObject({ ok: false, rejection: { code: 'invalid-configuration' } });
});

test('a historical DecisionId returns the original complete immutable view despite later Hands and management', () => {
  const cashGame = game();
  cashGame.startHand();
  const original = cashGame.forParticipant('alice').getView();
  cashGame.act('alice', { type: 'fold' });
  cashGame.topUpTo('alice', 1200);
  cashGame.moveParticipant('alice', 2);
  cashGame.setButton(2);
  cashGame.startHand();
  const historical = cashGame.forParticipant('alice').getView({ at: { decisionId: 'hand-1/decision-1' } });
  expect(historical).toEqual(original);
  expect(historical.state.participants[0]).toMatchObject({ seat: 1, stack: 990 });
  expect(historical.state.participants[1]).not.toHaveProperty('holeCards');
  expect(() => { (historical.state.participants[0] as { stack: number }).stack = 0; }).toThrow();
  expect(() => { (historical.configuration as { bigBlind: number }).bigBlind = 0; }).toThrow();
  expect(JSON.stringify(historical)).not.toMatch(/"(?:seed|deck|burns|commands|pokerRevision|sessionRevision|events)"\s*:/);
});

test('restoration rejects malformed metadata, configuration and accepted-command suffixes without a usable prefix', () => {
  const cashGame = game(); cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  const record = cashGame.toRecord();
  for (const malformed of [
    null, [], { ...record, schemaVersion: 2 }, { ...record, engineVersion: 'v2' },
    { ...record, pokerRevision: 3 }, { ...record, configuration: { ...record.configuration, deck: [] } },
    { ...record, configuration: { ...record.configuration, seed: '' } },
    { ...record, configuration: { ...record.configuration, defaultBuyIn: Number.NaN } },
    { ...record, commands: [...record.commands, { type: 'start-hand', events: [] }] },
    { ...record, commands: [...record.commands, { type: 'act', participantId: 'alice', action: { type: 'fold' } }] },
    { ...record, commands: [...record.commands, { type: 'seat-participant', participantId: 'bob', seat: 5, buyIn: 1000 }] },
    { ...record, commands: [...record.commands, { type: 'set-button', seat: 0 }] },
    { ...record, commands: [...record.commands, { type: 'seat-participant', participantId: () => 'injected', seat: 5, buyIn: 1000 }] },
  ]) {
    const result = CashGame.fromRecord(malformed);
    expect(result).toMatchObject({ ok: false, rejection: { code: 'invalid-record' } });
    expect(result).not.toHaveProperty('game');
  }
  expect(cashGame.toRecord()).toEqual(record);
});

test('restoration accepts plain replay data only, rejecting accessors and non-data record contents', () => {
  const record = game().toRecord();
  const accessor = { ...record, configuration: { ...record.configuration } };
  Object.defineProperty(accessor.configuration, 'seed', { enumerable: true, get: () => record.configuration.seed });
  const hiddenField = { ...record.configuration };
  Object.defineProperty(hiddenField, 'deck', { value: ['As'], enumerable: false });
  const hiddenArrayField = [...record.commands];
  Object.defineProperty(hiddenArrayField, 'events', { value: [], enumerable: false });
  const nonPlainAction = Object.assign(new Date(), { type: 'fold' });
  for (const malformed of [
    Object.assign(Object.create({ privateSeed: 'secret' }), record), accessor,
    { ...record, configuration: hiddenField }, { ...record, commands: hiddenArrayField },
    { ...record, commands: [...record.commands, { type: 'start-hand' }, { type: 'act', participantId: 'alice', action: nonPlainAction }] },
  ]) expect(CashGame.fromRecord(malformed)).toMatchObject({ ok: false, rejection: { code: 'invalid-record' } });
});

test('history retains full original observed decisions and results without transferring observations to a new seat occupant', () => {
  const cashGame = game(); cashGame.seatParticipant('observer', 3); cashGame.setSittingOut('observer', true);
  cashGame.startHand();
  const first = cashGame.forParticipant('alice').getView();
  cashGame.act('alice', { type: 'fold' });
  const completed = cashGame.forParticipant('alice').getView();
  expect(completed.history[0]).toMatchObject({ handId: 'hand-1', decisions: [{ decisionId: 'hand-1/decision-1', state: first.state, action: { participantId: 'alice', action: { type: 'fold' } } }], result: completed.state });
  const observer = cashGame.forParticipant('observer').getView();
  expect(observer.history[0].decisions[0].state.participants.every(p => !p.holeCards)).toBe(true);
  expect(observer.history[0].decisions[0].state.legalActions).toEqual([]);
  cashGame.leaveParticipant('alice'); cashGame.seatParticipant('newcomer', 1);
  expect(cashGame.forParticipant('newcomer').getView().history).toEqual([]);
  expect(cashGame.forParticipant('newcomer').getView().state).not.toHaveProperty('handId');
  expect(() => cashGame.forParticipant('newcomer').getView({ at: { decisionId: 'hand-1/decision-1' } })).toThrow(RangeError);
  cashGame.startHand(); cashGame.act('bob', { type: 'fold' });
  expect(cashGame.forParticipant('alice').getView().history).toEqual(completed.history);
  expect(() => cashGame.forParticipant('alice').getView({ at: { decisionId: 'hand-2/decision-1' } })).toThrow(RangeError);
  cashGame.seatParticipant('alice', 2); cashGame.setButton(2); cashGame.startHand();
  const rejoined = cashGame.forParticipant('alice').getView();
  expect(rejoined.history.map(h => h.handId)).toEqual(['hand-1']);
  expect(cashGame.forParticipant('alice').getView({ at: { decisionId: 'hand-1/decision-1' } })).toEqual(first);
  expect(cashGame.forParticipant('observer').getView().history.map(h => h.handId)).toEqual(['hand-1', 'hand-2']);
  expect(() => { (completed.history[0].decisions[0].state.board as string[]).push('As'); }).toThrow();
});

test('a full multi-Hand record restores facts, original decision visibility, regenerated transitions and future dealing', () => {
  const cashGame = game(); const beforeShowdown: { id: string; view: ReturnType<ReturnType<CashGame['forParticipant']>['getView']> }[] = [];
  cashGame.startHand();
  while (cashGame.forParticipant('alice').getView().state.actorId) {
    const state = cashGame.forParticipant('alice').getView().state;
    beforeShowdown.push({ id: state.decisionId!, view: cashGame.forParticipant('alice').getView() });
    const actor = state.actorId!;
    const legal = cashGame.forParticipant(actor).getView().state.legalActions;
    expect(cashGame.act(actor, { type: legal.some(a => a.type === 'call') ? 'call' : 'check' }).ok).toBe(true);
  }
  const revealed = cashGame.forParticipant('alice').getView();
  expect(revealed.state.participants[1].holeCards).toHaveLength(2);
  for (const original of beforeShowdown) {
    expect(cashGame.forParticipant('alice').getView({ at: { decisionId: original.id } })).toEqual(original.view);
    expect(original.view.state.participants[1]).not.toHaveProperty('holeCards');
    expect(original.view.history.every(h => h.decisions.every(d => !d.state.participants[1].holeCards))).toBe(true);
  }
  cashGame.moveParticipant('alice', 2); cashGame.topUpTo('alice', 1500); cashGame.setSittingOut('bob', true);
  cashGame.seatParticipant('carol', 6); cashGame.setButton(2); cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  cashGame.leaveParticipant('carol'); cashGame.setSittingOut('bob', false); cashGame.setButton(2); cashGame.startHand();
  const record = cashGame.toRecord();
  expect(Object.keys(record).sort()).toEqual(['commands', 'configuration', 'engineVersion', 'schemaVersion']);
  expect(JSON.stringify(record)).not.toMatch(/"(?:deck|burns|events|history|decisionId|handId|derivedSeed|pokerRevision|sessionRevision)"\s*:/);
  const restored = CashGame.fromRecord(JSON.parse(JSON.stringify(record)));
  if (!restored.ok) throw new Error('Expected complete played-session restoration.');
  expect(restored.game.toRecord()).toEqual(record);
  for (const id of ['alice', 'bob', 'carol']) expect(restored.game.forParticipant(id).getView()).toEqual(cashGame.forParticipant(id).getView());
  for (const id of ['hand-1', 'hand-2', 'hand-3']) expect(restored.game.getHand(id)).toEqual(cashGame.getHand(id));
  for (const original of beforeShowdown) expect(restored.game.forParticipant('alice').getView({ at: { decisionId: original.id } })).toEqual(original.view);
  const fork = restored.game.fork();
  for (const original of beforeShowdown) expect(fork.forParticipant('alice').getView({ at: { decisionId: original.id } })).toEqual(original.view);
  expect(cashGame.act('alice', { type: 'fold' })).toEqual(restored.game.act('alice', { type: 'fold' }));
  expect(cashGame.startHand()).toEqual(restored.game.startHand());
  expect(cashGame.getHand('hand-4')).toEqual(restored.game.getHand('hand-4'));
  expect(cashGame.forParticipant('alice').getView()).toEqual(restored.game.forParticipant('alice').getView());
  expect(fork.toRecord()).toEqual(record);
  expect(() => { (record.commands as unknown[]).pop(); }).toThrow();
});

test('historical Bet/Raise bounds and exact accepted totals survive later sizing and complete record restoration', () => {
  const cashGame = game(); cashGame.startHand();
  const originalRaise = cashGame.forParticipant('alice').getView();
  expect(originalRaise.state.legalActions).toContainEqual({ type: 'raise', minimum: 40, maximum: 1000 });
  expect(cashGame.act('alice', { type: 'raise', raiseTo: 53 }).ok).toBe(true);
  const response = cashGame.forParticipant('bob').getView();
  expect(response.state.legalActions).toContainEqual({ type: 'raise', minimum: 86, maximum: 1000 });
  expect(cashGame.act('bob', { type: 'call' }).ok).toBe(true);
  const originalBet = cashGame.forParticipant('bob').getView();
  expect(originalBet.state.legalActions).toContainEqual({ type: 'bet', minimum: 20, maximum: 947 });
  expect(cashGame.act('bob', { type: 'bet', betTo: 31 }).ok).toBe(true);
  expect(cashGame.act('alice', { type: 'call' }).ok).toBe(true);
  expect(cashGame.forParticipant('bob').getView().state.legalActions).toContainEqual({ type: 'bet', minimum: 20, maximum: 916 });
  const record = cashGame.toRecord();
  const restored = CashGame.fromRecord(JSON.parse(JSON.stringify(record)));
  if (!restored.ok) throw new Error('Expected exact sized-command restoration.');
  for (const replay of [cashGame, restored.game]) {
    expect(replay.forParticipant('alice').getView({ at: { decisionId: originalRaise.state.decisionId! } })).toEqual(originalRaise);
    expect(replay.forParticipant('bob').getView({ at: { decisionId: response.state.decisionId! } })).toEqual(response);
    expect(replay.forParticipant('bob').getView({ at: { decisionId: originalBet.state.decisionId! } })).toEqual(originalBet);
  }
  expect(restored.game.toRecord()).toEqual(record);
  expect(restored.game.forParticipant('bob').getView()).toEqual(cashGame.forParticipant('bob').getView());
  expect(restored.game.forParticipant('bob').getView().history[0].decisions.map(d => d.action.action)).toEqual([{ type: 'raise', raiseTo: 53 }, { type: 'call' }, { type: 'bet', betTo: 31 }, { type: 'call' }]);
  for (const tail of [{ type: 'act', participantId: 'bob', action: { type: 'bet', betTo: 19 } }, { type: 'act', participantId: 'bob', action: { type: 'bet', betTo: 31, to: 31 } }]) expect(CashGame.fromRecord({ ...record, commands: [...record.commands, tail] })).toMatchObject({ ok: false, rejection: { code: 'invalid-record' } });
});
