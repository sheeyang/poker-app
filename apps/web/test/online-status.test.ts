import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, type ObservableParticipant, type ObservableTableSession, type TableSchedule } from '@poker/contracts';
import { connectionOf, nextHandLabel, nextHandStatus, waitingDetail, waitingReason, watchingNames, type WaitingReason } from '../src/online-status.js';

const seated = (participantId: string, seat: number, extra: Partial<ObservableParticipant> = {}): ObservableParticipant => ({ participantId, seat, stack: 1000, sittingOut: false, ...extra });
function table(participants: ObservableParticipant[], connected: string[], schedule: TableSchedule = { phases: [], actionWindow: null }, mode: 'online' | 'practice' = 'online'): ObservableTableSession {
  return {
    tableSessionId: 't', mode, options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: 'you', ownerParticipantId: 'ann',
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule, serverTime: 0, pendingChanges: [], ...(mode === 'online' ? { connectedParticipantIds: connected } : {}),
    bindings: [{ participantId: 'ann', name: 'Ann', controller: { kind: 'player' } }, { participantId: 'you', name: 'You', controller: { kind: 'player' } }, { participantId: 'rex', name: 'Rex', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }],
    view: { configuration: defaultConfiguration, history: [], state: { status: 'between-hands', buttonSeat: 1, board: [], pots: [], actorId: null, legalActions: [], participants } },
  };
}

describe('connection status at an Online Table', () => {
  it('shows each player as connected or not, and Bots as neither', () => {
    const t = table([seated('ann', 1), seated('you', 2), seated('rex', 3)], ['you']);
    expect(['ann', 'you', 'rex'].map(id => connectionOf(t, id))).toEqual(['disconnected', 'connected', undefined]);
  });
  it('is not shown at a Practice Table, which has a single player', () => {
    expect(connectionOf(table([seated('you', 1)], [], undefined, 'practice'), 'you')).toBeUndefined();
  });
});

describe('the next Hand at an Online Table, between Hands', () => {
  it('counts down once the server has announced the Next-Hand Countdown', () => {
    const t = table([seated('ann', 1), seated('rex', 2)], ['ann'], { phases: [], actionWindow: null, nextHandCountdown: { startsAt: 1_000, endsAt: 6_000, durationMs: 5_000 } });
    expect(nextHandStatus(t, 2_500)).toEqual({ kind: 'countdown', seconds: 4 });
  });
  it('waits for two Eligible Participants, one of them a connected player, when no countdown is announced', () => {
    // Ann is disconnected, and you are sitting out: only the Bot could play.
    expect(nextHandStatus(table([seated('ann', 1), seated('you', 2, { sittingOut: true }), seated('rex', 3)], ['you']), 0)).toEqual({ kind: 'waiting', reason: { kind: 'sitting-out' } });
    // Bots never play on alone.
    expect(nextHandStatus(table([seated('ann', 1, { stack: 0 }), seated('rex', 3)], ['ann']), 0)).toEqual({ kind: 'waiting', reason: { kind: 'take-seat' } });
  });
  it('expects a countdown soon while the table can deal, as during the Settle after a payout', () => {
    const paid = table([seated('ann', 1), seated('rex', 2)], ['ann'], { phases: [{ kind: 'payout', handId: 'hand-1', street: 'preflop', startsAt: 0, endsAt: 2_000, durationMs: 2_000 }, { kind: 'settle', handId: 'hand-1', street: 'preflop', startsAt: 2_000, endsAt: 5_000, durationMs: 3_000 }], actionWindow: null });
    const settling = { ...paid, view: { ...paid.view, state: { ...paid.view.state, status: 'completed-hand' as const, handId: 'hand-1' } } };
    expect(nextHandStatus(settling, 3_000)).toEqual({ kind: 'soon' });
  });
  it('is told in words everyone can follow', () => {
    expect([nextHandLabel({ kind: 'countdown', seconds: 3 }), nextHandLabel({ kind: 'countdown', seconds: 5 }, true), nextHandLabel({ kind: 'countdown', seconds: 0 }), nextHandLabel({ kind: 'soon' }), nextHandLabel(undefined)])
      .toEqual(['Next hand in 3s', 'First hand in 5s', 'Dealing…', 'Next hand coming up', undefined]);
  });
  it('names what a waiting table needs in its headline: the viewer’s way in, or how many more participants', () => {
    const waiting = (reason: WaitingReason) => nextHandLabel({ kind: 'waiting', reason }, true);
    expect([
      waiting({ kind: 'take-seat' }), waiting({ kind: 'no-chips' }), waiting({ kind: 'sitting-out' }),
      waiting({ kind: 'participants', needed: 1, reconnecting: ['Ann'], sittingOut: [] }), waiting({ kind: 'participants', needed: 2, reconnecting: [], sittingOut: [] }),
    ]).toEqual(['Take an open seat', 'Waiting for your rebuy', 'Waiting for you to return', 'Waiting for one more participant', 'Waiting for 2 more participants']);
    // You are seated and sitting out beside one Bot: the table waits for you, not for more participants.
    const besideBot = nextHandStatus(table([seated('you', 1, { sittingOut: true }), seated('rex', 2)], ['you']), 0);
    expect(nextHandLabel(besideBot, true)).toBe('Waiting for you to return');
  });
  it('names what a waiting table needs from the viewer, or from others', () => {
    // You are watching: sitting down is your way in.
    expect(waitingReason(table([seated('ann', 1)], ['ann', 'you']))).toEqual({ kind: 'take-seat' });
    // You are seated but sitting out; with no chips, the rebuy comes first.
    expect(waitingReason(table([seated('ann', 1), seated('you', 2, { sittingOut: true })], ['you']))).toEqual({ kind: 'sitting-out' });
    expect(waitingReason(table([seated('ann', 1), seated('you', 2, { sittingOut: true, stack: 0 })], ['you']))).toEqual({ kind: 'no-chips' });
    // You are ready alone: one more participant, and Ann would count once she reconnects.
    expect(waitingReason(table([seated('ann', 1), seated('you', 2)], ['you']))).toEqual({ kind: 'participants', needed: 1, reconnecting: ['Ann'], sittingOut: [] });
    expect(waitingReason(table([seated('ann', 1, { sittingOut: true }), seated('you', 2)], ['ann', 'you']))).toEqual({ kind: 'participants', needed: 1, reconnecting: [], sittingOut: ['Ann'] });
    expect(waitingReason(table([seated('you', 2)], ['you']))).toEqual({ kind: 'participants', needed: 1, reconnecting: [], sittingOut: [] });
    // A table that can deal waits for nothing.
    expect(waitingReason(table([seated('you', 1), seated('rex', 2)], ['you']))).toBeUndefined();
  });
  it('explains the wait in plain words, offering everyone the Join Link and the owner Bots too', () => {
    expect(waitingDetail({ kind: 'participants', needed: 1, reconnecting: [], sittingOut: [] }, true)).toBe('Hands start once one more participant is seated. Share the join link, or add a Bot.');
    expect(waitingDetail({ kind: 'participants', needed: 1, reconnecting: [], sittingOut: [] }, false)).toBe('Hands start once one more participant takes a seat. Share the join link to invite someone.');
    expect(waitingDetail({ kind: 'participants', needed: 1, reconnecting: ['Ann'], sittingOut: ['Rex'] }, false)).toBe('Ann is disconnected. Rex is sitting out. Hands start once one more participant is ready.');
  });
    it('does not suggest adding a Bot when no Seat is open', () => {
      expect(waitingDetail({ kind: 'participants', needed: 1, reconnecting: [], sittingOut: ['Rex'] }, true, false)).toBe('Rex is sitting out. Hands start once one more participant is ready. Manage participants directly from the table.');
    });
    it('lists the other players watching without a Seat', () => {
    expect(watchingNames(table([seated('you', 2)], ['ann', 'you']))).toEqual(['Ann']);
    // The viewer is told in the tray that they are watching, not in this list.
    expect(watchingNames(table([seated('ann', 1)], ['ann', 'you']))).toEqual([]);
  });
  it('says nothing during a Hand or at a Practice Table', () => {
    const playing = table([seated('ann', 1), seated('rex', 2)], ['ann']);
    expect(nextHandStatus({ ...playing, view: { ...playing.view, state: { ...playing.view.state, status: 'active-hand' } } }, 0)).toBeUndefined();
    expect(nextHandStatus(table([seated('you', 1), seated('rex', 2)], [], undefined, 'practice'), 0)).toBeUndefined();
  });
});
