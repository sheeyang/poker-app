import { describe, expect, it } from 'vitest';
import { defaultConfiguration, payoutBeats, showdownBeats, streetBeats, type ObservableCashGameState, type ObservableParticipantState, type ReplayStep, type ShowdownInputs, type Street, type StreetInputs, type TableHandReplay } from '@poker/contracts';
import { moveReplay, openReplay, settleReplay } from '../src/replay-motion.js';

// One all-in Hand as the server replays it for "you": you raise to 40, Rex calls all-in, and the board runs out to a showdown.
const board: Readonly<Record<Street, readonly string[]>> = { preflop: [], flop: ['As', 'Kd', '7c'], turn: ['As', 'Kd', '7c', '2h'], river: ['As', 'Kd', '7c', '2h', '9s'] };
function state(street: Street, change: Partial<ObservableCashGameState> = {}, viewer: Partial<ObservableParticipantState> = {}, rex: Partial<ObservableParticipantState> = {}): ObservableCashGameState {
  return {
    status: 'active-hand', buttonSeat: 1, board: [...board[street]], pots: [], actorId: null, decisionId: null, legalActions: [], handId: 'hand-3', street,
    smallBlindParticipantId: 'you', bigBlindParticipantId: 'rex',
    participants: [
      { participantId: 'you', seat: 1, stack: 960, sittingOut: false, inHand: true, folded: false, allIn: false, contribution: 40, wager: 0, cardCount: 2, holeCards: ['Ah', 'Qs'], ...viewer },
      { participantId: 'rex', seat: 4, stack: 0, sittingOut: false, inHand: true, folded: false, allIn: true, contribution: 40, wager: 0, cardCount: 2, ...rex },
    ],
    ...change,
  };
}
const flop: StreetInputs = { swept: ['you', 'rex'], cardCount: 3 }, card: StreetInputs = { swept: [], cardCount: 1 };
const shown: ShowdownInputs = { swept: [], shown: [{ participantId: 'you', cardCount: 2 }, { participantId: 'rex', cardCount: 2 }] };
const paid = { awards: [{ participantId: 'you', won: 80, returned: 0 }] };
const steps: ReplayStep[] = [
  { kind: 'decision', state: state('preflop', { actorId: 'you', decisionId: 'hand-3/decision-1' }, { stack: 990, contribution: 10, wager: 10 }, { stack: 20, contribution: 20, wager: 20, allIn: false }),
    transition: { deal: { dealt: [{ participantId: 'you', cardCount: 2 }, { participantId: 'rex', cardCount: 2 }], blinds: ['you', 'rex'], refills: [] } }, viewerDecisionId: 'hand-3/decision-1' },
  { kind: 'decision', state: state('preflop', { actorId: 'rex', decisionId: 'hand-3/decision-2' }, { contribution: 40, wager: 40 }, { stack: 20, contribution: 20, wager: 20, allIn: false }),
    transition: { acted: { participantId: 'you', action: { type: 'raise', raiseTo: 40 } } } },
  { kind: 'street', state: state('flop'), transition: { acted: { participantId: 'rex', action: { type: 'call' } }, street: flop } },
  { kind: 'street', state: state('turn'), transition: { street: card } },
  { kind: 'street', state: state('river'), transition: { street: card } },
  { kind: 'result', state: state('river', { status: 'completed-hand', payouts: [{ participantId: 'you', amount: 80 }] }, { stack: 1040 }, { holeCards: ['Jc', 'Jd'] }), transition: { showdown: shown, payout: paid } },
];
const replay: TableHandReplay = {
  tableSessionId: 'table-1', mode: 'practice', viewerParticipantId: 'you', handId: 'hand-3', configuration: defaultConfiguration, steps,
  hand: { handId: 'hand-3', handNumber: 3, viewerDealtIn: true, dealtIn: [{ participantId: 'you', name: 'Alex' }, { participantId: 'rex', name: 'Rex' }] },
  participants: [{ participantId: 'you', name: 'Alex', bot: false }, { participantId: 'rex', name: 'Rex', bot: true }],
};

describe('stepping forward', () => {
  it('plays the step’s transition from its inputs, from the moment of the step input', () => {
    const felt = moveReplay(replay, openReplay(replay, 1), 2, 'step', 1_000);
    expect(felt.cues).toEqual([
      // Rex's call closed the street: its chips go straight to the pot, while the flop sweeps the line and is dealt.
      { kind: 'bet', participantId: 'rex', toPot: true, at: 1_000 },
      { kind: 'board', from: 0, to: 3, beats: streetBeats(flop), at: 1_000 },
    ]);
    expect(felt).toMatchObject({ step: 2, drawn: 2, reverse: false });
    expect(felt.felt.state).toBe(steps[2]!.state);
  });
  it('deals each runout street as its own step, then turns the hands up and, after the showdown’s Settle, pushes the pot', () => {
    expect(moveReplay(replay, openReplay(replay, 2), 3, 'step', 2_000).cues).toEqual([{ kind: 'board', from: 3, to: 4, beats: streetBeats(card), at: 2_000 }]);
    expect(moveReplay(replay, openReplay(replay, 3), 4, 'step', 3_000).cues).toEqual([{ kind: 'board', from: 4, to: 5, beats: streetBeats(card), at: 3_000 }]);
    const result = moveReplay(replay, openReplay(replay, 4), 5, 'step', 4_000);
    expect(result.cues).toEqual([
      { kind: 'showdown', beats: showdownBeats(shown), viewerId: 'you', at: 4_000 },
      { kind: 'payout', beats: payoutBeats(paid), at: 4_000 + showdownBeats(shown).totalMs + 1_200 },
    ]);
  });
});

describe('a new step input during motion', () => {
  it('snaps the motion to its end state and plays its own from there, from the moment of the input', () => {
    // Next while the flop is still being dealt: the turn is dealt now, not queued after the flop.
    const flopping = moveReplay(replay, openReplay(replay, 1), 2, 'step', 1_000);
    const turning = moveReplay(replay, flopping, 3, 'step', 1_100);
    expect(turning).toMatchObject({ step: 3, drawn: 3, reverse: false, cues: [{ kind: 'board', from: 3, to: 4, beats: streetBeats(card), at: 1_100 }] });
    expect(turning.input).not.toBe(flopping.input);
    // Next while a step back is still playing: the earlier step is where the step back ends, so Next plays its step again.
    const backing = moveReplay(replay, openReplay(replay, 3), 2, 'step', 5_000);
    expect(moveReplay(replay, backing, 3, 'step', 5_100)).toMatchObject({ step: 3, drawn: 3, reverse: false, cues: moveReplay(replay, openReplay(replay, 2), 3, 'step', 5_100).cues });
  });
  it('snaps even when it plays nothing itself, and a motion it snapped no longer settles the felt', () => {
    const backing = moveReplay(replay, openReplay(replay, 3), 2, 'step', 5_000);
    const jumped = moveReplay(replay, backing, 5, 'jump', 5_100);
    expect(jumped.input).not.toBe(backing.input);
    expect(settleReplay(replay, jumped, backing.input)).toBe(jumped);
    expect(settleReplay(replay, backing, backing.input)).toMatchObject({ step: 2, drawn: 2 });
  });
});

describe('a jump', () => {
  it('renders the step it goes to at once, even when it lands one step away', () => {
    for (const [from, to] of [[0, 2], [5, 2], [1, 2], [3, 2]] as const) {
      const jumped = moveReplay(replay, openReplay(replay, from), to, 'jump', 5_000);
      expect(jumped).toMatchObject({ step: to, drawn: to, cues: [], reverse: false });
      expect(jumped.felt.state).toBe(steps[to]!.state);
    }
  });
  it('is any move of more than one step', () => {
    expect(moveReplay(replay, openReplay(replay, 0), 3, 'step', 5_000)).toMatchObject({ step: 3, drawn: 3, cues: [] });
    expect(moveReplay(replay, openReplay(replay, 5), 2, 'step', 5_000)).toMatchObject({ step: 2, drawn: 2, cues: [] });
  });
});

describe('stepping back', () => {
  it('plays the same step’s cues in reverse, on the later step’s felt, then rests on the earlier step', () => {
    for (const to of [1, 2, 3, 4]) {
      const back = moveReplay(replay, openReplay(replay, to + 1), to, 'step', 5_000);
      expect(back).toMatchObject({ step: to, drawn: to + 1, reverse: true, cues: moveReplay(replay, openReplay(replay, to), to + 1, 'step', 5_000).cues });
      expect(back.felt.state).toBe(steps[to + 1]!.state);
      const rested = settleReplay(replay, back, back.input);
      expect(rested).toMatchObject({ step: to, drawn: to, cues: [], reverse: false });
      expect(rested.felt.state).toBe(steps[to]!.state);
    }
    // The flop's reverse: the board goes back to the deck while the line comes back out of the pot, and Rex's call returns.
    expect(moveReplay(replay, openReplay(replay, 2), 1, 'step', 5_000).cues.map(cue => cue.kind)).toEqual(['bet', 'board']);
  });
  it('renders a step back across a deal at once', () => {
    // The step back undoes a transition that dealt cards.
    const dealing: TableHandReplay = { ...replay, steps: steps.map((step, i) => i === 1 ? { ...step, transition: { ...step.transition, deal: steps[0]!.transition.deal! } } : step) };
    const back = moveReplay(dealing, openReplay(dealing, 1), 0, 'step', 5_000);
    expect(back).toMatchObject({ step: 0, drawn: 0, cues: [], reverse: false });
    expect(back.felt.state).toBe(steps[0]!.state);
  });
  it('leaves a forward step resting where it is once its motion is over', () => {
    const forward = moveReplay(replay, openReplay(replay, 1), 2, 'step', 1_000);
    expect(settleReplay(replay, forward, forward.input)).toBe(forward);
  });
});
