import type { TableHandReplay, TableHistory, TableHistoryHand } from '@poker/contracts';
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

/**
 * One completed Hand's Replay Steps for one Participant (ADR-0041), as the engine projects them, with the Hand's list
 * row and the names of everyone seated in it; `undefined` when `handId` is not a completed Hand of the table.
 */
export function handReplay(aggregate: PersistedTableSession, game: CashGame, participantId: string, handId: string): TableHandReplay | undefined {
  let replay;
  try { replay = game.forParticipant(participantId).getReplay(handId); } catch (error) { if (error instanceof RangeError) return undefined; throw error; }
  const hand = handsOf(aggregate, game, participantId).find(row => row.handId === handId);
  if (!hand) return undefined;
  const seats = new Map<string, number>();
  for (const step of replay.steps) for (const p of step.state.participants) if (p.seat !== null && !seats.has(p.participantId)) seats.set(p.participantId, p.seat);
  const players = [...seats].sort((a, b) => a[1] - b[1]).map(([id]) => ({ participantId: id, name: findBinding(aggregate, id)?.name ?? '' }));
  return { ...replay, tableSessionId: aggregate.tableSessionId, mode: aggregate.mode, viewerParticipantId: participantId, hand, players };
}
