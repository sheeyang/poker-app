import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, type ObservableCashGameState, type ObservableTableSession, type PresentationPhase, type TableSchedule } from '@poker/contracts';
import { actionWindowOpen, estimateClockOffset, nextPresentationChange, presentTable, recordClockSample } from '../src/presentation.js';

const deal = (startsAt: number, handId = 'hand-1'): PresentationPhase => ({ kind: 'deal', handId, street: 'preflop', startsAt, endsAt: startsAt + 1500, durationMs: 1500 });
const street = (name: 'flop' | 'turn' | 'river', startsAt: number): PresentationPhase => ({ kind: 'street', handId: 'hand-1', street: name, startsAt, endsAt: startsAt + 1000, durationMs: 1000 });
function table(state: Partial<ObservableCashGameState>, schedule: TableSchedule): ObservableTableSession {
  return { tableSessionId: 't', mode: 'practice', pokerRevision: 5, sessionRevision: 5, serverTime: 0, schedule, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
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
  it('presents an all-in runout street by street and settles it only after its last phase', () => {
    const settled = table({
      status: 'completed-hand', street: 'river', board: ['2c', '7d', 'Jh', 'Qs', '3d'], actorId: null, decisionId: null, legalActions: [],
      participants: [
        { participantId: 'you', seat: 1, stack: 2000, sittingOut: false, inHand: true, cardCount: 2, holeCards: ['As', 'Kd'], contribution: 1000, wager: 0 },
        { participantId: 'bot', seat: 2, stack: 0, sittingOut: false, inHand: true, cardCount: 2, holeCards: ['9c', '9h'], contribution: 1000, wager: 0 },
      ],
      pots: [{ amount: 2000, eligibleParticipantIds: ['you', 'bot'] }], returns: [], payouts: [{ participantId: 'you', amount: 2000 }],
    }, { phases: [deal(0), street('flop', 10_000), street('turn', 11_000), street('river', 12_000)], actionWindow: null });
    const during = { status: 'active-hand', stacks: [0, 0], payouts: [] };
    expect(shown(presentTable(settled, 10_500))).toEqual({ ...during, board: ['2c', '7d', 'Jh'], cards: [2, 2] });
    expect(shown(presentTable(settled, 11_000))).toEqual({ ...during, board: ['2c', '7d', 'Jh', 'Qs'], cards: [2, 2] });
    expect(shown(presentTable(settled, 12_999))).toEqual({ ...during, board: ['2c', '7d', 'Jh', 'Qs', '3d'], cards: [2, 2] });
    expect(shown(presentTable(settled, 13_000))).toEqual({ status: 'completed-hand', board: ['2c', '7d', 'Jh', 'Qs', '3d'], cards: [2, 2], stacks: [2000, 0], payouts: [{ participantId: 'you', amount: 2000 }] });
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
