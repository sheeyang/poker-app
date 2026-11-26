import { expect, test } from 'vitest';
import type { ObservableHistoryEntry } from '@poker/contracts';
import { CashGame } from '../src/index.js';

// Observable Session History covers the whole Table Session (ADR-0040): every Participant sees the same public history
// of every Hand, whenever they joined, plus their own hole cards in the Hands they were dealt.
const configuration = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 100, defaultBuyIn: 1000, maximumBuyIn: 2000, allowSeatChanges: true, seed: 'session-history-fixture' };
function game() {
  const created = CashGame.create(configuration);
  if (!created.ok) throw new Error('Expected valid CashGame.');
  created.game.seatParticipant('alice', 1); created.game.seatParticipant('bob', 4);
  return created.game;
}
const history = (cashGame: CashGame, participantId: string) => cashGame.forParticipant(participantId).getView().history;
const actor = (cashGame: CashGame) => cashGame.forParticipant('alice').getView().state.actorId;
/** Every remaining decision calls or checks, to a showdown. */
function playPassively(cashGame: CashGame) {
  for (let id = actor(cashGame); id; id = actor(cashGame)) {
    const legal = cashGame.forParticipant(id).getView().state.legalActions;
    if (!cashGame.act(id, { type: legal.some(a => a.type === 'call') ? 'call' : 'check' }).ok) throw new Error('Expected a passive action.');
  }
}
/**
 * What a viewer who was not dealt in sees: the bound Participant's legal actions and amount to call removed, and their
 * hole cards too, except in a result whose showdown revealed them (the authoritative facts say which).
 */
function withoutOwnFacts(cashGame: CashGame, entries: readonly ObservableHistoryEntry[], participantId: string) {
  const strip = <T extends { readonly participants: readonly { readonly participantId: string; readonly holeCards?: readonly string[] }[]; readonly legalActions: readonly unknown[]; readonly amountToCall?: number }>(state: T, revealed: boolean) => {
    const { amountToCall: _amount, ...rest } = state;
    return { ...rest, legalActions: [], participants: state.participants.map(p => { if (p.participantId !== participantId || revealed) return p; const { holeCards: _cards, ...others } = p; return others; }) };
  };
  return entries.map(entry => {
    const revealed = !!cashGame.getHand(entry.handId)!.participants.find(p => p.participantId === participantId)?.revealed;
    return { ...entry, decisions: entry.decisions.map(d => ({ ...d, state: strip(d.state, false) })), ...(entry.result ? { result: strip(entry.result, revealed) } : {}) };
  });
}

test('Participants who joined at different times, or left, see the same public history of every completed Hand, each with only their own hole cards', () => {
  const cashGame = game();
  cashGame.joinTable('early'); cashGame.joinTable('gone'); cashGame.leaveTable('gone');
  cashGame.startHand(); playPassively(cashGame);
  // Carol sits down after Hand 1 and is dealt into Hand 2, which she wins when the others fold to her raise.
  cashGame.seatParticipant('carol', 2);
  cashGame.startHand();
  expect(actor(cashGame)).toBe('carol');
  cashGame.act('carol', { type: 'raise', raiseTo: 60 }); cashGame.act('bob', { type: 'fold' }); cashGame.act('alice', { type: 'fold' });
  cashGame.joinTable('late');

  const early = history(cashGame, 'early');
  expect(early.map(h => [h.handId, h.description, h.result?.status])).toEqual([['hand-1', 'Completed Hand 1', 'completed-hand'], ['hand-2', 'Completed Hand 2', 'completed-hand']]);
  // Someone who joined after both Hands, and someone who left before either, see exactly what Early saw.
  expect(history(cashGame, 'late')).toEqual(early);
  expect(history(cashGame, 'gone')).toEqual(early);
  // Carol sees Hand 1 as everyone else does, and Hand 2 with her own cards and her own decision's legal actions.
  const carol = history(cashGame, 'carol');
  expect(carol[0]).toEqual(early[0]);
  expect(carol[1]!.decisions.map(d => d.state.participants.filter(p => p.holeCards).map(p => p.participantId))).toEqual([['carol'], ['carol'], ['carol']]);
  expect(carol[1]!.decisions.map(d => d.state.legalActions.length > 0)).toEqual([true, false, false]);
  expect(carol[1]!.decisions[0]!.state.participants.find(p => p.participantId === 'carol')!.holeCards).toEqual(cashGame.getHand('hand-2')!.participants.find(p => p.participantId === 'carol')!.holeCards);
  expect(withoutOwnFacts(cashGame, carol, 'carol')).toEqual(early);
  // The players' histories differ from the watchers' only by their own facts.
  for (const id of ['alice', 'bob']) expect(withoutOwnFacts(cashGame, history(cashGame, id), id)).toEqual(early);
});

test('a Participant who joins during a Hand sees its earlier public actions and addresses its earlier decisions as every other viewer does', () => {
  const cashGame = game(); cashGame.joinTable('early');
  cashGame.startHand();
  cashGame.act('alice', { type: 'call' });
  cashGame.joinTable('late');
  const joined = cashGame.forParticipant('late').getView();
  expect(joined.state).toMatchObject({ status: 'active-hand', handId: 'hand-1', actorId: 'bob', legalActions: [] });
  expect(joined.history).toEqual(history(cashGame, 'early'));
  expect(joined.history).toMatchObject([{ handId: 'hand-1', description: 'Hand 1', decisions: [{ decisionId: 'hand-1/decision-1', action: { participantId: 'alice', action: { type: 'call' } } }] }]);
  expect(joined.history[0]).not.toHaveProperty('result');
  // Alice's decision, from before Late joined, looks to Late exactly as it does to Early: no hole cards and no legal actions.
  const earlier = cashGame.forParticipant('late').getView({ at: { decisionId: 'hand-1/decision-1' } });
  expect(earlier).toEqual(cashGame.forParticipant('early').getView({ at: { decisionId: 'hand-1/decision-1' } }));
  expect(earlier.state).toMatchObject({ actorId: 'alice', decisionId: 'hand-1/decision-1', legalActions: [] });
  expect(earlier.state.participants.some(p => p.holeCards)).toBe(false);
  expect(earlier.state).toEqual(joined.history[0]!.decisions[0]!.state);
  expect(cashGame.forParticipant('late').getView({ at: { decisionId: 'hand-1/decision-2' } })).toEqual(cashGame.forParticipant('early').getView({ at: { decisionId: 'hand-1/decision-2' } }));
  playPassively(cashGame);
  const completed = history(cashGame, 'late');
  expect(completed).toEqual(history(cashGame, 'early'));
  expect(completed[0]).toMatchObject({ handId: 'hand-1', description: 'Completed Hand 1' });
  expect(completed[0]!.decisions).toHaveLength(8);
});

test('a Participant who leaves during a Hand stops seeing it until it completes, and then sees all of it', () => {
  const cashGame = game(); cashGame.joinTable('watcher');
  cashGame.startHand(); cashGame.act('alice', { type: 'call' });
  expect(cashGame.leaveTable('watcher').ok).toBe(true);
  // The Hand in progress belongs to the live table, which only joined Participants observe.
  const away = cashGame.forParticipant('watcher').getView();
  expect(away.state).toMatchObject({ board: [], pots: [], actorId: null, legalActions: [] });
  expect(away.state).not.toHaveProperty('handId');
  expect(away.history).toEqual([]);
  expect(() => cashGame.forParticipant('watcher').getView({ at: { decisionId: 'hand-1/decision-1' } })).toThrow(RangeError);
  playPassively(cashGame);
  const completed = cashGame.forParticipant('watcher').getView();
  expect(completed.state).not.toHaveProperty('handId');
  expect(completed.history).toEqual(history(cashGame, 'stranger'));
  expect(completed.history).toMatchObject([{ handId: 'hand-1', description: 'Completed Hand 1' }]);
  expect(completed.history[0]!.decisions).toHaveLength(8);
  expect(cashGame.forParticipant('watcher').getView({ at: { decisionId: 'hand-1/decision-1' } })).toEqual(cashGame.forParticipant('stranger').getView({ at: { decisionId: 'hand-1/decision-1' } }));
});

test('no history entry exposes burn cards, deck order or unrevealed hole cards, and a showdown reveal appears only in its own Hand\'s result', () => {
  const cashGame = game();
  cashGame.joinTable('early'); cashGame.joinTable('gone'); cashGame.leaveTable('gone');
  // Hand 1 reaches a showdown; Hand 2 ends when everyone folds to Carol; Hand 3 is an all-in with a runout.
  cashGame.startHand(); playPassively(cashGame);
  cashGame.seatParticipant('carol', 2);
  cashGame.startHand(); cashGame.act('carol', { type: 'raise', raiseTo: 60 }); cashGame.act('bob', { type: 'fold' }); cashGame.act('alice', { type: 'fold' });
  cashGame.startHand();
  expect(actor(cashGame)).toBe('bob');
  const allIn = cashGame.forParticipant('bob').getView().state.legalActions.find(a => a.type === 'raise')!;
  cashGame.act('bob', { type: 'raise', raiseTo: 'maximum' in allIn ? allIn.maximum : 0 }); cashGame.act('alice', { type: 'fold' }); cashGame.act('carol', { type: 'call' });
  // Hand 4 is in progress when Late joins.
  cashGame.startHand(); cashGame.act(actor(cashGame)!, { type: 'call' });
  cashGame.joinTable('late');
  expect(cashGame.getHand('hand-1')!.participants.map(p => p.revealed)).toEqual([true, true]);
  expect(cashGame.getHand('hand-2')!.participants.some(p => p.revealed)).toBe(false);
  expect(cashGame.getHand('hand-3')!.participants.filter(p => p.revealed).map(p => p.participantId).sort()).toEqual(['bob', 'carol']);
  expect(cashGame.getHand('hand-3')!.board).toHaveLength(5);

  for (const viewer of ['alice', 'bob', 'carol', 'early', 'gone', 'late']) {
    const entries = history(cashGame, viewer);
    expect({ viewer, hands: entries.map(h => h.handId) }).toEqual({ viewer, hands: viewer === 'gone' ? ['hand-1', 'hand-2', 'hand-3'] : ['hand-1', 'hand-2', 'hand-3', 'hand-4'] });
    for (const entry of entries) {
      const facts = cashGame.getHand(entry.handId)!;
      const own = facts.participants.find(p => p.participantId === viewer);
      const json = JSON.stringify(entry);
      const unrevealed = facts.participants.filter(p => p.participantId !== viewer && !(entry.result && p.revealed)).flatMap(p => p.holeCards);
      for (const card of [...facts.burns, ...facts.deck.slice(facts.drawnCardCount), ...unrevealed]) expect({ viewer, hand: entry.handId, card, leaked: json.includes('"' + card + '"') }).toMatchObject({ leaked: false });
      expect(json).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
      // Before every decision only the viewer's own cards show; a reveal waits for the Hand's result.
      for (const decision of entry.decisions) {
        expect({ viewer, decision: decision.decisionId, holders: decision.state.participants.filter(p => p.holeCards).map(p => p.participantId) }).toEqual({ viewer, decision: decision.decisionId, holders: own ? [viewer] : [] });
        if (own) expect(decision.state.participants.find(p => p.participantId === viewer)!.holeCards).toEqual(own.holeCards);
        expect(facts.board.slice(0, decision.state.board.length)).toEqual(decision.state.board);
      }
      if (entry.result) {
        const shown = entry.result.participants.filter(p => p.holeCards);
        expect({ viewer, hand: entry.handId, holders: shown.map(p => p.participantId).sort() }).toEqual({ viewer, hand: entry.handId, holders: facts.participants.filter(p => p.participantId === viewer || p.revealed).map(p => p.participantId).sort() });
        for (const p of shown) expect(p.holeCards).toEqual(facts.participants.find(member => member.participantId === p.participantId)!.holeCards);
        expect(entry.result.board).toEqual(facts.board);
      }
    }
  }
});
