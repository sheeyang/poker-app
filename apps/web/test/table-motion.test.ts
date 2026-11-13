import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, type ObservableCashGameState, type ObservableParticipantState, type ObservableTableSession, type PresentationPhase } from '@poker/contracts';
import { heldStacks, planMotion, sceneOf, type Cue } from '../src/table-motion.js';

const phase = (kind: PresentationPhase['kind'], startsAt: number, street: PresentationPhase['street'] = 'preflop', handId = 'hand-1'): PresentationPhase => ({ kind, handId, street, startsAt, endsAt: startsAt + 1000, durationMs: 1000 });
const seat = (participantId: string, seatNumber: number, extra: Partial<ObservableParticipantState> = {}): ObservableParticipantState => ({ participantId, seat: seatNumber, stack: 1000, sittingOut: false, inHand: true, cardCount: 2, contribution: 0, ...extra });
type Decision = readonly [participantId: string, type: string];

/** A three-handed Practice Table: you in seat 1, bots in seats 2 and 3; the button is seat 3. */
function table({ state = {}, phases = [], serverTime = 10_000, decisions = [] }: { state?: Partial<ObservableCashGameState>; phases?: PresentationPhase[]; serverTime?: number; decisions?: readonly Decision[] } = {}): ObservableTableSession {
  return { tableSessionId: 't', mode: 'practice', viewerParticipantId: 'you', pokerRevision: 5, sessionRevision: 5, serverTime, schedule: { phases, actionWindow: null }, pendingChanges: [], trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    bindings: [{ participantId: 'you', name: 'You', controller: { kind: 'human' } }, ...['ada', 'cy'].map(id => ({ participantId: id, name: id, controller: { kind: 'bot' as const, playingStrategy: baselinePlayingStrategy } }))],
    view: { configuration: { ...defaultConfiguration, seatCount: 3 },
      history: [{ handId: state.handId ?? 'hand-1', decisions: decisions.map(([participantId, type], i) => ({ decisionId: `d${i}`, action: { participantId, action: { type } } })) }] as never,
      state: {
        status: 'active-hand', buttonSeat: 3, handId: 'hand-1', street: 'preflop', board: [], pots: [], actorId: 'you', decisionId: 'd', legalActions: [],
        smallBlindParticipantId: 'you', bigBlindParticipantId: 'ada',
        participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 10 }), seat('ada', 2, { wager: 20 }), seat('cy', 3)],
        ...state,
      } } };
}
const kinds = (cues: Cue[]) => cues.map(c => c.kind);

describe('motion is planned only for changes this viewer saw happen', () => {
  it('moves nothing on a first view, or when the viewer changed seat and the whole table turned', () => {
    expect(planMotion(undefined, table())).toEqual([]);
    const before = sceneOf(table());
    const moved = table({ state: { participants: [seat('you', 2, { holeCards: ['As', 'Kd'], wager: 10 }), seat('ada', 1, { wager: 20 }), seat('cy', 3)] } });
    expect(planMotion(before, moved)).toEqual([]);
  });
  it('moves nothing when the view is unchanged', () => {
    expect(planMotion(sceneOf(table()), table())).toEqual([]);
  });
});

describe('a Hand is dealt and played', () => {
  const waiting = table({ state: { status: 'completed-hand', handId: 'hand-0', buttonSeat: 2, participants: [seat('you', 1, { cardCount: 0 }), seat('ada', 2, { cardCount: 0 }), seat('cy', 3, { cardCount: 0 })] } });
  it('deals from the deal phase’s start, clockwise from left of the button, after the blinds go in', () => {
    const cues = planMotion(sceneOf(waiting), table({ phases: [phase('deal', 9_000)] }));
    expect(kinds(cues)).toEqual(['new-hand', 'deal']);
    expect(cues[0]).toMatchObject({ at: 9_000, fromButton: 2 });
    expect(cues[1]).toEqual({ kind: 'deal', at: 9_000, blinds: ['you', 'ada'], order: [
      { participantId: 'you', cards: 2, viewer: true }, { participantId: 'ada', cards: 2, viewer: false }, { participantId: 'cy', cards: 2, viewer: false },
    ] });
  });
  it('deals when the deal phase reveals cards a view already carried', () => {
    const hidden = table({ state: { participants: [seat('you', 1, { cardCount: 0, wager: 10 }), seat('ada', 2, { cardCount: 0, wager: 20 }), seat('cy', 3, { cardCount: 0 })] } });
    expect(kinds(planMotion(sceneOf(hidden), table({ phases: [phase('deal', 9_000)] })))).toEqual(['deal']);
  });
  it('sends a bet’s chips to the line, mucks an opponent’s fold and keeps yours, each from the view that carried it', () => {
    const before = sceneOf(table());
    const cues = planMotion(before, table({ serverTime: 12_000, decisions: [['cy', 'fold'], ['you', 'raise']], state: { participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 60 }), seat('ada', 2, { wager: 20 }), seat('cy', 3, { folded: true })] } }));
    expect(cues).toEqual([{ kind: 'fold', participantId: 'cy', muck: true, cards: 2, at: 12_000 }, { kind: 'bet', participantId: 'you', toPot: false, at: 12_000 }]);
    const yours = planMotion(before, table({ decisions: [['you', 'fold']], state: { participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 10, folded: true }), seat('ada', 2, { wager: 20 }), seat('cy', 3)] } }));
    expect(yours).toContainEqual(expect.objectContaining({ kind: 'fold', participantId: 'you', muck: false }));
  });
  it('sweeps the line and deals the flop from its street phase; a call that closed the street goes straight to the pot', () => {
    const before = sceneOf(table({ decisions: [['you', 'call']], state: { participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 20 }), seat('ada', 2, { wager: 20 }), seat('cy', 3, { folded: true })] } }));
    const flop = table({ serverTime: 14_000, phases: [phase('deal', 0), phase('street', 14_050, 'flop')], decisions: [['you', 'call'], ['ada', 'check']], state: { board: ['2c', '7d', 'Jh'], street: 'flop', participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2), seat('cy', 3, { folded: true })] } });
    expect(planMotion(before, flop)).toEqual([
      { kind: 'check', participantId: 'ada', at: 14_000 },
      { kind: 'sweep', participantIds: ['you', 'ada'], at: 14_000 },
      { kind: 'board', from: 0, to: 3, swept: 2, at: 14_050 },
    ]);
    const closing = sceneOf(table({ decisions: [['you', 'call']], state: { participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 20 }), seat('ada', 2, { wager: 40 }), seat('cy', 3, { folded: true })] } }));
    expect(planMotion(closing, table({ decisions: [['you', 'call'], ['ada', 'call']], state: { participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2), seat('cy', 3, { folded: true })] } })))
      .toContainEqual(expect.objectContaining({ kind: 'bet', participantId: 'ada', toPot: true }));
  });
  it('sweeps the last street’s bets once betting is over, before the hands are turned up', () => {
    const river = sceneOf(table({ decisions: [['you', 'bet']], state: { board: ['2c', '7d', 'Jh', '9s', 'Qs'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 100 }), seat('ada', 2), seat('cy', 3, { folded: true })] } }));
    // The view keeps the wagers; the showdown phase says the betting is over.
    const called = table({ serverTime: 30_000, phases: [phase('showdown', 30_000, 'river')], decisions: [['you', 'bet'], ['ada', 'call']], state: { board: ['2c', '7d', 'Jh', '9s', 'Qs'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 100 }), seat('ada', 2, { holeCards: ['Qh', 'Qc'], wager: 100 }), seat('cy', 3, { folded: true })] } });
    expect(planMotion(river, called)).toEqual([
      { kind: 'bet', participantId: 'ada', toPot: true, at: 30_000 },
      { kind: 'sweep', participantIds: ['you'], at: 30_000 },
      { kind: 'showdown', participantIds: ['ada'], swept: 1, at: 30_000 },
    ]);
  });
  it('presents each street of a runout from its own phase', () => {
    const flop = sceneOf(table({ state: { board: ['2c', '7d', 'Jh'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2), seat('cy', 3)] } }));
    const river = table({ phases: [phase('street', 20_000, 'turn'), phase('street', 21_000, 'river')], state: { board: ['2c', '7d', 'Jh', '9s', 'Qs'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2), seat('cy', 3)] } });
    expect(planMotion(flop, river).filter(c => c.kind === 'board')).toEqual([{ kind: 'board', from: 3, to: 4, swept: 0, at: 20_000 }, { kind: 'board', from: 4, to: 5, swept: 0, at: 21_000 }]);
  });
  it('turns hands up from the showdown phase, then pushes the pot to the winner from the payout phase', () => {
    const river = sceneOf(table({ state: { board: ['2c', '7d', 'Jh', '9s', 'Qs'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2), seat('cy', 3, { folded: true })] } }));
    const shown = table({ phases: [phase('showdown', 30_000, 'river')], state: { board: ['2c', '7d', 'Jh', '9s', 'Qs'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2, { holeCards: ['Qh', 'Qc'] }), seat('cy', 3, { folded: true })] } });
    expect(planMotion(river, shown)).toEqual([{ kind: 'showdown', participantIds: ['ada'], swept: 0, at: 30_000 }]);
    const paid = table({ phases: [phase('showdown', 30_000, 'river'), phase('payout', 32_000, 'river')], state: { status: 'completed-hand', board: ['2c', '7d', 'Jh', '9s', 'Qs'], payouts: [{ participantId: 'ada', amount: 790 }], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2, { holeCards: ['Qh', 'Qc'], stack: 1790 }), seat('cy', 3, { folded: true })] } });
    expect(planMotion(sceneOf(shown), paid)).toEqual([{ kind: 'payout', awards: [{ participantId: 'ada', amount: 790 }], at: 32_000 }]);
  });
});

describe('who is at the table', () => {
  const between = (participants: ObservableParticipantState[], serverTime = 10_000) => table({ serverTime, state: { status: 'completed-hand', participants } });
  const three = [seat('you', 1), seat('ada', 2), seat('cy', 3)];
  it('settles arrivals, departures and moves in place, from the view that carried them', () => {
    const two = sceneOf(between([seat('you', 1), seat('ada', 2)]));
    expect(planMotion(two, between(three))).toEqual([{ kind: 'sit', seat: 3, at: 10_000 }]);
    expect(planMotion(sceneOf(between(three)), between([seat('you', 1), seat('ada', 2)]))).toEqual([{ kind: 'stand', seat: 3, at: 10_000 }]);
    expect(planMotion(two, between([seat('you', 1), seat('ada', 3)]))).toEqual([{ kind: 'move', fromSeat: 2, seat: 3, at: 10_000 }]);
  });
  it('brings chips added between Hands in with the amount, but not a payout’s', () => {
    expect(planMotion(sceneOf(between(three)), between([seat('you', 1), seat('ada', 2, { stack: 3000 }), seat('cy', 3)]))).toEqual([{ kind: 'chips', participantId: 'ada', amount: 2000, at: 10_000 }]);
    const river = sceneOf(table({ state: { participants: three } }));
    expect(kinds(planMotion(river, table({ phases: [phase('payout', 9_000)], state: { status: 'completed-hand', payouts: [{ participantId: 'ada', amount: 500 }], participants: [seat('you', 1), seat('ada', 2, { stack: 1500 }), seat('cy', 3)] } })))).toEqual(['payout']);
  });
  it('rewords a seat that sits out', () => {
    expect(planMotion(sceneOf(between(three)), between([seat('you', 1), seat('ada', 2, { sittingOut: true }), seat('cy', 3)]))).toEqual([{ kind: 'status', participantId: 'ada', at: 10_000 }]);
  });
});

describe('a winner’s stack figure during the payout', () => {
  const paid = table({ phases: [phase('payout', 32_000, 'river')], state: { status: 'completed-hand', payouts: [{ participantId: 'ada', amount: 500 }, { participantId: 'cy', amount: 300 }], participants: [seat('you', 1), seat('ada', 2, { stack: 1500 }), seat('cy', 3, { stack: 1300 })] } });
  it('keeps the old stack until the pushed chips land, each winner a little after the last', () => {
    expect(heldStacks(paid, 32_100)).toEqual(new Map([['ada', { value: 1000, until: 32_710 }], ['cy', { value: 1000, until: 32_770 }]]));
    expect(heldStacks(paid, 32_720)).toEqual(new Map([['cy', { value: 1000, until: 32_770 }]]));
    // Arriving after the chips landed shows the new totals at once.
    expect(heldStacks(paid, 40_000).size).toBe(0);
  });
});
