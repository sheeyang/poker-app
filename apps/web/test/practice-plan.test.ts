import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, baselinePlayingStrategy, type ObservableTableSession } from '@poker/contracts';
import { practiceStep } from '../src/practice-plan.js';

function table(): ObservableTableSession {
  return { tableSessionId: 't', mode: 'practice', options: { actionTimeLimitSeconds: null, allowLiveAnalysis: true }, viewerParticipantId: 'you', ownerParticipantId: 'you', pokerRevision: 7, sessionRevision: 9, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, bindings: [{ participantId: 'you', name: 'You', controller: { kind: 'human' } }, { participantId: 'bot', name: 'Bot 1', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }], view: { configuration: { ...defaultConfiguration, seatCount: 2, defaultBuyIn: 2000 }, history: [], state: { status: 'between-hands', buttonSeat: 1, participants: [], board: [], pots: [], actorId: null, legalActions: [] } } };
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
  it('refills a busted Bot with the deal itself (Rebuy & deal)', () => {
    const t = table();
    const ended = { ...t, view: { ...t.view, state: { ...t.view.state, status: 'completed-hand' as const, handId: 'h1', participants: [{ participantId: 'you', seat: 1, stack: 4000, sittingOut: false }, { participantId: 'bot', seat: 2, stack: 0, sittingOut: false }] } } };
    expect(practiceStep(ended, 'h1', 'r')).toEqual({ kind: 'start', tableId: 't', body: { requestId: 'r', expectedPokerRevision: 7, refills: [{ participantId: 'bot', targetStack: 2000 }] } });
    expect(practiceStep({ ...ended, view: { ...ended.view, state: { ...ended.view.state, participants: ended.view.state.participants.map(p => ({ ...p, stack: 2000 })) } } }, 'h1', 'r')).toEqual({ kind: 'start', tableId: 't', body: { requestId: 'r', expectedPokerRevision: 7 } });
  });
  it('leaves a sitting-out player to the Deal, which resumes them, but preserves deliberately removed Bots', () => {
    const t = table();
    const paused = { ...t, view: { ...t.view, state: { ...t.view.state, handId: 'h1', participants: [{ participantId: 'you', seat: 1, stack: 1000, sittingOut: true }] } } };
    // A sitting-out player still counts as a player: only a Bot is missing.
    expect(() => practiceStep(paused, 'h1', 'r')).toThrow('Add a Bot');
    const withBot = { ...paused, view: { ...paused.view, state: { ...paused.view.state, participants: [...paused.view.state.participants, { participantId: 'bot', seat: 2, stack: 1000, sittingOut: false }] } } };
    expect(practiceStep(withBot, 'h1', 'r')).toMatchObject({ kind: 'start', body: { expectedPokerRevision: 7 } });
  });
  it('rebuys a busted player who sat out before the Deal resumes them', () => {
    const t = table();
    const busted = { ...t, view: { ...t.view, state: { ...t.view.state, handId: 'h1', participants: [{ participantId: 'you', seat: 1, stack: 0, sittingOut: true }, { participantId: 'bot', seat: 2, stack: 1000, sittingOut: false }] } } };
    expect(practiceStep(busted, 'h1', 'r')).toMatchObject({ kind: 'start', body: { refills: [{ participantId: 'you', targetStack: 2000 }] } });
  });
  it('needs a Bot with chips or a refill to deal', () => {
    const t = table();
    const alone = { ...t, view: { ...t.view, state: { ...t.view.state, handId: 'h1', participants: [{ participantId: 'you', seat: 1, stack: 0, sittingOut: false }] } } };
    expect(() => practiceStep(alone, 'h1', 'r')).toThrow('Add a Bot');
  });
});
