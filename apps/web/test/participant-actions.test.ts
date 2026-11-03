import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ObservableTableSession } from '@poker/contracts';
import { participantActions, seatActions, stackBounds } from '../src/participant-actions.js';

function table(viewer = 'you'): ObservableTableSession {
  return {
    tableSessionId: 't', mode: 'online', options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: viewer, ownerParticipantId: 'owner',
    pokerRevision: 7, sessionRevision: 3, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: [], actionWindow: null }, serverTime: 0, pendingChanges: [],
    bindings: [{ participantId: 'owner', name: 'Owner', controller: { kind: 'human' } }, { participantId: 'you', name: 'Maya', controller: { kind: 'human' } }, { participantId: 'bot', name: 'Bot 1', controller: { kind: 'bot', playingStrategy: defaultTrainerConfiguration.referenceStrategy } }],
    view: { configuration: { ...defaultConfiguration, seatCount: 4, minimumBuyIn: 400, defaultBuyIn: 2000, maximumBuyIn: 4000, allowSeatChanges: true }, history: [], state: { status: 'between-hands', buttonSeat: 1, participants: [{ participantId: 'owner', seat: 1, stack: 2000, sittingOut: false }, { participantId: 'you', seat: 2, stack: 2010, sittingOut: false }, { participantId: 'bot', seat: 3, stack: 2000, sittingOut: false }], board: [], pots: [], actorId: null, legalActions: [] } },
  };
}
const withPlayers = (t: ObservableTableSession, participants: ObservableTableSession['view']['state']['participants']): ObservableTableSession => ({ ...t, view: { ...t.view, state: { ...t.view.state, participants } } });

describe('contextual Seat actions', () => {
  it('asks a seated Guest explicitly to move, while an owner also has Add a Bot', () => {
    expect(seatActions(table(), 4, false).map(a => a.id)).toEqual(['move']);
    expect(seatActions(table('owner'), 4, false).map(a => a.id)).toEqual(['move', 'add-bot']);
  });
  it('does not retarget a Seat someone else has taken', () => {
    expect(seatActions(table(), 3, false)).toEqual([]);
    expect(seatActions(table(), 5, false)).toEqual([]);
  });
  it('disables moves during a Hand and when the rules prohibit them', () => {
    expect(seatActions(table(), 4, true)[0]).toMatchObject({ timing: 'unavailable', reason: 'Available between hands' });
    const original = table(), t = { ...original, view: { ...original.view, configuration: { ...original.view.configuration, allowSeatChanges: false } } };
    expect(seatActions(t, 4, false)[0]).toMatchObject({ timing: 'unavailable', reason: 'Seat changes aren’t allowed' });
  });
  it('retains the selected Bot for the owner without granting control over other humans', () => {
    expect(seatActions(table('owner'), 4, false, 'bot')[0]).toMatchObject({ id: 'move', label: 'Move Bot 1 here', timing: 'now' });
    expect(seatActions(table('owner'), 4, false, 'you').map(a => a.id)).toEqual(['add-bot']);
    expect(seatActions(table(), 4, false, 'bot')).toEqual([]);
  });
  it('allows watching online Guests to sit during a Hand, but waits at Practice Tables', () => {
    const original = table(), t = withPlayers(original, original.view.state.participants.map(p => p.participantId === 'you' ? { ...p, seat: null } : p));
    expect(seatActions(t, 2, true)[0]).toMatchObject({ id: 'take-seat', timing: 'now' });
    expect(seatActions({ ...t, mode: 'practice' }, 2, true)[0]).toMatchObject({ id: 'take-seat', timing: 'unavailable' });
  });
});

describe('Participant actions', () => {
  it('gives Guests only their own controls and owners Bot controls plus human Removal', () => {
    expect(participantActions(table(), 'you', false).map(a => a.id)).toEqual(['stack', 'sit-out', 'move', 'stand-up', 'leave']);
    expect(participantActions(table(), 'bot', false)).toEqual([]);
    expect(participantActions(table(), 'owner', false)).toEqual([]);
    expect(participantActions(table('owner'), 'you', false).map(a => a.id)).toEqual(['remove-participant']);
    expect(participantActions(table('owner'), 'bot', false).map(a => a.id)).toEqual(['stack', 'sit-out', 'move', 'stand-up', 'strategy', 'remove-bot']);
  });
  it('honors after-Hand timing and pending request precedence', () => {
    const t: ObservableTableSession = { ...table(), pendingChanges: [{ participantId: 'you', change: 'sit-out' }] };
    const actions = participantActions(t, 'you', true);
    expect(actions.find(a => a.id === 'stack')?.timing).toBe('unavailable');
    expect(actions.find(a => a.id === 'sit-out')).toBeUndefined();
    expect(actions.find(a => a.id === 'stand-up')?.timing).toBe('after-hand');
    expect(actions.find(a => a.id === 'leave')?.timing).toBe('after-hand');
  });
  it('omits a redundant choose-seat action when only one Seat is open', () => {
    const t = withPlayers(table(), [{ participantId: 'owner', seat: 1, stack: 2000, sittingOut: false }, { participantId: 'you', seat: null, stack: 0, sittingOut: false }, { participantId: 'bot', seat: 2, stack: 2000, sittingOut: false }, { participantId: 'extra', seat: 3, stack: 2000, sittingOut: false }]);
    expect(participantActions(t, 'you', false).map(a => a.id)).toEqual(['leave']);
    expect(seatActions(t, 4, false)[0]?.id).toBe('take-seat');
  });
  it('offers no actions for a Participant who departed', () => {
    const t = { ...table('owner'), departedParticipantIds: ['bot', 'you'] };
    expect(participantActions(t, 'bot', false)).toEqual([]);
    expect(participantActions(t, 'you', false)).toEqual([]);
    expect(seatActions(t, 4, false, 'bot').map(a => a.id)).toEqual(['add-bot']);
  });
  it('uses the default buy-in for Rebuy and a valid maximum for Top up', () => {
    expect(stackBounds(table(), 0)).toEqual({ minimum: 400, maximum: 4000, initial: 2000 });
    expect(stackBounds(table(), 2010)).toEqual({ minimum: 2011, maximum: 4000, initial: 4000 });
    const original = table(), t = withPlayers(original, original.view.state.participants.map(p => p.participantId === 'you' ? { ...p, stack: 4000 } : p));
    expect(participantActions(t, 'you', false).find(a => a.id === 'stack')).toMatchObject({ timing: 'unavailable', reason: 'At the maximum buy-in' });
  });
});
