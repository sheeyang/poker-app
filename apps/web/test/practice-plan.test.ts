import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, baselinePlayingStrategy, type ObservableTableSession } from '@poker/contracts';
import { practiceStep } from '../src/practice-plan.js';

function table(): ObservableTableSession {
  return { tableSessionId: 't', pokerRevision: 7, sessionRevision: 9, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, bindings: [{ participantId: 'you', name: 'You', controller: { kind: 'human' } }, { participantId: 'bot', name: 'Bot 1', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }], view: { configuration: { ...defaultConfiguration, seatCount: 2, defaultBuyIn: 2000 }, history: [], state: { status: 'between-hands', buttonSeat: 1, participants: [], board: [], pots: [], actorId: null, legalActions: [] } } };
}

describe('practice preparation from confirmed state', () => {
  it('resumes seating at the next unseated player with the latest revision', () => {
    const t = table();
    const partiallySeated = { ...t, view: { ...t.view, state: { ...t.view.state, participants: [{ participantId: 'you', seat: 1, stack: 2000, sittingOut: false }] } } };
    expect(practiceStep(partiallySeated, undefined, 'r')).toMatchObject({ kind: 'seat', body: { participantId: 'bot', seat: 2, expectedPokerRevision: 7, requestId: 'r' } });
  });
  it('never deals twice after a successful start or a completed first hand', () => {
    const t = table();
    for (const status of ['active-hand', 'completed-hand'] as const) {
      const started = { ...t, view: { ...t.view, state: { ...t.view.state, status, handId: 'h2' } } };
      expect(practiceStep(started, undefined, 'r')).toBeNull();
      expect(practiceStep(started, 'h1', 'r')).toBeNull();
    }
  });
  it('refills a busted opponent before another explicit deal', () => {
    const t = table();
    const ended = { ...t, view: { ...t.view, state: { ...t.view.state, status: 'completed-hand' as const, handId: 'h1', participants: [{ participantId: 'you', seat: 1, stack: 4000, sittingOut: false }, { participantId: 'bot', seat: 2, stack: 0, sittingOut: false }] } } };
    expect(practiceStep(ended, 'h1', 'r')).toMatchObject({ kind: 'manage', operation: 'top-up-to', body: { participantId: 'bot', targetStack: 2000 } });
    expect(practiceStep({ ...ended, view: { ...ended.view, state: { ...ended.view.state, participants: ended.view.state.participants.map(p => ({ ...p, stack: 2000 })) } } }, 'h1', 'r')).toMatchObject({ kind: 'start', body: { expectedPokerRevision: 7 } });
  });
  it('returns a sitting-out human but preserves deliberately removed opponents', () => {
    const t = table();
    const paused = { ...t, view: { ...t.view, state: { ...t.view.state, handId: 'h1', participants: [{ participantId: 'you', seat: 1, stack: 1000, sittingOut: true }] } } };
    expect(practiceStep(paused, 'h1', 'r')).toMatchObject({ kind: 'manage', operation: 'set-sitting-out', body: { participantId: 'you', sittingOut: false } });
    const returned = { ...paused, view: { ...paused.view, state: { ...paused.view.state, participants: [{ ...paused.view.state.participants[0]!, sittingOut: false }] } } };
    expect(() => practiceStep(returned, 'h1', 'r')).toThrow('Add an opponent');
  });
});
