import { expect, test } from 'vitest';
import type { ReplayStep } from '@poker/contracts';
import { CashGame, type GameConfiguration } from '../src/index.js';

// A completed Hand can be replayed one Replay Step at a time (ADR-0041): before each decision, after each street reveal
// (every all-in runout street included) and at the result, each step showing only what the viewer could see then.
const configuration: GameConfiguration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'replay-steps-fixture' };
/** Alice on the button (the small blind, heads-up) and Bob in the big blind. */
function game(stacks: readonly [number, number] = [1000, 1000]) {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  created.game.seatParticipant('alice', 1, stacks[0]); created.game.seatParticipant('bob', 4, stacks[1]);
  return created.game;
}
function act(cashGame: CashGame, ...actions: readonly (readonly [string, Parameters<CashGame['act']>[1]])[]) {
  for (const [id, action] of actions) { const result = cashGame.act(id, action); if (!result.ok) throw new Error(id + ' ' + result.rejection.code); }
}
const replay = (cashGame: CashGame, viewer: string, handId = 'hand-1') => cashGame.forParticipant(viewer).getReplay(handId);
const outline = (steps: readonly ReplayStep[]) => steps.map(step => [step.kind, step.state.street, step.state.actorId, step.state.decisionId ?? null]);

/** Alice calls, Bob checks; on the flop Alice's bet is called; both check the turn and the river to a showdown. */
function showdown() {
  const cashGame = game(); cashGame.joinTable('watcher');
  cashGame.startHand();
  act(cashGame, ['alice', { type: 'call' }], ['bob', { type: 'check' }],
    ['bob', { type: 'check' }], ['alice', { type: 'bet', betTo: 40 }], ['bob', { type: 'call' }],
    ['bob', { type: 'check' }], ['alice', { type: 'check' }],
    ['bob', { type: 'check' }], ['alice', { type: 'check' }]);
  return cashGame;
}

test('a completed Hand has a step before every decision, one after each street reveal, and a result step', () => {
  const cashGame = showdown();
  const { handId, steps } = replay(cashGame, 'alice');
  expect(handId).toBe('hand-1');
  expect(outline(steps)).toEqual([
    ['decision', 'preflop', 'alice', 'hand-1/decision-1'], ['decision', 'preflop', 'bob', 'hand-1/decision-2'],
    ['street', 'flop', null, null], ['decision', 'flop', 'bob', 'hand-1/decision-3'], ['decision', 'flop', 'alice', 'hand-1/decision-4'], ['decision', 'flop', 'bob', 'hand-1/decision-5'],
    ['street', 'turn', null, null], ['decision', 'turn', 'bob', 'hand-1/decision-6'], ['decision', 'turn', 'alice', 'hand-1/decision-7'],
    ['street', 'river', null, null], ['decision', 'river', 'bob', 'hand-1/decision-8'], ['decision', 'river', 'alice', 'hand-1/decision-9'],
    ['result', 'river', null, null],
  ]);
  // Each step before a decision is the table as that decision opened, as the viewer could address it already.
  for (const step of steps.filter(step => step.kind === 'decision')) expect(step.state).toEqual(cashGame.forParticipant('alice').getView({ at: { decisionId: step.state.decisionId! } }).state);
  // The viewer's own decisions are marked by their DecisionId, with their legal actions; everyone else's have none.
  expect(steps.flatMap(step => step.viewerDecisionId ? [step.viewerDecisionId] : [])).toEqual(['hand-1/decision-1', 'hand-1/decision-4', 'hand-1/decision-7', 'hand-1/decision-9']);
  expect(steps.map(step => step.state.legalActions.length > 0)).toEqual(steps.map(step => !!step.viewerDecisionId));
  expect(outline(replay(cashGame, 'bob').steps)).toEqual(outline(steps));
  expect(replay(cashGame, 'bob').steps.flatMap(step => step.viewerDecisionId ? [step.viewerDecisionId] : [])).toEqual(['hand-1/decision-2', 'hand-1/decision-3', 'hand-1/decision-5', 'hand-1/decision-6', 'hand-1/decision-8']);
  expect(replay(cashGame, 'watcher').steps.some(step => step.viewerDecisionId || step.state.legalActions.length)).toBe(false);
  // The result is the Hand's result in the viewer's history.
  expect(steps.at(-1)!.state).toEqual(cashGame.forParticipant('alice').getView().history[0]!.result);
});

test('an all-in Hand has a step for each runout street, and its hands are turned up only at the result', () => {
  const cashGame = game();
  cashGame.startHand();
  act(cashGame, ['alice', { type: 'raise', raiseTo: 1000 }], ['bob', { type: 'call' }]);
  const facts = cashGame.getHand('hand-1')!;
  const { steps } = replay(cashGame, 'alice');
  expect(outline(steps)).toEqual([
    ['decision', 'preflop', 'alice', 'hand-1/decision-1'], ['decision', 'preflop', 'bob', 'hand-1/decision-2'],
    ['street', 'flop', null, null], ['street', 'turn', null, null], ['street', 'river', null, null], ['result', 'river', null, null],
  ]);
  expect(steps.map(step => step.state.board)).toEqual([[], [], facts.board.slice(0, 3), facts.board.slice(0, 4), facts.board, facts.board]);
  // Through the runout Alice sees only her own cards, although the engine turned both hands up when the betting closed.
  expect(steps.map(step => step.state.participants.filter(p => p.holeCards).map(p => p.participantId))).toEqual([['alice'], ['alice'], ['alice'], ['alice'], ['alice'], ['alice', 'bob']]);
  expect(steps.at(-1)!.state.participants.find(p => p.participantId === 'bob')!.holeCards).toEqual(facts.participants.find(p => p.participantId === 'bob')!.holeCards);
  // Each step carries what its transition presents: the deal, each decision taken, each street (the first sweeping the
  // line), and at the result the showdown and the payout.
  expect(steps.map(step => step.transition)).toEqual([
    { deal: { dealt: [{ participantId: 'alice', cardCount: 2 }, { participantId: 'bob', cardCount: 2 }], blinds: ['alice', 'bob'], refills: [] } },
    { acted: { participantId: 'alice', action: { type: 'raise', raiseTo: 1000 } } },
    { acted: { participantId: 'bob', action: { type: 'call' } }, street: { swept: ['alice', 'bob'], cardCount: 3 } },
    { street: { swept: [], cardCount: 1 } },
    { street: { swept: [], cardCount: 1 } },
    { showdown: { swept: [], shown: [{ participantId: 'alice', cardCount: 2 }, { participantId: 'bob', cardCount: 2 }] }, payout: { awards: facts.payouts.map(p => ({ participantId: p.participantId, won: p.amount, returned: 0 })) } },
  ]);
  expect(facts.payouts.reduce((total, p) => total + p.amount, 0)).toBe(2000);
});

test('a Hand whose blinds put a player all-in has no decisions: its first step is the flop, carrying the deal', () => {
  const created = CashGame.create({ ...configuration, minimumBuyIn: 1 });
  if (!created.ok) throw new Error('Expected valid CashGame.');
  const cashGame = created.game;
  cashGame.seatParticipant('alice', 1, 10); cashGame.seatParticipant('bob', 4, 1000);
  cashGame.startHand();
  expect(cashGame.getHand('hand-1')!.completed).toBe(true);
  const { steps } = replay(cashGame, 'bob');
  expect(outline(steps)).toEqual([['street', 'flop', null, null], ['street', 'turn', null, null], ['street', 'river', null, null], ['result', 'river', null, null]]);
  expect(steps[0]!.transition).toEqual({ deal: { dealt: [{ participantId: 'alice', cardCount: 2 }, { participantId: 'bob', cardCount: 2 }], blinds: ['alice', 'bob'], refills: [] }, street: { swept: [], cardCount: 3 } });
  // Bob's big blind was only half called: the rest comes back to him with the payout.
  expect(steps.at(-1)!.transition.payout!.awards.find(award => award.participantId === 'bob')).toMatchObject({ returned: 10 });
});

test('a Hand won by folds ends with the fold and the payout, and no showdown', () => {
  const cashGame = game();
  cashGame.startHand();
  act(cashGame, ['alice', { type: 'raise', raiseTo: 60 }], ['bob', { type: 'fold' }]);
  const { steps } = replay(cashGame, 'bob');
  expect(outline(steps)).toEqual([['decision', 'preflop', 'alice', 'hand-1/decision-1'], ['decision', 'preflop', 'bob', 'hand-1/decision-2'], ['result', 'preflop', null, null]]);
  expect(steps.at(-1)!.transition).toEqual({ acted: { participantId: 'bob', action: { type: 'fold' } }, payout: { awards: [{ participantId: 'alice', won: 40, returned: 40 }] } });
  expect(steps.at(-1)!.state.participants.filter(p => p.holeCards).map(p => p.participantId)).toEqual(['bob']);
});

test('no step exposes burn cards, deck order or hole cards not yet revealed, and every viewer sees the same public steps', () => {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  const cashGame = created.game;
  cashGame.seatParticipant('alice', 1); cashGame.seatParticipant('bob', 4);
  cashGame.joinTable('early'); cashGame.joinTable('gone'); cashGame.leaveTable('gone');
  const actor = () => cashGame.forParticipant('alice').getView().state.actorId;
  const passive = () => { for (let id = actor(); id; id = actor()) act(cashGame, [id, { type: cashGame.forParticipant(id).getView().state.legalActions.some(a => a.type === 'call') ? 'call' : 'check' }]); };
  // Hand 1 reaches a showdown; Hand 2 ends when everyone folds to Carol; Hand 3 is an all-in with a runout.
  cashGame.startHand(); passive();
  cashGame.seatParticipant('carol', 2);
  cashGame.startHand(); act(cashGame, ['carol', { type: 'raise', raiseTo: 60 }], ['bob', { type: 'fold' }], ['alice', { type: 'fold' }]);
  cashGame.startHand();
  const allIn = cashGame.forParticipant('bob').getView().state.legalActions.find(a => a.type === 'raise')!;
  act(cashGame, ['bob', { type: 'raise', raiseTo: 'maximum' in allIn ? allIn.maximum : 0 }], ['alice', { type: 'fold' }], ['carol', { type: 'call' }]);
  cashGame.joinTable('late');
  expect(cashGame.getHand('hand-3')!.participants.filter(p => p.revealed).map(p => p.participantId).sort()).toEqual(['bob', 'carol']);

  for (const handId of ['hand-1', 'hand-2', 'hand-3']) {
    const facts = cashGame.getHand(handId)!;
    const watched = replay(cashGame, 'late', handId);
    for (const viewer of ['alice', 'bob', 'carol', 'early', 'gone', 'late']) {
      const { steps } = replay(cashGame, viewer, handId);
      const own = facts.participants.find(p => p.participantId === viewer);
      // Everyone sees the same steps; a player's differ from a watcher's only by their own cards and legal actions.
      expect(steps.map(step => [step.kind, step.state.board, step.transition])).toEqual(watched.steps.map(step => [step.kind, step.state.board, step.transition]));
      for (const [index, step] of steps.entries()) {
        const json = JSON.stringify(step), at = { viewer, handId, index };
        const hidden = facts.participants.filter(p => p.participantId !== viewer && !(step.kind === 'result' && p.revealed)).flatMap(p => p.holeCards);
        for (const card of [...facts.burns, ...facts.deck.slice(facts.drawnCardCount), ...hidden, ...facts.board.slice(step.state.board.length)]) expect({ ...at, card, leaked: json.includes('"' + card + '"') }).toMatchObject({ leaked: false });
        expect(json).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
        expect(facts.board.slice(0, step.state.board.length)).toEqual(step.state.board);
        const holders = step.state.participants.filter(p => p.holeCards).map(p => p.participantId).sort();
        expect({ ...at, holders }).toEqual({ ...at, holders: facts.participants.filter(p => p.participantId === viewer && own || step.kind === 'result' && p.revealed).map(p => p.participantId).sort() });
      }
      // A showdown reveal appears only at the result.
      expect(steps.filter(step => step.transition.showdown).map(step => step.kind)).toEqual(facts.participants.some(p => p.revealed) ? ['result'] : []);
    }
  }
});

test('a Hand that is not complete has no Replay Steps', () => {
  const cashGame = showdown();
  cashGame.startHand();
  for (const handId of ['hand-2', 'hand-9', '']) expect(() => replay(cashGame, 'alice', handId)).toThrow(RangeError);
  expect(replay(cashGame, 'alice', 'hand-1').steps).toHaveLength(13);
});

test('a step before a decision shows the table as the decision opened, so a Participant seated during it appears from the next step', () => {
  const cashGame = game();
  cashGame.startHand();
  act(cashGame, ['alice', { type: 'call' }]);
  // Carol sits down while Bob decides; she is dealt in from the next Hand.
  cashGame.seatParticipant('carol', 2);
  act(cashGame, ['bob', { type: 'raise', raiseTo: 60 }], ['alice', { type: 'fold' }]);
  const { steps } = replay(cashGame, 'carol');
  const seated = steps.map(step => step.state.participants.find(p => p.participantId === 'carol')?.seat ?? null);
  expect(outline(steps)).toEqual([['decision', 'preflop', 'alice', 'hand-1/decision-1'], ['decision', 'preflop', 'bob', 'hand-1/decision-2'], ['decision', 'preflop', 'alice', 'hand-1/decision-3'], ['result', 'preflop', null, null]]);
  expect(seated).toEqual([null, null, 2, 2]);
  expect(steps[1]!.state).toEqual(cashGame.forParticipant('carol').getView({ at: { decisionId: 'hand-1/decision-2' } }).state);
});
