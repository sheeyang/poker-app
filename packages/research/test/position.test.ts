import { expect, test } from 'vitest';
import type { ObservableCashGameState, ObservableParticipant } from '@poker/contracts';
import { handPositions } from '../src/index.js';

/** A table of `seatCount` seats where the players in `seats` were dealt in, and the button is at `button`. */
function dealt(seatCount: number, seats: readonly number[], button: number, sittingOut: readonly number[] = []): ObservableCashGameState {
  const participants: ObservableParticipant[] = Array.from({ length: seatCount }, (_, index) => {
    const seat = index + 1, name = 'p' + seat;
    return seats.includes(seat) ? { participantId: name, seat, stack: 100, sittingOut: false, inHand: true, handSeat: seat } : { participantId: name, seat, stack: 100, sittingOut: sittingOut.includes(seat) };
  });
  return { status: 'active-hand', buttonSeat: button, participants, board: [], pots: [], actorId: null, legalActions: [], handId: 'hand-1' };
}
const labels = (state: ObservableCashGameState) => Object.fromEntries([...handPositions(state)].map(([id, position]) => [id.slice(1), position]));

test('heads-up the button posts the small blind and is BTN/SB, and the other player is BB', () => {
  expect(labels(dealt(2, [1, 2], 1))).toEqual({ 1: 'BTN/SB', 2: 'BB' });
  expect(labels(dealt(2, [1, 2], 2))).toEqual({ 2: 'BTN/SB', 1: 'BB' });
});

test('three players are BTN, SB and BB clockwise from the button, wrapping past the last seat', () => {
  expect(labels(dealt(3, [1, 2, 3], 1))).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB' });
  expect(labels(dealt(3, [1, 2, 3], 3))).toEqual({ 3: 'BTN', 1: 'SB', 2: 'BB' });
});

test('middle positions drop as the table gets smaller: only UTG and CO remain for the non-blind seats of a five-handed Hand', () => {
  expect(labels(dealt(9, [1, 2, 3, 4], 1))).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB', 4: 'CO' });
  expect(labels(dealt(9, [1, 2, 3, 4, 5], 1))).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB', 4: 'UTG', 5: 'CO' });
  expect(labels(dealt(6, [1, 2, 3, 4, 5, 6], 1))).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB', 4: 'UTG', 5: 'HJ', 6: 'CO' });
  expect(labels(dealt(9, [1, 2, 3, 4, 5, 6, 7], 1))).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB', 4: 'UTG', 5: 'LJ', 6: 'HJ', 7: 'CO' });
  expect(labels(dealt(9, [1, 2, 3, 4, 5, 6, 7, 8], 1))).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB', 4: 'UTG', 5: 'UTG+1', 6: 'LJ', 7: 'HJ', 8: 'CO' });
});

test('a full nine-handed Hand uses every label, from a button anywhere at the table', () => {
  expect(labels(dealt(9, [1, 2, 3, 4, 5, 6, 7, 8, 9], 1))).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB', 4: 'UTG', 5: 'UTG+1', 6: 'UTG+2', 7: 'LJ', 8: 'HJ', 9: 'CO' });
  expect(labels(dealt(9, [1, 2, 3, 4, 5, 6, 7, 8, 9], 6))).toEqual({ 6: 'BTN', 7: 'SB', 8: 'BB', 9: 'UTG', 1: 'UTG+1', 2: 'UTG+2', 3: 'LJ', 4: 'HJ', 5: 'CO' });
});

test('only dealt-in players count: empty and sitting-out seats are skipped, and have no Position', () => {
  const state = dealt(9, [2, 5, 7, 9], 7, [3]);
  expect(labels(state)).toEqual({ 7: 'BTN', 9: 'SB', 2: 'BB', 5: 'CO' });
  expect(handPositions(state).has('p3')).toBe(false);
});

test('a Hand with nobody dealt in has no Positions', () => {
  expect(handPositions({ ...dealt(6, [], 1) }).size).toBe(0);
});
