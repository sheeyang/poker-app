import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ObservableTableSession, type PendingParticipantChange } from '@poker/contracts';
import { canRemove, removalTiming } from '../src/removal.js';
import { pendingLabel, selfService } from '../src/self-service.js';

function table(viewer: 'ann' | 'ben', pendingChanges: PendingParticipantChange[] = []): ObservableTableSession {
  return {
    tableSessionId: 't', mode: 'online', options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: viewer, ownerParticipantId: 'ann',
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: [], actionWindow: null }, serverTime: 0, pendingChanges,
    bindings: [{ participantId: 'ann', name: 'Ann', controller: { kind: 'human' } }, { participantId: 'ben', name: 'Ben', controller: { kind: 'human' } }, { participantId: 'bot', name: 'Bot', controller: { kind: 'bot', playingStrategy: defaultTrainerConfiguration.referenceStrategy } }],
    view: { configuration: defaultConfiguration, history: [], state: { status: 'between-hands', buttonSeat: 1, board: [], pots: [], actorId: null, legalActions: [],
      participants: [{ participantId: 'ann', seat: 1, stack: 1000, sittingOut: false }, { participantId: 'ben', seat: 2, stack: 1000, sittingOut: false }] } },
  };
}
const binding = (t: ObservableTableSession, id: string) => t.bindings.find(b => b.participantId === id)!;

describe('who can be removed', () => {
  it('lets the Table Owner remove another human, and nobody else remove anyone', () => {
    expect(canRemove(table('ann'), binding(table('ann'), 'ben'))).toBe(true);
    expect(canRemove(table('ben'), binding(table('ben'), 'ann'))).toBe(false);
    expect(canRemove(table('ben'), binding(table('ben'), 'ben'))).toBe(false);
  });
  it('never offers the owner themselves or a Bot', () => {
    expect(canRemove(table('ann'), binding(table('ann'), 'ann'))).toBe(false);
    expect(canRemove(table('ann'), binding(table('ann'), 'bot'))).toBe(false);
  });
  it('stops offering Removal once it is pending', () => {
    const pending = table('ann', [{ participantId: 'ben', change: 'remove' }]);
    expect(canRemove(pending, binding(pending, 'ben'))).toBe(false);
  });
  it('says whether Removal applies at once or after the Hand', () => {
    expect([removalTiming(false), removalTiming(true)]).toEqual(['now', 'after-hand']);
  });
});

describe('a pending Removal', () => {
  it('is named for everyone at the table', () => {
    expect(pendingLabel('remove')).toBe('Being removed after this hand');
  });
  it('leaves the removed Guest nothing to ask for: no change of their own outranks it', () => {
    const asked = selfService(table('ben', [{ participantId: 'ben', change: 'remove' }]), true);
    expect(asked).toMatchObject({ pending: 'remove', sitOut: 'unavailable', standUp: 'unavailable', leaveTable: 'unavailable' });
  });
});
