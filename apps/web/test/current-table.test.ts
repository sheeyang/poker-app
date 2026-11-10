import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type AfterHandRequest, type ObservableTableSession, type SavedTable, type TableSchedule } from '@poker/contracts';
import { currentTableBanner, currentTableId, withMembershipEnded } from '../src/current-table.js';

const id = '7f3a0000-0000-4000-8000-000000000001';
const now = 1_000_000;

/** Sam's 6-max 10/20 Online Table; the viewer, `you`, sits in seat 2 with 2,140 chips, between Hands after 13 of them. */
function table(change: { seat?: number | null; owner?: string; pending?: AfterHandRequest[]; hand?: 'between' | 'active' | 'paying-out'; actor?: string; window?: TableSchedule['actionWindow']; mode?: 'online' | 'practice' } = {}): ObservableTableSession {
  const seat = change.seat === undefined ? 2 : change.seat;
  const history = Array.from({ length: 13 }, (_, i) => ({ handId: `hand-${i + 1}`, decisions: [] }));
  const active = change.hand === 'active', payingOut = change.hand === 'paying-out';
  const handId = active ? 'hand-14' : 'hand-13';
  return {
    tableSessionId: id, mode: change.mode ?? 'online', options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: 'you', ownerParticipantId: change.owner ?? 'sam',
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: payingOut ? [{ kind: 'payout', handId: 'hand-13', street: 'river', startsAt: now - 500, endsAt: now + 1500, durationMs: 2000 }] : [], actionWindow: change.window ?? null },
    serverTime: now, pendingChanges: change.pending ?? [],
    bindings: [{ participantId: 'sam', name: 'Sam', controller: { kind: 'human' } }, { participantId: 'you', name: 'Alex', controller: { kind: 'human' } }],
    view: { configuration: { ...defaultConfiguration, seatCount: 6, smallBlind: 10, bigBlind: 20 }, history: active ? [...history, { handId: 'hand-14', decisions: [] }] : history,
      state: { status: active ? 'active-hand' : payingOut ? 'completed-hand' : 'between-hands', handId, decisionId: active ? 'hand-14/decision-3' : undefined, buttonSeat: 1, board: [], pots: [], actorId: active ? change.actor ?? 'sam' : null, legalActions: [],
        participants: [{ participantId: 'sam', seat: 1, stack: 1000, sittingOut: false }, { participantId: 'you', seat, stack: seat === null ? 0 : 2140, sittingOut: false }] } },
  } as unknown as ObservableTableSession;
}

describe('the Current Table among saved tables', () => {
  const saved = (entries: Partial<SavedTable>[]) => entries.map((entry, i) => ({ tableSessionId: `t${i}`, mode: 'online', ...entry }) as SavedTable);
  it('is the one Online Table the Guest has not left', () => {
    expect(currentTableId(saved([{ mode: 'practice' }, { left: true }, { tableSessionId: id }]))).toBe(id);
  });
  it('is none while the Guest is only at Practice Tables, has left every Online Table, or the list is not read yet', () => {
    expect(currentTableId(saved([{ mode: 'practice' }, { left: true }]))).toBeUndefined();
    expect(currentTableId(undefined)).toBeUndefined();
  });
  it('is gone as soon as the server says the Guest’s Leave Table or Removal took effect', () => {
    const list = { tables: saved([{ tableSessionId: id }, { mode: 'practice' }]) };
    const ended = withMembershipEnded(list, id);
    expect(currentTableId(ended?.tables)).toBeUndefined();
    expect(ended?.tables[1]).toEqual(list.tables[1]);
    expect(withMembershipEnded(undefined, id)).toBeUndefined();
  });
});

describe('the Current Table banner', () => {
  it('shows on every other page, Practice Tables included, but not on the Current Table’s own page', () => {
    for (const page of ['/practice', '/online', '/practice/9b1d0000-0000-4000-8000-000000000002', '/online/9b1d0000-0000-4000-8000-000000000002', '/somewhere'])
      expect(currentTableBanner(table(), page, now)).toBeDefined();
    expect(currentTableBanner(table(), `/online/${id}`, now)).toBeUndefined();
    expect(currentTableBanner(table(), `/practice/${id}`, now)).toBeUndefined();
  });
  it('shows nothing without a Current Table to show', () => {
    expect(currentTableBanner(undefined, '/practice', now)).toBeUndefined();
    expect(currentTableBanner(table({ mode: 'practice' }), '/online', now)).toBeUndefined();
  });
  it('names the table by its owner, then its format and stakes, how play stands and the viewer’s stack, and links back to it', () => {
    expect(currentTableBanner(table(), '/practice', now)).toEqual({
      href: `/online/${id}`, heading: 'Sam’s table', format: '6-max · 10 / 20', hand: 'Between hands', stack: '2,140 chips',
      yourTurn: false, pending: undefined, handOpen: false, leave: 'now',
    });
  });
  it('calls the table the viewer’s own while they own it', () => {
    expect(currentTableBanner(table({ owner: 'you' }), '/practice', now)?.heading).toBe('Your table');
  });
  it('numbers the Hand in progress, until its payout phase ends', () => {
    expect(currentTableBanner(table({ hand: 'active' }), '/practice', now)).toMatchObject({ hand: 'Hand 14 in progress', leave: 'after-hand' });
    expect(currentTableBanner(table({ hand: 'paying-out' }), '/practice', now)).toMatchObject({ hand: 'Hand 13 in progress', leave: 'after-hand' });
    expect(currentTableBanner(table({ hand: 'paying-out' }), '/practice', now + 1500)).toMatchObject({ hand: 'Between hands', leave: 'now' });
  });
  it('says the viewer is watching when they have no Seat', () => {
    expect(currentTableBanner(table({ seat: null }), '/practice', now)?.stack).toBe('Watching');
  });
  it('says "Your turn" only while the viewer’s Action Window is open', () => {
    const window = (participantId: string, opensAt: number) => ({ participantId, decisionId: 'hand-14/decision-3', opensAt, deadlineAt: opensAt + 30_000 });
    expect(currentTableBanner(table({ hand: 'active', actor: 'you', window: window('you', now - 10) }), '/practice', now)).toMatchObject({ yourTurn: true, heading: 'Your turn at Sam’s table' });
    expect(currentTableBanner(table({ owner: 'you', hand: 'active', actor: 'you', window: window('you', now - 10) }), '/practice', now)?.heading).toBe('Your turn at your table');
    // Not yet open, already past its Action Deadline, or someone else's.
    expect(currentTableBanner(table({ hand: 'active', actor: 'you', window: window('you', now + 10) }), '/practice', now)?.yourTurn).toBe(false);
    expect(currentTableBanner(table({ hand: 'active', actor: 'you', window: window('you', now - 30_000) }), '/practice', now)?.yourTurn).toBe(false);
    expect(currentTableBanner(table({ hand: 'active', actor: 'sam', window: window('sam', now - 10) }), '/practice', now)?.yourTurn).toBe(false);
  });
  it('says "Leaving after this hand" while the viewer’s Leave Table is pending, and offers no second one', () => {
    expect(currentTableBanner(table({ hand: 'active', pending: [{ participantId: 'you', change: 'leave-table' }] }), '/practice', now)).toMatchObject({ pending: 'Leaving after this hand', leave: 'unavailable' });
    expect(currentTableBanner(table({ hand: 'active', pending: [{ participantId: 'you', change: 'remove' }] }), '/practice', now)).toMatchObject({ pending: 'Being removed after this hand', leave: 'unavailable' });
    // Someone else's, or a weaker change of the viewer's own, is not a leave.
    expect(currentTableBanner(table({ hand: 'active', pending: [{ participantId: 'sam', change: 'leave-table' }] }), '/practice', now)).toMatchObject({ pending: undefined, leave: 'after-hand' });
    expect(currentTableBanner(table({ hand: 'active', pending: [{ participantId: 'you', change: 'sit-out' }] }), '/practice', now)).toMatchObject({ pending: undefined, leave: 'after-hand' });
  });
});
