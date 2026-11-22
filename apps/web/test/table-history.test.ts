import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ObservableTableSession, type TableHistoryHand, type TableSchedule } from '@poker/contracts';
import { completedLabel, handRows, returnBar } from '../src/table-history.js';

const hand = (change: Partial<TableHistoryHand> = {}): TableHistoryHand => ({
  handId: 'hand-37', handNumber: 37, completedAt: Date.UTC(2026, 10, 22, 14, 5), viewerDealtIn: true, showdown: true, board: ['As', 'Kd', '7c', '2h', 'Tc'],
  dealtIn: [{ participantId: 'you', name: 'Alex', holeCards: ['Ah', 'Qs'] }, { participantId: 'rex', name: 'Rex', holeCards: ['9d', '9s'] }],
  payouts: [{ participantId: 'you', amount: 140 }], ...change,
});

describe('the Table History rows', () => {
  it('number each Hand with the table-wide number and list the newest first', () => {
    const rows = handRows([hand({ handId: 'hand-36', handNumber: 36 }), hand()], 'you');
    expect(rows.map(row => [row.key, row.label])).toEqual([['hand-37', 'Hand 37'], ['hand-36', 'Hand 36']]);
  });
  it('name the viewer "You", show cards only where the server gave them, and say who won what', () => {
    const [row] = handRows([hand({ dealtIn: [{ participantId: 'you', name: 'Alex', holeCards: ['Ah', 'Qs'] }, { participantId: 'rex', name: 'Rex' }], showdown: false, payouts: [{ participantId: 'rex', amount: 60 }, { participantId: 'rex', amount: 20 }] })], 'you');
    expect(row!.players).toEqual([{ participantId: 'you', name: 'You', cards: ['Ah', 'Qs'] }, { participantId: 'rex', name: 'Rex', cards: undefined }]);
    expect(row!.result).toBe('Rex won 80');
    expect(row!.ending).toBe('No showdown');
  });
  it('report a split pot as each winner’s share, and whether the viewer was dealt in', () => {
    const [row] = handRows([hand({ viewerDealtIn: false, payouts: [{ participantId: 'you', amount: 70 }, { participantId: 'rex', amount: 70 }] })], 'you');
    expect(row!.result).toBe('You won 70 · Rex won 70');
    expect(row!.ending).toBe('Showdown');
    expect(row!.dealtIn).toBe(false);
  });
});

describe('a Hand’s completion time', () => {
  it('reads as a date and time in the given zone, and as nothing for a Hand from before times were recorded', () => {
    expect(completedLabel(Date.UTC(2026, 10, 22, 14, 5), 'UTC')).toBe('Nov 22, 2:05 PM');
    expect(completedLabel(undefined)).toBeUndefined();
    expect(handRows([hand({ completedAt: undefined })], 'you')[0]!.completed).toBeUndefined();
  });
});

const now = 1_000_000;
function table(change: { window?: TableSchedule['actionWindow']; seat?: number | null } = {}): ObservableTableSession {
  const seat = change.seat === undefined ? 2 : change.seat;
  return {
    tableSessionId: 't1', mode: 'online', options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: 'you', ownerParticipantId: 'sam',
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: [], actionWindow: change.window ?? null }, serverTime: now, pendingChanges: [], bindings: [],
    view: { configuration: defaultConfiguration, history: [], state: { status: 'active-hand', handId: 'hand-2', decisionId: 'hand-2/decision-1', buttonSeat: 1, board: [], pots: [], actorId: 'you', legalActions: [],
      participants: [{ participantId: 'you', seat, stack: 1000, sittingOut: false }] } },
  } as unknown as ObservableTableSession;
}
const window = (deadlineAt?: number): TableSchedule['actionWindow'] => ({ participantId: 'you', decisionId: 'hand-2/decision-1', opensAt: now - 1000, ...(deadlineAt !== undefined ? { deadlineAt } : {}) });

describe('the "Your turn — return" bar', () => {
  it('appears when the viewer’s Action Window is open, naming the table to return to and the seconds left to act', () => {
    expect(returnBar(table({ window: window(now + 12_300) }), now)).toEqual({ href: '/online/t1', countdown: 13 });
  });
  it('has no countdown where the decision has no Action Deadline, and never pauses one that has', () => {
    expect(returnBar(table({ window: window() }), now)).toEqual({ href: '/online/t1' });
    expect(returnBar(table({ window: window(now + 3000) }), now + 2000)).toEqual({ href: '/online/t1', countdown: 1 });
  });
  it('does not appear before the window opens, after its deadline, without a window, or for a Participant without a Seat', () => {
    expect(returnBar(table({ window: { ...window(now + 30_000)!, opensAt: now + 500 } }), now)).toBeUndefined();
    expect(returnBar(table({ window: window(now + 100) }), now + 200)).toBeUndefined();
    expect(returnBar(table(), now)).toBeUndefined();
    expect(returnBar(table({ window: window(), seat: null }), now)).toBeUndefined();
  });
});
