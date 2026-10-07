import type { ChipTransfer, HandState, PotState } from './state.js';

/** Folded chips remain contributors. A single contributor's layer is an unmatched return. */
export function contributionLayers(hand: HandState): { pots: PotState[]; returns: ChipTransfer[] } {
  const levels = [...new Set(hand.participants.map(p => p.contribution).filter(amount => amount > 0))].sort((a, b) => a - b);
  const pots: PotState[] = [];
  const returns: ChipTransfer[] = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = hand.participants.filter(p => p.contribution >= level);
    const amount = (level - previous) * contributors.length;
    if (contributors.length === 1) returns.push({ participantId: contributors[0]!.participantId, amount });
    else pots.push({ amount, eligibleParticipantIds: contributors.filter(p => !p.folded).map(p => p.participantId) });
    previous = level;
  }
  return { pots, returns };
}
