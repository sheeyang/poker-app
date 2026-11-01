import { expect, test } from 'vitest';
import { CashGame } from '../src/index.js';

const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'membership-fixture' };
function game() {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  created.game.seatParticipant('alice', 1); created.game.seatParticipant('bob', 4);
  return created.game;
}
/** Heads-up passive play: the button calls, then every remaining decision checks. */
function playPassively(cashGame: CashGame) {
  for (let actor = cashGame.forParticipant('alice').getView().state.actorId; actor; actor = cashGame.forParticipant('alice').getView().state.actorId) {
    const legal = cashGame.forParticipant(actor).getView().state.legalActions;
    if (!cashGame.act(actor, { type: legal.some(a => a.type === 'call') ? 'call' : 'check' }).ok) throw new Error('Expected a passive action.');
  }
}

test('an unseated Participant who joins between Hands observes public table facts without hole cards or legal actions', () => {
  const cashGame = game();
  expect(cashGame.joinTable('watcher')).toEqual({ ok: true, events: [{ type: 'participant-joined', participantId: 'watcher' }] });
  expect(cashGame.toRecord().commands.at(-1)).toEqual({ type: 'join-table', participantId: 'watcher' });
  cashGame.startHand();
  const watching = cashGame.forParticipant('watcher').getView();
  expect(watching.state).toMatchObject({ status: 'active-hand', handId: 'hand-1', actorId: 'alice', board: [], pots: [{ amount: 20 }], legalActions: [] });
  expect(watching.state.participants.map(p => [p.participantId, p.seat, p.stack, p.wager ?? null])).toEqual([['alice', 1, 990, 10], ['bob', 4, 980, 20], ['watcher', null, 0, null]]);
  expect(watching.state.participants.some(p => p.holeCards)).toBe(false);
  expect(watching.state).not.toHaveProperty('amountToCall');
  playPassively(cashGame);
  const result = cashGame.forParticipant('watcher').getView();
  expect(result.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1', legalActions: [] });
  expect(result.state.board).toHaveLength(5);
  expect(result.state.participants.filter(p => p.holeCards).map(p => p.participantId)).toEqual(['alice', 'bob']);
  expect(result.history).toHaveLength(1);
  expect(result.history[0]).toMatchObject({ handId: 'hand-1', description: 'Completed Hand 1', result: result.state });
  expect(result.history[0].decisions.map(d => d.action.action.type)).toEqual(['call', 'check', 'check', 'check', 'check', 'check', 'check', 'check']);
  expect(result.history[0].decisions.every(d => d.state.legalActions.length === 0 && d.state.participants.every(p => !p.holeCards))).toBe(true);
});

test('seating implicitly joins, and a Participant who stands up stays joined and keeps observing without hole cards or legal actions', () => {
  const cashGame = game();
  expect(cashGame.joinTable('alice')).toMatchObject({ ok: false, rejection: { code: 'participant-already-joined' } });
  cashGame.startHand(); cashGame.act('alice', { type: 'fold' });
  expect(cashGame.standUpParticipant('alice').ok).toBe(true);
  expect(cashGame.joinTable('alice')).toMatchObject({ ok: false, rejection: { code: 'participant-already-joined' } });
  cashGame.seatParticipant('carol', 2);
  cashGame.startHand();
  const watching = cashGame.forParticipant('alice').getView();
  expect(watching.state).toMatchObject({ status: 'active-hand', handId: 'hand-2', legalActions: [] });
  expect(watching.state.participants.find(p => p.participantId === 'alice')).toEqual({ participantId: 'alice', seat: null, stack: 0, sittingOut: false });
  expect(watching.state.participants.some(p => p.holeCards)).toBe(false);
  expect(cashGame.forParticipant('carol').getView().history).toEqual([]);
  while (cashGame.forParticipant('alice').getView().state.actorId) cashGame.act(cashGame.forParticipant('alice').getView().state.actorId!, { type: 'fold' });
  expect(cashGame.forParticipant('alice').getView().history.map(h => h.handId)).toEqual(['hand-1', 'hand-2']);
  expect(cashGame.forParticipant('carol').getView().history.map(h => h.handId)).toEqual(['hand-2']);
  expect(cashGame.leaveTable('alice').ok).toBe(true);
  expect(cashGame.seatParticipant('alice', 5).ok).toBe(true);
  expect(cashGame.leaveTable('alice')).toMatchObject({ ok: false, rejection: { code: 'participant-seated' } });
  cashGame.startHand();
  expect(cashGame.forParticipant('alice').getView().state).toMatchObject({ handId: 'hand-3' });
});

test.each([
  ['joinTable', '', 'invalid-participant'], ['joinTable', '  ', 'invalid-participant'],
  ['joinTable', 'alice', 'participant-already-joined'], ['joinTable', 'watcher', 'participant-already-joined'],
  ['leaveTable', 'alice', 'participant-seated'], ['leaveTable', 'stranger', 'participant-not-joined'], ['leaveTable', 'gone', 'participant-not-joined'],
] as const)('during a Hand, %s(%j) is rejected atomically with %s', (method, participantId, code) => {
  const cashGame = game(); cashGame.joinTable('watcher'); cashGame.joinTable('gone'); cashGame.leaveTable('gone'); cashGame.startHand();
  const before = cashGame.toRecord();
  const views = ['alice', 'watcher', 'gone'].map(id => cashGame.forParticipant(id).getView());
  const facts = cashGame.getHand('hand-1');
  expect(cashGame[method](participantId)).toMatchObject({ ok: false, rejection: { code } });
  expect(cashGame.toRecord()).toEqual(before);
  expect(['alice', 'watcher', 'gone'].map(id => cashGame.forParticipant(id).getView())).toEqual(views);
  expect(cashGame.getHand('hand-1')).toEqual(facts);
});

test('a Participant who joins during a Hand observes the rest of it and its result, but no decision accepted before joining', () => {
  const cashGame = game(); cashGame.startHand();
  const earlier = cashGame.forParticipant('alice').getView().state.decisionId!;
  cashGame.act('alice', { type: 'call' });
  expect(cashGame.joinTable('late').ok).toBe(true);
  const joined = cashGame.forParticipant('late').getView();
  const player = cashGame.forParticipant('bob').getView();
  expect(joined.state).toMatchObject({ status: 'active-hand', handId: 'hand-1', actorId: 'bob', decisionId: player.state.decisionId, street: 'preflop', pots: player.state.pots, legalActions: [] });
  expect(joined.state.participants.map(p => [p.participantId, p.stack, p.wager ?? null, p.holeCards ?? null])).toEqual([['alice', 980, 20, null], ['bob', 980, 20, null], ['late', 0, null, null]]);
  expect(joined.history).toEqual([]);
  expect(() => cashGame.forParticipant('late').getView({ at: { decisionId: earlier } })).toThrow(RangeError);
  expect(cashGame.forParticipant('late').getView({ at: { decisionId: player.state.decisionId! } })).toEqual(joined);
  playPassively(cashGame);
  const completed = cashGame.forParticipant('late').getView();
  expect(completed.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(completed.state.participants.filter(p => p.holeCards).map(p => p.participantId)).toEqual(['alice', 'bob']);
  expect(completed.history).toHaveLength(1);
  expect(completed.history[0]).toMatchObject({ handId: 'hand-1', description: 'Completed Hand 1', result: completed.state });
  expect(completed.history[0].decisions.map(d => d.decisionId)).not.toContain(earlier);
  expect(completed.history[0].decisions).toHaveLength(7);
  expect(completed.history[0].decisions[0]).toEqual({ decisionId: player.state.decisionId, state: joined.state, action: { participantId: 'bob', action: { type: 'check' } } });
  expect(() => cashGame.forParticipant('late').getView({ at: { decisionId: earlier } })).toThrow(RangeError);
  expect(cashGame.forParticipant('alice').getView().history[0].decisions).toHaveLength(8);
});

test('leaving requires being unseated, hides every Hand played during the absence, and rejoining resumes observation with earlier history', () => {
  const cashGame = game(); cashGame.joinTable('watcher');
  cashGame.startHand(); playPassively(cashGame);
  const observed = cashGame.forParticipant('watcher').getView().history;
  expect(observed.map(h => h.handId)).toEqual(['hand-1']);
  const before = cashGame.toRecord();
  expect(cashGame.leaveTable('alice')).toMatchObject({ ok: false, rejection: { code: 'participant-seated' } });
  expect(cashGame.toRecord()).toEqual(before);
  expect(cashGame.leaveTable('watcher')).toEqual({ ok: true, events: [{ type: 'participant-left', participantId: 'watcher' }] });
  expect(cashGame.toRecord().commands.at(-1)).toEqual({ type: 'leave-table', participantId: 'watcher' });
  expect(cashGame.forParticipant('watcher').getView().state).not.toHaveProperty('handId');
  cashGame.startHand();
  const absentDecision = cashGame.forParticipant('alice').getView().state.decisionId!;
  expect(cashGame.forParticipant('watcher').getView()).toMatchObject({ state: { board: [], pots: [], actorId: null }, history: observed });
  playPassively(cashGame);
  expect(cashGame.forParticipant('watcher').getView().history).toEqual(observed);
  expect(cashGame.forParticipant('watcher').getView().state).not.toHaveProperty('handId');
  expect(() => cashGame.forParticipant('watcher').getView({ at: { decisionId: absentDecision } })).toThrow(RangeError);
  expect(cashGame.joinTable('watcher')).toEqual({ ok: true, events: [{ type: 'participant-joined', participantId: 'watcher' }] });
  expect(cashGame.forParticipant('watcher').getView().state).not.toHaveProperty('handId');
  cashGame.startHand(); playPassively(cashGame);
  const rejoined = cashGame.forParticipant('watcher').getView();
  expect(rejoined.history.map(h => h.handId)).toEqual(['hand-1', 'hand-3']);
  expect(rejoined.history[0]).toEqual(observed[0]);
  expect(JSON.stringify(rejoined)).not.toContain('hand-2');
  expect(rejoined.state.participants.filter(p => p.participantId === 'watcher')).toHaveLength(1);
});

test('a Participant who leaves during a Hand keeps the decisions observed while joined but never sees its result', () => {
  const cashGame = game(); cashGame.joinTable('watcher');
  cashGame.startHand(); cashGame.act('alice', { type: 'call' });
  expect(cashGame.leaveTable('watcher').ok).toBe(true);
  expect(cashGame.forParticipant('watcher').getView().state).toMatchObject({ board: [], pots: [], actorId: null });
  playPassively(cashGame);
  expect(cashGame.joinTable('watcher').ok).toBe(true);
  const view = cashGame.forParticipant('watcher').getView();
  expect(view.state).not.toHaveProperty('handId');
  expect(view.history).toHaveLength(1);
  expect(view.history[0]).toMatchObject({ handId: 'hand-1', description: 'Hand 1' });
  expect(view.history[0]).not.toHaveProperty('result');
  expect(view.history[0].decisions.map(d => [d.decisionId, d.action])).toEqual([['hand-1/decision-1', { participantId: 'alice', action: { type: 'call' } }]]);
});
