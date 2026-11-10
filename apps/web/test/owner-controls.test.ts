import { describe, expect, it } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ObservableTableSession } from '@poker/contracts';
import { botControls, hasDeparted, nextBotName, openSeats, optionChanges, optionControls, presentBindings, tablePasswordControl } from '../src/owner-controls.js';
import { canRemove } from '../src/removal.js';

const strategy = defaultTrainerConfiguration.referenceStrategy;
function table(viewer: 'ann' | 'ben', extra: Partial<ObservableTableSession> = {}, mode: 'online' | 'practice' = 'online'): ObservableTableSession {
  return {
    tableSessionId: 't', mode, options: { actionTimeLimitSeconds: mode === 'online' ? 30 : null, allowLiveAnalysis: true }, viewerParticipantId: viewer, ownerParticipantId: 'ann',
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: [], actionWindow: null }, serverTime: 0, pendingChanges: [],
    bindings: [{ participantId: 'ann', name: 'Ann', controller: { kind: 'human' } }, { participantId: 'ben', name: 'Ben', controller: { kind: 'human' } },
      { participantId: 'rex', name: 'Bot 1', controller: { kind: 'bot', playingStrategy: strategy } }, { participantId: 'sol', name: 'Sol', controller: { kind: 'bot', playingStrategy: strategy } }],
    view: { configuration: { ...defaultConfiguration, seatCount: 4 }, history: [], state: { status: 'between-hands', buttonSeat: 1, board: [], pots: [], actorId: null, legalActions: [],
      participants: [{ participantId: 'ann', seat: 1, stack: 1000, sittingOut: false }, { participantId: 'rex', seat: 3, stack: 1000, sittingOut: false }, { participantId: 'ben', seat: null, stack: 0, sittingOut: false }, { participantId: 'sol', seat: null, stack: 0, sittingOut: false }] } },
    ...extra,
  };
}

describe('who has departed', () => {
  it('lists only the Participants still at the table', () => {
    const t = table('ann', { departedParticipantIds: ['ben', 'sol'] });
    expect(hasDeparted(t, 'ben')).toBe(true);
    expect(hasDeparted(t, 'rex')).toBe(false);
    expect(presentBindings(t).map(b => b.name)).toEqual(['Ann', 'Bot 1']);
  });
  it('treats a view that lists nobody as everyone present', () => {
    expect(presentBindings(table('ann'))).toHaveLength(4);
  });
  it('does not offer Removal of a human who has left or was removed', () => {
    expect(canRemove(table('ann'), table('ann').bindings[1]!)).toBe(true);
    const left = table('ann', { departedParticipantIds: ['ben'] });
    expect(canRemove(left, left.bindings[1]!)).toBe(false);
  });
});

describe('the owner’s table option controls', () => {
  it('belong to the owner of an Online Table, and are editable between Hands only', () => {
    expect(optionControls(table('ann'), false)).toEqual({ shown: true, editable: true });
    expect(optionControls(table('ann'), true)).toEqual({ shown: true, editable: false });
    expect(optionControls(table('ben'), false).shown).toBe(false);
    expect(optionControls(table('ann', {}, 'practice'), false).shown).toBe(false);
  });
  it('send only what changed, and nothing when nothing did', () => {
    const t = table('ann');
    const same = { actionTimeLimitSeconds: 30, allowSeatChanges: true, allowLiveAnalysis: true };
    expect(optionChanges(t, same)).toBeUndefined();
    expect(optionChanges(t, { ...same, actionTimeLimitSeconds: 15 })).toEqual({ actionTimeLimitSeconds: 15 });
    expect(optionChanges(t, { ...same, allowSeatChanges: false, allowLiveAnalysis: false })).toEqual({ allowSeatChanges: false, allowLiveAnalysis: false });
  });
});

describe('the Table Password', () => {
  const locked = { options: { actionTimeLimitSeconds: 30 as const, allowLiveAnalysis: true, hasTablePassword: true as const } };
  it('is the Online Table owner’s to set, change or remove at any time, even during a Hand', () => {
    expect(tablePasswordControl(table('ann'))).toMatchObject({ shown: true, editable: true, set: false });
    expect(tablePasswordControl(table('ann', locked))).toMatchObject({ shown: true, editable: true, set: true });
    expect(tablePasswordControl(table('ben'))).toMatchObject({ shown: true, editable: false });
  });
  it('is shown to everyone at an Online Table as set or not, never as the password', () => {
    expect(tablePasswordControl(table('ben')).summary).toBe('No Table Password');
    expect(tablePasswordControl(table('ben', locked)).summary).toBe('Table Password set');
  });
  it('does not exist at a Practice Table', () => {
    expect(tablePasswordControl(table('ann', {}, 'practice'))).toEqual({ shown: false, editable: false, set: false });
  });
});

describe('adding a Bot', () => {
  it('offers the open Seats in order', () => {
    expect(openSeats(table('ann'))).toEqual([2, 4]);
  });
  it('suggests the next free "Bot N" name, ignoring case and counting departed Bots', () => {
    expect(nextBotName(table('ann'))).toBe('Bot 2');
    const crowded = table('ann');
    expect(nextBotName({ ...crowded, bindings: [...crowded.bindings, { participantId: 'x', name: 'BOT 2', controller: { kind: 'human' } }] })).toBe('Bot 3');
  });
});

describe('what the owner can ask of a Bot', () => {
  const seatedRex = (handOpen: boolean, extra: Partial<ObservableTableSession> = {}) => botControls(table('ann', extra), 'rex', handOpen);
  it('is immediate between Hands', () => {
    expect(seatedRex(false)).toEqual({ sitOut: 'now', resume: 'unavailable', topUp: 'now', standUp: 'now', remove: 'now' });
  });
  it('waits for the Hand: sitting out and Removal are asked for now, the rest are unavailable', () => {
    expect(seatedRex(true)).toEqual({ sitOut: 'after-hand', resume: 'unavailable', topUp: 'unavailable', standUp: 'unavailable', remove: 'after-hand' });
  });
  it('lets a sat-out Bot be resumed between Hands only', () => {
    const away = table('ann');
    away.view.state.participants.find(p => p.participantId === 'rex')!.sittingOut = true;
    expect(botControls(away, 'rex', false)).toMatchObject({ sitOut: 'unavailable', resume: 'now' });
    expect(botControls(away, 'rex', true)).toMatchObject({ resume: 'unavailable' });
  });
  it('lets a Bot without a Seat be removed at once even during a Hand', () => {
    expect(botControls(table('ann'), 'sol', true)).toEqual({ sitOut: 'unavailable', resume: 'unavailable', topUp: 'unavailable', standUp: 'unavailable', remove: 'now' });
  });
  it('stops offering a change that is already pending', () => {
    const pending = seatedRex(true, { pendingChanges: [{ participantId: 'rex', change: 'sit-out' }] });
    expect(pending.sitOut).toBe('unavailable');
    expect(pending.remove).toBe('after-hand');
    expect(seatedRex(true, { pendingChanges: [{ participantId: 'rex', change: 'remove' }] })).toMatchObject({ sitOut: 'unavailable', remove: 'unavailable' });
  });
  it('offers nothing for a Bot that has been removed', () => {
    expect(seatedRex(false, { departedParticipantIds: ['rex'] })).toEqual({ sitOut: 'unavailable', resume: 'unavailable', topUp: 'unavailable', standUp: 'unavailable', remove: 'unavailable' });
  });
});
