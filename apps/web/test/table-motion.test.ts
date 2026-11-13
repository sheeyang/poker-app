import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, dealBeats, defaultConfiguration, defaultTrainerConfiguration, payoutBeats, type DealInputs, type PayoutInputs, type ObservableCashGameState, type ObservableParticipantState, type ObservableTableSession, type PresentationPhase } from '@poker/contracts';
import { heldStacks, planMotion, sceneOf, type Cue } from '../src/table-motion.js';

const phase = (kind: Exclude<PresentationPhase['kind'], 'deal' | 'payout'>, startsAt: number, street: PresentationPhase['street'] = 'preflop', handId = 'hand-1'): PresentationPhase => ({ kind, handId, street, startsAt, endsAt: startsAt + 1000, durationMs: 1000 });
/** The three-handed table's deal (button seat 3): you, then ada, then cy; you and ada post the blinds. */
const dealt: DealInputs = { dealt: ['you', 'ada', 'cy'].map(participantId => ({ participantId, cardCount: 2 })), blinds: ['you', 'ada'], refills: [] };
/** A deal phase as the server schedules it: as long as its beats, unless `durationMs` says otherwise. */
const deal = (startsAt: number, inputs: DealInputs = dealt, durationMs = dealBeats(inputs).totalMs): PresentationPhase => ({ kind: 'deal', handId: 'hand-1', street: 'preflop', startsAt, endsAt: startsAt + durationMs, durationMs, inputs });
/** A payout phase as the server schedules it: as long as its beats, unless `durationMs` says otherwise. */
const payout = (startsAt: number, inputs: PayoutInputs, durationMs = payoutBeats(inputs).totalMs, street: PresentationPhase['street'] = 'river'): PresentationPhase => ({ kind: 'payout', handId: 'hand-1', street, startsAt, endsAt: startsAt + durationMs, durationMs, inputs });
/** Ada wins 790 alone. */
const adaWins: PayoutInputs = { awards: [{ participantId: 'ada', won: 790, returned: 0 }] };
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

describe('motion is planned for changes this viewer saw happen, and for the phase being presented', () => {
  it('moves nothing a first view did not see happen, nor when the viewer sits down or stands up', () => {
    expect(planMotion(undefined, table())).toEqual([]);
    const watching = table({ state: { participants: [seat('ada', 2, { wager: 20 }), seat('cy', 3)] } });
    expect(planMotion(sceneOf(watching), table())).toEqual([]);
    expect(planMotion(sceneOf(table()), watching)).toEqual([]);
  });
  it('turns the table, and nothing else, when the viewer changed seat', () => {
    const moved = table({ state: { participants: [seat('you', 2, { holeCards: ['As', 'Kd'], wager: 10 }), seat('ada', 1, { wager: 20 }), seat('cy', 3)] } });
    expect(planMotion(sceneOf(table()), moved)).toEqual([{ kind: 'turn', seat: 2, at: 10_000 }]);
  });
  it('moves nothing when the view is unchanged', () => {
    expect(planMotion(sceneOf(table()), table())).toEqual([]);
  });
});

describe('a Hand is dealt and played', () => {
  // Stacks before the blinds: the next Hand's blinds come out of them.
  const waiting = table({ state: { status: 'completed-hand', handId: 'hand-0', buttonSeat: 2, participants: [seat('you', 1, { cardCount: 0, stack: 1010 }), seat('ada', 2, { cardCount: 0, stack: 1020 }), seat('cy', 3, { cardCount: 0 })] } });
  it('deals from the deal phase’s start, playing the beats of what the phase presents, after the button moves on', () => {
    const cues = planMotion(sceneOf(waiting), table({ phases: [deal(9_000)] }));
    expect(cues).toEqual([{ kind: 'deal', at: 9_000, beats: dealBeats(dealt), viewerId: 'you', fromButton: 2, refills: [] }]);
  });
  it('plays the deal the phase presents, not the cards the view holds', () => {
    // The phase is the record: seat 3 dealt first, one card each.
    const inputs: DealInputs = { dealt: [{ participantId: 'cy', cardCount: 1 }, { participantId: 'you', cardCount: 1 }], blinds: ['ada'], refills: [] };
    expect(planMotion(sceneOf(waiting), table({ phases: [deal(9_000, inputs)] }))).toContainEqual(expect.objectContaining({ kind: 'deal', beats: dealBeats(inputs) }));
  });
  it('gives a viewer with no earlier view the identical deal, joined part-way', () => {
    const now = table({ serverTime: 9_800, phases: [deal(9_000)] });
    const watched = planMotion(sceneOf(waiting), now).find(c => c.kind === 'deal');
    expect(planMotion(undefined, now)).toEqual([{ ...watched, fromButton: null }]);
  });
  it('fits the beats to the phase when its length differs from theirs', () => {
    const natural = dealBeats(dealt).totalMs;
    const [cue] = planMotion(undefined, table({ phases: [deal(9_000, dealt, natural * 2)] }));
    if (cue?.kind !== 'deal') throw new Error('No deal cue.');
    expect(cue.beats).toEqual(dealBeats(dealt, natural * 2));
    expect(cue.beats.totalMs).toBe(natural * 2);
    expect(Math.max(...cue.beats.cards.map(c => c.turn.endsAt))).toBeCloseTo(natural * 2);
  });
  it('lands a refill that came with the deal first, unless this viewer already saw it land (Rebuy & deal)', () => {
    const inputs: DealInputs = { ...dealt, refills: [{ participantId: 'you', amount: 1000 }] };
    const rebought = table({ phases: [deal(9_000, inputs)], state: { participants: [seat('you', 1, { holeCards: ['As', 'Kd'], wager: 10, stack: 990 }), seat('ada', 2, { wager: 20 }), seat('cy', 3)] } });
    const busted = table({ state: { status: 'completed-hand', handId: 'hand-0', buttonSeat: 2, participants: [seat('you', 1, { cardCount: 0, stack: 0 }), seat('ada', 2, { cardCount: 0, stack: 1020 }), seat('cy', 3, { cardCount: 0 })] } });
    expect(planMotion(sceneOf(busted), rebought)).toEqual([{ kind: 'deal', at: 9_000, beats: dealBeats(inputs), viewerId: 'you', fromButton: 2, refills: [{ participantId: 'you', amount: 1000 }] }]);
    expect(planMotion(undefined, rebought)).toContainEqual(expect.objectContaining({ kind: 'deal', refills: [{ participantId: 'you', amount: 1000 }] }));
    // The rebuy came in a view of its own: its chips landed then, and the deal keeps its timing without them.
    const shown = table({ state: { status: 'completed-hand', handId: 'hand-0', buttonSeat: 2, participants: [seat('you', 1, { cardCount: 0, stack: 1000 }), seat('ada', 2, { cardCount: 0, stack: 1020 }), seat('cy', 3, { cardCount: 0 })] } });
    expect(planMotion(sceneOf(shown), rebought)).toEqual([{ kind: 'deal', at: 9_000, beats: dealBeats(inputs), viewerId: 'you', fromButton: 2, refills: [] }]);
  });
  it('deals when the deal phase reveals cards a view already carried', () => {
    const hidden = table({ state: { participants: [seat('you', 1, { cardCount: 0, wager: 10 }), seat('ada', 2, { cardCount: 0, wager: 20 }), seat('cy', 3, { cardCount: 0 })] } });
    expect(kinds(planMotion(sceneOf(hidden), table({ phases: [deal(9_000)] })))).toEqual(['deal']);
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
    const flop = table({ serverTime: 14_000, phases: [deal(0), phase('street', 14_050, 'flop')], decisions: [['you', 'call'], ['ada', 'check']], state: { board: ['2c', '7d', 'Jh'], street: 'flop', participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2), seat('cy', 3, { folded: true })] } });
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
    const paid = table({ phases: [phase('showdown', 30_000, 'river'), payout(32_000, adaWins)], state: { status: 'completed-hand', board: ['2c', '7d', 'Jh', '9s', 'Qs'], payouts: [{ participantId: 'ada', amount: 790 }], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2, { holeCards: ['Qh', 'Qc'], stack: 1790 }), seat('cy', 3, { folded: true })] } });
    expect(planMotion(sceneOf(shown), paid)).toEqual([{ kind: 'payout', beats: payoutBeats(adaWins), at: 32_000 }]);
  });
  describe('the payout', () => {
    // A split pot: ada and cy each win 400, and 60 of cy's bet came back uncalled.
    const split: PayoutInputs = { awards: [{ participantId: 'ada', won: 400, returned: 0 }, { participantId: 'cy', won: 400, returned: 60 }] };
    const river = sceneOf(table({ state: { board: ['2c', '7d', 'Jh', '9s', 'Qs'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'], folded: true }), seat('ada', 2), seat('cy', 3)] } }));
    const paid = (phases: PresentationPhase[], serverTime = 32_500) => table({ serverTime, phases, state: { status: 'completed-hand', board: ['2c', '7d', 'Jh', '9s', 'Qs'], payouts: [{ participantId: 'ada', amount: 400 }, { participantId: 'cy', amount: 400 }], returns: [{ participantId: 'cy', amount: 60 }],
      participants: [seat('you', 1, { holeCards: ['As', 'Kd'], folded: true }), seat('ada', 2, { stack: 1400 }), seat('cy', 3, { stack: 1460 })] } });
    it('pushes each award in turn, from the payout phase’s own beats', () => {
      const cues = planMotion(river, paid([payout(32_000, split)]));
      expect(cues).toEqual([{ kind: 'payout', at: 32_000, beats: payoutBeats(split) }]);
    });
    it('gives a viewer with no earlier view the identical payout, joined part-way', () => {
      const now = paid([payout(32_000, split)]);
      expect(planMotion(undefined, now)).toEqual(planMotion(river, now));
    });
    it('fits the beats to the phase when its length differs from theirs', () => {
      const natural = payoutBeats(split).totalMs;
      const [cue] = planMotion(undefined, paid([payout(32_000, split, natural / 2)]));
      if (cue?.kind !== 'payout') throw new Error('No payout cue.');
      expect(cue.beats).toEqual(payoutBeats(split, natural / 2));
      expect(cue.beats.totalMs).toBe(natural / 2);
    });
    it('holds each winner’s stack figure at its old value until their award lands, then shows the new total', () => {
      const table = paid([payout(32_000, split)]), [ada, cy] = payoutBeats(split).awards;
      // Ada's chips land first; cy's, with the 60 that came back, after them.
      expect(heldStacks(table, 32_000 + ada!.endsAt - 1)).toEqual(new Map([['ada', { value: 1000, until: 32_000 + ada!.endsAt }], ['cy', { value: 1000, until: 32_000 + cy!.endsAt }]]));
      expect(heldStacks(table, 32_000 + ada!.endsAt)).toEqual(new Map([['cy', { value: 1000, until: 32_000 + cy!.endsAt }]]));
      expect(heldStacks(table, 32_000 + cy!.endsAt).size).toBe(0);
      expect(cy!.endsAt).toBeLessThan(payoutBeats(split).totalMs);
    });
    it('releases each held stack at its landing beat fitted to the phase', () => {
      const natural = payoutBeats(split).totalMs, [, cy] = payoutBeats(split, natural * 2).awards;
      expect(heldStacks(paid([payout(32_000, split, natural * 2)]), 32_000).get('cy')).toEqual({ value: 1000, until: 32_000 + cy!.endsAt });
    });
  });
  it('plays nothing during a Settle: each motion starts with the phase that presents it, and the stillness after it has none', () => {
    const flop = sceneOf(table({ state: { board: ['2c', '7d', 'Jh'], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2), seat('cy', 3, { folded: true })] } }));
    // An all-in runout: the showdown, the turn, the river and the payout, each followed by its Settle.
    const phases = [phase('showdown', 30_000, 'flop'), phase('settle', 31_000, 'flop'), phase('street', 32_000, 'turn'), phase('settle', 33_000, 'turn'),
      phase('street', 34_000, 'river'), phase('settle', 35_000, 'river'), payout(36_000, adaWins), phase('settle', 37_000, 'river')];
    const done = table({ phases, state: { status: 'completed-hand', board: ['2c', '7d', 'Jh', '9s', 'Qs'], payouts: [{ participantId: 'ada', amount: 790 }], participants: [seat('you', 1, { holeCards: ['As', 'Kd'] }), seat('ada', 2, { holeCards: ['Qh', 'Qc'], stack: 1790 }), seat('cy', 3, { folded: true })] } });
    const cues = planMotion(flop, done);
    expect(cues.map(cue => [cue.kind, cue.at]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([['showdown', 30_000], ['board', 32_000], ['board', 34_000], ['payout', 36_000]]);
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
    expect(planMotion(sceneOf(between(three)), between([seat('you', 1), seat('ada', 2, { stack: 3000 }), seat('cy', 3)]))).toEqual([{ kind: 'chips', participantId: 'ada', amount: 2000, from: 1000, at: 10_000 }]);
    const river = sceneOf(table({ state: { participants: three } }));
    expect(kinds(planMotion(river, table({ phases: [payout(9_000, { awards: [{ participantId: 'ada', won: 500, returned: 0 }] }, undefined, 'preflop')], state: { status: 'completed-hand', payouts: [{ participantId: 'ada', amount: 500 }], participants: [seat('you', 1), seat('ada', 2, { stack: 1500 }), seat('cy', 3)] } })))).toEqual(['payout']);
  });
  it('rewords a seat that sits out', () => {
    expect(planMotion(sceneOf(between(three)), between([seat('you', 1), seat('ada', 2, { sittingOut: true }), seat('cy', 3)]))).toEqual([{ kind: 'status', participantId: 'ada', at: 10_000 }]);
  });
});
