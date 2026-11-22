import type { ObservableCashGameState, ParticipantId, Position } from '@poker/contracts';

/** The non-blind, non-button seats, first to act first, for each count of them; the middle ones drop as the table gets smaller. */
const early: Readonly<Record<number, readonly Position[]>> = {
  0: [], 1: ['CO'], 2: ['UTG', 'CO'], 3: ['UTG', 'HJ', 'CO'], 4: ['UTG', 'LJ', 'HJ', 'CO'], 5: ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO'], 6: ['UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO'],
};

/**
 * Each dealt-in Participant's Position in the Hand `state` belongs to (GLOSSARY: Position), from the dealt-in players
 * and the button alone, so it is fixed when the Hand is dealt. Players who were not dealt in have none. Clockwise from
 * the button: BTN, SB, BB, then UTG up to CO, with middle positions dropped at smaller tables; heads-up the button
 * posts the small blind and is BTN/SB. The browser receives the label only.
 */
export function handPositions(state: ObservableCashGameState): ReadonlyMap<ParticipantId, Position> {
  const players = state.participants.filter(p => p.inHand && p.handSeat !== undefined).sort((a, b) => a.handSeat! - b.handSeat!);
  const button = players.findIndex(p => p.handSeat === state.buttonSeat);
  const positions = new Map<ParticipantId, Position>();
  if (button < 0) return positions;
  const clockwise = [...players.slice(button), ...players.slice(0, button)];
  if (clockwise.length === 2) return positions.set(clockwise[0]!.participantId, 'BTN/SB').set(clockwise[1]!.participantId, 'BB');
  const labels: readonly Position[] = ['BTN', 'SB', 'BB', ...early[clockwise.length - 3] ?? []];
  for (const [index, label] of labels.entries()) if (clockwise[index]) positions.set(clockwise[index]!.participantId, label);
  return positions;
}
