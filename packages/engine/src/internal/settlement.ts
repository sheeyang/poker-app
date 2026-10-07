import type { CashGameEvent } from '../index.js';
import type { CashGameState, HandState } from './state.js';
import { contributionLayers } from './pots.js';
import { compareHandRanks, rankHand } from './ranking.js';

export function revealLiveHands(hand: HandState, events: CashGameEvent[]): void {
  for (const member of hand.participants.filter(p => !p.folded)) {
    if (member.revealed) continue;
    member.revealed = true;
    events.push({ type: 'hole-cards-revealed', participantId: member.participantId, cards: [...member.holeCards] });
  }
}

/** Derive every transfer from the contribution ledger on the caller's isolated draft. */
export function settleHand(state: CashGameState, hand: HandState, events: CashGameEvent[], seatCount: number): void {
  const live = hand.participants.filter(p => !p.folded);
  if (live.length > 1) revealLiveHands(hand, events);
  const layers = contributionLayers(hand);
  hand.pots = layers.pots; hand.returns = layers.returns;
  for (const transfer of hand.returns) {
    state.participants.find(p => p.participantId === transfer.participantId)!.stack += transfer.amount;
    events.push({ type: 'uncalled-return', participantId: transfer.participantId, amount: transfer.amount });
  }
  for (const pot of hand.pots) {
    const eligible = live.filter(p => pot.eligibleParticipantIds.includes(p.participantId));
    if (eligible.length === 0) throw new Error('A matched pot has no eligible live hand.');
    let winners = eligible;
    if (eligible.length > 1) {
      const ranked = eligible.map(p => ({ member: p, rank: rankHand([...p.holeCards, ...hand.board]) }));
      const best = ranked.reduce((a, b) => compareHandRanks(a.rank, b.rank) >= 0 ? a : b).rank;
      winners = ranked.filter(p => compareHandRanks(p.rank, best) === 0).map(p => p.member);
    }
    winners.sort((a, b) => ((a.seat - hand.buttonSeat - 1 + seatCount) % seatCount) - ((b.seat - hand.buttonSeat - 1 + seatCount) % seatCount));
    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount % winners.length;
    for (const [index, winner] of winners.entries()) {
      const amount = share + (index < remainder ? 1 : 0);
      state.participants.find(p => p.participantId === winner.participantId)!.stack += amount;
      hand.payouts.push({ participantId: winner.participantId, amount });
      events.push({ type: 'pot-awarded', participantId: winner.participantId, amount });
    }
  }
  hand.completed = true; hand.actorId = null; hand.decisionId = null;
  state.status = 'completed-hand';
  events.push({ type: 'hand-completed', handId: hand.handId });
}
