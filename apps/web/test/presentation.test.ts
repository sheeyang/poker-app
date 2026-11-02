import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, type ObservableCashGameState, type ObservableTableSession, type PresentationPhase, type TableSchedule } from '@poker/contracts';
import { actionWindowOpen, dealOpen, deadlineCountdown, estimateClockOffset, nextHandCountdown, nextPresentationChange, presentTable, recordClockSample } from '../src/presentation.js';

const deal = (startsAt: number, handId = 'hand-1'): PresentationPhase => ({ kind: 'deal', handId, street: 'preflop', startsAt, endsAt: startsAt + 1500, durationMs: 1500 });
const street = (name: 'flop' | 'turn' | 'river', startsAt: number): PresentationPhase => ({ kind: 'street', handId: 'hand-1', street: name, startsAt, endsAt: startsAt + 1000, durationMs: 1000 });
const showdown = (startsAt: number, name: 'preflop' | 'flop' | 'turn' | 'river'): PresentationPhase => ({ kind: 'showdown', handId: 'hand-1', street: name, startsAt, endsAt: startsAt + 2000, durationMs: 2000 });
const payout = (startsAt: number): PresentationPhase => ({ kind: 'payout', handId: 'hand-1', street: 'river', startsAt, endsAt: startsAt + 2000, durationMs: 2000 });
function table(state: Partial<ObservableCashGameState>, schedule: TableSchedule): ObservableTableSession {
  return { tableSessionId: 't', mode: 'practice', viewerParticipantId: 'you', pokerRevision: 5, sessionRevision: 5, serverTime: 0, schedule, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    bindings: [{ participantId: 'you', name: 'You', controller: { kind: 'human' } }, { participantId: 'bot', name: 'Bot', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }],
    view: { configuration: { ...defaultConfiguration, seatCount: 2 }, history: [], state: {
      status: 'active-hand', buttonSeat: 1, handId: 'hand-1', street: 'preflop', board: [], pots: [], actorId: 'you', decisionId: 'hand-1/decision-1', legalActions: [{ type: 'fold' }, { type: 'call' }],
      participants: [
        { participantId: 'you', seat: 1, stack: 990, sittingOut: false, inHand: true, cardCount: 2, holeCards: ['As', 'Kd'], contribution: 10, wager: 10 },
        { participantId: 'bot', seat: 2, stack: 980, sittingOut: false, inHand: true, cardCount: 2, contribution: 20, wager: 20 },
      ], ...state } } };
}
const shown = (t: ObservableTableSession) => ({ status: t.view.state.status, board: t.view.state.board, cards: t.view.state.participants.map(p => p.cardCount ?? 0), stacks: t.view.state.participants.map(p => p.stack), payouts: t.view.state.payouts ?? [] });

describe('server clock estimation from view timestamps', () => {
  it('reads a view’s server time as at most its arrival time on the server clock', () => {
    expect(estimateClockOffset([{ serverTime: 10_000, receivedAt: 4_000 }])).toBe(6_000);
    expect(estimateClockOffset([{ serverTime: 1_000, receivedAt: 4_000 }])).toBe(-3_000);
  });
  it('trusts the least-delayed of several views', () => {
    // 50 ms and 10 ms in transit: the second bounds the offset more tightly.
    expect(estimateClockOffset([{ serverTime: 10_000, receivedAt: 4_050 }, { serverTime: 12_000, receivedAt: 6_010 }, { serverTime: 13_000, receivedAt: 7_200 }])).toBe(5_990);
  });
  it('assumes synchronized clocks before any view arrives', () => {
    expect(estimateClockOffset([])).toBe(0);
  });
  it('keeps only recent views, so a changed client clock is not pinned by old ones', () => {
    let samples = recordClockSample([], { serverTime: 10_000, receivedAt: 0 }, 2);
    expect(estimateClockOffset(samples)).toBe(10_000);
    samples = recordClockSample(samples, { serverTime: 20_000, receivedAt: 15_000 }, 2);
    samples = recordClockSample(samples, { serverTime: 21_000, receivedAt: 16_000 }, 2);
    expect(samples).toEqual([{ serverTime: 20_000, receivedAt: 15_000 }, { serverTime: 21_000, receivedAt: 16_000 }]);
    expect(estimateClockOffset(samples)).toBe(5_000);
  });
});

describe('revealing received steps at their phase timestamps', () => {
  it('deals hole cards from the deal phase’s start', () => {
    const t = table({}, { phases: [deal(1_000)], actionWindow: { participantId: 'you', decisionId: 'hand-1/decision-1', opensAt: 2_500 } });
    expect(shown(presentTable(t, 999)).cards).toEqual([0, 0]);
    expect(presentTable(t, 999).view.state.participants[0]).not.toHaveProperty('holeCards');
    expect(shown(presentTable(t, 1_000)).cards).toEqual([2, 2]);
    expect(presentTable(t, 1_000).view.state.participants[0]!.holeCards).toEqual(['As', 'Kd']);
  });
  it('reveals each street from its phase’s start and skips phases already elapsed', () => {
    const flop = table({ street: 'flop', board: ['2c', '7d', 'Jh'], actorId: 'bot' }, { phases: [deal(0), street('flop', 5_000)], actionWindow: { participantId: 'bot', decisionId: 'hand-1/decision-3', opensAt: 6_000 } });
    expect(shown(presentTable(flop, 4_999)).board).toEqual([]);
    expect(shown(presentTable(flop, 4_999)).cards).toEqual([2, 2]);
    expect(shown(presentTable(flop, 5_000)).board).toEqual(['2c', '7d', 'Jh']);
    // A client arriving after the schedule has elapsed shows the received view as it is.
    expect(presentTable(flop, 60_000)).toBe(flop);
  });
  describe('an all-in runout that the server has already settled', () => {
    // Everything is in the view when it arrives; each step is shown at its own phase start.
    const settled = table({
      status: 'completed-hand', street: 'river', board: ['2c', '7d', 'Jh', 'Qs', '3d'], actorId: null, decisionId: null, legalActions: [],
      participants: [
        { participantId: 'you', seat: 1, stack: 2000, sittingOut: false, inHand: true, cardCount: 2, holeCards: ['As', 'Kd'], contribution: 1000, wager: 0 },
        { participantId: 'bot', seat: 2, stack: 0, sittingOut: false, inHand: true, cardCount: 2, holeCards: ['9c', '9h'], contribution: 1000, wager: 0 },
      ],
      pots: [{ amount: 2000, eligibleParticipantIds: ['you', 'bot'] }], returns: [], payouts: [{ participantId: 'you', amount: 2000 }],
    }, { phases: [deal(0), showdown(10_000, 'preflop'), street('flop', 12_000), street('turn', 13_000), street('river', 14_000), payout(15_000)], actionWindow: null });
    const during = { status: 'active-hand', stacks: [0, 0], payouts: [] };
    const botCards = (at: number) => presentTable(settled, at).view.state.participants[1]!.holeCards;
    it('keeps the opponent’s hole cards face down until the showdown phase starts', () => {
      expect(botCards(9_999)).toBeUndefined();
      expect(botCards(10_000)).toEqual(['9c', '9h']);
      expect(presentTable(settled, 9_999).view.state.participants[0]!.holeCards).toEqual(['As', 'Kd']);
      expect(shown(presentTable(settled, 9_999))).toEqual({ ...during, board: [], cards: [2, 2] });
    });
    it('reveals each remaining street at its phase start, after the showdown', () => {
      expect(shown(presentTable(settled, 11_999))).toEqual({ ...during, board: [], cards: [2, 2] });
      expect(shown(presentTable(settled, 12_000))).toEqual({ ...during, board: ['2c', '7d', 'Jh'], cards: [2, 2] });
      expect(shown(presentTable(settled, 13_000))).toEqual({ ...during, board: ['2c', '7d', 'Jh', 'Qs'], cards: [2, 2] });
      expect(shown(presentTable(settled, 14_999))).toEqual({ ...during, board: ['2c', '7d', 'Jh', 'Qs', '3d'], cards: [2, 2] });
    });
    it('pays out, with final stacks, at the payout phase’s start', () => {
      expect(shown(presentTable(settled, 15_000))).toEqual({ status: 'completed-hand', board: ['2c', '7d', 'Jh', 'Qs', '3d'], cards: [2, 2], stacks: [2000, 0], payouts: [{ participantId: 'you', amount: 2000 }] });
    });
    it('shows the received view as it is to a client arriving after the whole schedule', () => {
      expect(presentTable(settled, 17_000)).toBe(settled);
      expect(presentTable(settled, 60_000)).toBe(settled);
    });
  });
  it('holds back a pot won by folds, which has no showdown, until its payout phase starts', () => {
    const folded = table({
      status: 'completed-hand', actorId: null, decisionId: null, legalActions: [],
      participants: [
        { participantId: 'you', seat: 1, stack: 1010, sittingOut: false, inHand: true, cardCount: 2, holeCards: ['As', 'Kd'], contribution: 10, wager: 0 },
        { participantId: 'bot', seat: 2, stack: 980, sittingOut: false, inHand: true, cardCount: 2, folded: true, contribution: 20, wager: 0 },
      ], payouts: [{ participantId: 'you', amount: 30 }],
    }, { phases: [deal(0), payout(4_000)], actionWindow: null });
    expect(shown(presentTable(folded, 3_999))).toEqual({ status: 'active-hand', board: [], cards: [2, 2], stacks: [980, 980], payouts: [] });
    expect(shown(presentTable(folded, 4_000))).toEqual({ status: 'completed-hand', board: [], cards: [2, 2], stacks: [1010, 980], payouts: [{ participantId: 'you', amount: 30 }] });
  });
  it('shows a Hand completed under an earlier schedule, which has no payout phase, as it is', () => {
    const earlier = table({ status: 'completed-hand', actorId: null, decisionId: null, legalActions: [], payouts: [{ participantId: 'you', amount: 30 }] }, { phases: [deal(0), street('flop', 5_000)], actionWindow: null });
    expect(presentTable(earlier, 5_500)).toBe(earlier);
  });
  it('ignores phases of another Hand', () => {
    const t = table({ handId: 'hand-2' }, { phases: [deal(1_000, 'hand-1')], actionWindow: null });
    expect(presentTable(t, 0)).toBe(t);
  });
  it('names the next server time at which the presentation changes', () => {
    const flop = table({ street: 'flop', board: ['2c', '7d', 'Jh'], actorId: 'bot' }, { phases: [deal(0), street('flop', 5_000)], actionWindow: { participantId: 'bot', decisionId: 'hand-1/decision-3', opensAt: 6_000 } });
    expect(nextPresentationChange(flop, 4_000)).toBe(5_000);
    expect(nextPresentationChange(flop, 5_000)).toBe(6_000);
    expect(nextPresentationChange(flop, 6_000)).toBeUndefined();
  });
  it('reveals by client time through the estimated offset', () => {
    const flop = table({ street: 'flop', board: ['2c', '7d', 'Jh'], actorId: 'bot' }, { phases: [deal(0), street('flop', 5_000)], actionWindow: null });
    const offset = estimateClockOffset([{ serverTime: 4_000, receivedAt: 104_000 }]);
    expect(shown(presentTable(flop, 104_999 + offset)).board).toEqual([]);
    expect(shown(presentTable(flop, 105_000 + offset)).board).toHaveLength(3);
  });
});

describe('Deal follows the payout phase', () => {
  const completed = { status: 'completed-hand' as const, actorId: null, decisionId: null, legalActions: [] };
  const paid = table(completed, { phases: [deal(0), payout(4_000)], actionWindow: null });
  it('opens exactly when the payout phase ends', () => {
    expect(dealOpen(paid, 4_000)).toBe(false);
    expect(dealOpen(paid, 5_999)).toBe(false);
    expect(dealOpen(paid, 6_000)).toBe(true);
  });
  it('is the next presentation change once the payout phase has started', () => {
    expect(nextPresentationChange(paid, 3_999)).toBe(4_000);
    expect(nextPresentationChange(paid, 4_000)).toBe(6_000);
    expect(nextPresentationChange(paid, 6_000)).toBeUndefined();
  });
  it('is open when no Hand has been paid out yet, or the Hand ended under an earlier schedule', () => {
    expect(dealOpen(table({ status: 'between-hands', handId: undefined, actorId: null, decisionId: null, legalActions: [] }, { phases: [], actionWindow: null }), 0)).toBe(true);
    expect(dealOpen(table(completed, { phases: [deal(0), street('flop', 5_000)], actionWindow: null }), 5_500)).toBe(true);
  });
  it('ignores the payout phase of another Hand', () => {
    expect(dealOpen(table({ ...completed, handId: 'hand-2' }, { phases: [deal(0), payout(4_000)], actionWindow: null }), 4_500)).toBe(true);
  });
});

describe('action controls follow the Action Window', () => {
  const window = { participantId: 'you', decisionId: 'hand-1/decision-1', opensAt: 1_500 };
  const turn = table({}, { phases: [deal(0)], actionWindow: window });
  it('enable for the acting Participant only once the window opens', () => {
    expect(actionWindowOpen(turn, 'you', 1_499)).toBe(false);
    expect(actionWindowOpen(turn, 'you', 1_500)).toBe(true);
    expect(actionWindowOpen(turn, 'bot', 1_500)).toBe(false);
  });
  it('stay disabled without a window for the current decision', () => {
    expect(actionWindowOpen(table({}, { phases: [deal(0)], actionWindow: null }), 'you', 10_000)).toBe(false);
    expect(actionWindowOpen(table({}, { phases: [deal(0)], actionWindow: { ...window, decisionId: 'hand-1/decision-0' } }), 'you', 10_000)).toBe(false);
    expect(actionWindowOpen(table({ status: 'completed-hand', actorId: null, decisionId: null, legalActions: [] }, { phases: [deal(0)], actionWindow: window }), 'you', 10_000)).toBe(false);
  });
});

describe('the Action Deadline', () => {
  // A 15 s Action Time Limit: the window opens when the 1.5 s deal ends and closes 15 s later.
  const timed = table({}, { phases: [deal(0)], actionWindow: { participantId: 'you', decisionId: 'hand-1/decision-1', opensAt: 1_500, deadlineAt: 16_500 } });
  it('disables action controls at the deadline, on the estimated server clock', () => {
    expect(actionWindowOpen(timed, 'you', 1_500)).toBe(true);
    expect(actionWindowOpen(timed, 'you', 16_499)).toBe(true);
    expect(actionWindowOpen(timed, 'you', 16_500)).toBe(false);
    expect(actionWindowOpen(timed, 'you', 60_000)).toBe(false);
    const offset = estimateClockOffset([{ serverTime: 1_500, receivedAt: 101_500 }]);
    expect(actionWindowOpen(timed, 'you', 116_499 + offset)).toBe(true);
    expect(actionWindowOpen(timed, 'you', 116_500 + offset)).toBe(false);
  });
  it('counts down whole seconds from when the window opens', () => {
    expect([0, 1_500, 1_501, 2_500, 16_499, 16_500, 20_000].map(at => deadlineCountdown(timed, at))).toEqual([15, 15, 15, 14, 1, 0, 0]);
  });
  it('has no countdown without a deadline, as for a Bot or a table without an Action Time Limit', () => {
    expect(deadlineCountdown(table({}, { phases: [deal(0)], actionWindow: { participantId: 'you', decisionId: 'hand-1/decision-1', opensAt: 1_500 } }), 5_000)).toBeUndefined();
    expect(deadlineCountdown(table({}, { phases: [deal(0)], actionWindow: { participantId: 'you', decisionId: 'hand-1/decision-0', opensAt: 1_500, deadlineAt: 16_500 } }), 5_000)).toBeUndefined();
  });
  it('is the next presentation change at each second of its countdown, and at the deadline', () => {
    expect(nextPresentationChange(timed, 1_000)).toBe(1_500);
    expect(nextPresentationChange(timed, 1_500)).toBe(2_500);
    expect(nextPresentationChange(timed, 2_499)).toBe(2_500);
    expect(nextPresentationChange(timed, 15_600)).toBe(16_500);
    expect(nextPresentationChange(timed, 16_500)).toBeUndefined();
  });
});

describe('the Next-Hand Countdown', () => {
  const completed = { status: 'completed-hand' as const, actorId: null, decisionId: null, legalActions: [] };
  const pause = (startsAt: number): PresentationPhase => ({ kind: 'pause', handId: 'hand-1', street: 'preflop', startsAt, endsAt: startsAt + 3_000, durationMs: 3_000 });
  // The Hand was paid out at 4 s, the pause ended at 9 s, and the countdown runs from 9 s to 14 s.
  const announced = table(completed, { phases: [deal(0), payout(4_000), pause(6_000)], actionWindow: null, nextHandCountdown: { startsAt: 9_000, endsAt: 14_000, durationMs: 5_000 } });
  it('counts down whole seconds to the next Hand, for everyone at the table', () => {
    expect([9_000, 9_001, 10_000, 13_999, 14_000, 20_000].map(at => nextHandCountdown(announced, at))).toEqual([5, 5, 4, 1, 0, 0]);
  });
  it('is absent until the server announces one, and once the Hand it announced is dealt', () => {
    expect(nextHandCountdown(table(completed, { phases: [deal(0), payout(4_000), pause(6_000)], actionWindow: null }), 9_500)).toBeUndefined();
    expect(nextHandCountdown(table({ handId: 'hand-2' }, { ...announced.schedule, phases: [deal(14_000, 'hand-2')] }), 14_500)).toBeUndefined();
  });
  it('is the next presentation change at each of its seconds and at its expiry', () => {
    expect(nextPresentationChange(announced, 8_000)).toBe(9_000);
    expect(nextPresentationChange(announced, 9_000)).toBe(10_000);
    expect(nextPresentationChange(announced, 13_500)).toBe(14_000);
    expect(nextPresentationChange(announced, 14_000)).toBeUndefined();
  });
  it('presents nothing new during the pause between Hands', () => {
    const paused = table({ ...completed, payouts: [{ participantId: 'you', amount: 30 }] }, { phases: [deal(0), payout(4_000), pause(6_000)], actionWindow: null });
    expect(presentTable(paused, 7_000)).toBe(paused);
    expect(nextPresentationChange(paused, 6_500)).toBe(9_000);
  });
});
