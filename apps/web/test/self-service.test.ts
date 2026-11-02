import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ObservableTableSession, type PendingParticipantChange } from '@poker/contracts';
import { pendingChangeOf, pendingLabel, selfService } from '../src/self-service.js';

function table(you: { seat: number | null; sittingOut?: boolean }, pendingChanges: PendingParticipantChange[] = [], allowSeatChanges = true): ObservableTableSession {
  return {
    tableSessionId: 't', mode: 'online', options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: 'you', ownerParticipantId: 'ann',
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: [], actionWindow: null }, serverTime: 0, pendingChanges,
    bindings: [{ participantId: 'ann', name: 'Ann', controller: { kind: 'human' } }, { participantId: 'you', name: 'You', controller: { kind: 'human' } }],
    view: { configuration: { ...defaultConfiguration, allowSeatChanges }, history: [], state: { status: 'between-hands', buttonSeat: 1, board: [], pots: [], actorId: null, legalActions: [],
      participants: [{ participantId: 'ann', seat: 1, stack: 1000, sittingOut: false }, { participantId: 'you', seat: you.seat, stack: you.seat === null ? 0 : 1000, sittingOut: you.sittingOut ?? false }] } },
  };
}

describe('the viewer’s own controls', () => {
  it('apply at once between Hands, and top-ups and seat changes are available', () => {
    expect(selfService(table({ seat: 2 }), false)).toEqual({ pending: undefined, sitOut: 'now', resume: 'unavailable', standUp: 'now', leaveTable: 'now', topUp: 'now', moveSeat: 'now' });
  });
  it('wait for the Hand to end during one, except top-ups and seat changes, which wait without being asked for', () => {
    expect(selfService(table({ seat: 2 }), true)).toEqual({ pending: undefined, sitOut: 'after-hand', resume: 'unavailable', standUp: 'after-hand', leaveTable: 'after-hand', topUp: 'unavailable', moveSeat: 'unavailable' });
  });
  it('offer resuming only between Hands, to someone who is sitting out', () => {
    expect(selfService(table({ seat: 2, sittingOut: true }), false)).toMatchObject({ sitOut: 'unavailable', resume: 'now' });
    expect(selfService(table({ seat: 2, sittingOut: true }), true)).toMatchObject({ sitOut: 'unavailable', resume: 'unavailable', standUp: 'after-hand' });
  });
  it('let someone without a Seat leave at once even mid-Hand, and offer them nothing else', () => {
    expect(selfService(table({ seat: null }), true)).toEqual({ pending: undefined, sitOut: 'unavailable', resume: 'unavailable', standUp: 'unavailable', leaveTable: 'now', topUp: 'unavailable', moveSeat: 'unavailable' });
  });
  it('stop offering a change a pending one already covers, but still offer a stronger one', () => {
    const asked = (change: 'sit-out' | 'stand-up' | 'leave-table') => selfService(table({ seat: 2 }, [{ participantId: 'you', change }]), true);
    expect(asked('sit-out')).toMatchObject({ pending: 'sit-out', sitOut: 'unavailable', standUp: 'after-hand', leaveTable: 'after-hand' });
    expect(asked('stand-up')).toMatchObject({ pending: 'stand-up', sitOut: 'unavailable', standUp: 'unavailable', leaveTable: 'after-hand' });
    expect(asked('leave-table')).toMatchObject({ pending: 'leave-table', sitOut: 'unavailable', standUp: 'unavailable', leaveTable: 'unavailable' });
  });
  it('ignore other Participants’ pending changes, and offer no seat change where the table disallows them', () => {
    expect(selfService(table({ seat: 2 }, [{ participantId: 'ann', change: 'leave-table' }]), true).pending).toBeUndefined();
    expect(selfService(table({ seat: 2 }, [], false), false).moveSeat).toBe('unavailable');
  });
});

describe('pending changes shown to the table', () => {
  it('names each change in words everyone can follow', () => {
    expect(['sit-out', 'stand-up', 'leave-table'].map(change => pendingLabel(change as 'sit-out'))).toEqual(['Sitting out after this hand', 'Standing up after this hand', 'Leaving after this hand']);
  });
  it('finds a Participant’s pending change', () => {
    const t = table({ seat: 2 }, [{ participantId: 'ann', change: 'sit-out' }]);
    expect([pendingChangeOf(t, 'ann'), pendingChangeOf(t, 'you')]).toEqual(['sit-out', undefined]);
  });
});
