import type { TableHistory, TableHistoryHand } from '@poker/contracts';
import type { CashGame } from '@poker/engine';
import { findBinding, type PersistedTableSession } from './aggregate.js';

/**
 * The Table History list for one Participant: every completed Hand of the Table Session, oldest first (ADR-0040).
 * It is built only from that Participant's Observable Session History, so it shows public information for every Hand
 * plus their own hole cards, and any cards a showdown revealed in its own Hand's result. The Hand number is the
 * engine's table-wide sequence; the completion time is the server's, recorded beside the poker record, and absent
 * for a Hand completed before it was recorded.
 *
 * Later reads of a Hand (its Replay Steps) take their rows from the same place: `handsOf`.
 */
export function tableHistory(aggregate: PersistedTableSession, game: CashGame, participantId: string): TableHistory {
  return { tableSessionId: aggregate.tableSessionId, viewerParticipantId: participantId, hands: handsOf(aggregate, game, participantId) };
}
export function handsOf(aggregate: PersistedTableSession, game: CashGame, participantId: string): TableHistoryHand[] {
  const numbers = new Map(game.getCompletedHands().map(hand => [hand.handId, hand.sequence]));
  const hands: TableHistoryHand[] = [];
  for (const entry of game.forParticipant(participantId).getView().history) {
    const { result } = entry;
    const handNumber = numbers.get(entry.handId);
    if (!result || handNumber === undefined) continue;
    const dealt = result.participants.filter(player => player.inHand).sort((a, b) => a.handSeat! - b.handSeat!);
    const completedAt = aggregate.handCompletedAt?.[entry.handId];
    hands.push({
      handId: entry.handId, handNumber, ...(completedAt !== undefined ? { completedAt } : {}),
      dealtIn: dealt.map(player => ({ participantId: player.participantId, name: findBinding(aggregate, player.participantId)?.name ?? '', ...(player.holeCards ? { holeCards: [...player.holeCards] } : {}) })),
      viewerDealtIn: dealt.some(player => player.participantId === participantId),
      board: [...result.board],
      showdown: dealt.filter(player => !player.folded).length > 1,
      payouts: (result.payouts ?? []).map(payout => ({ participantId: payout.participantId, amount: payout.amount })),
    });
  }
  return hands;
}
