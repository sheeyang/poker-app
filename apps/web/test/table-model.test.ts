import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ObservableCashGameState, type ObservableTableSession } from '@poker/contracts';
import { retainNewestTable } from '@poker/client';
import { potTotal, presetTotal } from '../src/table-model.js';

describe('poker presentation boundaries', () => {
  it('counts active contributions once, then uses settled main and side pots', () => {
    const state: ObservableCashGameState = { status: 'active-hand', buttonSeat: 1, participants: [{ participantId: 'a', seat: 1, stack: 0, sittingOut: false, contribution: 125, wager: 25 }, { participantId: 'b', seat: 2, stack: 0, sittingOut: false, contribution: 175, wager: 75 }], board: [], pots: [{ amount: 200, eligibleParticipantIds: ['a', 'b'] }], actorId: null, legalActions: [] };
    expect(potTotal(state)).toBe(300);
    expect(potTotal({ ...state, status: 'completed-hand', pots: [{ amount: 250, eligibleParticipantIds: ['a', 'b'] }, { amount: 50, eligibleParticipantIds: ['b'] }] })).toBe(300);
  });
  it('adds the existing wager and call before calculating a pot-size raise total', () => {
    expect(presetTotal({ type: 'raise', minimum: 80, maximum: 2000 }, 100, 30, 20, 1)).toBe(180);
  });
  it('keeps short all-in and fractional-pot presets within the exact integer bounds', () => {
    expect(presetTotal({ type: 'raise', minimum: 75, maximum: 75 }, 150, 20, 10, 1)).toBe(75);
    expect(presetTotal({ type: 'bet', minimum: 20, maximum: 400 }, 11, 0, 0, .5)).toBe(20);
    expect(presetTotal({ type: 'raise', minimum: 40, maximum: 101 }, 500, 30, 10, .75)).toBe(101);
  });
  it('preserves newer confirmed facts when a delayed HTTP response arrives', () => {
    const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 4, sessionRevision: 5, bindings: [], trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: { status: 'between-hands', buttonSeat: 1, participants: [], board: [], pots: [], actorId: null, legalActions: [] }, history: [] } };
    expect(retainNewestTable(table, { ...table, sessionRevision: 4, pokerRevision: 3 })).toBe(table);
    expect(retainNewestTable(table, { ...table, runtimeStatus: { phase: 'recovering' } }).runtimeStatus?.phase).toBe('recovering');
    expect(retainNewestTable(table, { ...table, sessionRevision: 6, pokerRevision: 5 }).pokerRevision).toBe(5);
  });
});
