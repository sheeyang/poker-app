import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ObservableTableSession, type OwnerSuccession } from '@poker/contracts';
import { leaveWarning, ownershipChange } from '../src/ownership.js';

/** An Online Table owned by Ann, viewed by `viewer`, with Ben watching and a Bot. */
function table(viewer: 'ann' | 'ben', ownerSuccession?: OwnerSuccession, owner: 'ann' | 'ben' = 'ann'): ObservableTableSession {
  return {
    tableSessionId: 't', mode: 'online', options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: viewer, ownerParticipantId: owner,
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: [], actionWindow: null }, serverTime: 0, pendingChanges: [],
    bindings: [{ participantId: 'ann', name: 'Ann', controller: { kind: 'human' } }, { participantId: 'ben', name: 'Ben', controller: { kind: 'human' } }, { participantId: 'rex', name: 'Rex', controller: { kind: 'bot', playingStrategy: { policy: { id: 'p', version: 'v1', configuration: {} }, selector: { id: 's', version: 'v1', configuration: {} } } } }],
    ...(ownerSuccession ? { ownerSuccession } : {}),
    view: { configuration: defaultConfiguration, history: [], state: { status: 'between-hands', buttonSeat: 1, board: [], pots: [], actorId: null, legalActions: [],
      participants: [{ participantId: 'ann', seat: 1, stack: 1000, sittingOut: false }, { participantId: 'ben', seat: null, stack: 0, sittingOut: false }, { participantId: 'rex', seat: 2, stack: 1000, sittingOut: false }] } },
  };
}

describe('the leave warning', () => {
  it('names who becomes the Table Owner when the owner leaves, at once or when the Hand ends', () => {
    const owned = table('ann', { successorParticipantId: 'ben' });
    expect(leaveWarning(owned, 'now')).toEqual({ kind: 'successor', heading: 'Ben becomes the Table Owner', detail: 'Ben joined earliest of everyone still here, so they take over the Bots, the table rules and the Table Password.', confirm: 'Leave table' });
    expect(leaveWarning(owned, 'after-hand')).toMatchObject({ kind: 'successor', heading: 'Ben becomes the Table Owner when this hand ends' });
  });
  it('warns the owner that the table will close when nobody else is at it, and says so on the confirm button', () => {
    const alone = table('ann', { closes: true });
    expect(leaveWarning(alone, 'now')).toEqual({ kind: 'closes', heading: 'This table will close', detail: 'Nobody else is here to take it over. Once you leave, no one can join or play at it again. It stays in your Online tables.', confirm: 'Leave and close table' });
    expect(leaveWarning(alone, 'after-hand')).toMatchObject({ kind: 'closes', heading: 'This table closes when this hand ends', confirm: 'Leave and close table' });
  });
  it('says nothing to anyone but the owner, nor at a Practice Table, which is never left', () => {
    expect(leaveWarning(table('ben', undefined), 'now')).toBeUndefined();
    expect(leaveWarning({ ...table('ann', { closes: true }), mode: 'practice' }, 'now')).toBeUndefined();
  });
});

describe('an ownership change shown to the table', () => {
  it('tells everyone who the new owner is, and the new owner what they now manage', () => {
    expect(ownershipChange('ann', table('ann', undefined, 'ben'))).toBe('Ben is now the Table Owner.');
    expect(ownershipChange('ann', table('ben', undefined, 'ben'))).toBe('You’re now the Table Owner. You manage the Bots, the table rules and the Table Password.');
  });
  it('says nothing until ownership actually changes', () => {
    expect(ownershipChange(undefined, table('ben'))).toBeUndefined();
    expect(ownershipChange('ann', table('ben'))).toBeUndefined();
  });
});
